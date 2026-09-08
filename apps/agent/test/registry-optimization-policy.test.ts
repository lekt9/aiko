import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor } from "tardie/core/actor";
import { deriveComponent } from "tardie/core/component";
import { childCreated, childLineageOf, threadCreatedOf } from "tardie/core/thread";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { defaultRegistryBinding } from "../src/registry-defaults.ts";
import { createRegistryOptimization, registryExperimentApi, registryTrialActor } from "../src/registry-optimization.ts";
import { HarnessExperimentTrials, harnessExperimentTrialLifecycle, harnessExperimentTrialThread, harnessExperimentTrialEventKey, harnessExperimentTrialIsChild } from "../src/harness-experiment-trials.ts";
import { harnessDigest, harnessLibraryEventKey } from "../src/harness-library.ts";
import type { HarnessExperimentBinding, HarnessExperimentBrief } from "../src/harness-experiment.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { parseModelRouting } from "../src/model-routing.ts";
import { createAikoActor } from "../src/actor.ts";
import { registryReadiness } from "../src/registry-host.ts";

function selected(db: Database) {
  const sandbox = { harnessEnvironment: async () => harnessDigest("controlled-runtime"), harnessJob: async () => { throw Error("No execution permitted in authority fixture"); } };
  const registry = defaultRegistryBinding({ owner: "123", thread: "user-123", kv: sqliteWorkflowKV(db),
    policy: () => ({ owner: "123", active: true, revision: "one" }), guard: () => {},
    transport: { placement: "local", codeTransport: runCodeSegment, sandbox } });
  return { registry, library: registry.library!, sandbox };
}

for (const executable of [true, false]) test(`host trial dispatcher handles cancellation-only lineage and ignores foreign Work with execution binding ${executable}`, async () => {
  const db = new Database(":memory:"), { library } = selected(db);
  let alarm: number | null = null, host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const storage: AccountStorage = { sql: { exec: (sql,...args) => { const rows=db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async at => { alarm=at; }, deleteAlarm: async () => { alarm=null; } };
  const resolved: string[] = [];
  const binding: HarnessExperimentBinding = { library, regime: {}, authorize: async () => false,
    prepare: async () => { throw Error("No preparation"); }, propose: async () => { throw Error("No model"); } };
  binding.trials=new HarnessExperimentTrials({binding:library,journal:{read:()=>host.read("user-123"),append:events=>host.seed("user-123",events)},
    authorize:async()=>false,readThread:thread=>host.read(thread),sandbox:async()=>{throw Error("No job");}});
  const open=()=>createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:"scope-fixture",ownsThread:thread=>thread==="user-123",
    allowChild:(parent,child)=>parent==="user-123"&&harnessExperimentTrialIsChild(child),
    actorFor:thread=>thread==="user-123"?actor({name:"aiko",methods:{},components:[]}):registryTrialActor(owner=>{resolved.push(owner);return owner==="123"&&executable?binding:undefined;}, owner=>owner==="123"?harnessExperimentTrialLifecycle({owner,parentThread:"user-123",readParent:()=>host.read("user-123")}):undefined),
    layersFor:()=>Layer.empty,keyOf:e=>harnessExperimentTrialEventKey(e)??harnessLibraryEventKey(e)});
  host=await open();
  try {
    await host.commitRoot(host.self("user-123"),{type:"AikoAccountOpened",id:"open",at:Date.now()});
    const source=parseThreadAddress(host.self("user-123")), operation="cancel-before-work",
      target={...source,thread:harnessExperimentTrialThread("123","user-123",operation)},
      lineage=childLineageOf(threadCreatedOf(await host.read("user-123"))!,"colocated");
    const requested:Event={type:"AikoHarnessTrialRequested",owner:"123",id:operation,experimentId:"owned-experiment",childThread:target.thread,briefRef:harnessDigest("deleted-private-brief"),deadlineAt:Date.now()+10000,at:Date.now()};
    await host.seed("user-123",[requested,{type:"AikoHarnessExperimentCancelled",owner:"123",id:"owned-experiment",experimentId:"owned-experiment",at:Date.now()},childCreated(operation,target,lineage,Date.now())]);
    await host.commit({link:{source,target},lineage,event:{...requested,type:"AikoHarnessTrialWork",owner:"456"}});
    await host.commit({link:{source,target},lineage,event:{...requested,type:"AikoHarnessTrialCancelled"}});
    await host.drive();
    expect(new Set(resolved)).toEqual(new Set(["123"]));
    const rows=await host.read(target.thread);
    expect(rows.find(e=>e.type==="AikoHarnessTrialExecuted")).toMatchObject({status:"unavailable",cancelled:true});
    expect(rows.some(e=>e.type==="AikoHarnessRunStarted")).toBe(false);
    expect(rows.filter(e=>e.type==="AikoHarnessTrialSent")).toHaveLength(1);
    await host.close();host=await open();await host.drive();
    expect((await host.read(target.thread)).filter(e=>e.type==="AikoHarnessTrialExecuted")).toHaveLength(1);
  } finally {await host.close();db.close();}
});

test("cancellation checks the retained owned brief and caller, independent of expired execution/model policy", async () => {
  const db=new Database(":memory:"), {library,sandbox}=selected(db), rows:Event[]=[];
  let active=true,ownerAuthorized=true;
  try {
    const env={CODEGRAFF_API_KEY:"controlled-fixture-key",AIKO_ALLOW_PAID_INFERENCE:"true"};
    const optimization=createRegistryOptimization({library,instance:"fixture",journal:{read:async()=>rows,append:async events=>{rows.push(...events);}},
      current:()=>({active,revision:active?"one":"revoked"}),currentOwner:()=>ownerAuthorized,
      routing:{owner:"123",config:parseModelRouting(env),env,budget:{transport:()=>async()=>{throw Error("No model during cancellation");}}},
      readThread:async()=>[],sandbox:{placement:"local",sandbox,current:async()=>{throw Error("No runtime needed to cancel");}}});
    const brief={id:"owned-expired",deadlineAt:Date.now()-1000} as HarnessExperimentBrief;
    const briefRef=await library.blobs.putPrivate("123",brief);
    rows.push({type:"AikoHarnessExperimentRegistered",owner:"123",id:brief.id,experimentId:brief.id,briefRef,briefDigest:harnessDigest(brief)});
    active=false;
    expect(await optimization.binding.authorize("cancel",brief,new AbortController().signal)).toBe(true);
    expect(await optimization.binding.authorize("advance",brief,new AbortController().signal)).toBe(false);
    expect(await optimization.binding.authorize("cancel",{...brief,id:"foreign"},new AbortController().signal)).toBe(false);
    ownerAuthorized=false;
    expect(await optimization.binding.authorize("cancel",brief,new AbortController().signal)).toBe(false);
  } finally {db.close();}
});

test("custom legacy experiments are unavailable and expose no runnable host experiment tools", () => {
  const db=new Database(":memory:"),{registry,library}=selected(db);
  try {
    const experiments:HarnessExperimentBinding={library,regime:{},authorize:async()=>false,prepare:async()=>{throw Error("unused");},propose:async()=>{throw Error("unused");}};
    expect(registryReadiness({...registry,experiments},true)).toMatchObject({experiments:false,optimizationReason:"native_trial_host_not_configured"});
    // Root's lifecycle fallback retains deadline handling but cannot advance
    // even when registered metadata is present and an unusable binding is supplied.
    const definition=createAikoActor({owner:"123",memory:{owner:"123",thread:"user-123",redact:(text:string)=>text,readEvents:async()=>[],open:()=>{throw Error("unused");}} as any,harnessLibrary:library,experiments,persona:"controlled"} as any);
    const lifecycle = definition.components.find(c=>c.name==="aiko.harness-experiments")!;
    expect(lifecycle).toBeDefined();
    const projected = deriveComponent(lifecycle, [{ type: "AikoHarnessExperimentRegistered", owner: "123", id: "retained",
      experimentId: "retained", deadlineAt: Date.now() + 10000 }]);
    expect(projected.transitions).toHaveLength(1);
    expect(projected.transitions[0]?.kind).toBe("intent");
    expect(projected.transitions[0]?.key).toContain("AikoHarnessExperimentDeadline:");
  } finally {db.close();}
});


test("owner status/cancel uses exact retained metadata without any library, brief or execution binding", async () => {
  const rows: Event[] = [{ type: "AikoHarnessExperimentRegistered", owner: "123", id: "owned", experimentId: "owned", deadlineAt: 1 },
    { type: "AikoHarnessExperimentRegistered", owner: "456", id: "foreign", experimentId: "foreign", deadlineAt: 1 }];
  let authorized = true, wakes = 0, revokeOnRead = false, revokeOnWake = false;
  const options = { owner: "123", currentOwner: () => authorized,
    journal: { read: async () => { if (revokeOnRead) authorized = false; return rows; }, append: async (events: readonly Event[]) => { rows.push(...events); } },
    wake: async () => { wakes++; if (revokeOnWake) authorized = false; } };
  const request = (id: string, operation: "status" | "cancel") => registryExperimentApi(new Request(`https://fixture.invalid/api/harness/experiments/${id}/${operation}`, { method: operation === "cancel" ? "POST" : "GET" }), options);
  expect(await (await request("owned", "status")).json()).toMatchObject({ id: "owned", status: "pending" });
  expect((await request("foreign", "cancel")).status).toBe(409);
  expect((await request("absent", "cancel")).status).toBe(409);
  revokeOnRead = true;
  expect((await request("owned", "cancel")).status).toBe(403);
  expect(wakes).toBe(0);
  authorized = true; revokeOnRead = false;
  expect(await (await request("owned", "cancel")).json()).toMatchObject({ status: "cancelling" });
  expect((await request("owned", "cancel")).status).toBe(200);
  expect(rows.filter(e => e.type === "AikoHarnessExperimentCancelled")).toHaveLength(1);
  expect(rows.find(e => e.type === "AikoHarnessExperimentCancelled")?.owner).toBe("123");
  revokeOnWake = true;
  expect((await request("owned", "cancel")).status).toBe(403);
  expect(rows.filter(e => e.type === "AikoHarnessExperimentCancelled")).toHaveLength(1);
});
