import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalKeyring, VaultCipher } from "../../server/src/crypto.ts";
import { BrowserWatchRunner, type BrowserWatchLease } from "../src/browser-watch-runner.ts";
import { BrowserObservationQueue } from "../src/browser-event-queue.ts";
import type { BackgroundHealth, BackgroundObservation, BackgroundListenerOptions } from "../src/cdp-background-listener.ts";
type Transport=NonNullable<ConstructorParameters<typeof BrowserWatchRunner>[0]["fetch"]>;
const time=1_800_000_000_000;
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const clean of cleanups.splice(0))await clean();});
function lease(kinds:BrowserWatchLease["grant"]["kinds"]=["push"]):BrowserWatchLease{return {grant:{owner:"alice",producer:"watch-1",epoch:"epoch-1",profile:"owned",generation:1,connectionId:"site-1",connectionRevision:"r1",origins:["https://example.com"],kinds,active:true,expiresAt:time+60000,registeredAt:time-100,secret:"fixture-private-key-0000000000000000"},ingestUrl:"https://account.example/v1/browser-events/alice",...(kinds.includes("network")?{networkRoutes:[{method:"GET",route:"/messages/{id}"}]}:{})};}
const renew=(prior:BrowserWatchLease,expiresAt:number):BrowserWatchLease=>({...prior,grant:{...prior.grant,expiresAt},leaseRevision:(prior.leaseRevision??0)+1,renewalFrom:{leaseRevision:prior.leaseRevision??0,expiresAt:prior.grant.expiresAt}});
const event=(instanceId="1"):BackgroundObservation=>({service:"pushMessaging",origin:"https://example.com",serviceWorkerRegistrationId:"private-worker-id",storageKey:"private-storage-key",timestamp:time/1000,eventName:"Push message received",instanceId,eventMetadata:[{key:"payload",value:"private contents"}],observedAtMs:time,historical:false});
function fixture(db=new Database(":memory:")){
  let now=time,authorized=true,cause:string|undefined,transport:Transport=async(_url,init)=>{const b=JSON.parse(String(init?.body));return Response.json({status:"accepted",through:b.items.at(-1).sequence},{status:202});};
  const captures:{options:BackgroundListenerOptions;observerTargetId?:string;health:BackgroundHealth;closed:number;connects:number;renewals:number;connect:()=>Promise<void>;close:()=>Promise<void>;renewRecording:()=>Promise<void>;flush:()=>Promise<void>}[]=[];
  let network:{state:"watching"|"degraded"|"stopped";reason:string}={state:"watching",reason:"ready"};
  const cipher=new VaultCipher(new LocalKeyring("test",{test:Buffer.alloc(32,7).toString("base64")}));
  const options={owner:"alice",db,cipher,endpoint:async()=>"ws://127.0.0.1:9999/devtools/browser/fixture",authorized:()=>authorized,currentCause:()=>cause,networkHealth:()=>network,now:()=>now,fetch:((...args:Parameters<Transport>)=>transport(...args)) as Transport,
    createCapture:(options:BackgroundListenerOptions)=>{const c={options,observerTargetId:`owned-observer-${captures.length}` as string|undefined,health:{state:"watching",reason:"ready",targets:1,atMs:now} as BackgroundHealth,closed:0,connects:0,renewals:0,async connect(){this.connects++;},async close(){this.closed++;this.observerTargetId=undefined;},async renewRecording(){this.renewals++;},async flush(){}};captures.push(c);return c;}};
  const runner=new BrowserWatchRunner(options);
  cleanups.push(async()=>{await runner.close();db.close();});
  return {runner,options,db,captures,queue:new BrowserObservationQueue(db),setNow:(n:number)=>now=n,setAuthorized:(a:boolean)=>authorized=a,setCause:(c:string|undefined)=>cause=c,setNetwork:(h:typeof network)=>network=h,setTransport:(t:Transport)=>transport=t};
}
test("renewals preserve capture coverage and encrypted leases restore while connection is unavailable",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"watch-runner-"));const f=fixture(new Database(join(dir,"vm.sqlite")));cleanups.push(async()=>rmSync(dir,{recursive:true,force:true}));
  const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event());
  expect(f.runner.hasActiveLease()).toBe(true);
  await f.runner.configure(renew(l,time+120000));
  expect(f.captures).toHaveLength(1);expect(f.captures[0]!.closed).toBe(0);
  expect(f.runner.status()[0]).toMatchObject({leaseRevision:1});expect(f.runner.status()[0]!.observationFloor).toBeUndefined();
  expect(f.queue.highWatermark(l.grant)).toBe(1);
  const budgetRenewal=renew(renew(l,time+120000),time+120000);
  expect(await f.runner.configure(budgetRenewal)).toMatchObject({leaseRevision:2,expiresAt:time+120000});
  expect(f.captures).toHaveLength(1);expect(f.runner.status()[0]!.observationFloor).toBeUndefined();
  expect(JSON.stringify(f.db.query("SELECT * FROM browser_watch_leases").all())).not.toContain(l.grant.secret);
  await f.runner.close();f.setAuthorized(false);
  const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();
  expect(reopened.status()[0]).toMatchObject({state:"needs-attention",reason:"connection-unavailable"});
  f.setAuthorized(true);await reopened.tick();expect(reopened.status()[0]!.state).toBe("watching");
// This test includes real encrypted SQLite commits and reopen on the workspace
// temp volume. Keep its wall-clock test budget separate from runtime leases.
},30_000);

test("renewal after expiry and reconstruction preserves accepted queue and excludes recorded lapse history",async()=>{
  const f=fixture(),initial=lease();f.setTransport(async()=>new Response(null,{status:503}));
  await f.runner.configure(initial);await f.captures[0]!.options.onEvent(event("accepted-before-expiry"));
  await f.runner.close();f.setNow(time+65000);
  const runner=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>runner.close());await runner.restore();
  expect(runner.status()[0]).toMatchObject({state:"paused",reason:"lease-expired",leaseRevision:0});
  const renewed=renew(initial,time+120000);await runner.configure(renewed);
  expect(runner.status()[0]).toMatchObject({leaseRevision:1,observationFloor:time+65000,coverageLapse:{from:time+60000,to:time+65000,leaseRevision:1}});
  const captured=f.captures.at(-1)!;
  await captured.options.onEvent({...event("unleased"),timestamp:(time+62000)/1000});
  await captured.options.onEvent({...event("precommit"),timestamp:(time+65000)/1000});
  expect(f.queue.batch(initial.grant)!.batch.items.map(e=>e.sequence)).toEqual([1]);
  await captured.options.onEvent({...event("newly-authorized"),timestamp:(time+65001)/1000});
  expect(f.queue.highWatermark(initial.grant)).toBe(2);
  f.setNow(time+70000);const batches:number[][]=[];
  f.setTransport(async(_url,init)=>{const b=JSON.parse(String(init?.body));batches.push(b.items.map((e:any)=>e.sequence));return Response.json({status:"accepted",through:b.items.at(-1).sequence},{status:202});});
  await runner.tick();expect(batches).toEqual([[1,2]]);
  await runner.close();const again=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>again.close());await again.restore();
  await again.configure(renewed);expect(again.status()[0]!.observationFloor).toBe(time+65000);
  await f.captures.at(-1)!.options.onEvent({...event("unleased-after-restart"),timestamp:(time+62000)/1000});
  expect(f.queue.highWatermark(initial.grant)).toBe(2);expect(f.queue.batch(initial.grant)).toBeUndefined();
  await expect(again.configure(initial)).rejects.toThrow("lease_invalid");
  await expect(again.configure({...initial,grant:{...initial.grant,expiresAt:renewed.grant.expiresAt}})).rejects.toThrow("stale_lease");
  await expect(again.configure({...renewed,grant:{...renewed.grant,expiresAt:time+125000}})).rejects.toThrow("lease_conflict");
});

test("explicit paused renewal retains lifecycle watermark and cannot resume until a separate resume",async()=>{
  const f=fixture(),initial=lease();await f.runner.configure(initial);
  const paused=await f.runner.pause(initial.grant.producer,0),renewed=renew(initial,time+120000);
  expect(await f.runner.configure(renewed)).toMatchObject({state:"paused",leaseRevision:1,lifecycleRevision:0,pausedThrough:paused.pausedThrough});
  expect(f.runner.hasActiveLease()).toBe(false);expect(f.captures).toHaveLength(1);
  await f.runner.close();const runner=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>runner.close());await runner.restore();
  expect(await runner.configure(renewed)).toMatchObject({state:"paused",leaseRevision:1,pausedThrough:0});
  expect(await runner.configure({...renewed,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:0}})).toMatchObject({state:"watching",leaseRevision:1,lifecycleRevision:2});
  expect(await runner.pause(initial.grant.producer,2)).toMatchObject({state:"paused",leaseRevision:1});
});

test("renewal cutoff uses actual commit time if expiry passes during encryption; exact predecessor and authority remain required",async()=>{
  const f=fixture(),initial=lease();await f.runner.configure(initial);f.setNow(time+59000);
  const seal=f.options.cipher.seal.bind(f.options.cipher);
  f.options.cipher.seal=async(...args)=>{const result=await seal(...args);f.setNow(time+65000);return result;};
  const renewed=renew(initial,time+120000);await f.runner.configure(renewed);
  expect(f.runner.status()[0]!.observationFloor).toBe(time+65000);
  await expect(f.runner.configure({...renewed,leaseRevision:3})).rejects.toThrow("stale_lease");
  await expect(f.runner.configure({...renew(renewed,time+180000),renewalFrom:{leaseRevision:1,expiresAt:time+119999}})).rejects.toThrow("renewal_unconfirmed");
  await expect(f.runner.configure({...renew(renewed,time+180000),grant:{...renewed.grant,expiresAt:time+180000,connectionRevision:"changed"}})).rejects.toThrow("generation_conflict");
  f.options.cipher.seal=async(...args)=>{const result=await seal(...args);f.setAuthorized(false);return result;};
  await expect(f.runner.configure(renew(renewed,time+180000))).rejects.toThrow("connection_unavailable");
  expect(f.runner.status()[0]!.leaseRevision).toBe(1);
});
test("network-only watch avoids background capture, preserves originating cause and distinct exchanges",async()=>{
  const f=fixture();const l=lease(["network"]);await f.runner.configure(l);expect(f.captures).toHaveLength(0);
  const exchange=()=>({startedDateTime:new Date(time).toISOString(),request:{url:"https://example.com/messages/private-id?token=private",method:"GET"},response:{status:200}});
  f.setCause("intent-1");const first=exchange();await f.runner.observeNetwork(first,0,false);f.setCause(undefined);await f.runner.observeNetwork(first,0,true);await f.runner.observeNetwork(first,0,true);await f.runner.observeNetwork(exchange(),0,true);
  const batch=f.queue.batch(l.grant)!;expect(batch.batch.items).toHaveLength(2);expect(batch.batch.items[0]!.cause).toBe("intent-1");expect(batch.batch.items[1]!.cause).toBeUndefined();
  expect(JSON.stringify(batch)).not.toContain("private-id");expect(batch.batch.items[0]!.sourceId).not.toBe(batch.batch.items[1]!.sourceId);
  f.setNetwork({state:"degraded",reason:"network-disconnected"});await f.runner.tick();expect(f.runner.status()[0]).toMatchObject({state:"needs-attention",reason:"network-disconnected"});
});
test("bounded streaming acknowledgements retain encrypted work and retry stable occurrence after restart",async()=>{
  const f=fixture();const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event());
  let cancelled=false;f.setTransport(async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2049));},cancel(){cancelled=true;}}),{status:202}));
  await f.runner.tick();expect(cancelled).toBe(true);expect(f.queue.batch(l.grant)!.batch.items).toHaveLength(1);
  const before=f.queue.batch(l.grant)!;await f.runner.close();f.setNow(time+4000);
  f.setTransport(async(_url,init)=>{expect(JSON.parse(String(init?.body))).toEqual(before.batch);return Response.json({status:"duplicate",through:1},{status:202});});
  const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();expect(f.queue.batch(l.grant)).toBeUndefined();
  await f.captures.at(-1)!.options.onEvent(event());expect(f.queue.batch(l.grant)).toBeUndefined();
});
test("pause revokes an in-flight response before acknowledgement and remains paused after reopen",async()=>{
  const f=fixture();const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event());
  let deliver!:(r:Response)=>void,started!:()=>void;const active=new Promise<void>(r=>started=r);f.setTransport(async()=>{started();return new Promise<Response>(r=>deliver=r);});
  const tick=f.runner.tick();await active;await f.runner.pause(l.grant.producer);deliver(Response.json({status:"accepted",through:1},{status:202}));await tick;
  expect(f.runner.hasActiveLease()).toBe(false);expect(f.queue.batch(l.grant)!.batch.items).toHaveLength(1);expect(f.runner.status()[0]!.state).toBe("paused");
  await f.runner.close();const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();expect(reopened.status()[0]!.state).toBe("paused");
});
test("suspend stops capture and aborts delivery before private sign-in, resume keeps occurrence identity",async()=>{
  const f=fixture();const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event());
  let started!:()=>void;const active=new Promise<void>(r=>started=r);
  f.setTransport(async(_url,init)=>{started();return new Promise<Response>((_r,reject)=>init?.signal?.addEventListener("abort",()=>reject(Error("aborted"))));});
  const tick=f.runner.tick();await active;await f.runner.suspend();await tick;
  expect(f.captures[0]!.closed).toBeGreaterThan(0);expect(f.runner.status()[0]!.reason).toBe("private-sign-in");
  await expect(f.captures[0]!.options.onEvent(event("late"))).rejects.toThrow("unavailable");
  f.setTransport(async()=>Response.json({status:"accepted",through:1},{status:202}));await f.runner.resume();expect(f.queue.batch(l.grant)).toBeUndefined();expect(f.captures).toHaveLength(2);
});
test("partial acknowledgements stay catching-up and failed capture is never reported watching",async()=>{
  const f=fixture();const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event("1"));await f.captures[0]!.options.onEvent(event("2"));
  f.setTransport(async()=>Response.json({status:"accepted",through:1},{status:202}));await f.runner.tick();expect(f.runner.status()[0]!.state).toBe("catching-up");expect(f.queue.batch(l.grant)!.batch.items[0]!.sequence).toBe(2);
  f.captures[0]!.health={state:"degraded",reason:"no-observer-target",targets:0,atMs:time};f.setTransport(async()=>Response.json({status:"accepted",through:2},{status:202}));await f.runner.tick();expect(f.runner.status()[0]).toMatchObject({state:"needs-attention",reason:"no-observer-target"});
});
test("private observation cutoff survives unfinished suspension and restart without discarding queued work",async()=>{
  const f=fixture();const l=lease();await f.runner.configure(l);await f.captures[0]!.options.onEvent(event("queued-before-login"));
  await f.runner.suspend();await f.runner.close();
  f.setNow(time+10000);const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();
  expect(reopened.status()[0]!.reason).toBe("private-sign-in");expect(f.captures).toHaveLength(1);expect(f.queue.batch(l.grant)!.batch.items).toHaveLength(1);
  await reopened.resume();expect(f.queue.batch(l.grant)).toBeUndefined();
  const capture=f.captures.at(-1)!;
  await capture.options.onEvent({...event("private-login-notification"),timestamp:(time+5000)/1000});expect(f.queue.batch(l.grant)).toBeUndefined();
  await capture.options.onEvent({...event("after-login-notification"),timestamp:(time+10001)/1000});expect(f.queue.batch(l.grant)!.batch.items).toHaveLength(1);
  expect(reopened.status()[0]!.excludedBefore).toBe(time+10000);
});
test("network-only health repair starts its endpoint and sealed backlog forwards through failed capture",async()=>{
  const f=fixture();let starts=0;f.options.endpoint=async()=>{starts++;f.setNetwork({state:"watching",reason:"ready"});return "ws://127.0.0.1:9999/devtools/browser/fixture";};f.setNetwork({state:"stopped",reason:"not-started"});
  await f.runner.configure(lease(["network"]));expect(starts).toBe(1);expect(f.runner.status()[0]!.state).toBe("watching");
  const l={...lease(),grant:{...lease().grant,producer:"push-2"}};await f.runner.configure(l);await f.captures[0]!.options.onEvent(event());
  f.captures[0]!.health={state:"degraded",reason:"disconnected",targets:0,atMs:time};f.options.endpoint=async()=>{throw Error("browser unavailable");};
  await f.runner.tick();expect(f.queue.batch(l.grant)).toBeUndefined();expect(f.runner.status().find(s=>s.producer==="push-2")!).toMatchObject({state:"needs-attention",reason:"capture-unavailable"});
});

test("only currently retained owned observer IDs are exposed for private target selection",async()=>{
  const f=fixture();await f.runner.configure(lease());
  expect(f.runner.observerTargetIds()).toEqual(["owned-observer-0"]);
  await f.runner.suspend();expect(f.runner.observerTargetIds()).toEqual([]);
  await f.runner.resume();expect(f.runner.observerTargetIds()).toEqual(["owned-observer-1"]);
  await f.runner.pause("watch-1");expect(f.runner.observerTargetIds()).toEqual([]);
});
test("one full watch queue records bounded encrypted gaps while another watch continues and backlog still forwards",async()=>{
  const f=fixture(),full=lease(["network"]),other={...lease(["network"]),grant:{...lease(["network"]).grant,producer:"other-watch"}};
  await f.runner.configure(full);await f.runner.configure(other);
  for(let i=0;i<1024;i++)f.queue.append(full.grant,{kind:"network",observedAt:time,sourceId:`accepted-${i}`,fields:{origin:"https://example.com",method:"GET",route:"/messages/{id}",status:200,outcome:"completed"}},`accepted-${i}`,time);
  const exchange=(i:number)=>({startedDateTime:new Date(time).toISOString(),request:{url:`https://example.com/messages/private-${i}`,method:"GET"},response:{status:200}});
  await f.runner.observeNetwork(exchange(1),1,true);await f.runner.observeNetwork(exchange(2),2,true);
  expect(f.queue.batch(other.grant)!.batch.items).toHaveLength(2);
  expect(f.runner.status().find(s=>s.producer===full.grant.producer)).toMatchObject({state:"needs-attention",coverageGap:{missed:2,acknowledged:0,reason:"observation-backlog"}});
  expect(f.db.query("SELECT COUNT(*) AS n FROM browser_watch_health").get()).toEqual({n:1});
  const health=JSON.stringify(f.db.query("SELECT * FROM browser_watch_health").all());expect(health).not.toContain("missed");expect(health).not.toContain("private-1");
  await f.runner.tick();expect(f.queue.batch(full.grant)!.batch.items[0]!.sequence).toBe(129);expect(f.queue.batch(other.grant)).toBeUndefined();
  expect(f.runner.status().find(s=>s.producer===full.grant.producer)).toMatchObject({state:"needs-attention",reason:"observation-gap"});
  await f.runner.close();const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();
  expect(reopened.status().find(s=>s.producer===full.grant.producer)).toMatchObject({state:"needs-attention",reason:"observation-gap",coverageGap:{missed:2}});
  await expect(reopened.acknowledgeCoverageGap(full.grant.producer,1,1)).rejects.toThrow("changed");
  const status=await reopened.acknowledgeCoverageGap(full.grant.producer,1,2);
  expect(status).toMatchObject({state:"watching",reason:"watching-after-acknowledged-gap",coverageGap:{missed:2,acknowledged:2}});
});
test("unfinished encrypted coverage summary restores an uncertain gap instead of ready status",async()=>{
  const f=fixture(),l=lease();await f.runner.configure(l);await f.runner.close();
  f.db.query("INSERT INTO browser_watch_health VALUES(?,?,?,'',1)").run(l.grant.producer,"alice",1);
  const reopened=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>reopened.close());await reopened.restore();
  expect(reopened.status()[0]).toMatchObject({state:"needs-attention",reason:"observation-gap",coverageGap:{missed:1,countUncertain:true,acknowledged:0}});
  expect(f.db.query("SELECT pending FROM browser_watch_health").get()).toEqual({pending:0});
  await reopened.pause(l.grant.producer);expect((await reopened.acknowledgeCoverageGap(l.grant.producer,1,1)).state).toBe("paused");
});
test("daemon heartbeat is bounded, surfaces failure and stops during suspension or lease expiry",async()=>{
  const f=fixture();let heartbeats=0,fail=false;
  const options={...f.options,keepAlive:async(signal:AbortSignal)=>{signal.throwIfAborted();heartbeats++;if(fail)throw Error("daemon unavailable");}};
  await f.runner.close();const runner=new BrowserWatchRunner(options);cleanups.unshift(async()=>runner.close());
  const l=lease();l.grant.expiresAt=time+600000;await runner.configure(l);expect(heartbeats).toBe(1);
  f.setNow(time+119999);await runner.tick();expect(heartbeats).toBe(1);
  fail=true;f.setNow(time+120000);await runner.tick();expect(heartbeats).toBe(2);expect(runner.status()[0]).toMatchObject({state:"needs-attention",reason:"browser-keep-alive-unavailable"});
  fail=false;f.setNow(time+149999);await runner.tick();expect(heartbeats).toBe(2);
  f.setNow(time+150000);await runner.tick();expect(heartbeats).toBe(3);expect(runner.status()[0]!.state).toBe("watching");
  await runner.suspend();f.setNow(time+300000);await runner.tick();expect(heartbeats).toBe(3);
  await runner.resume();expect(heartbeats).toBe(4);
  f.setNow(time+600000);await runner.tick();expect(heartbeats).toBe(4);expect(runner.status()[0]!.state).toBe("paused");
});

test("pause retains the full private watermark across restart and rejects obsolete lifecycle commands",async()=>{
  const f=fixture(),l=lease();f.setTransport(async()=>new Response(null,{status:503}));
  await f.runner.configure(l);
  await f.captures[0]!.options.onEvent(event("before-pause-1"));
  await f.captures[0]!.options.onEvent(event("before-pause-2"));
  const paused=await f.runner.pause(l.grant.producer,0);
  expect(paused).toMatchObject({state:"paused",lifecycleRevision:0,pausedThrough:2});
  const offered=f.queue.batch(l.grant)!;f.queue.acknowledge(l.grant,offered.batch.items.at(-1)!.sequence);
  expect(f.queue.batch(l.grant)).toBeUndefined();expect(f.queue.highWatermark(l.grant)).toBe(2);
  await f.runner.close();
  const rebuilt=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>rebuilt.close());await rebuilt.restore();
  expect(rebuilt.status()[0]).toMatchObject({state:"paused",lifecycleRevision:0,pausedThrough:2});
  await expect(rebuilt.configure(l)).rejects.toThrow("stale_lifecycle");
  await expect(rebuilt.configure({...l,grant:{...l.grant,generation:2}})).rejects.toThrow("source_immutable_new_producer");
  await expect(rebuilt.configure({...l,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:1}})).rejects.toThrow("resume_unconfirmed");
  const resumed={...l,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:2}};
  expect(await rebuilt.configure(resumed)).toMatchObject({state:"watching",lifecycleRevision:2});
  await expect(rebuilt.pause(l.grant.producer,0)).rejects.toThrow("stale_lifecycle");
  await expect(rebuilt.pause(l.grant.producer)).rejects.toThrow("stale_lifecycle");
  await expect(rebuilt.configure(l)).rejects.toThrow("stale_lifecycle");
  expect(rebuilt.hasActiveLease()).toBe(true);
  expect(await rebuilt.configure(resumed)).toMatchObject({state:"watching",lifecycleRevision:2});
  await f.captures.at(-1)!.options.onEvent(event("after-resume"));
  expect(f.queue.batch(l.grant)!.batch.items.map(item=>item.sequence)).toEqual([3]);
  expect(await rebuilt.pause(l.grant.producer,2)).toMatchObject({state:"paused",lifecycleRevision:2,pausedThrough:3});
});

test("callbacks from a previous watch lifecycle cannot append after resume",async()=>{
  const f=fixture(),l=lease(["push","network"]);f.setTransport(async()=>new Response(null,{status:503}));await f.runner.configure(l);
  const oldCapture=f.captures[0]!;
  const exchange=()=>({startedDateTime:new Date(time).toISOString(),request:{url:"https://example.com/messages/1",method:"GET"},response:{status:200}});
  const old=exchange();await f.runner.observeNetwork(old,0,false);
  const paused=await f.runner.pause(l.grant.producer,0);
  await f.runner.configure({...l,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:paused.pausedThrough!}});
  await f.runner.observeNetwork(old,0,true);
  await expect(oldCapture.options.onEvent(event("old-capture"))).rejects.toThrow("unavailable");
  expect(f.queue.batch(l.grant)).toBeUndefined();
  await f.runner.observeNetwork(exchange(),0,true);
  await f.captures.at(-1)!.options.onEvent(event("new-capture"));
  expect(f.queue.batch(l.grant)!.batch.items.map(item=>item.kind)).toEqual(["network","push"]);
});

test("a pause during lease encryption prevents a racing renewal from restoring active capture",async()=>{
  const f=fixture(),l=lease();await f.runner.configure(l);
  const original=f.options.cipher.seal.bind(f.options.cipher);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  let hold=true;
  f.options.cipher.seal=async(...args)=>{if(hold){hold=false;entered();await held;}return original(...args);};
  const renewal=f.runner.configure(renew(l,time+120000));
  await started;const pause=f.runner.pause(l.grant.producer,0);release();
  await expect(renewal).rejects.toThrow("stale_lifecycle");
  expect(await pause).toMatchObject({state:"paused",lifecycleRevision:0,pausedThrough:0});
  expect(f.runner.hasActiveLease()).toBe(false);
  await f.runner.close();const rebuilt=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>rebuilt.close());await rebuilt.restore();
  expect(rebuilt.status()[0]).toMatchObject({state:"paused",lifecycleRevision:0,pausedThrough:0});
});

test("missing private queue identity cannot reconstruct a safe paused watermark",async()=>{
  const f=fixture(),l=lease();f.setTransport(async()=>new Response(null,{status:503}));await f.runner.configure(l);
  await f.captures[0]!.options.onEvent(event("retained"));const paused=await f.runner.pause(l.grant.producer,0);
  expect(paused.pausedThrough).toBe(1);
  f.db.exec("DELETE FROM browser_observation_items; DELETE FROM browser_observation_heads");
  await expect(f.runner.configure({...l,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:1}})).rejects.toThrow("resume_unconfirmed");
  await f.runner.close();const rebuilt=new BrowserWatchRunner(f.options);cleanups.unshift(async()=>rebuilt.close());
  await expect(rebuilt.restore()).rejects.toThrow("queue_watermark_unavailable");
  expect(rebuilt.hasActiveLease()).toBe(false);
});
