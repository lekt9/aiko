import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";
import { createService } from "../apps/agent/src/server.ts";
import { createAikoClient } from "../packages/sdk/src/aiko.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Deliberately separate from the offline test suite: real inference requires explicit invocation.
if (!process.argv.includes("--allow-paid"))
  throw new Error(
    "Use --allow-paid to authorize this bounded real-provider probe",
  );
process.umask(0o077);
const staging = process.argv.includes("--staging");
let service: Awaited<ReturnType<typeof createService>> | undefined;
let temporary: string | undefined;
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  staging,
  passed: false,
};
try {
  const saved = await loadConfig();
  const clientFile = await privateEnv(
    join(homedir(), ".config/unbrowse/aiko-plane.env"),
  );
  if (staging) {
    temporary = await mkdtemp("/tmp/aiko-live-probe-");
    const config = {
      ...saved,
      mode: "live" as const,
      instanceId: "live-probe",
      stateDir: temporary,
      botToken: undefined,
      webhookSecret: undefined,
      telegramMode: "webhook" as const,
      telegramPublic: false,
      allowedUsers: new Set<string>(),
      publicWeb: true,
      browser: undefined,
      voiceEnabled: false,
      modelLimits: { globalPerDay: 8, accountPerDay: 8, maxConcurrent: 1 },
    };
    if (!config.modelKey) throw new Error("No configured inference credential");
    service = await createService(config);
  }
  const client = createAikoClient({
    baseUrl: "http://127.0.0.1:4242",
    token: staging ? saved.operatorToken : clientFile.AIKO_PLANE_TOKEN,
    ...(service
      ? {
          fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            service!.fetch(new Request(input, init)),
        }
      : {}),
  });
  const before = await client.status();
  if (
    before.mode !== "live" ||
    before.fixtures !== false ||
    !before.inferenceUsage
  )
    throw new Error("Not a budgeted fixture-free live service");
  const marker = `liveprobe${Date.now()}`;
  const prompts = [
    "In one short paragraph, why does ice float on liquid water?",
    "Use web_read to read https://example.com/ . What is the page title and what is it for? Cite the observation.",
    `Use memory_remember to save an independent new note under the fresh subject verification/${marker}, with payload including: ${marker} launch reviews use UTC. Do not overwrite an earlier note. Briefly confirm the actual memory result.`,
  ];
  const replies = [];
  evidence.marker = marker;
  evidence.replies = replies;
  for (let i = 0; i < prompts.length; i++) {
    const status = await client.status();
    if (
      (status.inferenceUsage?.accountCalls ?? 0) -
        before.inferenceUsage.accountCalls >=
      6
    )
      throw new Error("Probe request budget reached");
    const admitted = await client.messages.send({
      id: `${marker}_${i}`,
      text: prompts[i],
    });
    let found = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const reply = (await client.messages.list()).messages.find(
        (m) => m.role === "assistant" && m.turn === admitted.id,
      );
      if (reply) {
        replies.push({ source: reply.source, text: reply.text });
        if (
          reply.source !== "model" ||
          /couldn.t finish|couldn.t confirm|not confirmed/i.test(reply.text)
        )
          throw new Error("No usable live answer");
        found = true;
        break;
      }
      await Bun.sleep(500);
    }
    if (!found) {
      await client.messages.cancel(admitted.id);
      throw new Error("Live answer timed out");
    }
  }
  const memory = await client.memory.recall(marker);
  const agentNote = memory.items.find(
    (item) => item.observation.producer.kind === "agent",
  );
  if (!agentNote) throw new Error("No model-authored memory observation");
  if (
    (await client.memory.get(agentNote.observation.id)).observation.id !==
    agentNote.observation.id
  )
    throw new Error("Pinned memory mismatch");
  const web = await client.memory.recall("Example Domain");
  if (!web.items.some((item) => item.observation.producer.kind === "tool"))
    throw new Error("No public-page observation");
  const after = await client.status();
  evidence.passed = true;
  evidence.model = after.model;
  evidence.replies = replies;
  evidence.callsUsed =
    after.inferenceUsage!.accountCalls - before.inferenceUsage.accountCalls;
  evidence.memory = {
    observation: agentNote.observation.id,
    follower: after.memory?.logFollower.status,
    publicPage: true,
  };
} catch {
  evidence.error =
    "Live probe failed; no raw provider exception or credential was printed.";
  if (service) {
    evidence.events = (await service.host.read("user-local")).map(
      (event) => event.type,
    );
    const status = await service.fetch(
      new Request("http://127.0.0.1:4242/v1/status", {
        headers: {
          authorization: `Bearer ${(await loadConfig()).operatorToken}`,
        },
      }),
    );
    evidence.status = await status.json();
  }
  process.exitCode = 1;
} finally {
  await service?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  const output = join(import.meta.dir, "../artifacts/aiko-production");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, staging ? "staging.json" : "live.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.info(JSON.stringify(evidence, null, 2));
}
