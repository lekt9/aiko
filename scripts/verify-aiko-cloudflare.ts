import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig, privateEnv } from "../apps/agent/src/config.ts";

process.umask(0o077);
const credentials = await privateEnv(
  "/home/deck/.config/unbrowse/aiko-cloudflare.env",
);
const url = credentials.AIKO_CLOUDFLARE_URL;
assert.match(url, /^https:\/\/aiko-agent\.[a-z0-9-]+\.workers\.dev$/);
const owner = credentials.AIKO_E2E_OWNER;
const directory = "/home/deck/work/unlock/artifacts/aiko-cloudflare";
const file = `${directory}/live.json`;
async function telegramEvidence(account: string) {
  assert.match(
    account,
    /^[1-9]\d{0,15}$/,
    "A real private Telegram account is required",
  );
  const migration = await Bun.file(`${directory}/migration.json`).json();
  assert.equal(migration.verified, true, "Cloudflare handoff is not verified");
  const config = await loadConfig(process.env, { readonly: true });
  const history: any[] = [];
  let after = 0;
  for (;;) {
    const response = await fetch(
      `${url}/api/control/events?thread=user-${account}&after=${after}&limit=100`,
      {
        headers: { authorization: `Bearer ${config.operatorToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert.ok(response.ok, `Telegram evidence: HTTP ${response.status}`);
    const page: any = await response.json();
    history.push(...page.events.map((r: any) => r.event));
    if (!page.hasMore) break;
    assert.ok(page.nextAfter > after);
    after = page.nextAfter;
  }
  const incoming = history.filter(
    (e) =>
      e.type === "MessageReceived" &&
      e.source === "telegram" &&
      String(e.chat) === account &&
      String(e.sender) === account &&
      e.at >= migration.completedAt,
  );
  const turns = new Set(incoming.map((e) => e.id));
  const own = history.filter((e) => turns.has(e.turn));
  const inspected = own.filter(
    (e) =>
      e.type === "ToolReturned" &&
      e.result?.action === "telegram_inspect" &&
      e.result.status === "processed",
  );
  const kinds = ["photo", "video", "voice"];
  for (const kind of kinds) {
    const files = incoming
      .flatMap((e) => e.media ?? [])
      .filter((m) => m.owner === account && m.kind === kind);
    assert.ok(
      files.some((m) => inspected.some((e) => e.result.fileId === m.fileId)),
      `No real incoming ${kind} processed after Cloudflare handoff`,
    );
  }
  const delivered = own.filter(
    (e) =>
      e.type === "AikoTelegramActionSettled" &&
      e.result?.owner === account &&
      e.result?.status === "delivered" &&
      (e.result.providerId || e.result.providerIds?.length),
  );
  const mediaKinds = new Set([
    "photo",
    "video",
    "voice",
    "audio",
    "video_note",
    "document",
    "sticker",
    "animation",
    "album",
  ]);
  const richDelivered = delivered.filter(
    (settled) =>
      settled.result.action === "telegram_screenshot" ||
      (settled.result.action === "telegram_send" &&
        own.some(
          (called) =>
            called.type === "ToolCalled" &&
            ["telegram_send", "send_message"].includes(called.name) &&
            called.turn === settled.turn &&
            typeof called.callId === "string" &&
            settled.id === JSON.stringify([called.turn, called.callId]) &&
            mediaKinds.has(called.arguments?.kind),
        )),
  );
  assert.ok(
    delivered.some((e) => e.result.action === "telegram_voice"),
    "No real Telegram voice reply accepted",
  );
  assert.ok(richDelivered.length > 0, "No real rich-media reply accepted");
  const typingCompleted = own.some(
    (started, index) =>
      started.type === "AikoTelegramTypingStarted" &&
      started.owner === account &&
      typeof started.activation === "string" &&
      own
        .slice(index + 1)
        .some(
          (stopped) =>
            stopped.type === "AikoTelegramTypingStopped" &&
            stopped.owner === account &&
            stopped.turn === started.turn &&
            stopped.activation === started.activation &&
            stopped.at >= started.at,
        ),
  );
  assert.ok(typingCompleted, "No matching typing lifecycle completed");
  assert.ok(
    own.some((e) => e.type === "AikoReplyPrepared"),
    "No native foreground reply",
  );
  return {
    verified: true,
    at: Date.now(),
    url,
    owner: account,
    migrationCompletedAt: migration.completedAt,
    inboundKinds: kinds,
    inspectedTurns: [...new Set(inspected.map((e) => e.turn))],
    typingLifecycleObserved: true,
    deliveries: delivered.map((e) => ({
      id: e.id,
      turn: e.turn,
      action: e.result.action,
      providerIds: e.result.providerIds ?? [e.result.providerId],
    })),
    meaning:
      "Actual post-handoff Telegram input, processing and provider-acknowledged media output. Typing events prove the local lifecycle, not provider acknowledgment. Not proof of human playback or reading.",
  };
}
async function request(path: string, body?: unknown) {
  const response = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${credentials.AIKO_E2E_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json() as Promise<any>;
}
const eventCache = new Map<string, { result: any[]; after: number }>();
async function events(thread: string) {
  const cached = eventCache.get(thread) ?? { result: [], after: 0 };
  const result = cached.result;
  let after = cached.after;
  for (;;) {
    const page = await request(
      `/api/control/events?thread=${encodeURIComponent(thread)}&after=${after}&limit=100`,
    );
    result.push(...page.events.map((row: any) => row.event));
    assert.ok(page.nextAfter >= after);
    eventCache.set(thread, { result, after: page.nextAfter });
    if (!page.hasMore) return result;
    assert.ok(page.nextAfter > after);
    after = page.nextAfter;
  }
}
if (process.argv.includes("--automations-test")) {
  assert.equal(
    owner,
    "acct_cloudflare_e2e02",
    "Only the isolated canary may run this probe",
  );
  const startedAt = Date.now(),
    suffix = String(startedAt);
  const schedule = `probe_schedule_${suffix}`,
    listener = `probe_listener_${suffix}`;
  const at = new Date(startedAt + 360_000).toISOString();
  const thread = `user-${owner}`;
  const evidence: Record<string, unknown> = {
    url,
    owner,
    startedAt,
    schedule,
    listener,
    at,
    verified: false,
  };
  let setupSent = false;
  async function until(
    label: string,
    check: () => Promise<boolean>,
    timeout = 240_000,
  ) {
    const start = Date.now();
    let progressAt = 0;
    while (Date.now() - start < timeout) {
      if (await check()) return;
      if (Date.now() - progressAt > 20_000) {
        console.log(`Automation probe: waiting for ${label}`);
        progressAt = Date.now();
      }
      await Bun.sleep(2000);
    }
    throw new Error(`Automation probe timed out: ${label}`);
  }
  try {
    const before = await events(thread);
    const terminal = new Set(
      before
        .filter((e) =>
          ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type),
        )
        .map((e) => e.turn),
    );
    assert.ok(
      !before.some((e) => e.type === "MessageReceived" && !terminal.has(e.id)),
      "Canary has active work; do not interrupt it",
    );
    setupSent = true;
    await request("/v1/messages", {
      id: `automation-setup-${suffix}`,
      text: `Use automation_set twice now for my requested test. Create schedule ${schedule}, kind schedule, at ${at}, instruction "Reply only: scheduled probe complete. Do not use external tools or send messages." Create listener ${listener}, kind listener, eventType AikoHookReceived, cooldownSeconds 60, instruction "Reply only: hook probe complete. Do not use external tools or send messages." These are isolated test rules I authorize. Do not browse or create any other rules.`,
    });
    await until(
      "agent self-wiring",
      async () => {
        const view = await request("/v1/automations");
        return [schedule, listener].every((name) =>
          view.rules.some((r: any) => r.name === name && r.enabled),
        );
      },
      300_000,
    );
    const hook = {
      id: `automation-probe-${suffix}`,
      subject: "automation-probe",
      title: "Synthetic automation verification",
      kind: "fact",
      type: "automation-test",
      payload: { status: "observed", synthetic: true },
    };
    assert.equal((await request("/v1/hooks", hook)).status, "accepted");
    assert.equal((await request("/v1/hooks", hook)).status, "duplicate");
    await until(
      "hook and Cloudflare alarm completion",
      async () => {
        const log = await events(thread);
        return [schedule, listener].every((name) => {
          const fired = log.filter(
            (e) => e.type === "AikoAutomationFired" && e.name === name,
          );
          assert.ok(fired.length <= 1, `${name} fired more than once`);
          return (
            fired.length === 1 &&
            log.some(
              (e) =>
                e.type === "TurnCompleted" &&
                e.turn === `automation:${fired[0].id}`,
            )
          );
        });
      },
      480_000,
    );
    evidence.firings = (await events(thread))
      .filter(
        (e) =>
          e.type === "AikoAutomationFired" &&
          [schedule, listener].includes(e.name),
      )
      .map(({ id, name, at, trigger }: any) => ({ id, name, at, trigger }));
    evidence.verified = true;
  } finally {
    if (setupSent) {
      if (!evidence.verified)
        await request("/v1/cancel", {
          id: `plane:automation-setup-${suffix}`,
        }).catch(() => undefined);
      await request("/v1/messages", {
        id: `automation-cleanup-${suffix}`,
        text: `Remove only the test automation rules ${schedule} and ${listener} using automation_change action remove. If already absent, do nothing. No other actions.`,
      });
      await until(
        "test rule cleanup",
        async () =>
          (await events(thread)).some(
            (e) =>
              e.type === "TurnCompleted" &&
              e.turn === `plane:automation-cleanup-${suffix}`,
          ) &&
          !(await request("/v1/automations")).rules.some((r: any) =>
            [schedule, listener].includes(r.name),
          ),
        300_000,
      );
      evidence.cleanedUp = true;
      evidence.completedAt = Date.now();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        `${directory}/automations-live.json`,
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
  }
  console.log(JSON.stringify(evidence));
} else if (process.argv.includes("--telegram-check")) {
  const account =
    process.argv.find((x) => x.startsWith("--account="))?.slice(10) ?? "";
  const evidence = await telegramEvidence(account);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    `${directory}/telegram-live.json`,
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      verified: true,
      inboundKinds: evidence.inboundKinds,
      deliveries: evidence.deliveries.length,
    }),
  );
} else if (
  process.argv.includes("--learning") ||
  process.argv.includes("--learning-check")
) {
  const previous = process.argv.includes("--learning-check")
    ? await Bun.file(`${directory}/learning.json`).json()
    : undefined;
  if (previous) {
    assert.equal(previous.url, url);
    assert.equal(previous.owner, owner);
    assert.match(previous.turn, /^plane:cf-native-learning-\d+$/);
  }
  const id = previous
      ? previous.turn.slice(6)
      : `cf-native-learning-${Date.now()}`,
    turn = `plane:${id}`,
    startedAt = previous?.startedAt ?? Date.now(),
    checkedAt = Date.now();
  const evidence: Record<string, any> = {
    verified: false,
    url,
    owner,
    turn,
    startedAt,
    source: "https://dummyjson.com/products/1",
    sampleData: true,
  };
  try {
    const initial = await events(`user-${owner}`);
    const before = previous
      ? initial.findIndex((e) => e.type === "MessageReceived" && e.id === turn)
      : initial.length;
    assert.ok(before >= 0, "Original learning turn is missing");
    if (!previous)
      await request("/v1/messages", {
        id,
        text: "For a read-only browser learning check, navigate to https://dummyjson.com/products/1 and inspect the JSON with get_text or snapshot. Report its sample product title and price. This is public sample data, not a real offer. Do not perform any write or login.",
      });
    while (Date.now() - checkedAt < 8 * 60_000) {
      const history = (await events(`user-${owner}`)).slice(before);
      const prepared = history.filter(
        (e) => e.type === "BrowserNetworkToolPrepared",
      );
      const pending = history.filter(
        (e) =>
          e.type === "AikoBrowserLearningPending" &&
          e.ready === false &&
          e.executable === false,
      );
      const indexer = await events(`background-${owner}-indexer`);
      const dispatched = history.filter((e) => e.type === "AikoHookDispatched");
      const hooks = indexer.filter(
        (e) =>
          e.type === "AikoHookReceived" &&
          e.sourceThread === `user-${owner}` &&
          ["browser-tool", "browser-learning-pending"].includes(
            e.input?.type,
          ) &&
          dispatched.some((d) => d.id === e.id),
      );
      const indexed = indexer.filter(
        (e) =>
          e.type === "AikoLearningIndexed" && hooks.some((h) => h.id === e.id),
      );
      const reflection = await events(`background-${owner}-reflection`);
      const reflected = reflection.filter(
        (e) =>
          e.type === "AikoDecisionRecorded" &&
          indexed.some((i) => i.id === e.id) &&
          indexer.some(
            (i) => i.type === "AikoReflectionDispatched" && i.id === e.id,
          ),
      );
      const unchanged = indexer.filter(
        (e) =>
          e.type === "AikoKnowledgeUnchanged" &&
          indexed.some((i) => i.id === e.id),
      );
      if (
        history.some(
          (e) => e.type === "AikoReplyPrepared" && e.turn === turn,
        ) &&
        (prepared.length || pending.length) &&
        indexed.length &&
        indexed.every(
          (i) =>
            reflected.some((r) => r.id === i.id) ||
            unchanged.some((u) => u.id === i.id),
        )
      ) {
        evidence.verified = true;
        evidence.prepared = prepared.length;
        evidence.pendingObservations = pending.length;
        evidence.learningState = prepared.length
          ? "prepared-draft-not-approved"
          : "pending-observation-not-executable";
        evidence.hooks = hooks.length;
        evidence.indexed = indexed.length;
        evidence.reflections = reflected.length;
        evidence.unchangedRoots = unchanged.length;
        evidence.latencyMs = Date.now() - startedAt;
        evidence.eventTypes = [...new Set(history.map((e) => e.type))];
        evidence.indexedIds = indexed.map((e) => e.id);
        evidence.decisions = reflected.map((e) => ({
          id: e.id,
          decision: e.decision,
          root: e.root,
        }));
        break;
      }
      assert.ok(
        !history.some(
          (e) =>
            ["TurnFailed", "TurnCancelled"].includes(e.type) && e.turn === turn,
        ),
        "Native learning test turn failed/cancelled",
      );
      await Bun.sleep(2000);
    }
    assert.equal(
      evidence.verified,
      true,
      "Native browser evidence did not complete foreground hook, memory indexing and changed-root reflection or unchanged-root suppression",
    );
  } catch (error) {
    evidence.error =
      error instanceof assert.AssertionError
        ? error.message
        : "Live native-learning probe failed";
    if (!previous)
      await request("/v1/cancel", { id: turn }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      `${directory}/learning.json`,
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence));
  }
} else if (process.argv.includes("--probe")) {
  const id =
    process.argv.find((x) => x.startsWith("--id="))?.slice(5) ??
    `cf-live-browser-${Date.now()}`;
  const turn = `plane:${id}`,
    startedAt = Date.now();
  const evidence: Record<string, any> = {
    passed: false,
    url,
    owner,
    turn,
    startedAt,
    trace: `${url}/control`,
  };
  try {
    const status = await request("/v1/status");
    assert.equal(status.mode, "live");
    assert.equal(status.fixtures, false);
    assert.equal(status.toolCallLimit, null);
    assert.equal(status.memory.engine, "entity-learn");
    const text =
      "Find Eatigo Singapore restaurants offering 50% off. Use web_search to discover the site, then open the discovered link with the browser and inspect the live page. Give two restaurant names with dated time slots and the source URL. Do not book or log in. Do not ask me for a URL. If infrastructure is unavailable report the blocker instead of repeating failed calls.";
    await request("/v1/messages", { id, text });
    let history: any[] = [],
      reply: any;
    // This is a test deadline, not a production actor/tool-call budget.
    while (Date.now() - startedAt < 12 * 60_000) {
      history = await events(`user-${owner}`);
      reply = history.find(
        (e) => e.type === "AikoReplyPrepared" && e.turn === turn,
      );
      if (reply) break;
      assert.ok(
        !history.some(
          (e) =>
            ["TurnFailed", "TurnCancelled"].includes(e.type) && e.turn === turn,
        ),
        "Native test turn failed/cancelled",
      );
      await Bun.sleep(1500);
    }
    assert.ok(reply, "No prepared reply by test deadline");
    const own = history.filter((e) => e.turn === turn);
    const searches = own.filter(
      (e) =>
        e.type === "ToolReturned" &&
        e.result?.capability === "web.search" &&
        e.result.entities?.length,
    );
    const reads = own.filter(
      (e) =>
        e.type === "ToolReturned" &&
        e.result?.kind === "browser-receipt" &&
        e.result.status === "completed",
    );
    assert.ok(searches.length, "No successful native query search");
    assert.ok(
      searches.some((e) =>
        e.result.observations?.some((o: any) => /^obs_/.test(o.id)),
      ),
      "No native search citation",
    );
    assert.ok(
      reads.some((e) => e.result.operation === "agent_browser_navigate"),
      "No real browser navigation",
    );
    assert.ok(
      reads.some((e) => /snapshot|get_text/.test(e.result.operation)),
      "No live browser page read",
    );
    const answer = JSON.stringify(reply.result);
    assert.match(answer, /eatigo\.com/);
    assert.match(answer, /50%/);
    assert.match(answer, /\d{1,2}:\d{2}/);
    assert.doesNotMatch(
      answer,
      /paste (?:an? |the )?(?:exact )?URL|can only read exact|can.t browse/i,
    );
    assert.equal(
      (await request("/v1/messages", { id, text })).status,
      "duplicate",
    );
    const forbidden = await fetch(
      `${url}/api/control/events?thread=user-local`,
      { headers: { authorization: `Bearer ${credentials.AIKO_E2E_TOKEN}` } },
    );
    assert.equal(forbidden.status, 403);
    const threads = await request(`/api/control/threads?account=${owner}`);
    assert.equal(threads.foreground, `user-${owner}`);
    assert.equal(threads.background.length, 2);
    evidence.passed = true;
    evidence.reply = reply.result;
    evidence.searchCalls = searches.length;
    evidence.browserReads = reads.map((e) => e.result.operation);
    evidence.modelCalls = own.filter((e) => e.type === "ModelCalled").length;
    evidence.usage = own.filter((e) => e.usage).map((e) => e.usage);
    evidence.latencyMs = Date.now() - startedAt;
    evidence.sandbox = (await request("/v1/status")).sandbox;
  } catch (error) {
    evidence.error =
      error instanceof assert.AssertionError
        ? error.message
        : "Live probe failed; inspect owner-scoped control trace";
    await request("/v1/cancel", { id: turn }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(evidence));
  }
} else {
  assert.ok(process.argv.includes("--contract"), "Use --probe or --contract");
  const evidence = await Bun.file(file).json();
  assert.equal(evidence.passed, true, "Live query/browser witness missing");
  assert.equal(
    evidence.url,
    url,
    "Browser witness belongs to another deployment origin",
  );
  assert.equal(
    evidence.owner,
    owner,
    "Browser witness belongs to another canary owner",
  );
  const learning = await Bun.file(`${directory}/learning.json`).json();
  assert.equal(
    learning.verified,
    true,
    "Native hook/index/reflection witness missing",
  );
  assert.equal(learning.url, url);
  assert.equal(learning.owner, owner);
  assert.ok(
    learning.indexed > 0 &&
      learning.reflections > 0 &&
      learning.unchangedRoots > 0,
    "Changed-root reflection and unchanged-root suppression must both be observed",
  );
  for (const capability of ["speech", "video", "document", "screenshot"]) {
    const processed = await Bun.file(`${directory}/${capability}.json`).json();
    assert.equal(
      processed.verified,
      true,
      `Real ${capability} processing witness missing`,
    );
  }
  const ready = await request("/ready");
  assert.equal(ready.storage, "durable-object");
  const migration = await Bun.file(`${directory}/migration.json`).json();
  assert.equal(migration.verified, true, "History migration not verified");
  assert.equal(
    migration.url,
    url,
    "Migration belongs to another deployment origin",
  );
  assert.ok(
    await Bun.file(`${directory}/telegram-live.json`).exists(),
    "Real Telegram photo/video/voice and outbound-media acceptance is still pending; run --telegram-check --account=TELEGRAM_ID after the authorized test-chat run",
  );
  const media = await Bun.file(`${directory}/telegram-live.json`).json();
  assert.equal(
    media.verified,
    true,
    "Live Telegram media acceptance not verified",
  );
  await telegramEvidence(media.owner);
  const config = await loadConfig(process.env, { readonly: true });
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/getWebhookInfo`,
    { signal: AbortSignal.timeout(15000) },
  );
  assert.ok(response.ok);
  const webhook: any = await response.json();
  assert.equal(webhook.result?.url, `${url}/telegram/webhook`);
  assert.ok(
    !webhook.result?.last_error_date ||
      webhook.result.last_error_date * 1000 < migration.completedAt,
  );
  const local = Bun.spawn(
    ["systemctl", "--user", "is-active", "unlock-aiko.service"],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.notEqual(await local.exited, 0, "Old polling host must not also run");
  console.log(
    JSON.stringify({
      contract: "2ecfd646",
      verified: true,
      trace: `${url}/control`,
      browserTurn: evidence.turn,
    }),
  );
}
