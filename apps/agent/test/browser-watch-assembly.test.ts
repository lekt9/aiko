import { browserWatchApi } from "../src/browser-watch-api.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import type { Event } from "tardie/core/event";
import { createAikoActor } from "../src/actor.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { channelHarnessHandlers, createHostedChannels } from "../src/channel-host.ts";
import { channelWiringAppendAllowed, channelWiringEventKey } from "../src/channel-wiring.ts";
import { channelLogSourceAppendAllowed, channelLogSourceEventKey } from "../src/channel-log-source.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey, type HarnessLibraryBinding, type HarnessJournal } from "../src/harness-library.ts";
import { BROWSER_EVENT_SCHEMA, browserBatchSignature, browserEventAppendAllowed, browserEventKey, type BrowserEventBatch, type BrowserProducerGrant } from "../src/browser-events.ts";
import { browserWatchAppendAllowed, browserWatchEventKey, browserWatchHarnessDefinitions, type BrowserWatchConfig, type BrowserWatchDispatch } from "../src/browser-watches.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createVoice } from "../src/voice.ts";
import { PERSONA } from "../src/config.ts";
import { withRequiredResponse } from "../src/channel-response.ts";
import { BrowserWatchRunner } from "../src/browser-watch-runner.ts";
import { BrowserObservationQueue } from "../src/browser-event-queue.ts";
import { LocalKeyring, VaultCipher } from "../../server/src/crypto.ts";
import type { BackgroundListenerOptions } from "../src/cdp-background-listener.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(enabled = true, nativeHarness = false, realPrivateQueue = false, nativeActor = false) {
  const owner = "watch-assembly", thread = `user-${owner}`, db = new Database(":memory:");
  const stateDir = await mkdtemp("/tmp/browser-watch-assembly-");
  let alarm: number | null = null, active = true, externalActive = false, models = 0;
  let revokeAtActorCommit=false,actorCommitCuts=0,commitAuthority=true;
  let external: BrowserProducerGrant | undefined;
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {},
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const calls: BrowserWatchDispatch[] = [], leases: string[] = [];
  const privateLeases = new Map<string, {producer:string;generation:number;state:string;lifecycleRevision:number;pausedThrough?:number}>();
  const definitions = browserWatchHarnessDefinitions();
  const config: BrowserWatchConfig = { id: "new-request", label: "New requests", connectionId: "site", connectionRevision: "r1", sourceGeneration: 1,
    origin: "https://site.example", kind: "push", outcome: "received", action: nativeHarness ? {kind:"harness",digest:harnessDigest(definitions[0]!.artifact),contractDigest:harnessDigest(definitions[0]!.contract),input:definitions[0]!.verifier.cases[0]!.input} : { kind: "actor", instruction: "Summarize the new request" },
    expiresAt: Date.now() + 600_000, backlog: 8, maxOccurrences: 256 };
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>, channels!: ReturnType<typeof createHostedChannels>;
  let relay = false, loseRenewalReply=false, pendingActions=false;
  const pendingDeadlines=new Map<string,number>();
  const reconciled:BrowserWatchDispatch[]=[];
  const captures:BackgroundListenerOptions[]=[];
  const runnerOptions:ConstructorParameters<typeof BrowserWatchRunner>[0]={owner,db,
    cipher:new VaultCipher(new LocalKeyring("fixture",{fixture:Buffer.alloc(32,3).toString("base64")})),
    endpoint:async()=>"ws://127.0.0.1:9999/fixture",authorized:()=>active,
    fetch:async(_url,init)=>{
      if(!relay)return new Response(null,{status:503});
      const result=await channels.browserAdmission!(JSON.parse(String(init?.body)),new Headers(init?.headers).get("x-browser-signature")!);
      return Response.json(result,{status:202});
    },
    createCapture:options=>{captures.push(options);return {health:{state:"watching",reason:"ready",targets:1,atMs:Date.now()},
      connect:async()=>{},close:async()=>{},renewRecording:async()=>{},flush:async()=>{}};},
  };
  let privateRunner=realPrivateQueue?new BrowserWatchRunner(runnerOptions):undefined;
  const journal: HarnessJournal = { read: () => host.read(thread), append: async events => { for (const event of events) await host.commitRoot(host.self(thread), event); } };
  const libraryBinding: HarnessLibraryBinding = { owner, thread, blobs: harnessBlobStore(sqliteWorkflowKV(db)), guard: () => {},
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest("watch-assembly"), bindings: {} }),
    verifiers: new Map(definitions.map(d => [d.verifier.digest, d.verifier])), authorize: async () => active,
    execute: async (job, signal) => {
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, signal);
      return result.error ? { status: "failed", evidence: ["quickjs-error"] } : { status: "succeeded", output: result.result as any, evidence: ["real-quickjs"] };
    } };
  const library = new HarnessLibrary(libraryBinding, journal);
  const model = withRequiredResponse(Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "watch-assembly" } }),
    react: request => {
      models++;
      if (nativeActor && request.identity.turn.startsWith("watch:"))
        return Effect.succeed({kind:"complete" as const,output:"The saved watch task finished."});
      if (!request.trajectory.some(e => e.type === "ToolReturned" && e.turn === request.identity.turn)) return Effect.succeed({
        kind: "call" as const, callId: `configure:${request.identity.turn}`, name: "browser_watch_configure", arguments: { config, expectedGeneration: 0 },
      });
      return Effect.succeed({ kind: "complete" as const, output: "Watch setup returned." });
    },
  }));
  const open = async (refresh = true) => {
    channels = createHostedChannels(owner, () => host, undefined, {
      wiring: channelHarnessHandlers(libraryBinding, journal, async (o, authority) => o === owner && authority === "watch-grant" && active),
      browserProducers: { current: () => externalActive, grant: producer => external?.producer === producer ? external : undefined },
      ...(enabled ? { browserWatches: () => ({ library, receivingAuthority: "watch-grant", current: () => active, authorize: async () => active&&commitAuthority,
        discovery: async () => ({sites:[{connectionId:config.connectionId,label:"Requests site",origin:config.origin,connectionRevision:config.connectionRevision,sourceGeneration:config.sourceGeneration,
          privateProducerSecret:"DO_NOT_RETURN",events:[{id:"new-request",label:"New request",kind:config.kind,outcome:config.outcome}]}],
          actions:[{id:"saved",label:"Saved action",action:config.action},...(nativeHarness?[{id:"unbound",label:"Unbound actor",action:{kind:"actor" as const,instruction:"Not configured"}}]:[])],defaults:{expiresInMs:600000,backlog:8,maxOccurrences:256}}),
        prepareLease: async (c: BrowserWatchConfig, identity: { producer: string; epoch: string; registeredAt: number }) => ({ grant: { owner, ...identity, profile: "owned", generation: c.sourceGeneration,
          connectionId: c.connectionId, connectionRevision: c.connectionRevision, origins: [c.origin], kinds: [c.kind], active: true, expiresAt: c.expiresAt,
          secret: "watch-assembly-private-producer-key-0000000" }, ingestUrl: `https://aiko.example/v1/browser-events/${owner}` }),
        configureLease: async (lease: import("../src/browser-watches.ts").BrowserWatchLease) => { leases.push(lease.grant.producer);if(privateRunner){const status=await privateRunner.configure(lease);if(loseRenewalReply&&(lease.leaseRevision??0)>0){loseRenewalReply=false;throw Error("fixture-renewal-ack-lost");}return status;}privateLeases.set(lease.grant.producer,{producer:lease.grant.producer,generation:lease.grant.generation,lifecycleRevision:lease.lifecycleRevision??0,state:"watching"}); },
        pauseLease: async (producer:string,_signal?:AbortSignal,lifecycleRevision=0) => { if(privateRunner)return privateRunner.pause(producer,lifecycleRevision);const prior=privateLeases.get(producer);if(prior&&prior.lifecycleRevision===lifecycleRevision)privateLeases.set(producer,{...prior,state:"paused",pausedThrough:Math.max(0,...(await host.read(thread)).filter(e=>browserEventKey(e)&&e.producer===producer).map(e=>Number(e.sequence)))}); },
        leaseStatus: async (producer:string) => privateRunner ? privateRunner.status().find(s=>s.producer===producer) : privateLeases.get(producer),
        ...(nativeActor ? {nativeActions:{actor:{timeoutMs:60000,commitCurrent:()=>active&&commitAuthority}}} : nativeHarness ? {} : {
          execute: async (intent: BrowserWatchDispatch) => { calls.push(structuredClone(intent));if(pendingActions)pendingDeadlines.set(intent.operationId,Date.now()+60000);return pendingActions?
            {status:"pending" as const,receipt:{kind:"actor" as const,id:intent.operationId},deadlineAt:pendingDeadlines.get(intent.operationId)!}:
            { status: "completed" as const, result: { receipt: intent.operationId } }; },
          reconcile:async(intent:BrowserWatchDispatch)=>{reconciled.push(structuredClone(intent));return pendingActions?
            {status:"pending" as const,receipt:{kind:"actor" as const,id:intent.operationId},deadlineAt:pendingDeadlines.get(intent.operationId)!}:
            {status:"completed" as const,result:{receipt:intent.operationId}};},
        }),
      }) } : {}),
    });
    const definition = createAikoActor({ owner, channels, live: true, voice: createVoice({ enabled: false, persona: PERSONA }),
      memory: { owner, thread, stateDir, redact: text => text, readPage: (after, limit) => host.readPage(thread, after, limit) } });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "watch-assembly", ownsThread: t => t === thread,
      actorFor: () => definition, layersFor: () => model,
      canDeliver: (_t,batch,read) => {
        if(revokeAtActorCommit&&batch.some(e=>e.type==="MessageReceived"&&String(e.id).startsWith("watch:"))){commitAuthority=false;actorCommitCuts++;}
        return channels.actorAdmissionAllowed(batch,read) && browserWatchAppendAllowed(batch,read);
      },
      keyOf: e => browserWatchEventKey(e) ?? browserEventKey(e) ?? channelLogSourceEventKey(e) ?? channelWiringEventKey(e) ?? harnessLibraryEventKey(e),
      canAppend: (_t, batch, read) => channels.actorAdmissionAllowed(batch,read) && browserWatchAppendAllowed(batch, read) && browserEventAppendAllowed(batch, read) && channelLogSourceAppendAllowed(batch, read) && channelWiringAppendAllowed(batch, read) && harnessLibraryAppendAllowed(batch, read),
    });
    if (refresh) await channels.refresh();
  };
  await open();
  cleanups.push(async () => { await privateRunner?.close();await host.close(); db.close(); await rm(stateDir, { recursive: true, force: true }); });
  const makeBatch = (grant: BrowserProducerGrant, sequence = 1): BrowserEventBatch => ({ schema: BROWSER_EVENT_SCHEMA, producer: grant.producer, epoch: grant.epoch, generation: grant.generation,
    items: [{ sequence, occurrence: `push-${sequence}`, kind: "push", observedAt: Date.now(), sourceId: `cdp-${sequence}`, fields: { origin: config.origin, outcome: "received" }, payload: { request: sequence, text: "PRIVATE_WATCH_PAYLOAD" } }] });
  return { config, calls, leases, library, get channels() { return channels; }, models: () => models, events: () => host.read(thread), drive: () => host.recover(), makeBatch,
    get privateRunner(){return privateRunner;}, privateQueue:new BrowserObservationQueue(db),setRelay:(enabled:boolean)=>{relay=enabled;},
    loseRenewalReply:()=>{loseRenewalReply=true;},pendingActions:()=>{pendingActions=true;},reconciled,
    restartPrivate:async()=>{await privateRunner!.close();privateRunner=new BrowserWatchRunner(runnerOptions);await privateRunner.restore();},
    revokeActorAtCommit:()=>{revokeAtActorCommit=true;},actorCommitCuts:()=>actorCommitCuts,
    capture:async(id:string,at=Date.now())=>captures.at(-1)!.onEvent({service:"pushMessaging",origin:config.origin,serviceWorkerRegistrationId:"fixture",storageKey:"fixture",timestamp:at/1000,
      eventName:"Push message received",instanceId:id,eventMetadata:[],observedAtMs:Date.now(),historical:false}),
    setup: async () => { await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "watch-setup", at: Date.now(), text: "Watch new requests" }); await host.recover(); },
    restart: async (refresh = true) => { await host.close(); await open(refresh); }, revoke: () => { active = false; },
    setExternal: (grant: BrowserProducerGrant, current: boolean) => { external = grant; externalActive = current; },
  };
}

test("hosted actor tools configure a watch and its mounted native component dispatches once across restart", async () => {
  const f = await fixture(); await f.setup();
  expect(f.leases).toEqual(["watch-new-request"]);
  expect((await f.events()).some(e => e.type === "ToolReturned" && String(e.callId).startsWith("configure:"))).toBe(true);
  const grant = f.channels.watches!.producerGrants()[0]!, batch = f.makeBatch(grant);
  const models = f.models();
  await f.channels.browserAdmission!(batch, browserBatchSignature(batch, grant.secret)); await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.action).toEqual(f.config.action);
  expect((await f.events()).some(e => e.type === "AikoBrowserWatchSettled" && e.status === "completed")).toBe(true);
  expect(f.models()).toBe(models);
  await f.restart(false);
  expect(f.channels.watches!.producerGrants()).toEqual([]);
  // Signed ingress restores encrypted grant projections even before explicit recovery.
  await f.channels.browserAdmission!(batch, browserBatchSignature(batch, grant.secret)); await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([{ status: "watching", lastTaskStatus: "completed" }]);
  expect(JSON.stringify(await f.events())).not.toContain("PRIVATE_WATCH_PAYLOAD");
  expect(JSON.stringify(await f.events())).not.toContain(grant.secret);
  await f.restart();
  const next = f.makeBatch(grant, 2);
  await f.channels.browserAdmission!(next, browserBatchSignature(next, grant.secret)); await f.drive();
  expect(f.calls).toHaveLength(2);
  f.revoke();
  const revoked = f.makeBatch(grant, 3);
  await expect(f.channels.browserAdmission!(revoked, browserBatchSignature(revoked, grant.secret))).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
});

test("default actor watch calls the canonical native method and waits for its response across restart", async () => {
  const f=await fixture(true,false,false,true);await f.setup();
  const grant=f.channels.watches!.producerGrants()[0]!,batch=f.makeBatch(grant);
  await f.channels.browserAdmission!(batch,browserBatchSignature(batch,grant.secret));await f.drive();
  const rows=await f.events(),started=rows.find(e=>e.type==="AikoBrowserWatchStarted")!;
  expect(started).toBeDefined();expect(f.calls).toHaveLength(0);
  expect(rows.some(e=>e.type==="CallPlanned"&&e.id===started.id&&e.method==="message")).toBe(true);
  expect(rows.filter(e=>e.type==="MessageReceived"&&e.id===started.id)).toHaveLength(1);
  expect(rows.some(e=>e.type==="AikoBrowserWatchActionAccepted"&&e.operationId===started.id)).toBe(true);
  expect(rows.some(e=>e.type==="ResponseReceived"&&e.call===started.id)).toBe(true);
  expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"completed"}]);
  const modelCalls=f.models();await f.restart();await f.drive();
  expect(f.models()).toBe(modelCalls);
  expect((await f.events()).filter(e=>e.type==="MessageReceived"&&e.id===started.id)).toHaveLength(1);
});

test("hosted actor watch cannot cross an authority revocation at the actual native message commit",async()=>{
  const f=await fixture(true,false,false,true);await f.setup();
  const models=f.models(),grant=f.channels.watches!.producerGrants()[0]!,batch=f.makeBatch(grant);
  f.revokeActorAtCommit();await f.channels.browserAdmission!(batch,browserBatchSignature(batch,grant.secret));await f.drive();
  const rows=await f.events(),started=rows.find(e=>e.type==="AikoBrowserWatchStarted")!;
  expect(started).toBeDefined();expect(f.actorCommitCuts()).toBe(1);
  expect(rows.some(e=>e.type==="MessageReceived"&&e.id===started.id)).toBe(false);
  expect(rows.some(e=>e.type==="CallDispatched"&&e.id===started.id)).toBe(false);
  expect(f.models()).toBe(models);
  await f.restart();await f.drive();expect(f.models()).toBe(models);
});

test("watch authority does not enable an inactive configured producer and duplicate identities fail closed", async () => {
  const f = await fixture(); await f.setup();
  const watched = f.channels.watches!.producerGrants()[0]!;
  const external = { ...watched, producer: "external-producer", epoch: "external-profile" };
  f.setExternal(external, false);
  const b = f.makeBatch(external);
  await expect(f.channels.browserAdmission!(b, browserBatchSignature(b, external.secret))).rejects.toThrow();
  f.setExternal(external, true);
  await f.channels.browserAdmission!(b, browserBatchSignature(b, external.secret));
  f.setExternal(watched, true);
  const collision = f.makeBatch(watched);
  await expect(f.channels.browserAdmission!(collision, browserBatchSignature(collision, watched.secret))).rejects.toThrow();
});

test("disabled watch policy mounts no watches or implicit source authority", async () => {
  const f = await fixture(false);
  expect(f.channels.watches).toBeUndefined(); expect(f.channels.logSources).toBeUndefined();
  await f.channels.refresh();
  expect((await f.events()).some(e => e.type.startsWith("AikoBrowserWatch"))).toBe(false);
});


test("owner watch API shares native tools, rejects foreign/read-only mutation and keeps producer secrets private", async () => {
  const f=await fixture(),owner="watch-assembly";let wakes=0;
  const call=(path:string,body?:unknown,principal={owner,scopes:["read","write"]})=>browserWatchApi(new Request(`https://aiko.example/api/channels/browser-watches${path}`,{
    method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),owner,f.channels.watches,principal,()=>{wakes++;});
  const discovery=await call("/discovery");expect(discovery.status).toBe(200);
  const available=await discovery.json() as any;expect(available.result.sites[0]).toMatchObject({connectionId:f.config.connectionId,connectionRevision:f.config.connectionRevision});
  expect(JSON.stringify(available)).not.toContain("DO_NOT_RETURN");
  expect(f.leases).toEqual([]);
  expect((await call("/configure",{config:f.config,expectedGeneration:0},{owner:"foreign",scopes:["read","write"]})).status).toBe(403);
  expect((await call("/configure",{config:f.config,expectedGeneration:0},{owner,scopes:["read"]})).status).toBe(403);
  expect((await call("/configure",{config:f.config,expectedGeneration:0,producerSecret:"untrusted"})).status).toBe(400);
  expect(f.leases).toEqual([]);
  expect((await call("/configure",{config:f.config,expectedGeneration:0})).status).toBe(200);
  await f.drive();expect(f.leases).toEqual(["watch-new-request"]);
  const status=await call("");expect(status.status).toBe(200);expect(status.headers.get("cache-control")).toBe("no-store");
  const text=await status.text();expect(text).toContain("new-request");expect(text).not.toContain(f.channels.watches!.producerGrants()[0]!.secret);
  expect((await call("/sample",{id:f.config.id})).status).toBe(200);
  expect(f.calls).toHaveLength(0);
  expect((await call("/control",{id:f.config.id,status:"paused",expectedRevision:0})).status).toBe(200);
  expect((await call("/control",{id:f.config.id,status:"active",expectedRevision:0})).status).toBe(409);
  expect(f.channels.watches!.producerGrants()[0]!.active).toBe(false);
  expect(wakes).toBe(3);
  f.revoke();expect((await call("")).status).toBe(409);
});


test("hosted watch defaults execute a pinned harness through the native library without a custom action callback", async () => {
  const f=await fixture(true,true),definition=browserWatchHarnessDefinitions()[0]!;
  await f.library.registerContract(definition.contract);await f.library.record(definition.artifact);
  const discovery=await f.channels.watches!.discovery(AbortSignal.timeout(1000));
  expect(discovery.actions.map(choice=>choice.id)).toEqual(["saved"]);
  await expect(f.channels.watches!.configure({...f.config,action:{kind:"actor",instruction:"Not configured"}},0,AbortSignal.timeout(1000))).rejects.toThrow("watch_authority_unavailable");
  await f.setup();
  const grant=f.channels.watches!.producerGrants()[0]!,batch=f.makeBatch(grant);
  const models=f.models();await f.channels.browserAdmission!(batch,browserBatchSignature(batch,grant.secret));await f.drive();
  const rows=await f.events(),started=rows.find(e=>e.type==="AikoBrowserWatchStarted")!;
  expect(started).toBeDefined();
  expect(rows.find(e=>e.type==="AikoHarnessRunStarted"&&e.id===started.id)).toMatchObject({caseId:null});
  expect(rows.find(e=>e.type==="AikoHarnessChecked"&&e.id===started.id)).toMatchObject({witness:{status:"satisfied"}});
  expect(rows.find(e=>e.type==="AikoBrowserWatchSettled"&&e.operationId===started.id)).toMatchObject({status:"completed"});
  expect(f.calls).toHaveLength(0);expect(f.models()).toBe(models);
  await f.restart();await f.channels.browserAdmission!(batch,browserBatchSignature(batch,grant.secret));await f.drive();
  expect((await f.events()).filter(e=>e.type==="AikoHarnessRunStarted"&&e.id===started.id)).toHaveLength(1);
});

test("private queued observations cross native resume as history while fresh observations execute once",async()=>{
  const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);
  await f.channels.watches!.configure(f.config,0,signal());await f.drive();
  await f.capture("queued-before-pause");
  expect((await f.events()).filter(e=>browserEventKey(e))).toHaveLength(0);
  const paused=await f.channels.watches!.control(f.config.id,"paused",0,signal());
  expect(paused.release).toMatchObject({status:"confirmed"});
  expect(f.privateRunner!.status()[0]).toMatchObject({lifecycleRevision:0,pausedThrough:1,state:"paused"});
  await f.restart();f.setRelay(true);
  await f.channels.watches!.control(f.config.id,"active",1,signal());await f.drive();
  expect((await f.events()).filter(e=>browserEventKey(e)).map(e=>e.sequence)).toEqual([1]);
  expect(f.calls).toHaveLength(0);
  await expect(f.privateRunner!.pause("watch-new-request",0)).rejects.toThrow("stale_lifecycle");
  expect(f.privateRunner!.status()[0]).toMatchObject({lifecycleRevision:2,state:"watching"});
  await f.capture("new-after-resume");await f.privateRunner!.tick();await f.drive();
  expect(f.calls).toHaveLength(1);expect(f.calls[0]!.event.sequence).toBe(2);
  const models=f.models();await f.restart();await f.privateRunner!.tick();await f.drive();
  expect(f.calls).toHaveLength(1);expect(f.models()).toBe(models);
});

test("renew API tops up an exhausted native source with actual private lease proof and no cursor or receipt reset",async()=>{
  const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);f.config.maxOccurrences=1;
  await f.channels.watches!.configure(f.config,0,signal());f.setRelay(true);
  const grant=f.channels.watches!.producerGrants()[0]!;
  await f.capture("first-budget");await f.privateRunner!.tick();await f.drive();
  const initial=await f.events(),cut=initial.find(e=>e.type==="AikoChannelLogSourceCut")!,activation=initial.find(e=>e.type==="AikoBrowserWatchActivated")!;
  const receipt=initial.find(e=>e.type==="AikoBrowserWatchSettled"&&e.status==="completed")!;
  expect(receipt).toBeDefined();expect(f.calls).toHaveLength(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([{generation:1,leaseRevision:0,budget:{used:1,limit:1,remaining:0},source:{reason:"source_occurrence_budget"}}]);
  const args={id:f.config.id,expectedGeneration:1,expectedLeaseRevision:0,expiresAt:f.config.expiresAt+60000,maxOccurrences:3};
  const api=(body:unknown,scopes=["read","write"])=>browserWatchApi(new Request("https://aiko.example/api/channels/browser-watches/renew",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),"watch-assembly",f.channels.watches,{owner:"watch-assembly",scopes},()=>{});
  expect((await api(args,["read"])).status).toBe(403);expect((await api({...args,leaseRevision:99})).status).toBe(400);
  const response=await api(args);expect(response.status).toBe(200);expect((await response.json() as any).result).toMatchObject({status:"confirmed",leaseRevision:1});
  expect(f.privateRunner!.status()[0]).toMatchObject({leaseRevision:1,expiresAt:args.expiresAt});
  const renewed=f.channels.watches!.producerGrants()[0]!;
  expect({...renewed,expiresAt:grant.expiresAt}).toEqual(grant);
  expect(f.privateQueue.highWatermark(renewed)).toBe(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([{generation:1,leaseRevision:1,budget:{used:1,limit:3,remaining:2}}]);
  await f.restart();await f.restartPrivate();
  expect((await api(args)).status).toBe(200);
  for(const id of ["second-budget","third-budget"]){await f.capture(id);await f.privateRunner!.tick();await f.drive();}
  expect(f.calls.map(call=>call.event.sequence)).toEqual([1,2,3]);
  const rows=await f.events();expect(rows.filter(e=>e.type==="AikoChannelLogSourceCut")).toEqual([cut]);
  expect(rows.filter(e=>e.type==="AikoBrowserWatchActivated")).toEqual([activation]);
  expect(rows.filter(e=>e.type==="AikoBrowserWatchPrepared")).toHaveLength(1);
  expect(rows.find(e=>e.type==="AikoBrowserWatchSettled"&&e.id===receipt.id)).toEqual(receipt);
  expect(rows.filter(e=>e.type==="AikoChannelLogSourceRenewed")).toHaveLength(1);
  expect(rows.filter(e=>e.type==="AikoChannelLogSourceExhausted")).toHaveLength(2);
  expect(await f.channels.watches!.inspect()).toMatchObject([{budget:{used:3,limit:3,remaining:0},source:{reason:"source_occurrence_budget"}}]);
  expect((await api({...args,maxOccurrences:4})).status).toBe(409);
  expect(f.privateQueue.highWatermark(renewed)).toBe(3);
});

test("paused renewal preserves native history and the private queue until separate resume",async()=>{
  const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);
  await f.channels.watches!.configure(f.config,0,signal());await f.capture("queued-before-renewal-pause");
  await f.channels.watches!.control(f.config.id,"paused",0,signal());
  const args={id:f.config.id,expectedGeneration:1,expectedLeaseRevision:0,expiresAt:f.config.expiresAt+60000,maxOccurrences:512};
  expect(await f.channels.watches!.renew(args,signal())).toMatchObject({status:"confirmed",leaseRevision:1});
  expect(f.privateRunner!.status()[0]).toMatchObject({state:"paused",leaseRevision:1,lifecycleRevision:0,pausedThrough:1});
  expect(await f.channels.watches!.inspect()).toMatchObject([{status:"paused",leaseRevision:1}]);
  await f.restart();await f.restartPrivate();f.setRelay(true);
  await f.channels.watches!.control(f.config.id,"active",1,signal());await f.drive();
  expect(f.privateRunner!.status()[0]).toMatchObject({state:"watching",leaseRevision:1,lifecycleRevision:2});
  expect((await f.events()).filter(e=>browserEventKey(e)).map(e=>e.sequence)).toEqual([1]);expect(f.calls).toHaveLength(0);
  await f.capture("after-renewal-resume");await f.privateRunner!.tick();await f.drive();
  expect(f.calls.map(call=>call.event.sequence)).toEqual([2]);
});

test("lost real private renewal acknowledgement is adopted after restart without another configure or action",async()=>{
  const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);
  await f.channels.watches!.configure(f.config,0,signal());f.loseRenewalReply();
  const args={id:f.config.id,expectedGeneration:1,expectedLeaseRevision:0,expiresAt:f.config.expiresAt+60000,maxOccurrences:512};
  expect(await f.channels.watches!.renew(args,signal())).toMatchObject({status:"pending"});
  expect(f.privateRunner!.status()[0]!.leaseRevision).toBe(1);expect(f.channels.watches!.producerGrants()[0]!.expiresAt).toBe(f.config.expiresAt);
  const count=f.leases.length;await f.restart();await f.restartPrivate();
  expect(await f.channels.watches!.renew(args,signal())).toMatchObject({status:"confirmed",leaseRevision:1});
  expect(f.leases).toHaveLength(count);expect(f.calls).toHaveLength(0);
  expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchLeaseRenewalRequested")).toHaveLength(1);
  expect((await f.events()).filter(e=>e.type==="AikoChannelLogSourceRenewed")).toHaveLength(1);
  await expect(f.channels.watches!.renew({...args,expiresAt:args.expiresAt+1},signal())).rejects.toThrow("renewal_conflict");
});

test("renewal and action upgrade retain the original accepted action pin and fixed receipt deadline",async()=>{
  const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);f.pendingActions();
  await f.channels.watches!.configure(f.config,0,signal());f.setRelay(true);
  await f.capture("original-accepted-action");await f.privateRunner!.tick();await f.drive();
  expect(f.calls).toHaveLength(1);
  const original=f.calls[0]!,accepted=(await f.events()).find(e=>e.type==="AikoBrowserWatchActionAccepted"&&e.operationId===original.operationId)!;
  expect(accepted).toBeDefined();expect(await f.channels.watches!.inspect()).toMatchObject([{lastTaskStatus:"pending"}]);
  await f.channels.watches!.configure({...f.config,action:{kind:"actor",instruction:"Use the new instruction for future events"}},1,signal());
  expect(await f.channels.watches!.renew({id:f.config.id,expectedGeneration:2,expectedLeaseRevision:0,expiresAt:f.config.expiresAt+60000,maxOccurrences:512},signal())).toMatchObject({status:"confirmed"});
  await f.restart();await f.restartPrivate();await f.drive();
  expect(f.calls).toHaveLength(1);
  expect((await f.events()).find(e=>e.type==="AikoBrowserWatchActionAccepted"&&e.operationId===original.operationId)).toEqual(accepted);
  expect(await f.channels.watches!.authorizeAction(original,"execute",signal())).toBe(true);
  expect(await f.channels.watches!.reconcile(original.operationId,"check-original",signal())).toMatchObject({status:"pending"});
  expect(f.reconciled.at(-1)).toMatchObject({operationId:original.operationId,generation:1,action:original.action});
  expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchStarted"&&e.id===original.operationId)).toHaveLength(1);
  expect(await f.channels.watches!.inspect()).toMatchObject([{generation:2,leaseRevision:1}]);
});

test("renewal after a private expiry lapse retains queued authorized observations and excludes lapse replay",async()=>{
  let now=Date.now();const clock=spyOn(Date,"now").mockImplementation(()=>now);
  try{
    const f=await fixture(true,false,true),signal=()=>AbortSignal.timeout(5000);
    await f.channels.watches!.configure(f.config,0,signal());await f.capture("accepted-before-expiry");
    const from=f.config.expiresAt;now=from+5000;await f.restartPrivate();await f.restart();
    const args={id:f.config.id,expectedGeneration:1,expectedLeaseRevision:0,expiresAt:now+60000,maxOccurrences:512};
    expect(await f.channels.watches!.renew(args,signal())).toMatchObject({status:"confirmed",leaseRevision:1});
    expect(f.privateRunner!.status()[0]).toMatchObject({observationFloor:now,coverageLapse:{from,to:now,leaseRevision:1}});
    await f.capture("recorded-during-lapse",from+1000);
    f.setRelay(true);now+=2000;await f.privateRunner!.tick();await f.drive();
    expect(f.calls.map(call=>call.event.sequence)).toEqual([1]);
    await f.capture("fresh-after-lapse");await f.privateRunner!.tick();await f.drive();
    expect(f.calls.map(call=>call.event.sequence)).toEqual([1,2]);
    expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchLeaseRenewalChecked"&&e.status==="confirmed")).toMatchObject([{coverageLapse:{from,to:from+5000,leaseRevision:1}}]);
  }finally{clock.mockRestore();}
});
