import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";
import { createService } from "../apps/agent/src/server.ts";
import { createAikoClient } from "../packages/sdk/src/aiko.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

if (!process.argv.includes("--allow-paid"))
  throw new Error(
    "Explicit --allow-paid required for this bounded provider probe",
  );
process.umask(0o077);
const live = process.argv.includes("--live");
const id =
  process.argv.find((value) => value.startsWith("--id="))?.slice(5) ??
  `background-probe-${Date.now()}`;
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  mode: live ? "live" : "staging",
  id,
  passed: false,
};
let service: Awaited<ReturnType<typeof createService>> | undefined;
let temporary: string | undefined;
try {
  const saved = await loadConfig();
  const credentials = live
    ? await privateEnv(join(homedir(), ".config/unbrowse/aiko-plane.env"))
    : undefined;
  if (!live) {
    temporary = await mkdtemp("/tmp/aiko-background-live-");
    service = await createService({
      ...saved,
      mode: "live",
      stateDir: temporary,
      instanceId: "background-staging",
      botToken: undefined,
      webhookSecret: undefined,
      telegramMode: "webhook",
      telegramPublic: false,
      allowedUsers: new Set(),
      planeCredentials: [],
      voiceEnabled: false,
      browser: undefined,
      publicWeb: false,
      modelLimits: { globalPerDay: 3, accountPerDay: 3, maxConcurrent: 1 },
    });
  }
  const token = live ? credentials!.AIKO_PLANE_TOKEN : saved.operatorToken;
  const fetcher = service
    ? (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        service!.fetch(new Request(input, init))
    : fetch;
  if (live) {
    let listening = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if (
          (
            await fetch("http://127.0.0.1:4242/health", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        ) {
          listening = true;
          break;
        }
      } catch {}
      await Bun.sleep(250);
    }
    assert.ok(listening, "Service did not start listening within ten seconds");
  }
  const client = createAikoClient({
    baseUrl: "http://127.0.0.1:4242",
    token,
    fetch: fetcher,
  });
  const before = await client.status();
  assert.equal(before.mode, "live");
  const result = await client.hooks.publish({
    id,
    subject: `verification/${id}`,
    title: "Background pipeline verification",
    kind: "fact",
    type: "verification",
    payload: {
      source: "operator verification probe",
      finding:
        "Synthetic canary for native learning and reflection; no user interruption required",
      status: "recorded",
    },
  });
  const thread = `background-${before.account}-reflection`;
  let recorded: any;
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = await fetcher(
      `http://127.0.0.1:4242/api/control/events?thread=${encodeURIComponent(thread)}&limit=100`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      const page = (await response.json()) as any;
      recorded = page.events
        .map((row: any) => row.event)
        .find(
          (event: any) =>
            event.type === "AikoDecisionRecorded" && event.id === result.id,
        );
      if (recorded) break;
    }
    await Bun.sleep(500);
  }
  assert.ok(recorded, "No durable reflection decision");
  assert.equal(
    recorded.decision,
    "silent",
    "Verification canary should not interrupt the user",
  );
  assert.notEqual(
    recorded.reason,
    "Reflection failed or returned an invalid decision",
  );
  const replay = await client.hooks.publish({
    id,
    subject: `verification/${id}`,
    title: "Background pipeline verification",
    kind: "fact",
    type: "verification",
    payload: {
      source: "operator verification probe",
      finding:
        "Synthetic canary for native learning and reflection; no user interruption required",
      status: "recorded",
    },
  });
  assert.equal(replay.status, "duplicate");
  const recalled = await client.memory.recall(id);
  assert.ok(
    recalled.items.some((item) =>
      item.observation.subject.includes("verification"),
    ),
  );
  const after = await client.status();
  evidence.passed = true;
  evidence.admission = result.status;
  evidence.replay = replay.status;
  evidence.model = after.model;
  evidence.decision = recorded.decision;
  evidence.callsUsed =
    (after.inferenceUsage?.accountCalls ?? 0) -
    (before.inferenceUsage?.accountCalls ?? 0);
  evidence.thread = thread;
  evidence.root = recorded.root;
  evidence.trace = live ? `http://127.0.0.1:4242/control` : null;
} catch (error) {
  evidence.error =
    error instanceof assert.AssertionError
      ? error.message
      : "Provider or service probe failed; inspect private runtime configuration";
  process.exitCode = 1;
} finally {
  await service?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  const dir = join(import.meta.dir, "../artifacts/aiko-background");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, live ? "live.json" : "staging.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.info(JSON.stringify(evidence, null, 2));
}
