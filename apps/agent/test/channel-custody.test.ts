import { retainedChannelManagement, type ChannelManagementBinding, type ChannelManagementGrant } from "../src/channel-registry.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import { createHostedChannels } from "../src/channel-host.ts";
import {
  channelWiringEventKey,
  channelWiringAppendAllowed,
  channelWiringView,
} from "../src/channel-wiring.ts";
import {
  channelHydrate,
  channelSeal,
  type ChannelPrivateRef,
} from "../src/channel-custody.ts";
import { channelDigest } from "../src/channel-bindings.ts";
import {
  harnessBlobStore,
  harnessDigest,
  type HarnessBlobStore,
} from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const pin = { harness: "a".repeat(64), contract: "b".repeat(64) };
const code = (result = "result.value.text") =>
  `const input=await channels.bind({name:'input',schema:'message.v1',directions:['inbox','outbox'],authorityRef:'grant',operationId:'input'}); const output=await channels.bind({name:'output',schema:'message.v1',directions:['inbox','outbox'],authorityRef:'grant',operationId:'output'}); await channels.connect({name:'wire',generation:1,input:{channel:input.channel,generation:1},accepts:'message.v1',handler:${JSON.stringify(pin)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:'grant',start:'after-registration',operationId:'wire'}); const result=await channels.wait({port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'message.v1',correlation:'task',deadline:9999999999999,authorityRef:'grant'}); return ${result};`;
async function fixture(
  options: {
    retainedManagement?: ChannelManagementGrant;
    management?: ChannelManagementBinding;
    toolValue?: string;
    corruptToolScope?: "owner" | "thread" | "callId" | "tool" | "definitionDigest";
    failToolRetention?: boolean;
    eraseOutput?: boolean;
    code?: string;
    pauseAt?: "admission" | "handoff";
    now?: () => number;
  } = {},
) {
  const directory = await mkdtemp("/tmp/channel-custody-");
  let db = new Database(`${directory}/native.sqlite`),
    blobs!: HarnessBlobStore;
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>,
    hosted!: ReturnType<typeof createHostedChannels>;
  let toolCalls = 0;
  let calls = 0,
    reconciles = 0,
    allowed = true,
    returned: unknown,
    paused = !!options.pauseAt;
  const storage: AccountStorage = {
    sql: {
      exec: (q, ...args) => {
        const rows = db.query(q).all(...(args as any[]));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const erase = (r: any) =>
    db
      .query("DELETE FROM workflow_records WHERE key=?")
      .run(`harness-blobs:${harnessDigest("alice")}:${r.ref}`);
  const open = async () => {
    const base = harnessBlobStore(sqliteWorkflowKV(db));
    blobs = {
      ...base,
      get: async (owner, ref) => {
        const value = await base.get(owner,ref) as any;
        return options.corruptToolScope && value?.kind === "aiko-code-retained.v1"
          ? {...value,[options.corruptToolScope]:"foreign"} : value;
      },
      putPrivate: async (owner, value) => {
        if (options.failToolRetention && (value as any)?.kind === "aiko-code-retained.v1") throw Error("fixture storage failure");
        const ref = await base.putPrivate(owner, value);
        if (
          options.eraseOutput &&
          typeof (value as any)?.text === "string" &&
          (value as any).text.startsWith("output:")
        )
          erase({ ref });
        return ref;
      },
    };
    hosted = createHostedChannels("alice", () => host, undefined, {
      wiring: {
        blobs,
        now: options.now,
        authorize: async (owner, grant) =>
          allowed && owner === "alice" && grant === "grant",
        resolve: async () => ({
          eligible: true,
          accepts: "message.v1",
          emits: "message.v1",
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
          effects: ["pure"],
        }),
        execute: async (_pin, input) => {
          calls++;
          return {
            status: "satisfied",
            output: { text: `output:${(input as any).value.text}` },
            evidence: `checked-private:${(input as any).value.text}`,
          };
        },
        reconcile: async () => { reconciles++; return { status: "pending", evidence: "missing_checked_bytes" }; },
      },
    });
    const durableManagement = options.retainedManagement ? retainedChannelManagement(hosted.journal,blobs,async owner => allowed && owner === "alice") : undefined;
    const harness = new CodeHarness(
      "alice",
      "user-alice",
      runCodeSegment,
      (s) => s,
      undefined,
      {blobs, authorize: async scope => allowed && scope.owner === "alice" && scope.thread === "user-alice"},
    );
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "private" } }),
      react: (request) => {
        const answer = request.trajectory.find(
          (e) => e.type === "ToolReturned",
        );
        if (!answer)
          return Effect.succeed({
            kind: "call" as const,
            name: "execute",
            callId: "create-private",
            arguments: { code: options.code ?? code() },
          });
        returned = answer.result;
        return Effect.succeed({
          kind: "complete" as const,
          output: "Private continuation checked",
        });
      },
    });
    const native = hosted.wiring!.component;
    const controlled = {
      ...native,
      machine: {
        ...native.machine,
        output: (state: any) => {
          const output = native.machine.output(state);
          return paused
            ? {
                ...output,
                transitions:
                  options.pauseAt === "admission"
                    ? []
                    : output.transitions.filter(
                        (t) =>
                          !String(t.key).startsWith(
                            "aiko-channel-wiring:dispatch:",
                          ),
                      ),
              }
            : output;
        },
      },
    };
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        controlled,
        infer([codeMode([harness.package([{spec:{name:"fixture_private",description:"Private fixture",inputSchema:{type:"object"}},run:()=>Effect.sync(()=>{toolCalls++;return {text:options.toolValue};})}]),hosted.wiring!.package]), outputValidateOnce]),
      ],
    });
    host = await createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "custody",
      ownsThread: (t) => t === "user-alice",
      actorFor: () => definition,
      layersFor: () =>
        Layer.merge(
          harness.inference(model),
          hosted.wiring!.sandboxLayer(harness.sandboxLayer(), durableManagement ?? options.management),
        ),
      keyOf: channelWiringEventKey,
      canAppend: (_t, batch, read) => channelWiringAppendAllowed(batch, read),
    });
  };
  await open();
  closes.push(async () => {
    await host.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get toolCalls() { return toolCalls; },
    resume: () => {
      paused = false;
    },
    start: async () => {
      await host.commitRoot(host.self("user-alice"), {
        type: "MessageReceived",
        id: "create",
        text: "Create private channel",
        at: 1,
      });
      const grant = options.retainedManagement ?? await options.management?.resolve("alice", "create-private");
      if (grant?.owner === "alice" && grant.execution === "create-private")
        await retainedChannelManagement(hosted.journal,blobs,async()=>true).grant(grant);
      await host.drive();
    },
    emit: async (text: string) => {
      const p = [
        ...channelWiringView(
          await host.read("user-alice"),
          "alice",
        ).ports.values(),
      ].find((p) => p.name === "input")!;
      return hosted.run(
        hosted.wiring!.api.emit({
          port: { channel: p.channel, generation: 1 },
          schema: "message.v1",
          value: { text },
          occurrence: "one",
          correlation: "task",
          authorityRef: "grant",
        }),
      );
    },
    read: () => host.read("user-alice"),
    drive: () => host.recover(),
    erase,
    disk: () => db.serialize().toString("utf8"),
    get blobs() {
      return blobs;
    },
    get returned() {
      return returned;
    },
    get calls() {
      return calls;
    },
    get reconciles() { return reconciles; },
    markStarted: (id: string) => host.commitRoot(host.self("user-alice"), { type: "AikoChannelWiringStarted", owner: "alice", id, handler: pin, at: 2 }),
    deny: () => {
      allowed = false;
    },
    cancel: () =>
      host.commitRoot(host.self("user-alice"), {
        type: "TurnCancelled",
        turn: "create",
        epoch: 0,
        at: 2,
      }),
    restart: async () => {
      await host.close();
      db.close();
      db = new Database(`${directory}/native.sqlite`);
      await open();
    },
  };
}
test("native codeMode traces and SQLite contain only sealed refs across handler/waiter restart", async () => {
  const f = await fixture();
  const secret = `custody-private-${crypto.randomUUID()}@private.invalid`;
  await f.start();
  await f.emit(secret);
  const source = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringAccepted",
  )!;
  expect(source.value).toBeUndefined();
  expect(source.valueRef).toBeDefined();
  expect((source.valueRef as ChannelPrivateRef).ref).not.toBe(
    harnessDigest({ text: secret }),
  );
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(JSON.stringify(f.returned)).toContain(`output:${secret}`);
  const trace = JSON.stringify(await f.read());
  for (const marker of [
    secret,
    channelDigest({ text: secret }),
    channelDigest(`output:${secret}`),
  ]) {
    expect(trace).not.toContain(marker);
    expect(f.disk()).not.toContain(marker);
  }
  for (const event of (await f.read()).filter((e) =>
    ["AikoChannelWiringAccepted", "AikoChannelWiringClaimed"].includes(e.type),
  )) {
    expect(event.value).toBeUndefined();
    expect(event.valueRef).toBeDefined();
  }
  const ready = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringWaitReady",
  )!;
  expect((ready.result as any).value).toBeUndefined();
  expect((ready.result as any).valueRef).toBeDefined();
  expect(
    (await f.read())
      .filter((e) => e.type === "PackageCalled")
      .every((e) => (e.arguments as any)?.privateInput),
  ).toBe(true);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});
test("deleted admitted input is unavailable before invocation and never reconstructed", async () => {
  const f = await fixture();
  await f.start();
  await f.emit("deleted-private-input");
  f.erase(
    (await f.read()).find((e) => e.type === "AikoChannelWiringAccepted")!
      .valueRef,
  );
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(0);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelWiringSettled" &&
        e.reason === "input_unavailable",
    ),
  ).toBe(true);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(0);
});
test("deleted checked output wakes unavailable without repeating the handler", async () => {
  const f = await fixture({ eraseOutput: true, code: code("result.status") });
  await f.start();
  await f.emit("private-output-missing");
  await f.drive();
  expect(f.calls).toBe(1);
  expect(JSON.stringify(f.returned)).toContain("unavailable");
  expect(JSON.stringify(await f.read())).not.toContain(
    "private-output-missing",
  );
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});
test("private ref ownership and revoked receiving authority fail closed", async () => {
  const f = await fixture();
  const ref = await channelSeal(f.blobs, "alice", {
    text: "private-owner-data",
  });
  await expect(channelHydrate(f.blobs, "bob", ref)).rejects.toThrow(
    "channel_custody_unavailable",
  );
  await expect(
    channelHydrate(f.blobs, "bob", { ...ref, owner: "bob" }),
  ).rejects.toThrow("channel_custody_unavailable");
  const foreign = await channelSeal(f.blobs, "bob", {
    text: "private-owner-data",
  });
  expect(foreign.ref).not.toBe(ref.ref);
  await f.start();
  await f.emit("private-revoked-data");
  f.deny();
  await f.drive();
  expect(f.calls).toBe(0);
});
test("native cancellation prevents parked private continuation and wake delivery", async () => {
  const f = await fixture();
  await f.start();
  await f.cancel();
  await f.drive();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitCancelled"),
  ).toBe(true);
  await f.emit("private-cancelled-data");
  await f.drive();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toBe(false);
  expect(JSON.stringify(await f.read())).not.toContain(
    "private-cancelled-data",
  );
});
test("deleted retained package result aborts VM replay without repeating channel operations", async () => {
  const f = await fixture();
  await f.start();
  const result = (await f.read()).find((e) => e.type === "PackageReturned")!;
  f.erase((result.result as any).privateResult);
  await f.emit("private-vm-result-loss");
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringBound"),
  ).toHaveLength(2);
  expect(JSON.stringify(await f.read())).not.toContain(
    "private-vm-result-loss",
  );
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});

function atomicCode(
  secret: string,
  result = "result.value.text",
  deadline = 9999999999999,
) {
  const wait = `channels.wait({port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'message.v1',correlation:'task',deadline:9999999999999,authorityRef:'grant'})`;
  // Construct private fixture data inside the VM, so it is not a literal in retained code.
  const value = `String.fromCharCode(${[...secret].map((c) => c.charCodeAt(0)).join(",")})`;
  return code(result).replace(
    wait,
    `channels.request({operationId:'atomic-private',send:{port:{channel:input.channel,generation:1},schema:'message.v1',value:{text:${value}},occurrence:'atomic-private-source',correlation:'task',authorityRef:'grant'},reply:{port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'message.v1',correlation:'task',deadline:${deadline},authorityRef:'grant'}})`,
  );
}
for (const pauseAt of ["admission", "handoff"] as const) {
  test(`atomic request resumes native code after SQLite restart at ${pauseAt}, with sealed traces`, async () => {
    const secret = `atomic-private-${crypto.randomUUID()}`;
    const f = await fixture({ code: atomicCode(secret), pauseAt });
    await f.start();
    const rows = await f.read();
    expect(rows.some((e) => e.type === "BlockedOn")).toBe(true);
    expect(
      rows.filter((e) => e.type === "AikoChannelWiringWaitRegistered"),
    ).toHaveLength(1);
    expect(
      rows.filter((e) => e.type === "AikoChannelWiringAccepted"),
    ).toHaveLength(1);
    expect(rows.some((e) => e.type === "AikoChannelWiringHandoff")).toBe(
      pauseAt === "handoff",
    );
    expect(f.calls).toBe(0);
    await f.restart();
    f.resume();
    await f.drive();
    expect(f.calls).toBe(1);
    expect(JSON.stringify(f.returned)).toContain(`output:${secret}`);
    const complete = await f.read();
    expect(
      complete.filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
    ).toHaveLength(1);
    for (const marker of [
      secret,
      channelDigest({ text: secret }),
      channelDigest(`output:${secret}`),
    ]) {
      expect(JSON.stringify(complete)).not.toContain(marker);
      expect(f.disk()).not.toContain(marker);
    }
    expect(
      complete
        .filter((e) => e.type === "PackageCalled")
        .every((e) => (e.arguments as any)?.privateInput),
    ).toBe(true);
    await f.restart();
    await f.drive();
    expect(f.calls).toBe(1);
    expect(
      (await f.read()).filter(
        (e) => e.type === "AikoChannelWiringWaitDelivered",
      ),
    ).toHaveLength(1);
  });
}

test("atomic request cancellation after admission never resumes the cancelled continuation", async () => {
  const f = await fixture({
    code: atomicCode("cancel-private"),
    pauseAt: "admission",
  });
  await f.start();
  await f.cancel();
  await f.restart();
  f.resume();
  await f.drive();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitCancelled"),
  ).toBe(true);
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toBe(false);
  await f.restart();
  await f.drive();
  expect(f.calls).toBeLessThanOrEqual(1);
});

test("atomic request deadline excludes late results and resumes expired once after restart", async () => {
  let clock = 100;
  const f = await fixture({
    code: atomicCode("late-private", "result.status", 150),
    pauseAt: "admission",
    now: () => clock,
  });
  await f.start();
  clock = 200;
  await f.restart();
  f.resume();
  await f.drive();
  expect(JSON.stringify(f.returned)).toContain("expired");
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});

for (const boundary of ["admission", "handoff"] as const) test(`atomic request missing source bytes at ${boundary} become unavailable without execution`, async () => {
  const f = await fixture({
    code: atomicCode("deleted-atomic-private"),
    pauseAt: boundary,
  });
  await f.start();
  const source = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringAccepted",
  )!;
  f.erase(source.valueRef);
  await f.restart();
  f.resume();
  await f.drive();
  expect(f.calls).toBe(0);
  if (boundary === "handoff") {
    expect((await f.read()).filter(e => e.type === "AikoChannelWiringStarted")).toHaveLength(0);
    expect((await f.read()).some(e => e.type === "AikoChannelWiringSettled" && e.status === "unavailable")).toBe(true);
    expect((await f.read()).some(e => e.type === "AikoChannelWiringWaitReady" && (e.result as any).status === "unavailable")).toBe(true);
  }
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelWiringSettled" &&
        e.reason === "input_unavailable",
    ),
  ).toBe(true);
  await expect(
    channelHydrate(f.blobs, "alice", source.valueRef),
  ).rejects.toThrow("channel_custody_unavailable");
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(0);
});

test("atomic request missing checked output returns unavailable without rerunning the handler", async () => {
  const f = await fixture({
    code: atomicCode("deleted-atomic-output", "result.status"),
    eraseOutput: true,
  });
  await f.start();
  expect(f.calls).toBe(1);
  expect(JSON.stringify(f.returned)).toContain("unavailable");
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});

test("atomic request lost private package arguments cannot replay admission or handler execution", async () => {
  const f = await fixture({
    code: atomicCode("lost-package-args"),
    pauseAt: "admission",
  });
  await f.start();
  const calls = (await f.read()).filter((e) => e.type === "PackageCalled");
  for (const call of calls) {
    const ref = (call.arguments as any).privateInput;
    const args = await channelHydrate(f.blobs, "alice", ref);
    if (args.operationId === "atomic-private") f.erase(ref);
  }
  await f.restart();
  f.resume();
  await f.drive();
  expect(f.calls).toBe(1);
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringWaitRegistered",
    ),
  ).toHaveLength(1);
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoChannelWiringAccepted" && e.requestWaiter,
    ),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(1);
});

test("atomic request admitted under a revoked grant cannot execute after restart", async () => {
  const f = await fixture({
    code: atomicCode("revoked-request"),
    pauseAt: "admission",
  });
  await f.start();
  f.deny();
  await f.restart();
  f.resume();
  await f.drive();
  expect(f.calls).toBe(0);
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toBe(false);
});

test("private native continuation feeds request without placing external secret in code or traces", async () => {
  const continuation = `const next=await channels.request({operationId:'private-chain',send:{port:{channel:input.channel,generation:1},schema:'message.v1',value:result.value,occurrence:'private-chain-source',correlation:'private-chain',authorityRef:'grant'},reply:{port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'message.v1',correlation:'private-chain',deadline:9999999999999,authorityRef:'grant'}}); return next.value.text`;
  const f = await fixture({
    code: code().replace("return result.value.text", continuation),
  });
  const secret = `external-private-request-${crypto.randomUUID()}`;
  await f.start();
  await f.emit(secret);
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(2);
  expect(JSON.stringify(f.returned)).toContain(`output:output:${secret}`);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringWaitDelivered"),
  ).toHaveLength(2);
  for (const marker of [secret, channelDigest({ text: `output:${secret}` })]) {
    expect(JSON.stringify(await f.read())).not.toContain(marker);
    expect(f.disk()).not.toContain(marker);
  }
  await f.restart();
  await f.drive();
  expect(f.calls).toBe(2);
});


test("missing input after a retained Started claim reconciles once and never guesses that the effect did not happen", async () => {
  const f = await fixture({ code: atomicCode("missing-after-started", "result.status"), pauseAt: "handoff" });
  await f.start();
  const claim = (await f.read()).find(e => e.type === "AikoChannelWiringClaimed")!;
  await f.markStarted(String(claim.id));
  f.erase(claim.valueRef);
  await f.restart(); f.resume(); await f.drive();
  expect(f.calls).toBe(0); expect(f.reconciles).toBe(1);
  expect((await f.read()).some(e => e.type === "AikoChannelWiringSettled" && e.status === "pending")).toBe(true);
  expect((await f.read()).some(e => e.type === "AikoChannelWiringWaitReady")).toBe(false);
  await f.restart(); await f.drive();
  expect(f.calls).toBe(0); expect(f.reconciles).toBe(1);
});

for (const boundary of ["restart", "missing", "revoked"] as const) test(`retained tools.call custody across native channel park: ${boundary}`, async () => {
  const secret = `tool-private-${crypto.randomUUID()}`;
  // Deliberately use non-canonical nested key order; private custody sorts keys.
  const f = await fixture({toolValue:secret, code:`const privateRow=await tools.call({name:'fixture_private',arguments:{z:2,a:{second:2,first:1}}}); ${code("privateRow.text + result.value.text")}`});
  await f.start();
  const receipt = (await f.read()).find(e => e.type === "AikoCodeToolSettled")!;
  expect((receipt.result as any).kind).toBe("aiko-code-retained.v1");
  expect(f.toolCalls).toBe(1);
  await f.emit("wake");
  if (boundary === "missing") f.erase(receipt.result);
  if (boundary === "revoked") f.deny();
  await f.restart(); await f.drive();
  expect(f.toolCalls).toBe(1);
  if (boundary === "restart") expect(JSON.stringify(f.returned)).toContain(secret);
  if (boundary === "missing") expect(JSON.stringify(await f.read())).toContain("Private tool result unavailable");
  if (boundary !== "restart") expect(JSON.stringify(f.returned ?? null)).not.toContain(secret);
  expect(JSON.stringify(await f.read())).not.toContain(secret);
  expect(f.disk()).not.toContain(secret);
  await f.restart(); await f.drive(); expect(f.toolCalls).toBe(1);
});

for (const field of ["owner","thread","callId","tool","definitionDigest"] as const) test(`native code rejects retained tool envelope with foreign ${field}`, async () => {
  const secret = `forged-private-${crypto.randomUUID()}`;
  const f = await fixture({toolValue:secret,corruptToolScope:field,code:"return await tools.call({name:'fixture_private',arguments:{}});"});
  await f.start();
  expect(f.toolCalls).toBe(1);
  expect(JSON.stringify(f.returned)).toContain("Private tool result unavailable");
  expect(JSON.stringify(await f.read())).not.toContain(secret);
  await f.restart(); await f.drive(); expect(f.toolCalls).toBe(1);
});
test("failed private tool retention settles unavailable and never repeats completed tool", async () => {
  const f = await fixture({toolValue:"unretained-private",failToolRetention:true,code:"return await tools.call({name:'fixture_private',arguments:{}});"});
  await f.start();
  expect(f.toolCalls).toBe(1);
  const receipt = (await f.read()).find(e=>e.type === "AikoCodeToolSettled")!;
  expect(receipt.succeeded).toBe(false);
  expect(receipt.result).toMatchObject({status:"unavailable"});
  expect(JSON.stringify(await f.read())).not.toContain("unretained-private");
  await f.restart(); await f.drive(); expect(f.toolCalls).toBe(1);
});

const childGrant = (): ChannelManagementGrant => ({owner:"alice",execution:"create-private",parentOperation:"retained-parent-1",revision:"v1",authorityRef:"grant",depth:0,maxDepth:2,maxCalls:8,maxBytes:1024,backlog:8,maxHops:2,deadline:Date.now()+60000,handlers:[pin],methods:["bind","connect","emit","request","wait"]});
const childCode = `const input=await channels.bind({schema:'message.v1',directions:['inbox','outbox']}); const output=await channels.bind({schema:'message.v1',directions:['inbox','outbox']}); await channels.connect({generation:1,input:{channel:input.channel,generation:1},accepts:'message.v1',handler:${JSON.stringify(pin)},output:{channel:output.channel,generation:1,mode:'port'},start:'after-registration'}); const result=await channels.request({send:{port:{channel:input.channel,generation:1},schema:'message.v1',value:{text:'child-private'},correlation:'child'},reply:{port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'message.v1',correlation:'child',deadline:input.deadline ?? DEADLINE}}); return result.value.text;`;
test("scoped sandbox child ports connect and request resumes across native SQLite handoff restart", async () => {
  const grant=childGrant();
  const f=await fixture({code:childCode.replace("DEADLINE",String(grant.deadline)),retainedManagement:grant,pauseAt:"handoff"});
  await f.start();
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(2);
  expect(f.calls).toBe(0);
  await f.restart(); f.resume(); await f.drive();
  expect(JSON.stringify(f.returned)).toContain("output:child-private"); expect(f.calls).toBe(1);
  await f.restart(); await f.drive(); expect(f.calls).toBe(1);
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(2);
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringWaitDelivered")).toHaveLength(1);
  expect(JSON.stringify(await f.read())).not.toContain('"value":{"text":"child-private"}');
});
for(const failure of ["owner","depth","methods","authority"] as const) test(`scoped child bridge denies ${failure} before port admission`,async()=>{
  const grant=childGrant();
  if(failure === "owner")grant.owner="foreign";
  if(failure === "depth")grant.depth=grant.maxDepth;
  if(failure === "methods")grant.methods=[];
  const f=await fixture({management:{resolve:async()=>grant},code:`return await channels.bind({schema:'message.v1',directions:['inbox']${failure === "authority" ? ",authorityRef:'forged'" : ""}});`});
  await f.start(); expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(0);
  expect(JSON.stringify(f.returned)).toContain("channel_management_denied"); expect(f.calls).toBe(0);
});

test("child sandbox call budget is ordinal-bound and foreign port emission cannot widen scope",async()=>{
  const grant=childGrant();grant.maxCalls=1;
  const f=await fixture({management:{resolve:async()=>grant},code:"await channels.bind({schema:'message.v1',directions:['inbox']}); return await channels.bind({schema:'message.v1',directions:['inbox']});"});
  await f.start();expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(1);
  expect(JSON.stringify(f.returned)).toContain("channel_management_denied");
  await f.restart();await f.drive();expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(1);
  const other=await fixture({management:{resolve:async()=>childGrant()},code:"return await channels.emit({port:{channel:'foreign',generation:1},schema:'message.v1',value:{text:'private'},correlation:'x'});"});
  await other.start();expect((await other.read()).filter(e=>e.type === "AikoChannelWiringAccepted")).toHaveLength(0);
  expect(JSON.stringify(other.returned)).toContain("channel_management_denied");
});
test("revoked child grant stops hydration and resume after retained handoff",async()=>{
  const grant=childGrant();let revoked=false;
  const f=await fixture({code:childCode.replace("DEADLINE",String(grant.deadline)),management:{resolve:async()=>revoked?undefined:grant},pauseAt:"handoff"});
  await f.start();revoked=true;await f.restart();f.resume();await f.drive();
  expect(JSON.stringify(f.returned)).toContain("channel_management_denied");
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(2);
  await f.restart();await f.drive();expect(f.calls).toBe(1);
});

test("deleted retained management grant cannot be reconstructed by sandbox replay",async()=>{
  const grant=childGrant();
  const f=await fixture({retainedManagement:grant,code:childCode.replace("DEADLINE",String(grant.deadline)),pauseAt:"handoff"});
  await f.start();const row=(await f.read()).find(e=>e.type === "AikoChannelWiringManagementGranted")!;
  f.erase({ref:row.grantRef});await f.restart();f.resume();await f.drive();
  expect(JSON.stringify(f.returned)).toContain("channel_management_denied");
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringBound")).toHaveLength(2);
  expect((await f.read()).filter(e=>e.type === "AikoChannelWiringManagementGranted")).toHaveLength(1);
  await f.restart();await f.drive();expect(f.calls).toBe(1);
});
