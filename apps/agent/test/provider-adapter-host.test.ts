import {
  productionWorker,
  durableStorage,
} from "./registry-worker-host.test.ts";
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import {
  harnessDigest,
  type HarnessContract,
  type HarnessVerifier,
} from "../src/harness-library.ts";
import { type ProviderAdapterPolicy } from "../src/provider-adapter.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
const hmac = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");
const keys = {
  receive: "controlled-receive-secret-123456789",
  receipt: "controlled-receipt-secret-123456789",
  request: "controlled-request-secret-123456789",
};
const text = "PRIVATE_PROVIDER_MESSAGE_79326";
function definition() {
  const check = (input: any) =>
    input.operation === "decode"
      ? {
          kind: "external",
          schemaVersion: "provider.text.v1",
          text: JSON.parse(input.input.body).message,
        }
      : { payload: input.input };
  const verifier: HarnessVerifier = {
    digest: harnessDigest("provider-planner-independent-v1"),
    evaluatorDigest: harnessDigest("provider-planner-cases-v1"),
    cases: [
      {
        id: "decode",
        split: "development",
        input: {
          operation: "decode",
          input: { body: JSON.stringify({ message: "hello" }) },
          binding: {},
        },
      },
      {
        id: "poll-plan",
        split: "development",
        input: {
          operation: "poll",
          input: { partition: "provider", cursor: null, limit: 8 },
          binding: {},
        },
      },
      {
        id: "renew-plan",
        split: "held-out",
        input: {
          operation: "renew",
          input: { kind: "subscription", operationId: "original-key" },
          binding: {},
        },
      },
      {
        id: "send",
        split: "held-out",
        input: {
          operation: "send",
          input: { payload: "boundary", replyTo: "original" },
          binding: {},
        },
      },
    ],
    verify: async ({ input, output }) => {
      const passed = harnessDigest(check(input)) === harnessDigest(output);
      return {
        passed,
        quality: passed ? 1 : 0,
        evidence: ["fixed-provider-planner-exact"],
      };
    },
  };
  const contract: HarnessContract = {
    version: 1,
    outcome:
      "Decode message field only; preserve exact operation input as payload. Cannot create provider receipt facts.",
    effect: "read",
    verifierDigest: verifier.digest,
    evaluatorDigest: verifier.evaluatorDigest,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    applicability: {
      channel: {
        directions: ["inbox", "outbox"],
        operations: [
          "decode",
          "subscribe",
          "send",
          "remove",
          "reconcile",
          "poll",
          "renew",
        ],
      },
    },
    timeoutMs: 3000,
  };
  return {
    contract,
    verifier,
    artifact: {
      version: 1 as const,
      name: "provider.generated",
      description: "Generated JSON message adapter",
      runtime: "javascript" as const,
      entrypoint: "adapter.js",
      files: {
        "adapter.js":
          'if(input.operation==="decode")return {kind:"external",schemaVersion:"provider.text.v1",text:JSON.parse(input.input.body).message};return {payload:input.input};',
      },
      dependencies: [],
      sources: [],
      contractDigest: harnessDigest(contract),
    },
  };
}
export async function fixture(worker = false, pollOnly = false, controls: {lease?:boolean} | undefined = undefined) {
  const dir = await mkdtemp("/tmp/provider-actual-host-"),
    db = new Database(join(dir, "jobs.sqlite"));
  const token = "owner-provider-token-1234567890123456";
  let service: Awaited<ReturnType<typeof createService>>,
    policy: ProviderAdapterPolicy,
    program = "",
    models = 0,
    earlyStatus = 0,
    lost = "",
    tamper = false,
    workerProgramDispatched = false,
    workerCallId = "provider-compose";
  let beforeJob:
    ((job: any, signal?: AbortSignal) => Promise<void>) | undefined;
  let pollCut: Uint8Array | undefined, bindingCut: Uint8Array | undefined;
  let beforeResponse: ((operation: string) => Promise<void>) | undefined;
  let pollItems: any[] = [],
    pollGap = false;
  const requests: any[] = [],
    jobs: any[] = [],
    subscriptions = new Map<string, any>(),
    outputs = new Map<string, any>();
  const ingress = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => service.fetch(req),
  });
  const emit = async (
    subscription: any,
    occurrence: string,
    value = text,
    signature = true,
  ) => {
    const body = JSON.stringify({ message: value }),
      conversation = "controlled-conversation";
    return fetch(subscription.webhook, {
      method: "POST",
      headers: {
        "x-channel-receive-capability": subscription.receiveCapability,
        "x-provider-occurrence": occurrence,
        "x-provider-conversation": conversation,
        "x-provider-signature": signature
          ? hmac(
              keys.receive,
              JSON.stringify([
                "123",
                policy.account,
                subscription.channel,
                subscription.generation,
                occurrence,
                conversation,
                body,
              ]),
            )
          : "invalid",
      },
      body,
    });
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const envelope =
        req.method === "GET"
          ? JSON.parse(new URL(req.url).searchParams.get("request")!)
          : ((await req.json()) as any);
      const value = envelope.request;
      expect(envelope.proof).toBe(hmac(keys.request, harnessDigest(value)));
      requests.push(value);
      let status: string,
        providerId: string | undefined,
        subscriptionRef: string | undefined;
      if (value.operation === "subscribe") {
        expect(subscriptions.has(value.key)).toBe(false);
        subscriptions.set(value.key, value);
        earlyStatus = (await emit(value, "early-occurrence")).status;
        status = "ready";
        subscriptionRef = "remote-subscription-1";
      } else if (value.operation === "poll") {
        expect(req.method).toBe("GET");
        expect(value.payload.partition).toBe(policy.account);
        status = pollGap ? "gap" : "polled";
      } else if (value.operation === "renew") {
        expect(subscriptions.has(value.subscriptionKey)).toBe(true);
        status = "renewed";
        subscriptionRef = "remote-subscription-1";
      } else if (value.operation === "send") {
        expect(outputs.has(value.key)).toBe(false);
        outputs.set(value.key, value);
        status = "accepted_by_provider";
        providerId = "remote-message-" + outputs.size;
      } else if (value.operation === "remove") {
        subscriptions.clear();
        status = "removed";
        subscriptionRef = "remote-subscription-1";
      } else {
        if (value.payload.kind === "subscription") {
          expect(
            requests.some(
              (previous) =>
                previous.key === value.payload.operationId &&
                ["subscribe", "remove", "renew"].includes(previous.operation),
            ),
          ).toBe(true);
          status =
            value.payload.originalOperation === "renew"
              ? "renewed"
              : subscriptions.has(value.subscriptionKey)
                ? "ready"
                : "removed";
          subscriptionRef = "remote-subscription-1";
        } else {
          expect(outputs.has(value.payload.operationId)).toBe(true);
          status = "delivered";
          providerId = "remote-message-1";
        }
      }
      await beforeResponse?.(value.operation);
      const receipt = {
        owner: value.owner,
        account: value.account,
        operation: value.operation,
        key: value.key,
        requestDigest: harnessDigest(value),
        channel: value.channel,
        generation: value.generation,
        status,
        ...(value.operation === "poll"
          ? {
              partition: policy.account,
              previous: value.payload.cursor,
              cursor: pollItems.length
                ? `PRIVATE_CURSOR_${requests.length}`
                : (value.payload.cursor ?? "PRIVATE_CURSOR_INITIAL"),
              items: pollGap ? [] : pollItems,
            }
          : {}),
        ...(providerId ? { providerId } : {}),
        ...(subscriptionRef ? { subscriptionRef } : {}),
        ...(subscriptionRef && controls?.lease ? {receiptVersion:"signed-lease-v1",leaseExpiresAt:Date.now()+2000}:{}),
      };
      const signature = hmac(keys.receipt, harnessDigest(receipt));
      return Response.json({
        receipt,
        signature: tamper ? "forged" : signature,
      });
    },
  });
  policy = {
    id: "controlled",
    revision: "v1",
    owner: "123",
    active: true,
    expiresAt: Date.now() + 120000,
    account: "provider-account",
    source: "controlled-source",
    destination: "controlled-destination",
    authorityRef: "provider-bind",
    sendAuthorityRef: "provider-send",
    ingressBaseUrl: ingress.url.origin,
    origin: provider.url.origin,
    receiveKey: keys.receive,
    receiptKey: keys.receipt,
    requestToken: keys.request,
    endpoints: pollOnly
      ? { poll: "/poll", send: "/send", reconcile: "/reconcile" }
      : {
          renew: "/renew",
          subscribe: "/subscribe",
          send: "/send",
          remove: "/remove",
          reconcile: "/reconcile",
        },
    definition: definition(),
    maxInstances: 2,
    maxBytes: 4096,
    backlog: 8,
    retentionMs: 60000,
    ...(controls ? {automaticControls:{maxRuns:3,minIntervalMs:100,maxDurationMs:10000}} : {}),
    ...(controls?.lease ? {leaseReceiptVersion:"signed-lease-v1" as const} : {}),
  };
  const env = await sandboxEnvironment("actual-provider-fixture"),
    journal = await sandboxJobJournal(db, join(dir, "job-key"));
  const local = localHarnessSandbox({
    owner: "123",
    environmentDigest: env,
    journal,
    send: async (req, signal) => {
      if (new URL(req.url).origin !== provider.url.origin)
        throw Error("Foreign network denied");
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal,
        redirect: "manual",
      });
      if (lost && new URL(req.url).pathname === lost) {
        lost = "";
        throw Error("Controlled lost provider acknowledgement");
      }
      return {
        status: response.status,
        headers: { "content-type": "application/json" },
        body: (await response.json()) as any,
        classification: "application",
      };
    },
  });
  const sandbox = {
    harnessEnvironment: local.harnessEnvironment,
    harnessJob: async (job: any, signal?: AbortSignal) => {
      jobs.push(job);
      await beforeJob?.(job, signal);
      return local.harnessJob(job, signal);
    },
  };
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }),
    react: (r: any) => {
      models++;
      return Effect.succeed(
        r.trajectory.some(
          (e: any) => e.type === "ToolReturned" && e.turn === r.identity.turn,
        )
          ? { kind: "complete" as const, output: "Created controlled channel" }
          : {
              kind: "call" as const,
              name: "execute",
              callId: `compose:${r.identity.turn}`,
              arguments: { code: program },
            },
      );
    },
  });
  const config: AikoConfig = {
    mode: "demo",
    codeMode: true,
    port: ingress.port!,
    stateDir: dir,
    operatorToken: "operator-controlled-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123"]),
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(token),
        scopes: ["read", "write"],
      },
    ],
  };
  const options = {
    model,
    registrySandbox: () => ({
      sandbox,
      placement: "local" as const,
      codeTransport: runCodeSegment,
    }),
    providerAdapters: (owner: string) => (owner === "123" ? [policy] : []),
  };
  const module = worker ? await productionWorker() : undefined;
  let workerDb = worker ? new Database(join(dir, "worker.sqlite")) : undefined;
  let account: any;
  const id = (name: string) => ({
    name,
    equals: (other: any) => other?.name === name,
    toString: () => name,
  });
  const workerEnv: any = {
    AIKO_MODE: "live",
    AIKO_CODE_MODE: "true",
    AIKO_INSTANCE_ID: "provider-worker",
    AIKO_REPLY_STYLE: "direct",
    AIKO_OPERATOR_TOKEN: config.operatorToken,
    CODEGRAFF_API_KEY: "controlled-unused-model-key",
    AIKO_ALLOWED_USERS: "123",
    AIKO_PLANE_CREDENTIALS: JSON.stringify(config.planeCredentials),
    AIKO_VOICE_ENABLED: "false",
    AIKO_PROVIDER_ADAPTERS: options.providerAdapters,
    AIKO_REGISTRY_SANDBOX: options.registrySandbox,
    AIKO_MODEL_FETCH: async (_url: any, init: RequestInit) => {
      models++;
      const body = JSON.parse(String(init.body)),
        called = workerProgramDispatched;
      workerProgramDispatched = true;
      const delta = called
        ? { content: "Controlled channel created" }
        : {
            tool_calls: [
              {
                index: 0,
                id: workerCallId,
                type: "function",
                function: {
                  name: "execute",
                  arguments: JSON.stringify({ code: program }),
                },
              },
            ],
          };
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: called ? "stop" : "tool_calls",
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10, cost: 0 },
          },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  const registryDb = worker ? new Database(":memory:") : undefined;
  if (worker) {
    const registry = new module.AikoRegistryDO(
      { storage: durableStorage(registryDb!) },
      workerEnv,
    );
    workerEnv.AIKO_REGISTRY = { getByName: () => registry };
    workerEnv.AIKO_ACCOUNTS = {
      idFromName: id,
      getByName: (name: string) => {
        if (name !== module.accountObjectName("123"))
          throw Error("foreign account");
        return account;
      },
    };
  }
  const open = async () => {
    if (!worker) return createService(config, options);
    account = new module.AikoAccountDO(
      {
        id: id(module.accountObjectName("123")),
        storage: durableStorage(workerDb!, () => {
          if (
            pollCut || (!pollOnly && bindingCut) ||
            !workerDb!
              .query(
                "SELECT name FROM sqlite_master WHERE name='aiko_thread_events'",
              )
              .get()
          )
            return;
          const rows = workerDb!
            .query(
              "SELECT event FROM aiko_thread_events WHERE thread='user-123' ORDER BY seq",
            )
            .all()
            .map((r: any) => JSON.parse(r.event));
          if (
            !bindingCut &&
            rows.some((e) => e.type === "AikoChannelBindingIntent") &&
            !rows.some((e) => e.type === "AikoChannelBridgeBound")
          )
            bindingCut = workerDb!.serialize();
          if (
            rows.some((e) => e.type === "AikoChannelPollFetched") &&
            !rows.some((e) => e.type === "AikoChannelCursorAdvanced")
          )
            pollCut = workerDb!.serialize();
        }),
        waitUntil: () => {},
        blockConcurrencyWhile: (fn: any) => fn(),
      },
      workerEnv,
    );
    return {
      fetch: (request: Request) => module.default.fetch(request, workerEnv),
      host: {
        wake: () => account.alarm(),
        read: async (thread: string) =>
          (await account.runtime)?.host.read(thread) ?? [],
      },
      close: async () => {
        await (await account.runtime)?.host.close();
      },
    } as unknown as Awaited<ReturnType<typeof createService>>;
  };
  service = await open();
  const request = (path: string, body?: unknown, bearer = token) =>
    service.fetch(
      new Request(ingress.url.origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    request,
    requests,
    jobs,
    outputs,
    subscriptions,
    emit,
    policy,
    beforeJob: (hook: typeof beforeJob) => {
      beforeJob = hook;
    },
    restoreBindingCut: async () => {
      if (!workerDb || !bindingCut) throw Error("Native binding cut absent");
      await service.close();
      workerDb.close();
      await writeFile(join(dir, "worker.sqlite"), bindingCut);
      workerDb = new Database(join(dir, "worker.sqlite"));
      beforeJob = undefined;
      service = await open();
    },
    restorePollCut: async () => {
      if (!workerDb || !pollCut) throw Error("Native poll cut absent");
      await service.close();
      workerDb.close();
      await writeFile(join(dir, "worker.sqlite"), pollCut);
      workerDb = new Database(join(dir, "worker.sqlite"));
      beforeJob = undefined;
      service = await open();
    },
    pollPage: (items: any[], gap = false) => {
      pollItems = items;
      pollGap = gap;
    },
    beforeResponse: (callback: typeof beforeResponse) => {
      beforeResponse = callback;
    },
    early: () => earlyStatus,
    models: () => models,
    events: () => service.host.read("user-123"),
    drive: () => service.host.wake("user-123"),
    lost: (path: string) => {
      lost = path;
    },
    tamper: () => {
      tamper = true;
    },
    run: async (code: string, id = "provider-compose") => {
      program = code;
      workerProgramDispatched = false;
      workerCallId = `provider-compose:${id}`;
      expect(
        (
          await request("/api/messages", {
            id,
            text: "Compose the controlled generated adapter.",
          })
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
    },
    restart: async () => {
      await service.close();
      service = await open();
    },
    disk: async () => {
      const chunks: Buffer[] = [];
      const visit = async (path: string) => {
        for (const e of await readdir(path, { withFileTypes: true })) {
          const f = join(path, e.name);
          if (e.isDirectory()) await visit(f);
          else if (/sqlite(-wal)?$/.test(f)) chunks.push(await readFile(f));
        }
      };
      await visit(dir);
      return Buffer.concat(chunks);
    },
    close: async () => {
      await service.close();
      await ingress.stop(true);
      await provider.stop(true);
      db.close();
      workerDb?.close();
      registryDb?.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const candidate = {
  ...definition().artifact,
  files: {
    "adapter.js":
      'const {operation,input:payload}=input; return operation==="decode" ? {kind:"external",schemaVersion:"provider.text.v1",text:JSON.parse(payload.body).message} : {payload};',
  },
};
export const compose = `
const acquired=await tools.call({name:"provider_adapter_acquire",arguments:{policy:"controlled",operationId:"acquire:provider",candidate:${JSON.stringify(candidate)}}});if(acquired.status!=="ready")throw Error("provider acquisition "+JSON.stringify(acquired));
for(const name of ["channel.text.echo"]){const r=await tools.call({name:"harness_acquire",arguments:{name,operationId:"acquire:"+name}});if(r.status!=="ready")throw Error("acquisition "+name+JSON.stringify(r));}
const list=await tools.call({name:"harness_list",arguments:{}}),adapter={harnessDigest:acquired.harnessDigest},echo=list.candidates.find(c=>c.name==="channel.text.echo");
const authorityRef="registry-internal:123";
const input=await channels.bind({name:"generated-in",schema:"text.message.v1",directions:["inbox","outbox"],authorityRef,operationId:"provider-in"});
const output=await channels.bind({name:"generated-out",schema:"text.message.v1",directions:["inbox","outbox"],authorityRef,operationId:"provider-out"});
const wire=await channels.connect({name:"generated-hook",generation:1,input:{channel:input.channel,generation:input.generation},accepts:"text.message.v1",handler:{harness:echo.harnessDigest,contract:echo.contractDigest},output:{channel:output.channel,generation:output.generation,mode:"port"},start:"after-registration",authorityRef,operationId:"provider-hook"});
if(wire.status!=="active")throw Error("hook unavailable");
const bound=await tools.call({name:"provider_adapter_bind",arguments:{policy:"controlled",name:"generated-provider",digest:adapter.harnessDigest,generation:1,bridge:{operationId:"provider-bridge",input:{channel:input.channel,generation:input.generation},output:{channel:output.channel,generation:output.generation},wiring:{id:wire.id,generation:wire.generation},decodeSchema:"provider.text.v1",expiresAt:Date.now()+60000}}});
return bound;
`;
for (const worker of [false, true])
  test(`actual default ${worker ? "Worker" : "Bun"} generated adapter prearms signed ingress, executes a known hook and correlates provider acceptance/delivery after restart`, async () => {
    const f = await fixture(worker);
    try {
      expect(
        await (await f.request("/api/harness/readiness")).json(),
      ).toMatchObject({ providerAdapters: true });
      expect(
        await (await f.request("/api/provider-bridge/readiness")).json(),
      ).toMatchObject({ providerBridge: true, providerIngress: true });
      await f.run(compose);
      for (let n = 0; n < 4; n++) await f.drive();
      const rows = await f.events();
      expect(f.early()).toBe(202);
      expect(f.subscriptions.size).toBe(1);
      expect(f.outputs.size).toBe(1);
      expect(
        rows.find((e) => e.type === "AikoChannelBindingReady"),
      ).toBeDefined();
      expect(
        rows.findIndex((e) => e.type === "AikoChannelIngressArmed"),
      ).toBeLessThan(
        rows.findIndex((e) => e.type === "AikoChannelSubscriptionStarted"),
      );
      expect(
        rows.filter((e) => e.type === "AikoChannelInputHandled"),
      ).toHaveLength(1);
      expect(rows.filter((e) => e.type === "MessageReceived")).toHaveLength(1);
      expect(
        (rows.find((e) => e.type === "AikoChannelOutputSettled")?.result as any)
          ?.status,
      ).toBe("accepted_by_provider");
      const calls = f.models(),
        jobs = f.jobs.length,
        sub = [...f.subscriptions.values()][0];
      await f.restart();
      await f.drive();
      expect(f.jobs).toHaveLength(jobs);
      expect(f.models()).toBe(calls);
      expect((await f.emit(sub, "early-occurrence")).status).toBe(202);
      await f.drive();
      expect(f.outputs.size).toBe(1);
      expect((await f.emit(sub, "bad-signature", text, false)).status).toBe(
        403,
      );
      const out = (await f.events()).find(
        (e) => e.type === "AikoChannelOutputPrepared",
      )!;
      expect(
        (
          await f.request("/api/channels/reconcile", {
            id: out.channel,
            generation: out.generation,
            outputId: out.id,
            operationId: "delivery-status",
          })
        ).status,
      ).toBe(202);
      await f.drive();
      expect(
        (
          (await f.events()).find(
            (e) => e.type === "AikoChannelReconcileSettled",
          )?.result as any
        )?.status,
      ).toBe("delivered");
      expect(f.outputs.size).toBe(1);
      // All setup guests have exited and the owner host has reopened. The stable
      // HTTP endpoint retains a fresh occurrence and launches only checked jobs.
      expect((await f.emit(sub, "after-reopen")).status).toBe(202);
      await f.drive();
      expect(f.outputs.size).toBe(2);
      expect(f.models()).toBe(calls);
      expect(
        f.requests.filter((r) => r.operation === "subscribe"),
      ).toHaveLength(1);
      const sent = [...f.outputs.values()].at(-1);
      expect(sent.payload.replyTo).toBe("after-reopen");
      expect(sent.payload.conversation).toBe("controlled-conversation");
      expect(sent.payload.payload).toBe(text);
      expect(
        (
          await f.request("/api/channels/lifecycle", {
            id: out.channel,
            generation: out.generation,
            status: "retiring",
            authorization: "provider-bind",
            operationId: "cleanup",
          })
        ).status,
      ).toBe(202);
      await f.drive();
      expect(f.subscriptions.size).toBe(0);
      expect((await f.emit(sub, "retired")).status).toBe(409);
      const trace = JSON.stringify(await f.events()),
        disk = await f.disk();
      for (const secret of [text, ...Object.values(keys)]) {
        expect(trace).not.toContain(secret);
        expect(disk.includes(Buffer.from(secret))).toBe(false);
      }
    } finally {
      await f.close();
    }
  }, 30000);

for (const lost of ["/subscribe", "/send", "/remove"])
  test(`native generated provider ${lost} lost acknowledgement is reconciled without repeating mutation`, async () => {
    const f = await fixture();
    try {
      if (lost !== "/remove") f.lost(lost);
      await f.run(compose);
      const binding = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!.binding as any;
      if (lost === "/remove") {
        f.lost(lost);
        expect(
          (
            await f.request("/api/channels/lifecycle", {
              id: binding.id,
              generation: 1,
              status: "retiring",
              authorization: "provider-bind",
              operationId: "retire-lost",
            })
          ).status,
        ).toBe(202);
        await f.drive();
      }
      const count = f.requests.filter(
          (r) => r.operation === lost.slice(1),
        ).length,
        jobs = f.jobs.length;
      expect(count).toBe(1);
      await f.restart();
      await f.drive();
      expect(f.jobs).toHaveLength(jobs);
      if (lost === "/send") {
        const out = (await f.events()).find(
          (e) => e.type === "AikoChannelOutputPrepared",
        )!;
        expect(
          (
            (await f.events()).find(
              (e) => e.type === "AikoChannelOutputSettled",
            )?.result as any
          ).status,
        ).toBe("unknown");
        expect(
          (
            await f.request("/api/channels/reconcile", {
              id: binding.id,
              generation: 1,
              outputId: out.id,
              operationId: "resolve-lost",
            })
          ).status,
        ).toBe(202);
      } else
        expect(
          (
            await f.request("/api/channels/subscription", {
              id: binding.id,
              generation: 1,
              operation: "reconcile",
              operationId: "resolve-lost",
              authorization: "provider-bind",
            })
          ).status,
        ).toBe(202);
      await f.drive();
      expect(
        f.requests.filter((r) => r.operation === lost.slice(1)),
      ).toHaveLength(1);
      if (lost === "/remove") expect(f.subscriptions.size).toBe(0);
      else if (lost === "/subscribe") {
        expect(
          (await f.events()).some((e) => e.type === "AikoChannelBindingReady"),
        ).toBe(true);
        expect(f.outputs.size).toBe(1);
      } else
        expect(
          (
            (await f.events()).find(
              (e) => e.type === "AikoChannelReconcileSettled",
            )?.result as any
          ).status,
        ).toBe("delivered");
    } finally {
      await f.close();
    }
  }, 30000);

test("provider provenance, owner, and current send policy are independent of generated adapter output", async () => {
  const f = await fixture();
  try {
    f.tamper();
    await f.run(compose);
    expect(f.subscriptions.size).toBe(1);
    expect(f.outputs.size).toBe(0);
    expect(
      (await f.events()).some((e) => e.type === "AikoChannelBindingReady"),
    ).toBe(false);
    expect(
      (await f.request("/api/harness/readiness", undefined, "foreign-token"))
        .status,
    ).toBe(401);
    f.policy.active = false;
    const sub = [...f.subscriptions.values()][0];
    expect((await f.emit(sub, "revoked")).status).toBe(403);
    expect(
      await (await f.request("/api/harness/readiness")).json(),
    ).toMatchObject({ providerAdapters: false });
    const before = f.requests.length;
    await f.restart();
    await f.drive();
    expect(f.requests).toHaveLength(before);
  } finally {
    await f.close();
  }
}, 30000);

test("inbox-only provider policy cannot manufacture a subscription with correlated send authority", async () => {
  const f = await fixture();
  try {
    delete f.policy.sendAuthorityRef;
    delete f.policy.destination;
    delete f.policy.endpoints.send;
    await f.run(compose);
    expect(f.subscriptions.size).toBe(0);
    expect(f.outputs.size).toBe(0);
    expect(
      (await f.events()).some((e) => e.type === "AikoChannelBindingIntent"),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

test("fixed provider instance quota is enforced at native append and current policy cannot retarget a retained binding", async () => {
  const f = await fixture();
  try {
    f.policy.maxInstances = 1;
    await f.run(compose);
    expect(f.subscriptions.size).toBe(1);
    await f.run(
      compose
        .replace('name:"generated-provider"', 'name:"second-provider"')
        .replace(
          'operationId:"provider-bridge"',
          'operationId:"second-bridge"',
        ),
      "second-provider-compose",
    );
    expect(
      (await f.events()).filter((e) => e.type === "AikoChannelBindingIntent"),
    ).toHaveLength(1);
    expect(f.requests.filter((r) => r.operation === "subscribe")).toHaveLength(
      1,
    );
    const sub = [...f.subscriptions.values()][0];
    f.policy.endpoints.send = "/unapproved-new-destination";
    expect((await f.emit(sub, "changed-policy")).status).toBe(403);
    f.policy.endpoints.send = "/send";
    f.policy.expiresAt = Date.now() - 1;
    expect((await f.emit(sub, "expired-policy")).status).toBe(403);
  } finally {
    await f.close();
  }
}, 30000);

test("revoking the retained bridge during subscribe cannot activate it; authorized retirement still removes the uncertain remote subscription", async () => {
  const f = await fixture();
  try {
    f.beforeResponse(async (operation) => {
      if (operation !== "subscribe") return;
      const bridge = (await f.events()).find(
        (e) => e.type === "AikoChannelBridgeBound",
      )!;
      expect(
        (
          await f.request("/api/provider-bridge", {
            operation: "revoke",
            id: bridge.id,
          })
        ).status,
      ).toBe(200);
    });
    await f.run(compose);
    expect(f.subscriptions.size).toBe(1);
    expect(f.outputs.size).toBe(0);
    expect(
      (await f.events()).some((e) => e.type === "AikoChannelBindingReady"),
    ).toBe(false);
    const binding = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!.binding as any;
    expect(
      (
        await f.request("/api/channels/lifecycle", {
          id: binding.id,
          generation: 1,
          status: "retiring",
          authorization: "provider-bind",
          operationId: "revoked-cleanup",
        })
      ).status,
    ).toBe(202);
    await f.drive();
    expect(f.subscriptions.size).toBe(0);
    expect(f.requests.filter((r) => r.operation === "subscribe")).toHaveLength(
      1,
    );
    expect(f.requests.filter((r) => r.operation === "remove")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

for (const worker of [false, true])
  test(`actual ${worker ? "Worker" : "Bun"} poll-only signed source retains batch and cursor, unchanged polls stay silent across reopen`, async () => {
    const f = await fixture(worker, true);
    try {
      await f.run(compose);
      for (let i = 0; i < 3; i++) await f.drive();
      const intent = (await f.events()).find(
        (e) => e.type === "AikoChannelBindingIntent",
      )!;
      expect(intent).toBeDefined();
      expect(f.subscriptions.size).toBe(0);
      expect(
        f.requests.filter((r) => r.operation === "subscribe"),
      ).toHaveLength(0);
      const page = [
        {
          occurrence: "poll-1",
          conversation: "controlled-conversation",
          observation: {
            kind: "external",
            schemaVersion: "provider.text.v1",
            text,
          },
        },
        {
          occurrence: "poll-rejected",
          conversation: "controlled-conversation",
          observation: { kind: "not-external", secret: "PRIVATE_INVALID_POLL" },
        },
      ];
      f.pollPage(page);
      const poll = (operationId: string) =>
        f.request("/v1/channels/poll", {
          id: intent.channel,
          generation: 1,
          partition: "provider",
          operationId,
        });
      expect((await poll("poll-first")).status).toBe(202);
      for (let i = 0; i < 3; i++) await f.drive();
      let rows = await f.events();
      expect(
        rows.filter((e) => e.type === "AikoChannelPollFetched"),
      ).toHaveLength(1);
      expect(
        rows.filter((e) => e.type === "AikoChannelCursorAdvanced"),
      ).toHaveLength(1);
      expect(
        rows.some(
          (e) =>
            e.type === "AikoChannelInputRejected" &&
            e.reason === "schema_invalid",
        ),
      ).toBe(true);
      expect(f.outputs.size).toBe(1);
      const jobs = f.jobs.length,
        calls = f.models();
      await f.restart();
      await f.drive();
      expect(f.jobs).toHaveLength(jobs);
      expect(f.models()).toBe(calls);
      f.pollPage([]);
      expect((await poll("poll-unchanged")).status).toBe(202);
      await f.drive();
      expect(f.outputs.size).toBe(1);
      expect(f.models()).toBe(calls);
      expect(
        f.requests.filter((r) => r.operation === "poll").at(-1).payload.cursor,
      ).toMatch(/^PRIVATE_CURSOR_/);
      expect(JSON.stringify(await f.events())).not.toContain("PRIVATE_CURSOR_");
      expect(await f.disk()).not.toContain("PRIVATE_CURSOR_");
      expect(await f.disk()).not.toContain("PRIVATE_INVALID_POLL");
      f.pollPage([], true);
      expect((await poll("poll-gap")).status).toBe(202);
      await f.drive();
      expect(
        (await f.events()).some(
          (e) =>
            e.type === "AikoChannelPollSettled" && e.status === "source_gap",
        ),
      ).toBe(true);
      expect((await poll("poll-after-gap")).status).not.toBe(202);
    } finally {
      await f.close();
    }
  });

test("signed renewal lost acknowledgement reconciles the original mutation key without another renewal", async () => {
  const f = await fixture();
  try {
    await f.run(compose);
    for (let i = 0; i < 3; i++) await f.drive();
    const b = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!;
    f.lost("/renew");
    expect(
      (
        await f.request("/v1/channels/subscription", {
          id: b.channel,
          generation: 1,
          operation: "renew",
          operationId: "renew-once",
          authorization: "provider-bind",
        })
      ).status,
    ).toBe(202);
    await f.drive();
    await f.restart();
    await f.drive();
    expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(1);
    expect(
      (await f.events()).some(
        (e) =>
          e.type === "AikoChannelRenewSettled" &&
          e.id === "renew-once" &&
          e.status === "unknown",
      ),
    ).toBe(true);
    expect(
      (
        await f.request("/v1/channels/subscription", {
          id: b.channel,
          generation: 1,
          operation: "reconcile",
          operationId: "renew-reconcile",
          originalRenewalId: "renew-once",
          authorization: "provider-bind",
        })
      ).status,
    ).toBe(202);
    await f.drive();
    expect(
      (await f.events()).some(
        (e) =>
          e.type === "AikoChannelRenewSettled" &&
          e.id === "renew-reconcile" &&
          e.status === "ready",
      ),
    ).toBe(true);
    expect(f.requests.filter((r) => r.operation === "renew")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const worker of [false, true])
  test(`actual ${worker ? "Worker" : "Bun"} pause/resume and retired generation upgrade survive restart and fence old ingress`, async () => {
    const f = await fixture(worker);
    try {
      await f.run(compose);
      for (let i = 0; i < 3; i++) await f.drive();
      const old = [...f.subscriptions.values()][0],
        rows = await f.events(),
        intent = rows.find((e) => e.type === "AikoChannelBindingIntent")!;
      const lifecycle = (status: string, operationId: string) =>
        f.request("/v1/channels/lifecycle", {
          id: intent.channel,
          generation: 1,
          status,
          authorization: "provider-bind",
          operationId,
        });
      await f.run(
        `return await tools.call({name:"provider_adapter_control",arguments:{channel:${JSON.stringify(intent.channel)},generation:1,operation:"pause",operationId:"pause-native"}});`,
        "native-pause",
      );
      expect(
        (await f.events()).some(
          (e) => e.type === "AikoChannelLifecycle" && e.status === "paused",
        ),
      ).toBe(true);
      await f.restart();
      await f.drive();
      expect((await f.emit(old, "paused-input")).status).toBe(409);
      expect((await lifecycle("paused", "pause-native")).status).toBe(202);
      expect((await lifecycle("active", "resume-native")).status).toBe(202);
      await f.restart();
      await f.drive();
      expect((await f.emit(old, "resumed-input")).status).toBe(202);
      for (let i = 0; i < 3; i++) await f.drive();
      expect(
        f.requests.filter((r) => r.operation === "subscribe"),
      ).toHaveLength(1);
      expect((await lifecycle("retiring", "retire-native")).status).toBe(202);
      await f.drive();
      await f.restart();
      expect(f.requests.filter((r) => r.operation === "remove")).toHaveLength(
        1,
      );
      const wire = (
        rows.find((e) => e.type === "AikoChannelWiringConnected") as any
      ).wire;
      const upgrade = {
        policy: "controlled",
        name: "generated-provider",
        digest: (intent.binding as any).artifact.digest,
        generation: 2,
        bridge: {
          operationId: "provider-bridge-v2",
          input: wire.input,
          output: {
            channel: wire.output.channel,
            generation: wire.output.generation,
          },
          wiring: { id: wire.id, generation: wire.generation },
          decodeSchema: "provider.text.v1",
          expiresAt: Date.now() + 60000,
        },
      };
      // Call the real native tool using the actual production host's retained code mode.
      const nextCandidate = {
        ...candidate,
        files: {
          "adapter.js":
            'const request=input; if(request.operation==="decode") return {kind:"external",schemaVersion:"provider.text.v1",text:JSON.parse(request.input.body).message}; return {payload:request.input};',
        },
      };
      await f.run(
        `const next=await tools.call({name:"provider_adapter_acquire",arguments:{policy:"controlled",operationId:"acquire:provider:v2",candidate:${JSON.stringify(nextCandidate)}}}); if(next.status!=="ready")throw Error("upgrade acquisition unavailable"); return await tools.call({name:"provider_adapter_bind",arguments:{...${JSON.stringify(upgrade)},digest:next.harnessDigest}});`,
        "provider-upgrade",
      );
      for (let i = 0; i < 3; i++) await f.drive();
      expect(
        (await f.events()).some(
          (e) => e.type === "AikoChannelBindingIntent" && e.generation === 2,
        ),
      ).toBe(true);
      expect(
        (
          (await f.events()).find(
            (e) => e.type === "AikoChannelBindingIntent" && e.generation === 2,
          )!.binding as any
        ).artifact.digest,
      ).not.toBe((intent.binding as any).artifact.digest);
      expect((await f.emit(old, "stale-generation")).status).toBe(403);
      await f.restart();
      await f.drive();
      expect(
        f.requests.filter((r) => r.operation === "subscribe"),
      ).toHaveLength(2);
      expect(f.requests.filter((r) => r.operation === "remove")).toHaveLength(
        1,
      );
    } finally {
      await f.close();
    }
  }, 30000);

test("actual Worker recovers the retained poll-batch cut before cursor without repeating the provider GET", async () => {
  const f = await fixture(true, true),
    entered = Promise.withResolvers<void>();
  try {
    await f.run(compose);
    for (let i = 0; i < 3; i++) await f.drive();
    const b = (await f.events()).find(
      (e) => e.type === "AikoChannelBindingIntent",
    )!;
    f.pollPage([
      {
        occurrence: "cut-item",
        conversation: "controlled-conversation",
        observation: {
          kind: "external",
          schemaVersion: "provider.text.v1",
          text,
        },
      },
    ]);
    f.beforeJob(async (_job, signal) => {
      if (
        !(await f.events()).some((e) => e.type === "AikoChannelCursorAdvanced")
      )
        return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const stop = () =>
          reject(Error("controlled downstream job stopped at native cut"));
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
    });
    expect(
      (
        await f.request("/v1/channels/poll", {
          id: b.channel,
          generation: 1,
          partition: "provider",
          operationId: "cut-poll",
        })
      ).status,
    ).toBe(202);
    const driving = f.drive().catch(() => undefined);
    const timeout = setTimeout(
      () =>
        entered.reject(
          Error(
            "native checked handler did not reach controlled physical edge",
          ),
        ),
      8000,
    );
    try {
      await entered.promise;
    } finally {
      clearTimeout(timeout);
    }
    expect(f.outputs.size).toBe(0);
    await f.restorePollCut();
    await driving;
    for (let i = 0; i < 4; i++) await f.drive();
    expect(f.requests.filter((r) => r.operation === "poll")).toHaveLength(1);
    expect(
      (await f.events()).filter((e) => e.type === "AikoChannelCursorAdvanced"),
    ).toHaveLength(1);
    expect(f.outputs.size).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

test("actual Worker binding-intent cut recovers bridge and ingress arm before its only subscription", async () => {
  const f = await fixture(true),
    entered = Promise.withResolvers<void>();
  try {
    f.beforeJob(async (_job, signal) => {
      if (
        !(await f.events()).some((e) => e.type === "AikoChannelBindingIntent")
      )
        return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const stop = () =>
          reject(
            Error("controlled subscribe job paused before physical dispatch"),
          );
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
    });
    const driving = f.run(compose).catch(() => undefined);
    const timeout = setTimeout(
      () => entered.reject(Error("binding did not reach physical edge")),
      8000,
    );
    try {
      await entered.promise;
    } finally {
      clearTimeout(timeout);
    }
    expect(f.requests.filter((r) => r.operation === "subscribe")).toHaveLength(
      0,
    );
    await f.restoreBindingCut();
    await driving;
    for (let i = 0; i < 4; i++) await f.drive();
    const rows = await f.events();
    expect(
      rows.filter((e) => e.type === "AikoChannelBindingIntent"),
    ).toHaveLength(1);
    expect(
      rows.filter((e) => e.type === "AikoChannelIngressArmed"),
    ).toHaveLength(1);
    expect(f.requests.filter((r) => r.operation === "subscribe")).toHaveLength(
      1,
    );
    expect(f.early()).toBe(202);
    expect(f.outputs.size).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);
