import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { Effect, Layer } from "effect";
import { actor } from "tardie";
import { Self } from "tardie/core/runtime";
import { alarmFired } from "tardie/core/method";
import { EventLog, withWatermark } from "tardie/core/log";
import { channelAppendAllowed, channelBindings, channelDigest, channelEventKey, channelId, type ChannelBinding } from "../src/channel-bindings.ts";
import { createChannelRuntime } from "../src/channel-runtime.ts";
import {channelControlState} from "../src/channel-controls.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { createWebhookAdapterHost, webhookTarget, type WebhookDestinationPolicy, type WebhookRequest } from "../src/webhook-adapter.ts";
import { createNodeWebhookTransport } from "../src/webhook-node.ts";
import { createSandboxWebhookTransport } from "../src/webhook-sandbox.ts";
import { runSandboxJob, type SandboxJobJournal } from "../src/sandbox-job-runner.ts";
import { sandboxDigest, type SandboxJob } from "../src/sandbox-job.ts";
import type { WorkflowKV } from "../src/workflow-host.ts";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); });
const hmac = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("hex");
function fixture(dispatchBoundary: "request" | "host-permit" | "sandbox-admission" = "request") {
  let currentOwner = true;
  let p: WebhookDestinationPolicy = { id: "requests", revision: "1", owner: "alice", active: true,
    expiresAt: Date.now() + 60000, url: "https://hooks.receiver.com/aiko", signingKey: "sender-private-key-0123456789abcdef",
    authorityRef: "configure-webhook", sendAuthorityRef: "send-webhook", maxBytes: 4096, retentionMs: 60000,
    idempotency: "delivery-id", reconcile: { url: "https://hooks.receiver.com/status", receiptKey: "receiver-private-key-0123456789abc" } };
  const values = new Map<string, unknown>();
  const kv: WorkflowKV = { get: async k => values.get(k), put: async (k,v) => { values.set(k,v); },
    list: async p => [...values.entries()].filter(([k]) => k.startsWith(p)).map(([,v]) => v),
    claim: async (k,v) => { if (values.has(k)) return false; values.set(k,v); return true; },
    update: async (k,f) => { values.set(k, f(values.get(k))); } };
  const blobs = harnessBlobStore(kv);
  const calls: WebhookRequest[] = [];
  let dispatch: (r: WebhookRequest) => Promise<{status:number;body?:string}> = async () => ({status:202});
  let rows: any[] = [];
  const host = () => createWebhookAdapterHost({ owner:"alice", policies:()=>[p], currentOwner:()=>currentOwner,
    journal:{read:async()=>rows,append:async e=>{rows.push(...e);}}, blobs, kv,
    transport:{dispatchBoundary,request:async r=>{
      if (dispatchBoundary === "host-permit") { const result = await dispatch(r); calls.push(r); return result; }
      await r.beforeDispatch();calls.push(r);return dispatch(r);
    }} });
  let adapter = host();
  const binding = ():ChannelBinding => ({...adapter.bindingInput("requests","webhook",1),id:channelId("alice","webhook"),owner:"alice",status:"active"});
  const b = binding();
  const input = {operationId:"event-1",task:"task",authorization:p.sendAuthorityRef,payload:"private result",conversation:"watch",ancestry:[],destination:b.destination};
  return { b, input, kv, blobs, values, calls, get p(){return p;},get adapter(){return adapter;},
    setPolicy:(next:Partial<WebhookDestinationPolicy>)=>{p={...p,...next};},setOwner:(v:boolean)=>{currentOwner=v;},
    setDispatch:(fn:typeof dispatch)=>{dispatch=fn;},setRows:(r:any[])=>{rows=r;},reopen:()=>{adapter=host();},
    send:(key="delivery-1",value=input)=>adapter.adapters.execute(b,"send",value,key,new AbortController().signal),
    reconcile:(id="delivery-1",key="reconcile-1")=>adapter.adapters.execute(b,"reconcile",{operationId:id},key,new AbortController().signal),
  };
}

test("fixed private payload, stable signed delivery identity, retained receipt and duplicate conflict",async()=>{
  const f=fixture();
  const r=await f.send() as any;
  expect(r.status).toBe("accepted_by_provider");
  expect(await f.adapter.adapters.validateReceipt(f.b,"send",r)).toBe(true);
  const request=f.calls[0]!;
  expect(JSON.parse(request.body!)).toEqual({version:1,deliveryId:"delivery-1",payload:"private result"});
  expect(request.headers["x-aiko-proof"]).toBe("v1="+hmac(f.p.signingKey,JSON.stringify([1,"send","delivery-1",f.p.url,request.body])));
  expect(request.headers["x-aiko-delivery-id"]).toBe("delivery-1");
  f.reopen();
  expect(await f.send()).toEqual(r);
  expect(f.calls.length).toBe(1);
  await expect(f.send("delivery-1",{...f.input,payload:"changed"})).rejects.toThrow("webhook_receipt_unavailable");
  expect(JSON.stringify([...f.values])).not.toContain("private result");
  expect(JSON.stringify([...f.values])).not.toContain(f.p.signingKey);
  expect(await f.adapter.adapters.validateReceipt(f.b,"send",{...r,status:"delivered"})).toBe(false);
});

test("lost acknowledgement is held across restart and signed GET reconciliation uses original send identity",async()=>{
  const f=fixture();
  f.setDispatch(async()=>{throw Error("receiver accepted but socket vanished");});
  const result=await f.send() as any;
  expect(result.status).toBe("unknown");
  f.reopen();
  expect(await f.send()).toEqual(result);
  expect(f.calls.length).toBe(1);
  f.setDispatch(async request=>{
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("delivery_id")).toBe("delivery-1");
    const receipt={version:1,deliveryId:"delivery-1",status:"delivered"};
    return {status:200,body:JSON.stringify({receipt,signature:hmac(f.p.reconcile!.receiptKey,channelDigest(receipt))})};
  });
  expect((await f.reconcile() as any).status).toBe("delivered");
  expect(f.calls.filter(c=>c.method==="POST").length).toBe(1);
});

test("unsigned, foreign and oversized reconciliation do not fabricate delivery; absent API stays unknown",async()=>{
  for(const kind of ["unsigned","foreign","large","absent"]){
    const f=fixture();
    if(kind==="absent") {
      f.setPolicy({reconcile:undefined});
      // Rebinding is required when trusted destination configuration changes.
      const b={...f.b,...f.adapter.bindingInput("requests","webhook",1)};
      const r=await f.adapter.adapters.execute(b,"reconcile",{operationId:"delivery-1"},"reconcile-1",AbortSignal.timeout(1000)) as any;
      expect(r.status).toBe("unknown");expect(f.calls.length).toBe(0);continue;
    }
    f.setDispatch(async()=>{
      const receipt={version:1,deliveryId:kind==="foreign"?"foreign":"delivery-1",status:"delivered"};
      return {status:200,body:kind==="large"?"x".repeat(17000):JSON.stringify({receipt,signature:kind==="unsigned"?"bad":hmac(f.p.reconcile!.receiptKey,channelDigest(receipt))})};
    });
    expect((await f.reconcile() as any).status).toBe("unknown");
  }
});

test("reject insecure/private destinations, stale revisions, cross-owner and oversized payloads",async()=>{
  for(const url of ["http://receiver.com/hook","https://127.0.0.1/","https://2130706433/","https://[::1]/","https://localhost/","https://a.internal/","https://user:pass@receiver.com/","https://receiver.com:8443/","https://receiver.com/#token"])
    expect(()=>webhookTarget(url)).toThrow();
  const f=fixture();
  await expect(f.send("large",{...f.input,payload:"x".repeat(5000)})).rejects.toThrow();
  await expect(f.send("retarget",{...f.input,destination:"webhook:other:1"})).rejects.toThrow();
  expect(await f.adapter.adapters.artifactAllowed({...f.b,owner:"bob"})).toBe(false);
  f.setPolicy({revision:"2"});
  await expect(f.send()).rejects.toThrow("webhook_adapter_unavailable");
  expect(f.calls.length).toBe(0);
});

test("authority is checked after awaited preflight and revoked receipts cannot establish current delivery",async()=>{
  const f=fixture();
  f.setDispatch(async()=>{f.setOwner(false);return {status:202};});
  const result=await f.send() as any;
  expect(result.status).toBe("accepted_by_provider");
  expect(await f.adapter.adapters.validateReceipt(f.b,"send",result)).toBe(false);
  expect(f.calls.length).toBe(1);
});

test("unconfigured non-2xx and redirects remain unknown without retry; receiver-declared rejection is failed",async()=>{
  for(const status of [302,429,500]){
    const f=fixture();f.setDispatch(async()=>({status}));
    expect((await f.send() as any).status).toBe("unknown");expect(f.calls.length).toBe(1);
  }
  const f=fixture();f.setPolicy({notAcceptedStatuses:[429]});
  const b={...f.b,...f.adapter.bindingInput("requests","webhook",1)};
  f.setDispatch(async()=>({status:429}));
  expect((await f.adapter.adapters.execute(b,"send",f.input,"delivery-1",AbortSignal.timeout(1000)) as any).status).toBe("failed");
});

test("Node transport pins checked DNS, refuses private/mixed answers, and rechecks authority before dispatch",async()=>{
  const f=fixture();await f.send();const input=f.calls[0]!;
  for(const addresses of [["127.0.0.1"],["93.184.216.34","10.0.0.2"]]){
    let calls=0;
    const transport=createNodeWebhookTransport({lookup:async()=>addresses,request:(()=>{calls++;throw Error("must not dispatch");}) as any});
    await expect(transport.request(input)).rejects.toThrow("Non-public DNS answer");expect(calls).toBe(0);
  }
  let pinned="",dispatched=0;
  const transport=createNodeWebhookTransport({lookup:async()=>["93.184.216.34"],request:((_url:any,options:any,callback:any)=>{
    dispatched++;options.lookup("hooks.receiver.com",{},(_e:any,ip:string)=>{pinned=ip;});
    expect(options.agent).toBe(false);expect(options.family).toBe(4);
    const req=new EventEmitter() as any;req.end=()=>{const response=new EventEmitter() as any;response.statusCode=302;response.destroy=()=>{};callback(response);};return req;
  }) as any});
  expect((await transport.request(input)).status).toBe(302);expect(pinned).toBe("93.184.216.34");expect(dispatched).toBe(1);
  await expect(transport.request({...input,beforeDispatch:()=>{throw Error("revoked during DNS");}})).rejects.toThrow("revoked during DNS");
  expect(dispatched).toBe(1);
});

test("watch dispatch awaits current authority and rejects a remote admission-only fence",async()=>{
  const f=fixture();let checks=0;
  const denied=await f.adapter.adapters.execute(f.b,"send",f.input,"denied-watch",AbortSignal.timeout(1000),{
    beforeDispatch:async()=>{await Promise.resolve();checks++;throw Error("watch paused");},
  }) as any;
  expect(checks).toBe(1);expect(f.calls).toHaveLength(0);expect(denied.status).toBe("failed");
  const remote=fixture("sandbox-admission");
  const unavailable=await remote.adapter.adapters.execute(remote.b,"send",remote.input,"remote-watch",AbortSignal.timeout(1000),{
    beforeDispatch:async()=>{checks++;},
  }) as any;
  expect(unavailable.status).toBe("failed");expect(remote.calls).toHaveLength(0);expect(checks).toBe(1);
  const revoked=fixture();
  const result=await revoked.adapter.adapters.execute(revoked.b,"send",revoked.input,"provider-revoked",AbortSignal.timeout(1000),{
    beforeDispatch:async()=>{await Promise.resolve();revoked.p.active=false;},
  }) as any;
  expect(result.status).toBe("failed");expect(revoked.calls).toHaveLength(0);
});

test("remote permit denial is undispatched while lost permit acknowledgement stays unknown", async () => {
  for (const outcome of ["permitted", "denied", "unknown", "lost"] as const) {
    const f = fixture("host-permit"); let checks = 0;
    f.setDispatch(async request => {
      const allowed = await request.authorizeDispatch!({ status: "awaiting-dispatch", protocol: "host-request/v1", owner: "alice",
        operationId: `webhook:${request.operationId}`, jobDigest: `sha256:${"a".repeat(64)}`, requestDigest: `sha256:${"b".repeat(64)}`,
        stepId: "deliver", attempt: 1, nonce: crypto.randomUUID(), expiresAt: Date.now() + 5000,
        prepared: { url: request.url, method: request.method, headers: request.headers, address: "93.184.216.34", body: request.body } });
      if (!allowed) throw Error("private request denied");
      return { status: 202 };
    });
    const result = await f.adapter.adapters.execute(f.b, "send", f.input, `permit-${outcome}`, AbortSignal.timeout(1000), {
      beforeDispatch: async () => { throw Error("job admission cannot authorize this transport"); },
      permit: async (identity, _signal, policyCurrent) => {
        checks++; expect(identity.operationId).toBe(`permit-${outcome}`); expect(policyCurrent?.()).toBe(true);
        expect(JSON.stringify(identity)).not.toContain(f.p.signingKey);
        if (outcome === "lost") throw Error("native commit acknowledgement lost");
        return { status: outcome };
      },
    }) as any;
    expect(result.status).toBe(outcome === "permitted" ? "accepted_by_provider" : outcome === "denied" ? "failed" : "unknown");
    expect(checks).toBe(1); expect(f.calls).toHaveLength(outcome === "permitted" ? 1 : 0);
    f.reopen(); await f.send(`permit-${outcome}`); expect(checks).toBe(1);
  }
});

test("Node transport waits for an asynchronous post-DNS watch fence before opening a socket",async()=>{
  const f=fixture();await f.send();const input=f.calls[0]!;
  const order:string[]=[];let finish!:()=>void;
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  const transport=createNodeWebhookTransport({lookup:async()=>{order.push("dns");return ["93.184.216.34"];},
    request:(()=>{order.push("socket");throw Error("must not send");}) as any});
  const pending=transport.request({...input,beforeDispatch:async()=>{order.push("guard");await gate;throw Error("watch revoked after DNS");}});
  const checked=pending.then(()=>"unexpected success",error=>String(error.message));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(order).toEqual(["dns","guard"]);finish();expect(await checked).toBe("watch revoked after DNS");
  expect(order).toEqual(["dns","guard"]);
});

test("Worker sandbox transport executes exact signed bytes, pins owner and job, and never follows redirects or repeats uncertain POST",async()=>{
  const f=fixture();await f.send();const input=f.calls[0]!;
  const receipts=new Map<string,any>(),jobs:SandboxJob[]=[];
  const journal:SandboxJobJournal={claim:async(_o,k,d)=>{if(receipts.has(k))return false;receipts.set(k,{digest:d});return true;},
    read:async(_o,k)=>receipts.get(k),settle:async(_o,k,r)=>{receipts.get(k).receipt=r;}};
  const environmentDigest=await sandboxDigest("webhook-fixture-environment");let sent=0,redirect=false;const wire:any[]=[];
  const transport=createSandboxWebhookTransport("alice",{sandbox:{harnessEnvironment:async()=>environmentDigest,
    harnessJob:async(job:SandboxJob,signal:AbortSignal)=>{jobs.push(job);return runSandboxJob(job,{owner:"alice",environmentDigest,journal,
      send:async req=>{
        sent++;wire.push(req);
        return {status:redirect?302:202,headers:(redirect?{location:"https://hooks.receiver.com/other"}:{}) as Record<string,string>,body:null,classification:"application"};
      }},signal);}},executeCode:async()=>{throw Error("unused");}} as any);
  expect((await transport.request(input)).status).toBe(202);
  expect(wire[0].url).toBe(input.url);expect(wire[0].body).toBe(input.body);
  expect(wire[0].headers["x-aiko-proof"]).toBe(input.headers["x-aiko-proof"]);
  expect(jobs[0]!.budget.requests).toBe(1);expect(jobs[0]!.authority).toEqual({origins:["https://hooks.receiver.com"],methods:["POST"]});
  expect(JSON.stringify(jobs)).not.toContain(f.p.signingKey);
  await transport.request(input);expect(sent).toBe(1);
  await expect(transport.request({...input,owner:"bob"})).rejects.toThrow("webhook_sandbox_owner_or_redirect");
  redirect=true;await expect(transport.request({...input,operationId:"redirect"})).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect(sent).toBe(2);
  await expect(transport.request({...input,operationId:"redirect"})).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect(sent).toBe(2);
});

async function nativeFixture(f=fixture()) {
  const db=new Database(":memory:");let alarm:number|null=null,currentTime=Date.now();
  const storage:AccountStorage={sql:{exec:(sql,...args)=>{const rows=db.query(sql).all(...args as any[]);return {toArray:()=>rows as never};}},
    transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,
    setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;}};
  const runtime=createChannelRuntime("alice",{...f.adapter.adapters,now:()=>currentTime,handle:async()=>({receipt:"unused"})});
  const definition=actor({name:"aiko",methods:{},components:[runtime.component]});
  const open=()=>createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:"test",ownsThread:t=>t==="user-alice",
    actorFor:()=>definition,layersFor:()=>Layer.empty,keyOf:channelEventKey,canAppend:(_t,e,r)=>channelAppendAllowed(e,r)});
  let host=await open();close.push(async()=>{await host.close();db.close();});
  await host.commitRoot(host.self("user-alice"),{type:"FixtureStarted",id:"start",at:0});
  const read=()=>host.read("user-alice");
  const run=async<T>(work:Effect.Effect<T,never,EventLog|Self>)=>{
    f.setRows([...(await read())]);
    const log=withWatermark({read:Effect.promise(read),append:events=>Effect.promise(async()=>{
      const before=await read();if(!channelAppendAllowed(events,()=>before))throw Error("fixture_fence");
      await host.seed("user-alice",events);f.setRows([...(await read())]);
      await host.commitRoot(host.self("user-alice"),{type:"FixtureWake",id:crypto.randomUUID(),at:Date.now()});
    })});
    return Effect.runPromise(work.pipe(Effect.provideService(EventLog,log),Effect.provideService(Self,{actor:"aiko",instance:"test",thread:"user-alice"})));
  };
  const id=await run(runtime.configure(f.adapter.bindingInput("requests","webhook",1)));await host.drive();
  expect(channelBindings(await read(),"alice").get(id)?.status).toBe("active");
  return {f,runtime,id,run,read,drive:()=>host.drive(),now:()=>currentTime,
    reopen:async()=>{await host.close();host=await open();await host.drive();},
    advance:async(ms:number)=>{currentTime+=ms;await host.commitRoot(host.self("user-alice"),alarmFired({scheduledFor:currentTime,at:currentTime}));await host.drive();}};
}

test("native outbox survives dispatched cut, never repeats POST and reconciles through retained runtime",async()=>{
  const n=await nativeFixture(),{f,runtime,id,run,read}=n;
  const {destination:_destination,...prepared}=f.input;
  f.setDispatch(async()=>{throw Error("accepted then lost acknowledgment");});
  await run(runtime.prepare(id,1,prepared));await n.drive();
  expect(f.calls.length).toBe(1);
  expect((await read()).find(e=>e.type==="AikoChannelOutputSettled")?.result).toMatchObject({status:"unknown"});
  await n.reopen();
  await run(runtime.prepare(id,1,prepared));await n.drive();expect(f.calls.length).toBe(1);
  const deliveryId=f.calls[0]!.headers["x-aiko-delivery-id"];
  f.setDispatch(async req=>{
    expect(req.method).toBe("GET");const receipt={version:1,deliveryId,status:"delivered"};
    return {status:200,body:JSON.stringify({receipt,signature:hmac(f.p.reconcile!.receiptKey,channelDigest(receipt))})};
  });
  await run(runtime.requestReconcile(id,1,prepared.operationId,"resolve-1"));await n.drive();
  expect(f.calls.length).toBe(2);
  expect((await read()).find(e=>e.type==="AikoChannelReconcileSettled")?.result).toMatchObject({status:"delivered"});
});

test("bounded native retries retain original delivery identity, recheck policy and stop permanently on unknown",async()=>{
  const f=fixture();f.setPolicy({notAcceptedStatuses:[429],retries:{maxRuns:2,minBackoffMs:100,maxDurationMs:30000}});
  const n=await nativeFixture(f),{runtime,id,run,read}=n;
  const {destination:_destination,...prepared}=f.input;
  f.setDispatch(async()=>({status:429}));
  await run(runtime.prepare(id,1,prepared));await n.drive();
  expect((await read()).find(e=>e.type==="AikoChannelOutputSettled")?.result).toMatchObject({status:"failed"});
  const plan={id:"safe-retries",action:"retry-send" as const,partition:prepared.operationId,maxRuns:2,
    intervalMs:100,backoffMs:100,firstAt:n.now()+100,expiresAt:n.now()+10000,leaseLeadMs:0};
  await run(runtime.scheduleControl(id,1,plan));await n.drive();expect(f.calls.length).toBe(1);
  await n.reopen();await n.advance(100);
  expect(f.calls.length).toBe(2);
  expect(f.calls[1]!.operationId).not.toBe(f.calls[0]!.operationId);
  expect(f.calls[1]!.headers["x-aiko-delivery-id"]).toBe(f.calls[0]!.headers["x-aiko-delivery-id"]);
  expect(f.calls[1]!.body).toBe(f.calls[0]!.body);
  expect(channelControlState(await read(),"alice")[0]).toMatchObject({ordinal:1});
  f.setDispatch(async()=>{throw Error("accepted but response lost");});
  await n.advance(101);
  expect(channelControlState(await read(),"alice")[0]).toMatchObject({ordinal:1,reason:"unknown"});
  expect(f.calls.length).toBe(3);
  await n.advance(500);await n.reopen();expect(f.calls.length).toBe(3);
  await expect(run(runtime.scheduleControl(id,1,{...plan,id:"refill",firstAt:n.now()+100}))).rejects.toThrow("channel_control_already_registered");
});

test("native retry budget cannot be refilled; unknown originals and revoked plans cannot dispatch",async()=>{
  for(const outcome of ["failed","unknown","revoked"]){
    const f=fixture();f.setPolicy({notAcceptedStatuses:[429],retries:{maxRuns:1,minBackoffMs:100,maxDurationMs:30000}});
    const n=await nativeFixture(f),{runtime,id,run}=n;const {destination:_destination,...prepared}=f.input;
    f.setDispatch(async()=>outcome==="unknown"?Promise.reject(Error("lost")):{status:429});
    await run(runtime.prepare(id,1,prepared));await n.drive();
    const plan={id:"retry",action:"retry-send" as const,partition:prepared.operationId,maxRuns:1,
      intervalMs:100,backoffMs:100,firstAt:n.now()+100,expiresAt:n.now()+10000,leaseLeadMs:0};
    if(outcome==="unknown"){
      await expect(run(runtime.scheduleControl(id,1,plan))).rejects.toThrow("channel_retry_requires_verified_failure");
      expect(f.calls.length).toBe(1);continue;
    }
    await run(runtime.scheduleControl(id,1,plan));
    if(outcome==="revoked")f.setPolicy({active:false});
    await n.advance(100);await n.advance(500);
    expect(f.calls.length).toBe(outcome==="revoked"?1:2);
    if(outcome==="failed")await expect(run(runtime.scheduleControl(id,1,{...plan,id:"again",firstAt:n.now()+100}))).rejects.toThrow("channel_control_already_registered");
  }
});
