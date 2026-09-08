import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { channelHydrate } from "../src/channel-custody.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import { Self } from "tardie/core/runtime";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  createHostedChannels,
  type ChannelAdapterBindings,
} from "../src/channel-host.ts";
import {
  channelWiringAppendAllowed,
  channelWiringEventKey,
  channelWiringView,
  type ChannelWiringBindings,
} from "../src/channel-wiring.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const handler = { harness: "a".repeat(64), contract: "b".repeat(64) };
const bind = (name: string) => ({
  name,
  schema: "fixture.v1",
  directions: ["inbox", "outbox"],
  authorityRef: "grant",
  operationId: `bind:${name}`,
});
const reference = (p: any) => ({
  channel: p.channel,
  generation: p.generation,
});
const connect = (input: any, output: any, generation = 1) => ({
  name: "fixture",
  generation,
  input: reference(input),
  accepts: "fixture.v1",
  handler,
  output: { ...reference(output), mode: "port" },
  authorityRef: "grant",
  start: "after-registration",
  operationId: `connect:${generation}`,
});
const emit = (p: any, occurrence: string, value = { text: occurrence }) => ({
  port: reference(p),
  schema: "fixture.v1",
  value,
  occurrence,
  correlation: `correlation:${occurrence}`,
  authorityRef: "grant",
});
export async function fixture(
  options: { code?: string; bindings?: Partial<ChannelWiringBindings> } = {},
) {
  const db = new Database(":memory:");
  let alarm: number | null = null;
  const storage: AccountStorage = {
    sql: {
      exec: (q, ...args) => {
        const rows = db.query(q).all(...(args as any[]));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (v) => {
      alarm = v;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  let calls = 0,
    models = 0,
    reconciles = 0;
  const executions: { key: string; input: any; pin: unknown }[] = [];
  const results = new Map<string, any>();
  const bindings: ChannelWiringBindings = {
    blobs: harnessBlobStore(sqliteWorkflowKV(db)),
    authorize: async (owner, authority) =>
      owner === "alice" && authority === "grant",
    resolve: async () => ({
      eligible: true,
      accepts: "fixture.v1",
      emits: "fixture.v1",
      effects: ["pure", "channel.reply"],
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    }),
    execute: async (pin, input, key) => {
      calls++;
      executions.push({ pin, input, key });
      const result = {
        status: "satisfied" as const,
        output: { text: `handled:${(input as any).value.text}` },
        evidence: `receipt:${key}`,
      };
      results.set(key, result);
      return result;
    },
    reconcile: async (_pin, key) => {
      reconciles++;
      return results.get(key) ?? { status: "pending", evidence: "unknown" };
    },
    ...options.bindings,
  };
  const adapters: ChannelAdapterBindings = {
    authorize: async () => false,
    authenticate: async () => undefined,
    artifactAllowed: async () => false,
    execute: async () => {
      throw new Error("No provider execution");
    },
    validateReceipt: async () => false,
  };
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  let hosted: ReturnType<typeof createHostedChannels>;
  const open = async () => {
    hosted = createHostedChannels("alice", () => host, adapters, {
      wiring: bindings,
    });
    const harness = new CodeHarness(
      "alice",
      "user-alice",
      runCodeSegment,
      (s) => s,
    );
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
      react: (request) => {
        models++;
        if (!request.trajectory.some((e) => e.type === "ToolReturned"))
          return Effect.succeed({
            kind: "call" as const,
            name: "execute",
            callId: "create-internal",
            arguments: { code: options.code! },
          });
        return Effect.succeed({
          kind: "complete" as const,
          output: "Created typed hook",
        });
      },
    });
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        hosted.wiring!.component,
        ...(options.code
          ? [infer([codeMode([hosted.wiring!.package]), outputValidateOnce])]
          : []),
      ],
    });
    host = await createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "fixture",
      ownsThread: (t) => t === "user-alice",
      actorFor: () => definition,
      layersFor: () =>
        Layer.merge(
          harness.inference(model),
          hosted.wiring!.sandboxLayer(harness.sandboxLayer()),
        ),
      keyOf: channelWiringEventKey,
      canAppend: (_t, batch, read) => channelWiringAppendAllowed(batch, read),
    });
  };
  await open();
  cleanups.push(async () => {
    await host.close();
    db.close();
  });
  return {
    commitNative: (event: any) =>
      host.commitRoot(host.self("user-alice"), event),
    blobs: bindings.blobs!,
    value: (e: any) => channelHydrate(bindings.blobs, "alice", e.valueRef),
    get api() {
      return hosted.wiring!.api;
    },
    run: (work: any) => hosted.run(work) as Promise<any>,
    read: () => host.read("user-alice"),
    restore: async (rows: readonly import("tardie/core/event").Event[]) => {
      await host.commitRoot(host.self("user-alice"), {
        type: "FixtureStarted",
        id: "restore",
        at: 1,
      });
      await host.seed(
        "user-alice",
        rows.filter((e) => !!channelWiringEventKey(e)),
      );
    },
    drive: async () => {
      await host.recover();
    },
    restart: async () => {
      await host.close();
      await open();
    },
    code: async () => {
      await host.commitRoot(host.self("user-alice"), {
        type: "MessageReceived",
        id: "create",
        text: "Create",
        at: 1,
      });
      await host.drive();
    },
    get calls() {
      return calls;
    },
    get models() {
      return models;
    },
    get reconciles() {
      return reconciles;
    },
    executions,
    get hosted() {
      return hosted;
    },
  };
}
test("native codeMode binds/connects; router handoff executes after VM exit without inference and survives restart", async () => {
  const f = await fixture({
    code: `const input=await channels.bind(${JSON.stringify(bind("input"))}); const output=await channels.bind(${JSON.stringify(bind("output"))}); return await channels.connect({name:'fixture',generation:1,input:{channel:input.channel,generation:1},accepts:'fixture.v1',handler:${JSON.stringify(handler)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:'grant',start:'after-registration',operationId:'connect:1'});`,
  });
  await f.code();
  const before = await f.read();
  expect(
    before.filter((e) => e.type === "AikoChannelWiringBound"),
  ).toHaveLength(2);
  expect(
    before.filter((e) => e.type === "AikoChannelWiringConnected"),
  ).toHaveLength(1);
  expect(before.find((e) => e.type === "TurnCompleted")).toBeDefined();
  const input = [...channelWiringView(before, "alice").ports.values()].find(
    (p) => p.name === "input",
  )!;
  const models = f.models;
  await f.run(f.api.emit(emit(input, "one")));
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(f.models).toBe(models);
  const rows = await f.read();
  expect(rows.find((e) => e.type === "AikoChannelWiringHandoff")).toBeDefined();
  const output = rows.find(
    (e) => e.type === "AikoChannelWiringAccepted" && e.invocation,
  );
  expect(await f.value(output)).toEqual({ text: "handled:one" });
  expect(output?.correlation).toBe(
    await f.blobs.putPrivate("alice", "correlation:one"),
  );
  expect(
    rows.indexOf(rows.find((e) => e.type === "AikoChannelWiringHandoff")!),
  ).toBeLessThan(
    rows.indexOf(rows.find((e) => e.type === "AikoChannelWiringCursor")!),
  );
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(channelWiringView(rows, "alice")).toEqual(
    channelWiringView(await f.read(), "alice"),
  );
});
test("registration races admission atomically; upgrades pin old pending occurrences and explicit bounded backfill", async () => {
  const f = await fixture();
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.emit(emit(input, "history")));
  await Promise.all([
    f.run(f.api.connect(connect(input, output))),
    f.run(f.api.emit(emit(input, "racing"))),
  ]);
  const registration = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringConnected",
  )!;
  await f.run(f.api.emit(emit(input, "future")));
  await f.run(
    f.api.connect({
      ...connect(input, output, 2),
      handler: { ...handler, harness: "c".repeat(64) },
    }),
  );
  await f.run(f.api.emit(emit(input, "new-version")));
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(4 - Number(registration.watermark));
  expect(
    f.executions.find((e) => e.input.value.text === "future")?.pin,
  ).toEqual(handler);
  expect(
    f.executions.find((e) => e.input.value.text === "new-version")?.pin,
  ).toEqual({ ...handler, harness: "c".repeat(64) });
  const backfill = {
    ...connect(input, output),
    name: "history-only",
    start: { from: 1, through: 1, authorityRef: "grant" },
    operationId: "backfill",
  };
  await f.run(f.api.connect(backfill));
  await f.run(f.api.connect(backfill));
  await f.drive();
  expect(
    f.executions.filter((e) => e.input.value.text === "history"),
  ).toHaveLength(1);
  const calls = f.calls;
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(calls);
});
test("scope, schema, bounded backfill and injected reply destinations cannot forge authority", async () => {
  const f = await fixture();
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await expect(
    f.run(f.api.emit({ ...emit(input, "bad"), replyTo: "https://evil" })),
  ).rejects.toThrow("channel_emit_invalid");
  await expect(
    f.run(f.api.emit({ ...emit(input, "bad"), authorityRef: "foreign" })),
  ).rejects.toThrow("channel_capability_denied");
  await expect(
    f.run(
      f.api.connect({
        ...connect(input, output),
        output: { channel: "foreign", generation: 1, mode: "port" },
      }),
    ),
  ).rejects.toThrow("channel_receiving_capability_required");
  await expect(
    f.run(
      f.api.connect({
        ...connect(input, output),
        start: { from: 1, through: 1000, authorityRef: "grant" },
      }),
    ),
  ).rejects.toThrow("channel_backfill_invalid");
  await expect(
    Effect.runPromise(
      f.api.bind(bind("foreign")).pipe(
        Effect.provideService(Self, {
          actor: "aiko",
          instance: "fixture",
          thread: "user-bob",
        }),
      ),
    ),
  ).rejects.toThrow("channel_owner_mismatch");
  const failed = await f.run(
    f.api.connect({ ...connect(input, output), accepts: "wrong.v1" }),
  );
  expect(failed.status).toBe("failed");
  await f.run(f.api.connect({ ...connect(input, output, 2) }));
  await f.run(f.api.emit(emit(input, "invalid", { text: 42 } as any)));
  await f.drive();
  expect(f.calls).toBe(0);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelWiringSettled" &&
        e.reason === "schema_or_chain_limit",
    ),
  ).toBe(true);
});
test("lost dispatch acknowledgement reconciles retained outcome without repeating the effect; duplicate source is one invocation", async () => {
  let sends = 0,
    reconciles = 0;
  const outcomes = new Map<string, any>();
  const f = await fixture({
    bindings: {
      execute: async (_pin, _input, key) => {
        sends++;
        outcomes.set(key, {
          status: "satisfied",
          output: { text: "durable result" },
          evidence: "fixture:retained",
        });
        throw new Error("lost acknowledgement");
      },
      reconcile: async (_pin, key) => {
        reconciles++;
        return outcomes.get(key);
      },
    },
  });
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.connect(connect(input, output)));
  const admissions = await Promise.all([
    f.run(f.api.emit(emit(input, "one"))),
    f.run(f.api.emit(emit(input, "one"))),
  ]);
  expect(admissions[0]).toEqual(admissions[1]);
  await f.drive();
  expect(sends).toBe(1);
  const invocation = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringStarted",
  )!.id;
  expect(
    (await f.read()).find((e) => e.type === "AikoChannelWiringSettled")?.status,
  ).toBe("pending");
  await f.restart();
  await f.drive();
  expect(sends).toBe(1);
  await f.run(
    f.api.reconcile({
      invocation,
      operationId: "inspect",
      authorityRef: "grant",
    }),
  );
  await f.restart();
  await f.drive();
  expect(sends).toBe(1);
  expect(reconciles).toBe(1);
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringAccepted" && e.invocation,
    ),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(sends).toBe(1);
  expect(reconciles).toBe(1);
});
test("bounded uncertain reconciliation records exhaustion and never blindly retries", async () => {
  const f = await fixture({
    bindings: {
      execute: async () => {
        throw new Error("unknown");
      },
    },
  });
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.connect({ ...connect(input, output), maxAttempts: 1 }));
  await f.run(f.api.emit(emit(input, "one")));
  await f.drive();
  const invocation = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringStarted",
  )!.id;
  await f.run(
    f.api.reconcile({
      invocation,
      operationId: "inspect",
      authorityRef: "grant",
    }),
  );
  await f.drive();
  expect(
    (await f.read()).findLast((e) => e.type === "AikoChannelWiringSettled")
      ?.status,
  ).toBe("exhausted");
  await expect(
    f.run(
      f.api.reconcile({
        invocation,
        operationId: "again",
        authorityRef: "grant",
      }),
    ),
  ).rejects.toThrow("channel_retry_exhausted");
});
test("native parked code waiter ignores untrusted/foreign correlation and resumes its continuation once", async () => {
  const f = await fixture({
    code: `const input=await channels.bind(${JSON.stringify(bind("input"))}); const output=await channels.bind(${JSON.stringify(bind("output"))}); await channels.connect({name:'fixture',generation:1,input:{channel:input.channel,generation:1},accepts:'fixture.v1',handler:${JSON.stringify(handler)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:'grant',start:'after-registration',operationId:'connect:1'}); const result=await channels.wait({port:{channel:output.channel,generation:1},handler:${JSON.stringify(handler)},schema:'fixture.v1',correlation:'correlation:match',deadline:${Date.now() + 60000},authorityRef:'grant'}); return await channels.emit({port:{channel:output.channel,generation:1},schema:'fixture.v1',value:{text:'continued'},occurrence:'continuation',correlation:'continued',authorityRef:'grant'});`,
  });
  await f.code();
  expect((await f.read()).some((e) => e.type === "BlockedOn")).toBe(true);
  const ports = [...channelWiringView(await f.read(), "alice").ports.values()];
  const input = ports.find((p) => p.name === "input")!,
    output = ports.find((p) => p.name === "output")!;
  const before = f.models;
  // An authorized source can publish ordinary data but cannot forge a checked terminal result.
  await f.run(
    f.api.emit({ ...emit(output, "forged"), correlation: "correlation:match" }),
  );
  await f.run(f.api.emit(emit(input, "wrong")));
  await f.drive();
  expect(f.models).toBe(before);
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitReady"),
  ).toBe(false);
  await f.restart();
  await f.run(f.api.emit(emit(input, "match")));
  await f.drive();
  const rows = await f.read();
  const continuationRef = await f.blobs.putPrivate("alice", "continuation");
  expect(
    rows.filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
  expect(
    rows.filter(
      (e) =>
        e.type === "AikoChannelWiringAccepted" &&
        e.occurrence === continuationRef,
    ),
  ).toHaveLength(1);
  expect(
    rows.filter(
      (e) => e.type === "MessageReceived" && e.source === "channel-waiter",
    ),
  ).toHaveLength(1);
  expect(rows.filter((e) => e.type === "CodeDispatched")).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(
    (await f.read()).filter(
      (e) =>
        e.type === "AikoChannelWiringAccepted" &&
        e.occurrence === continuationRef,
    ),
  ).toHaveLength(1);
});
test("typed handler uses actual evaluated registry artifact and local sandbox on native handoff", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const {
    HarnessLibrary,
    harnessBlobStore,
    harnessDigest,
    harnessLibraryEventKey,
  } = await import("../src/harness-library.ts");
  const { createHarnessSandboxBinding } =
    await import("../src/harness-sandbox.ts");
  const { localHarnessSandbox } =
    await import("../src/harness-sandbox-local.ts");
  const { sandboxJobJournal } = await import("../src/sandbox-job-journal.ts");
  const { sandboxEnvironment } = await import("../src/sandbox-job-runner.ts");
  const { sqliteWorkflowKV } = await import("../src/workflow-store.ts");
  const { channelHarnessHandlers } = await import("../src/channel-host.ts");
  const directory = await mkdtemp("/tmp/channel-typed-registry-");
  const db = new Database(`${directory}/state.sqlite`);
  cleanups.push(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const runtimeDigest = await sandboxEnvironment("typed-channel-fixture-v1");
  const authority = {
    owner: "alice",
    active: true,
    runtimeDigest,
    contextRef: "fixture",
    authorityRef: "fixture",
    sessionRevision: null,
    effects: ["read" as const],
    origins: [],
    methods: ["GET"],
    budget: { wallMs: 5000, requests: 0, outputBytes: 32768 },
  };
  const sandbox = localHarnessSandbox({
    owner: "alice",
    environmentDigest: runtimeDigest,
    journal: await sandboxJobJournal(db, `${directory}/key`),
  });
  const bridge = createHarnessSandboxBinding({
    owner: "alice",
    thread: "user-alice",
    placement: "local",
    sandbox,
    current: async () => authority,
  });
  const verifier = {
    digest: harnessDigest("typed-verifier"),
    evaluatorDigest: harnessDigest("typed-fixed-cases"),
    cases: [
      {
        id: "dev",
        input: {
          value: { text: "first" },
          schema: "fixture.v1",
          correlation: "dev",
        },
        split: "development" as const,
      },
      {
        id: "held",
        input: {
          value: { text: "second" },
          schema: "fixture.v1",
          correlation: "held",
        },
        split: "held-out" as const,
      },
    ],
    verify: async ({ input, output }: any) => ({
      passed: output.text === `sandbox:${input.value.text}`,
      evidence: ["fixture-equality"],
      quality: 1,
    }),
  };
  const binding = {
    owner: "alice",
    thread: "user-alice",
    blobs: harnessBlobStore(sqliteWorkflowKV(db)),
    verifiers: new Map([[verifier.digest, verifier]]),
    guard: () => {},
    ...bridge,
  };
  const events: import("tardie/core/event").Event[] = [];
  const journal = {
    read: async () => events,
    append: async (batch: typeof events) => {
      for (const e of batch)
        if (
          !events.some(
            (r) => harnessLibraryEventKey(r) === harnessLibraryEventKey(e),
          )
        )
          events.push(e);
    },
  };
  const library = new HarnessLibrary(binding, journal);
  const valueSchema = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const contract = await library.registerContract({
    version: 1,
    outcome: "Transform typed fixture text",
    inputSchema: { type: "object" },
    outputSchema: valueSchema,
    effect: "read",
    verifierDigest: verifier.digest,
    evaluatorDigest: verifier.evaluatorDigest,
    applicability: {
      hook: {
        accepts: "fixture.v1",
        emits: "fixture.v1",
        inputSchema: valueSchema,
        effects: ["pure", "channel.reply"],
      },
    },
    timeoutMs: 5000,
  });
  const code = 'return {text:"sandbox:"+input.value.text};';
  const harness = await library.record({
    version: 1,
    name: "typed-handler",
    description: "Fixture immutable handler",
    runtime: "javascript",
    entrypoint: "main.js",
    files: { "main.js": code },
    dependencies: [],
    sources: [
      {
        uri: "fixture:typed",
        revision: "1",
        digest: harnessDigest(code),
        license: "fixture",
      },
    ],
    contractDigest: contract,
  });
  const handlers = channelHarnessHandlers(
    binding,
    journal,
    async (owner, grant) => owner === "alice" && grant === "grant",
  );
  expect(
    (await handlers.resolve({ harness, contract }, AbortSignal.timeout(5000)))
      .eligible,
  ).toBe(false);
  expect(
    (
      await library.evaluate(
        harness,
        "typed-evaluation",
        AbortSignal.timeout(15000),
      )
    ).eligible,
  ).toBe(true);
  const f = await fixture({ bindings: handlers });
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  expect(
    (
      await f.run(
        f.api.connect({
          ...connect(input, output),
          handler: { harness, contract },
        }),
      )
    ).status,
  ).toBe("active");
  await f.run(f.api.emit(emit(input, "fresh")));
  await f.restart();
  await f.drive();
  expect(
    await f.value(
      (await f.read()).find(
        (e) => e.type === "AikoChannelWiringAccepted" && e.invocation,
      ),
    ),
  ).toEqual({ text: "sandbox:fresh" });
  expect(JSON.stringify(events)).not.toContain("sandbox:fresh");
  expect(JSON.stringify(await f.read())).not.toContain("sandbox:fresh");
  const runs = events.filter((e) => e.type === "AikoHarnessRunStarted").length;
  await f.restart();
  await f.drive();
  expect(events.filter((e) => e.type === "AikoHarnessRunStarted")).toHaveLength(
    runs,
  );
});
test("native recovery from exact handoff and dispatch crash prefixes loses no occurrence or effect", async () => {
  const original = await fixture();
  const input = await original.run(original.api.bind(bind("input"))),
    output = await original.run(original.api.bind(bind("output")));
  await original.run(original.api.connect(connect(input, output)));
  await original.run(original.api.emit(emit(input, "one")));
  await original.drive();
  const rows = await original.read();
  for (const boundary of [
    "AikoChannelWiringHandoff",
    "AikoChannelWiringStarted",
  ]) {
    let reconciles = 0;
    const recovered = await fixture({
      bindings: {
        blobs: original.blobs,
        reconcile: async () => {
          reconciles++;
          return {
            status: "satisfied",
            output: { text: "handled:one" },
            evidence: "retained-before-crash",
          };
        },
      },
    });
    await recovered.restore(
      rows.slice(0, rows.findIndex((e) => e.type === boundary) + 1),
    );
    await recovered.restart();
    await recovered.drive();
    expect(
      (await recovered.read()).filter(
        (e) => e.type === "AikoChannelWiringAccepted" && e.invocation,
      ),
    ).toHaveLength(1);
    expect(recovered.calls).toBe(boundary.endsWith("Started") ? 0 : 1);
    expect(reconciles).toBe(boundary.endsWith("Started") ? 1 : 0);
    await recovered.restart();
    await recovered.drive();
    expect(
      (await recovered.read()).filter(
        (e) => e.type === "AikoChannelWiringCursor",
      ),
    ).toHaveLength(1);
  }
});
test("late checked outcome cannot resume waiter successfully; deadline uses existing host wake", async () => {
  const { channelWiringNextWake } = await import("../src/channel-wiring.ts");
  let now = 100;
  const f = await fixture({
    bindings: { now: () => now },
    code: `const input=await channels.bind(${JSON.stringify(bind("input"))}); const output=await channels.bind(${JSON.stringify(bind("output"))}); await channels.connect({name:'fixture',generation:1,input:{channel:input.channel,generation:1},accepts:'fixture.v1',handler:${JSON.stringify(handler)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:'grant',start:'after-registration',operationId:'connect:1'}); return await channels.wait({port:{channel:output.channel,generation:1},handler:${JSON.stringify(handler)},schema:'fixture.v1',correlation:'correlation:match',deadline:150,authorityRef:'grant'});`,
  });
  await f.code();
  expect(channelWiringNextWake(await f.read(), "alice")).toBe(151);
  const input = [
    ...channelWiringView(await f.read(), "alice").ports.values(),
  ].find((p) => p.name === "input")!;
  now = 151;
  await f.run(f.api.emit(emit(input, "match")));
  await f.restart();
  await f.drive();
  expect(
    (await f.read()).find((e) => e.type === "AikoChannelWiringWaitReady")
      ?.result,
  ).toEqual({ status: "expired" });
  expect(channelWiringNextWake(await f.read(), "alice")).toBeUndefined();
});
test("scope-bound reply chains stop and source bytes/backlog are bounded", async () => {
  const f = await fixture();
  const input = await f.run(
    f.api.bind({ ...bind("loop"), maxBytes: 40, backlog: 3, maxHops: 2 }),
  );
  await f.run(
    f.api.connect({
      ...connect(input, input),
      output: { ...reference(input), mode: "reply-to-accepted-input" },
    }),
  );
  await f.run(f.api.emit(emit(input, "one")));
  await f.drive();
  expect(f.calls).toBe(1);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelWiringSettled" &&
        e.reason === "schema_or_chain_limit",
    ),
  ).toBe(true);
  await expect(
    f.run(f.api.emit(emit(input, "huge", { text: "x".repeat(100) }))),
  ).rejects.toThrow("channel_bytes");
  const bounded = await f.run(f.api.bind({ ...bind("bounded"), backlog: 1 }));
  await f.run(f.api.emit(emit(bounded, "one")));
  await expect(f.run(f.api.emit(emit(bounded, "two")))).rejects.toThrow(
    "channel_backlog",
  );
});

test("native unresolved-claim concurrency is bounded and releasing a claim recovers queued work", async () => {
  let dispatches = 0;
  const f = await fixture({
    bindings: {
      execute: async () => {
        dispatches++;
        throw new Error("uncertain fixture");
      },
    },
  });
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.connect({ ...connect(input, output), maxAttempts: 1 }));
  for (let i = 0; i < 10; i++)
    await f.run(f.api.emit(emit(input, `source-${i}`)));
  await f.drive();
  expect(dispatches).toBe(8);
  const first = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringStarted",
  )!;
  await f.run(
    f.api.reconcile({
      invocation: first.id,
      operationId: "exhaust",
      authorityRef: "grant",
    }),
  );
  await f.restart();
  await f.drive();
  expect(dispatches).toBe(9);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringCursor"),
  ).toHaveLength(9);
});

const requestArgs = (input: any, output: any, occurrence = "request") => ({
  operationId: `request:${occurrence}`,
  send: emit(input, occurrence),
  reply: {
    port: reference(output),
    handler,
    schema: "fixture.v1",
    correlation: `correlation:${occurrence}`,
    deadline: Date.now() + 60000,
    authorityRef: "grant",
  },
});
const requestCode = () =>
  `const input=await channels.bind(${JSON.stringify(bind("input"))}); const output=await channels.bind(${JSON.stringify(bind("output"))}); await channels.connect({name:'fixture',generation:1,input:{channel:input.channel,generation:1},accepts:'fixture.v1',handler:${JSON.stringify(handler)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:'grant',start:'after-registration',operationId:'connect:1'}); const result=await channels.request({operationId:'request',send:{port:{channel:input.channel,generation:1},schema:'fixture.v1',value:{text:'immediate'},occurrence:'request',correlation:'request',authorityRef:'grant'},reply:{port:{channel:output.channel,generation:1},handler:${JSON.stringify(handler)},schema:'fixture.v1',correlation:'request',deadline:${Date.now() + 60000},authorityRef:'grant'}}); return await channels.emit({port:{channel:output.channel,generation:1},schema:'fixture.v1',value:{text:result.value.text},occurrence:'continued-request',correlation:'continued',authorityRef:'grant'});`;

test("atomic request in native codeMode handles immediate output and resumes exactly once across restart", async () => {
  const f = await fixture({ code: requestCode() });
  await f.code();
  const rows = await f.read();
  const waiter = rows.find(
    (e) => e.type === "AikoChannelWiringWaitRegistered",
  )!;
  const source = rows.find((e) => e.id === waiter.source)!;
  expect(rows.indexOf(waiter)).toBeLessThan(rows.indexOf(source));
  expect(source.requestWaiter).toBe(waiter.id);
  expect(f.calls).toBe(1);
  expect(
    rows.filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
  const continued = await f.blobs.putPrivate("alice", "continued-request");
  expect(
    rows.filter(
      (e) =>
        e.type === "AikoChannelWiringAccepted" && e.occurrence === continued,
    ),
  ).toHaveLength(1);
  const models = f.models;
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(f.models).toBe(models);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
});

test("atomic request racing replay admits once; pinned arguments, authority, schemas and fences reject forgery", async () => {
  const f = await fixture();
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.connect(connect(input, output)));
  const args = requestArgs(input, output);
  const call = () =>
    f.run(f.api.request(args, { callId: "request-call" })).catch(String);
  await Promise.all([call(), call()]);
  const rows = await f.read();
  expect(
    rows.filter((e) => e.type === "AikoChannelWiringAccepted"),
  ).toHaveLength(1);
  expect(
    rows.filter((e) => e.type === "AikoChannelWiringWaitRegistered"),
  ).toHaveLength(1);
  await expect(
    f.run(
      f.api.request(
        { ...args, send: { ...args.send, value: { text: "changed" } } },
        { callId: "request-call" },
      ),
    ),
  ).rejects.toThrow("channel_wait_conflict");
  await expect(
    f.run(f.api.request(args, { callId: "other-call" })),
  ).rejects.toThrow("channel_request_conflict");
  for (const invalid of [
    { ...args, send: { ...args.send, authorityRef: "foreign" } },
    { ...args, reply: { ...args.reply, authorityRef: "foreign" } },
    { ...args, reply: { ...args.reply, correlation: "foreign" } },
    {
      ...args,
      reply: {
        ...args.reply,
        port: { channel: "foreign-owner", generation: 1 },
      },
    },
    {
      ...args,
      reply: { ...args.reply, port: { ...args.reply.port, generation: 2 } },
    },
    {
      ...args,
      reply: {
        ...args.reply,
        handler: { ...handler, contract: "c".repeat(64) },
      },
    },
    { ...args, reply: { ...args.reply, deadline: 0 } },
    { ...args, send: { ...args.send, value: { text: 42 } } },
  ]) {
    const unique = crypto.randomUUID();
    await expect(
      f.run(
        f.api.request(
          {
            ...invalid,
            operationId: unique,
            send: { ...invalid.send, occurrence: unique },
          },
          { callId: unique },
        ),
      ),
    ).rejects.toThrow();
  }
  const waiter = rows.find(
      (e) => e.type === "AikoChannelWiringWaitRegistered",
    )!,
    source = rows.find((e) => e.type === "AikoChannelWiringAccepted")!;
  const prior = rows.filter((e) => e !== waiter && e !== source);
  expect(channelWiringAppendAllowed([waiter], () => prior)).toBe(false);
  expect(channelWiringAppendAllowed([source], () => prior)).toBe(false);
  expect(
    channelWiringAppendAllowed(
      [{ ...waiter, invocation: "forged" }, source],
      () => prior,
    ),
  ).toBe(false);
  expect(channelWiringAppendAllowed([waiter, source], () => prior)).toBe(true);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});

test("atomic request cannot consume a different checked invocation with copied correlation", async () => {
  const f = await fixture({
    code: requestCode(),
    bindings: {
      execute: async (_pin, input) =>
        (input as any).value.text === "immediate"
          ? { status: "pending", evidence: "unknown" }
          : {
              status: "satisfied",
              output: { text: "foreign result" },
              evidence: "checked",
            },
    },
  });
  await f.code();
  const input = [
    ...channelWiringView(await f.read(), "alice").ports.values(),
  ].find((p) => p.name === "input")!;
  await f.run(
    f.api.emit({ ...emit(input, "unrelated"), correlation: "request" }),
  );
  await f.restart();
  await f.drive();
  const rows = await f.read();
  expect(
    rows.some(
      (e) => e.type === "AikoChannelWiringSettled" && e.status === "satisfied",
    ),
  ).toBe(true);
  expect(rows.some((e) => e.type === "AikoChannelWiringWaitReady")).toBe(false);
  await f.restart();
  await f.drive();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toBe(false);
});

test("atomic request reconciles an uncertain handler without repeating execution or continuation", async () => {
  let executions = 0,
    reconciliations = 0;
  const f = await fixture({
    code: requestCode(),
    bindings: {
      execute: async () => {
        executions++;
        return { status: "pending", evidence: "ack-lost" };
      },
      reconcile: async () => {
        reconciliations++;
        return {
          status: "satisfied",
          output: { text: "checked retained result" },
          evidence: "retained-check",
        };
      },
    },
  });
  await f.code();
  await f.restart();
  await f.drive();
  expect(executions).toBe(1);
  expect(reconciliations).toBe(0);
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toBe(false);
  const waiter = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringWaitRegistered",
  )!;
  await f.run(
    f.api.reconcile({
      invocation: waiter.invocation,
      operationId: "inspect-request",
      authorityRef: "grant",
    }),
  );
  await f.restart();
  await f.drive();
  expect(executions).toBe(1);
  expect(reconciliations).toBe(1);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(executions).toBe(1);
  expect(reconciliations).toBe(1);
});

test("request admitted before wiring upgrade retains its original invocation generation", async () => {
  const f = await fixture();
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  const old = await f.run(f.api.connect(connect(input, output)));
  const args = requestArgs(input, output);
  await f.run(f.api.request(args, { callId: "upgrade-request" })).catch(String);
  await f.run(f.api.connect(connect(input, output, 2)));
  await f.restart();
  await f.drive();
  const rows = await f.read(),
    waiter = rows.find((e) => e.type === "AikoChannelWiringWaitRegistered")!;
  const claim = rows.find((e) => e.type === "AikoChannelWiringClaimed")!;
  expect(claim.id).toBe(waiter.invocation);
  expect((claim.wire as any).generation).toBe(old.generation);
  expect(f.calls).toBe(1);
});

test("request fails atomically for a historical-only wiring, existing occurrence or foreign native owner", async () => {
  const f = await fixture();
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.emit(emit(input, "history")));
  await f.run(
    f.api.connect({
      ...connect(input, output),
      start: { from: 1, through: 1, authorityRef: "grant" },
    }),
  );
  await expect(
    f.run(f.api.request(requestArgs(input, output), { callId: "historical" })),
  ).rejects.toThrow("channel_request_wiring_scope");
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringWaitRegistered",
    ),
  ).toHaveLength(0);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringAccepted"),
  ).toHaveLength(1);
  await f.run(f.api.connect(connect(input, output, 2)));
  await expect(
    f.run(
      f.api.request(requestArgs(input, output, "history"), {
        callId: "existing",
      }),
    ),
  ).rejects.toThrow("channel_request_source_exists");
  await expect(
    Effect.runPromise(
      f.api.request(requestArgs(input, output), { callId: "foreign" }).pipe(
        Effect.provideService(Self, {
          actor: "aiko",
          thread: "user-bob",
        } as any),
      ),
    ),
  ).rejects.toThrow("channel_owner_mismatch");
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringWaitRegistered",
    ),
  ).toHaveLength(0);
});

test("cancellation racing request authorization prevents both registration and source admission", async () => {
  let cancelAtAuthorization: (() => Promise<void>) | undefined;
  const f = await fixture({
    bindings: {
      authorize: async (_owner, _grant, operation) => {
        if (operation === "emit" && cancelAtAuthorization) {
          const cancel = cancelAtAuthorization;
          cancelAtAuthorization = undefined;
          await cancel();
        }
        return true;
      },
    },
  });
  const input = await f.run(f.api.bind(bind("input"))),
    output = await f.run(f.api.bind(bind("output")));
  await f.run(f.api.connect(connect(input, output)));
  // Trusted fixture records the native call/cancellation while authorization is awaited.
  cancelAtAuthorization = async () => {
    await f.commitNative({
      type: "PackageCalled",
      id: "cancel-race-call",
      callId: "cancel-race",
      turn: "cancel-race",
      epoch: 0,
      at: 1,
    });
    await f.commitNative({
      type: "TurnCancelled",
      id: "cancel-race-cancel",
      turn: "cancel-race",
      epoch: 0,
      at: 2,
    });
  };
  await expect(
    f.run(f.api.request(requestArgs(input, output), { callId: "cancel-race" })),
  ).rejects.toThrow("channel_request_cancelled");
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringWaitRegistered",
    ),
  ).toHaveLength(0);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringAccepted"),
  ).toHaveLength(0);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(0);
});
