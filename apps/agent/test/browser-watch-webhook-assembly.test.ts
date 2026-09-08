import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createAikoActor } from "../src/actor.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  channelHarnessHandlers,
  createHostedChannels,
  type BrowserWatchHostPolicy,
} from "../src/channel-host.ts";
import {
  channelAppendAllowed,
  channelEventKey,
  channelId,
} from "../src/channel-bindings.ts";
import {
  channelWiringAppendAllowed,
  channelWiringEventKey,
} from "../src/channel-wiring.ts";
import {
  channelLogSourceAppendAllowed,
  channelLogSourceEventKey,
} from "../src/channel-log-source.ts";
import {
  HarnessLibrary,
  harnessBlobStore,
  harnessDigest,
  harnessLibraryAppendAllowed,
  harnessLibraryEventKey,
  type HarnessLibraryBinding,
  type HarnessJournal,
} from "../src/harness-library.ts";
import {
  BROWSER_EVENT_SCHEMA,
  browserBatchSignature,
  browserEventAppendAllowed,
  browserEventKey,
  type BrowserEventBatch,
} from "../src/browser-events.ts";
import {
  browserWatchAppendAllowed,
  browserWatchEventKey,
  browserWatchHarnessDefinitions,
  type BrowserWatchConfig,
} from "../src/browser-watches.ts";
import { browserWatchApi } from "../src/browser-watch-api.ts";
import { channelHydrate } from "../src/channel-custody.ts";
import {
  createWebhookAdapterHost,
  type WebhookDestinationPolicy,
  type WebhookRequest,
} from "../src/webhook-adapter.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createVoice } from "../src/voice.ts";
import { PERSONA } from "../src/config.ts";
import { setupWebhookSandbox } from "./webhook-sandbox-fixture.ts";
import { configuredBrowserWatchPolicy, configuredBrowserWatchWebhooks, parseBrowserWatchDeployment } from "../src/browser-watch-config.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Actual native account assembly; only the browser producer and HTTP socket are fixtures. */
async function fixture(options: { guarded?: boolean; deployment?: boolean } = {}) {
  const owner = options.deployment ? "123" : "watch-webhook-assembly",
    thread = `user-${owner}`;
  let db = new Database(":memory:"),
    alarm: number | null = null,
    nativeWebhook = true;
  let preparedSnapshot: Uint8Array | undefined;
  let startedSnapshot: Uint8Array | undefined;
  const stateDir = await mkdtemp("/tmp/browser-watch-webhook-assembly-");
  const calls: WebhookRequest[] = [];
  const sandbox = options.guarded ? await setupWebhookSandbox(owner) : undefined;
  let connectionCurrent = true;
  let destinationEnabled = true;
  let beforePermitCommit: () => void = () => {};
  let beforeRequest: () => Promise<void> = async () => {};
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>,
    channels!: ReturnType<typeof createHostedChannels>;
  const privateLeases = new Map<
    string,
    {
      producer: string;
      generation: number;
      state: string;
      lifecycleRevision: number;
      pausedThrough?: number;
    }
  >();
  const policy: WebhookDestinationPolicy = {
    id: "requests",
    revision: "1",
    owner,
    active: true,
    expiresAt: Date.now() + 600_000,
    url: "https://hooks.receiver.com/aiko",
    signingKey: "fixture-sender-private-key-0123456789abcdef",
    authorityRef: "configure-webhook",
    sendAuthorityRef: "send-webhook",
    maxBytes: 8192,
    retentionMs: 600_000,
    idempotency: "delivery-id",
  };
  const config: BrowserWatchConfig = {
    id: "new-request",
    label: "New requests",
    connectionId: options.deployment ? "11111111-1111-4111-8111-111111111111" : "site",
    connectionRevision: options.deployment ? "7" : "r1",
    sourceGeneration: 1,
    origin: options.deployment ? "https://site.example.com" : "https://site.example",
    kind: "push",
    outcome: "received",
    action: { kind: "webhook", destination: options.deployment ? "requests-v1" : "saved-hook" },
    expiresAt: policy.expiresAt,
    backlog: 8,
    maxOccurrences: 256,
  };
  const deployment = () => parseBrowserWatchDeployment(JSON.stringify({version:1,ingressOrigin:"https://aiko.example.com",owners:{[owner]:{
    sources:[{connectionId:config.connectionId,label:config.label,origin:config.origin,sourceGeneration:1,events:[{id:"new",label:"New request",kind:"push",outcome:"received"}]}],
    actions:destinationEnabled?[{id:"deliver",label:"Send request",action:config.action}]:[],defaults:{expiresInMs:60000,backlog:8,maxOccurrences:256},
    webhooks:destinationEnabled?[{id:"requests-v1",url:policy.url,signingKeyRef:"key",expiresAt:policy.expiresAt,maxBytes:policy.maxBytes,retentionMs:policy.retentionMs}]:[],
  }}}));
  const storage: AccountStorage = {
    sql: {
      exec: (sql, ...args) => {
        const rows = db.query(sql).all(...(args as any));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {
      if (!startedSnapshot && db.query("SELECT 1 FROM aiko_thread_events WHERE json_extract(event,'$.type')='AikoBrowserWatchStarted'").get() &&
        !db.query("SELECT 1 FROM aiko_thread_events WHERE json_extract(event,'$.type')='AikoChannelOutputPrepared'").get()) startedSnapshot = db.serialize();
      // Capture a durable crash boundary before any native outbox dispatch starts.
      if (
        !preparedSnapshot &&
        db
          .query(
            "SELECT 1 FROM aiko_thread_events WHERE json_extract(event,'$.type')='AikoChannelOutputPrepared'",
          )
          .get() &&
        !db
          .query(
            "SELECT 1 FROM aiko_thread_events WHERE json_extract(event,'$.type')='AikoChannelOutputStarted'",
          )
          .get()
      )
        preparedSnapshot = db.serialize();
    },
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const journal: HarnessJournal = {
    read: () => host.read(thread),
    append: async (events) => {
      for (const event of events)
        await host.commitRoot(host.self(thread), event);
    },
  };
  const open = async () => {
    const kv = sqliteWorkflowKV(db),
      blobs = harnessBlobStore(kv),
      definitions = browserWatchHarnessDefinitions();
    const libraryBinding: HarnessLibraryBinding = {
      owner,
      thread,
      blobs,
      guard: () => {},
      context: async () => ({
        placement: "local",
        runtimeDigest: harnessDigest("watch-webhook-assembly"),
        bindings: {},
      }),
      verifiers: new Map(
        definitions.map((d) => [d.verifier.digest, d.verifier]),
      ),
      authorize: async () => true,
      execute: async (job, signal) => {
        const r = await runCodeSegment(
          {
            version: 1,
            code: job.artifact.files[job.artifact.entrypoint]!,
            packages: {},
            values: { input: job.input },
            ambient: { at: 0, seed: job.operationId },
            history: [],
          },
          signal,
        );
        return r.error
          ? { status: "failed", evidence: ["quickjs-error"] }
          : {
              status: "succeeded",
              output: r.result as any,
              evidence: ["real-quickjs"],
            };
      },
    };
    const library = new HarnessLibrary(libraryBinding, journal);
    const mounted = options.deployment ? configuredBrowserWatchWebhooks({owner,destinations:()=>deployment()!.owners[owner]!.webhooks!,
      keys:()=>JSON.stringify({version:1,owners:{[owner]:{key:policy.signingKey}}}),current:()=>true,
      journal,blobs,kv,transport:{sandbox:sandbox!.sandbox,placement:"codegraff",codeTransport:async()=>{throw Error("unused");}}}) : undefined;
    const webhook = mounted?.webhook ?? createWebhookAdapterHost({
      owner,
      policies: () => [policy],
      currentOwner: () => true,
      journal,
      blobs,
      kv,
      transport: sandbox ? sandbox.transport() : {
        dispatchBoundary: "request",
        request: async (request) => {
          await beforeRequest();
          await request.beforeDispatch();
          calls.push(request);
          return { status: 202 };
        },
      },
    });
    channels = createHostedChannels(owner, () => host, webhook.adapters, {
      wiring: channelHarnessHandlers(
        libraryBinding,
        journal,
        async (o, authority) => o === owner && authority === "watch-grant",
      ),
      browserWatches: context => {
        const manual: ReturnType<BrowserWatchHostPolicy> = {
        library,
        receivingAuthority: "watch-grant",
        current: () => true,
        authorize: async () => true,
        prepareLease: async (c, identity) => ({
          grant: {
            owner,
            ...identity,
            profile: "owned",
            generation: c.sourceGeneration,
            connectionId: c.connectionId,
            connectionRevision: c.connectionRevision,
            origins: [c.origin],
            kinds: [c.kind],
            active: true,
            expiresAt: c.expiresAt,
            secret: "fixture-browser-producer-private-key-0000000",
          },
          ingestUrl: `https://aiko.example/v1/browser-events/${owner}`,
        }),
        configureLease: async (lease) => {
          privateLeases.set(lease.grant.producer, {
            producer: lease.grant.producer,
            generation: lease.grant.generation,
            lifecycleRevision: lease.lifecycleRevision ?? 0,
            state: "watching",
          });
        },
        pauseLease: async (producer, _signal, revision = 0) => {
          const previous = privateLeases.get(producer);
          if (previous && previous.lifecycleRevision === revision)
            privateLeases.set(producer, {
              ...previous,
              state: "paused",
              pausedThrough: Math.max(
                0,
                ...(await host.read(thread))
                  .filter((e) => browserEventKey(e) && e.producer === producer)
                  .map((e) => Number(e.sequence)),
              ),
            });
        },
        leaseStatus: async (producer) => privateLeases.get(producer),
        ...(nativeWebhook
          ? {
              nativeActions: {
                webhook: {
                  commitCurrent: (intent) => connectionCurrent && intent.event.owner === owner &&
                    intent.event.connectionId === config.connectionId && intent.event.connectionRevision === config.connectionRevision &&
                    Date.now() < policy.expiresAt,
                  resolve: async (destination) =>
                    destination === "saved-hook"
                      ? {
                          channel: channelId(owner, "webhook"),
                          generation: 1,
                          authorization: policy.sendAuthorityRef,
                          conversation: "new-requests",
                          deadlineAt: policy.expiresAt,
                        }
                      : undefined,
                },
              },
            }
          : {}),
        };
        if (!options.deployment) return manual;
        const authority = () => connectionCurrent ? {owner,connectionId:config.connectionId,native:true as const,status:"connected" as const,
          domain:new URL(config.origin).hostname,revision:7,expiresAt:policy.expiresAt} : undefined;
        const status = (producer:string) => ({...privateLeases.get(producer)!,state:privateLeases.get(producer)!.state as "watching"|"paused",reason:"fixture",expiresAt:policy.expiresAt});
        return configuredBrowserWatchPolicy({owner,configuration:deployment,library,receivingAuthority:"watch-grant",current:()=>true,webhooks:mounted,
          connections:{browserWatchAuthority:async()=>authority(),browserWatchAuthorities:async()=>authority()?[authority()!]:[],browserWatchCommitAuthority:()=>authority()},
          runner:{watchContext:async()=>({owner,profile:"owned"}),watchConfigure:async lease=>{await manual.configureLease(lease);return status(lease.grant.producer);},
            watchPause:async(producer,signal,revision)=>{await manual.pauseLease(producer,signal,revision);return status(producer);},
            watchStatus:async()=>[...privateLeases.keys()].map(status),watchAcknowledgeGap:async()=>{throw Error("unused");}},
        })!(context);
      },
    });
    const definition = createAikoActor({
      owner,
      channels,
      live: true,
      voice: createVoice({ enabled: false, persona: PERSONA }),
      memory: {
        owner,
        thread,
        stateDir,
        redact: (text) => text,
        readPage: (after, limit) => host.readPage(thread, after, limit),
      },
    });
    host = await createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "watch-webhook-assembly",
      ownsThread: (t) => t === thread,
      actorFor: () => definition,
      layersFor: () =>
        Layer.succeed(Infer, {
          resolve: () => ({
            model: { provider: "fixture", model_id: "unused" },
          }),
          react: () => Effect.die("Webhook watch must not call the model"),
        }),
      keyOf: (e) =>
        browserWatchEventKey(e) ??
        browserEventKey(e) ??
        channelLogSourceEventKey(e) ??
        channelWiringEventKey(e) ??
        harnessLibraryEventKey(e) ??
        channelEventKey(e),
      canAppend: (_t, batch, read) => {
        if (batch.some(event => event.type === "AikoBrowserWatchWebhookPermitted")) beforePermitCommit();
        return channels.dispatchAdmissionAllowed(batch, read) &&
        browserWatchAppendAllowed(batch, read) &&
        browserEventAppendAllowed(batch, read) &&
        channelLogSourceAppendAllowed(batch, read) &&
        channelWiringAppendAllowed(batch, read) &&
        harnessLibraryAppendAllowed(batch, read) &&
        channelAppendAllowed(batch, read);
      },
    });
    if (mounted && await mounted.initialize(channels)) await host.recover();
    await channels.refresh();
    return webhook;
  };
  const webhook = await open();
  cleanups.push(async () => {
    await host.close();
    await sandbox?.close();
    db.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const api = async (path: string, body: unknown) =>
    browserWatchApi(
      new Request(`https://aiko.example/api/channels/browser-watches/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      owner,
      channels.watches,
      { owner, scopes: ["write"] },
      () => {},
    );
  return {
    config,
    policy,
    calls,
    sandbox,
    revokeConnection: () => { connectionCurrent = false; },
    removeDestination: () => { destinationEnabled = false; },
    beforePermitCommit: (callback: () => void) => { beforePermitCommit = callback; },
    get channels() {
      return channels;
    },
    events: () => host.read(thread),
    hydrate: (ref: unknown) =>
      channelHydrate(harnessBlobStore(sqliteWorkflowKV(db)), owner, ref),
    drive: () => host.recover(),
    api,
    beforeRequest: (callback: () => Promise<void>) => {
      beforeRequest = callback;
    },
    setup: async () => {
      if (!options.deployment) await channels.run(
        channels.runtime.configure(
          webhook.bindingInput("requests", "webhook", 1),
        ),
      );
      await host.recover();
      const response = await api("configure", {
        config,
        expectedGeneration: 0,
      });
      expect(response.status).toBe(200);
      await host.recover();
    },
    ingest: async () => {
      const grant = channels.watches!.producerGrants()[0]!;
      const batch: BrowserEventBatch = {
        schema: BROWSER_EVENT_SCHEMA,
        producer: grant.producer,
        epoch: grant.epoch,
        generation: grant.generation,
        items: [
          {
            sequence: 1,
            occurrence: "push-1",
            kind: "push",
            observedAt: Date.now(),
            sourceId: "cdp-1",
            fields: { origin: config.origin, outcome: "received" },
            payload: { text: "PRIVATE_WATCH_PAYLOAD" },
          },
        ],
      };
      await channels.browserAdmission!(
        batch,
        browserBatchSignature(batch, grant.secret),
      );
      return { batch, signature: browserBatchSignature(batch, grant.secret) };
    },
    restart: async () => {
      await host.close();
      await open();
    },
    restoreStarted: async () => {
      expect(startedSnapshot).toBeDefined();await host.close();db.close();db=Database.deserialize(startedSnapshot!);await open();
    },
    restorePreparedWithoutCapability: async () => {
      expect(preparedSnapshot).toBeDefined();
      await host.close();
      db.close();
      db = Database.deserialize(preparedSnapshot!);
      nativeWebhook = false;
      await open();
    },
  };
}

test("owner API and signed browser event use real mapper and native webhook outbox receipts once across restart", async () => {
  const f = await fixture();
  await f.setup();
  const ingress = await f.ingest();
  await f.drive();
  expect(f.calls).toHaveLength(1);
  const request = f.calls[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(f.policy.url);
  expect(request.headers["x-aiko-proof"]).toBe(
    "v1=" +
      createHmac("sha256", f.policy.signingKey)
        .update(
          JSON.stringify([
            1,
            "send",
            request.operationId,
            request.url,
            request.body,
          ]),
        )
        .digest("hex"),
  );
  const envelope = JSON.parse(JSON.parse(request.body!).payload);
  expect(envelope.schema).toBe("aiko.browser-watch.webhook.v1");
  expect(envelope.event.kind).toBe("push");
  expect(request.body).not.toContain("PRIVATE_WATCH_PAYLOAD");
  const rows = await f.events();
  const claim = rows.find((e) => e.type === "AikoBrowserWatchStarted")!;
  expect(envelope.operationId).toBe(claim.id);
  const accepted = rows.find(
    (e) =>
      e.type === "AikoBrowserWatchActionAccepted" && e.operationId === claim.id,
  )!;
  expect(accepted).toBeDefined();
  expect(await f.hydrate(accepted.jobRef)).toMatchObject({
    receipt: { kind: "channel", id: claim.id },
    deadlineAt: accepted.deadlineAt,
  });
  expect(
    rows.some(
      (e) => e.type === "AikoChannelOutputPrepared" && e.id === claim.id,
    ),
  ).toBe(true);
  expect(
    rows.some(
      (e) => e.type === "AikoChannelOutputSettled" && e.id === claim.id,
    ),
  ).toBe(true);
  expect(await f.channels.watches!.inspect()).toMatchObject([
    { lastTaskStatus: "completed" },
  ]);
  const settled = rows.find(
    (e) => e.type === "AikoBrowserWatchSettled" && e.operationId === claim.id,
  )!;
  expect(rows.indexOf(settled)).toBeGreaterThan(rows.indexOf(accepted));
  expect(await f.hydrate(settled.resultRef)).toMatchObject({
    operationId: claim.id,
    delivery: { status: "accepted_by_provider" },
  });
  expect(rows.some((e) => e.type === "MessageReceived")).toBe(false);
  expect(JSON.stringify(rows)).not.toContain(f.policy.signingKey);
  await f.restart();
  await f.channels.browserAdmission!(ingress.batch, ingress.signature);
  await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([
    { lastTaskStatus: "completed" },
  ]);
}, 20_000);

test("pause after transport setup is checked again before the physical POST", async () => {
  const f = await fixture();
  await f.setup();
  let release!: () => void, arrive!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    arrived = new Promise<void>((r) => {
      arrive = r;
    });
  f.beforeRequest(async () => {
    arrive();
    await gate;
  });
  await f.ingest();
  const drive = f.drive();
  try {
    await Promise.race([
      arrived,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("transport setup not reached")), 8000),
      ),
    ]);
    expect(
      (
        await f.api("control", {
          id: f.config.id,
          status: "paused",
          expectedRevision: 0,
        })
      ).status,
    ).toBe(200);
  } finally {
    release();
    await drive;
  }
  expect(f.calls).toHaveLength(0);
  expect(await f.channels.watches!.inspect()).toMatchObject([
    { status: "paused" },
  ]);
  await f.restart();
  await f.drive();
  expect(f.calls).toHaveLength(0);
}, 20_000);

test("restoring queued outbox without the watch webhook capability cannot dispatch through the configured provider", async () => {
  const f = await fixture();
  await f.setup();
  f.beforeRequest(async () => {
    throw Error("fixture interrupted before socket dispatch");
  });
  await f.ingest();
  await f.drive();
  expect(f.calls).toHaveLength(0);
  await f.restorePreparedWithoutCapability();
  const before = await f.events();
  expect(before.some((e) => e.type === "AikoChannelOutputPrepared")).toBe(true);
  expect(before.some((e) => e.type === "AikoChannelOutputStarted")).toBe(false);
  f.beforeRequest(async () => {});
  await f.drive();
  expect(f.calls).toHaveLength(0);
}, 20_000);

// This joins native watch/source/mapper/outbox and permit admission to the real
// encrypted private runner protocol. Only producer input, owned VM readiness,
// DNS answers and the final local socket destination are substituted.
test("native watch commits exact webhook permit before encrypted private HTTP and preserves receipt across both restarts",async()=>{
  const f=await fixture({guarded:true}),privateRunner=f.sandbox!;
  await f.setup();
  privateRunner.beforeContinue(async()=>{
    expect(privateRunner.sockets).toBe(0);
    const rows=await f.events(),permit=rows.find(e=>e.type==="AikoBrowserWatchWebhookPermitted");
    expect(permit).toBeDefined();
    const continuation=privateRunner.operations.at(-1).input;
    expect(permit).toMatchObject({jobDigest:continuation.jobDigest,requestDigest:continuation.requestDigest,nonce:continuation.nonce});
  });
  await f.ingest();await f.drive();
  expect(privateRunner.sockets).toBe(1);expect(privateRunner.received).toHaveLength(1);
  const wire=privateRunner.received[0]!,envelope=JSON.parse(wire.body);
  expect(wire.headers["x-aiko-proof"]).toBe("v1="+createHmac("sha256",f.policy.signingKey).update(JSON.stringify([1,"send",envelope.deliveryId,f.policy.url,wire.body])).digest("hex"));
  expect(wire.body).not.toContain("PRIVATE_WATCH_PAYLOAD");
  expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"completed"}]);
  const before=await f.events();expect(before.filter(e=>e.type==="AikoBrowserWatchWebhookPermitted")).toHaveLength(1);
  expect((await privateRunner.receipt()).status).toBe("completed");
  await f.restart();await privateRunner.restart();await f.drive();
  expect(privateRunner.sockets).toBe(1);expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchWebhookPermitted")).toHaveLength(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"completed"}]);
},20000);

test("pause before native webhook permit prevents the real private socket",async()=>{
  const f=await fixture({guarded:true}),privateRunner=f.sandbox!;
  await f.setup();let release!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  privateRunner.transform(async reply=>{if(reply.status==="awaiting-dispatch"){enter();await gate;}return reply;});
  await f.ingest();const running=f.drive();
  try {
    await Promise.race([entered,Bun.sleep(8000).then(()=>{throw Error("Private challenge not reached");})]);
    expect(privateRunner.sockets).toBe(0);
    expect((await f.api("control",{id:f.config.id,status:"paused",expectedRevision:0})).status).toBe(200);
  }finally{release();await running;}
  expect(privateRunner.sockets).toBe(0);
  expect((await f.events()).some(e=>e.type==="AikoBrowserWatchWebhookPermitted")).toBe(false);
  await f.restart();await privateRunner.restart();await f.drive();expect(privateRunner.sockets).toBe(0);
},20000);

test("pause after native webhook permit retains in-flight delivery and cannot cause a second POST",async()=>{
  const f=await fixture({guarded:true}),privateRunner=f.sandbox!;
  await f.setup();let release!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  privateRunner.beforeContinue(async()=>{enter();await gate;});
  await f.ingest();const running=f.drive();
  try {
    await Promise.race([entered,Bun.sleep(8000).then(()=>{throw Error("Native permit not reached");})]);
    expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchWebhookPermitted")).toHaveLength(1);
    expect(privateRunner.sockets).toBe(0);
    expect((await f.api("control",{id:f.config.id,status:"paused",expectedRevision:0})).status).toBe(200);
  }finally{release();await running;}
  expect(privateRunner.sockets).toBe(1);expect((await privateRunner.receipt()).status).toBe("completed");
  const id=JSON.parse(privateRunner.received[0]!.body).deliveryId;
  expect(await f.channels.watches!.inspect()).toMatchObject([{status:"paused"}]);
  await f.restart();await privateRunner.restart();await f.drive();expect(privateRunner.sockets).toBe(1);
  expect(JSON.parse(privateRunner.received[0]!.body).deliveryId).toBe(id);
},20000);

test("native permit with lost encrypted continuation acknowledgement stays uncertain across restart without redispatch",async()=>{
  const f=await fixture({guarded:true}),privateRunner=f.sandbox!;
  await f.setup();privateRunner.loseContinuationReply();await f.ingest();await f.drive();
  expect(privateRunner.sockets).toBe(1);expect((await privateRunner.receipt()).status).toBe("completed");
  const before=await f.events(),permit=before.find(e=>e.type==="AikoBrowserWatchWebhookPermitted")!;
  expect(permit).toBeDefined();
  const deliveryId=JSON.parse(privateRunner.received[0]!.body).deliveryId;
  expect(privateRunner.jobs[0]!.operationId).toBe(`webhook:${deliveryId}`);
  const operationCount=privateRunner.operations.length;
  expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"unknown"}]);
  await f.restart();await privateRunner.restart();await f.drive();
  expect(privateRunner.sockets).toBe(1);
  expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchWebhookPermitted")).toEqual([permit]);
  expect(JSON.parse(privateRunner.received[0]!.body).deliveryId).toBe(deliveryId);
  expect(privateRunner.operations.filter(value=>value.operation==="guarded-continue")).toHaveLength(1);
  expect(privateRunner.operations.slice(operationCount).every(value=>value.operation==="harness-receipt")).toBe(true);
  expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"unknown"}]);
},20000);

test("synchronous connection revocation at actual native permit append denies the prepared private socket",async()=>{
  const f=await fixture({guarded:true}),privateRunner=f.sandbox!;await f.setup();let commits=0;
  f.beforePermitCommit(()=>{commits++;f.revokeConnection();});
  await f.ingest();await f.drive();
  expect(commits).toBe(1);expect(privateRunner.dns).toBe(1);expect(privateRunner.sockets).toBe(0);
  expect((await f.events()).some(event=>event.type==="AikoBrowserWatchWebhookPermitted")).toBe(false);
  expect(privateRunner.operations.filter(value=>value.operation==="guarded-continue"&&value.input.allow)).toHaveLength(0);
  await f.restart();await privateRunner.restart();await f.drive();expect(privateRunner.sockets).toBe(0);
},20000);

for (const change of ["key", "url", "removal"] as const) test(`configured destination ${change} cannot remap an accepted watch task before outbox preparation`,async()=>{
  const f=await fixture({guarded:true,deployment:true}),privateRunner=f.sandbox!;
  await f.setup();await f.ingest();await f.drive();expect(privateRunner.sockets).toBe(1);
  const original=f.events(),beforeSockets=privateRunner.sockets;
  if (change === "key") f.policy.signingKey="ROTATED_PRIVATE_KEY_REQUIRES_NEW_DESTINATION_000000";
  else if (change === "url") f.policy.url="https://hooks.receiver.com/new-destination";
  else f.removeDestination();
  await f.restoreStarted();
  const cut=await f.events();expect(cut.some(e=>e.type==="AikoBrowserWatchStarted")).toBe(true);
  expect(cut.some(e=>e.type==="AikoChannelOutputPrepared")).toBe(false);
  await f.drive();expect(privateRunner.sockets).toBe(beforeSockets);
  expect((await f.events()).some(e=>e.type==="AikoChannelOutputPrepared")).toBe(false);
  expect((await f.events()).filter(e=>e.type==="AikoChannelBindingIntent")).toEqual((await original).filter(e=>e.type==="AikoChannelBindingIntent"));
  const discovery=await f.channels.watches!.discovery(AbortSignal.timeout(5000));expect(discovery.actions).toEqual([]);
},30000);
