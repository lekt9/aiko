import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { createIndexerActor } from "../src/background.ts";
import { openMemory, type MemoryBinding } from "../src/memory.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { scanLearningSources, learningEventDigest } from "../src/learning-origin.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const thread="background-123-indexer";
const job=(id:string)=>({type:"AikoHookReceived",id,at:1,input:{id,subject:`fixture/${id}`,title:"Controlled source",kind:"fact",type:"fixture",payload:{value:id}},notification:{decision:"silent",reason:"fixture"}});
async function setup(mode:"normal"|"missing"|"transient"|"context-revoke"="normal"){
 const dir=await mkdtemp("/tmp/learning-source-recovery-");console.log(`source recovery evidence: ${dir}`);
 let connections=0,sourceRevoked=false;
 let reads=0,unavailable=mode==="transient";
 const binding:MemoryBinding={stateDir:dir,owner:"123",thread,redact:s=>s,
 readPage:async(a,n)=>{reads++;if(unavailable)throw Error("temporary source unavailable");const rows=await host.readPage(thread,a,n);return mode==="missing"?rows.map(r=>r.event.type==="AikoHookReceived"?{...r,event:{type:"FixtureNoise",at:1}}:r):rows;},
 readSourcePage:async(source,a,n)=>{if(sourceRevoked)throw Error("source revoked during context");if(source.actor!=="aiko"||source.instance!=="recovery"||!['user-123',thread].includes(source.thread))throw Error("denied source");return host.readPage(source.thread,a,n);}};
 const host=await createBunHost({database:join(dir,"actor.sqlite"),actorName:"aiko",actorInstance:"recovery",actorFor:t=>t===thread?createIndexerActor(binding,async()=>{connections++;
 if(mode!=="context-revoke")throw Error("unexpected connection execution");
 await Promise.resolve();sourceRevoked=true;
 return {input:{id:"context-result-001",subject:"fixture/context",title:"Valid context",kind:"fact",type:"fixture",payload:{value:"valid"}},url:"https://fixture.invalid/",revision:1,routes:[],linksTruncated:false};}):actor({name:"aiko",methods:{},components:[]})});
 cleanup.push(async()=>{await host.close();await rm(dir,{recursive:true,force:true});});
 await host.commitRoot(host.self(thread),{type:"FixtureRoot",at:1});
 return {host,binding,connections:()=>connections,reads:()=>reads,restore:()=>{unavailable=false;}, observations:()=>{const m=openMemory(binding);try{return m.journal.page(m.scope,{limit:2000});}finally{m.close();}}};
}
test("native indexer scans >800 rows and ingests without another turn",async()=>{
 const f=await setup();await f.host.seed(thread,Array.from({length:850},(_,i)=>({type:"FixtureNoise",at:1,i})));
 await f.host.seed(thread,[job("large-source-001")]);await f.host.wake(thread);
 const events=await f.host.read(thread),scans=events.filter(e=>e.type==="AikoLearningSourceScanned");
 expect(scans.length).toBeGreaterThanOrEqual(14);expect(scans.length).toBeLessThanOrEqual(15);
 expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id==="large-source-001")).toBe(true);
 expect(events.filter(e=>e.type==="AikoReplyPrepared"||e.type==="MessageReceived")).toHaveLength(0);
 const count=f.reads();await f.host.wake(thread);expect(f.reads()).toBe(count);
},30000);
test("missing target stops at fixed native cut despite appended scan receipts",async()=>{
 const f=await setup("missing");await f.host.seed(thread,[job("missing-source-001")]);
 const cut=(await f.host.readPage(thread,0,100)).at(-1)!.seq;await f.host.wake(thread);
 const events=await f.host.read(thread),scans=events.filter(e=>e.type==="AikoLearningSourceScanned");
 expect(scans.length).toBeLessThanOrEqual(2);expect(scans.length).toBeGreaterThan(0);
 expect(scans.every(e=>e.cut===cut&&Number(e.through)<=cut)).toBe(true);
 expect(events.some(e=>e.type==="AikoBackgroundFailed"&&e.id==="missing-source-001")).toBe(true);
 expect(f.observations()).toHaveLength(0);const reads=f.reads();await f.host.wake(thread);expect(f.reads()).toBe(reads);
},30000);
test("unavailable first target does not poison a distinct later native job",async()=>{
 const f=await setup("transient");await f.host.seed(thread,[job("first-source-001")]);await f.host.wake(thread);
 expect((await f.host.read(thread)).some(e=>e.type==="AikoBackgroundFailed"&&e.id==="first-source-001")).toBe(true);
 f.restore();await f.host.seed(thread,[job("second-source-002")]);await f.host.wake(thread);
 const events=await f.host.read(thread);expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id==="second-source-002")).toBe(true);
 expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id==="first-source-001")).toBe(false);
},30000);
test("valid original source with altered forwarded input is refused before DB ingestion",async()=>{
 const f=await setup();const sourceThread="user-123";
 await f.host.commitRoot(f.host.self(sourceThread),{type:"FixtureRoot",at:1});
 // Controlled source fact tests the trust boundary, not real promotion correctness.
 const source={type:"AikoHarnessPromoted",owner:"123",id:"promotion-source-001",at:1,name:"fixture",harnessDigest:`sha256:${"1".repeat(64)}`,contractDigest:`sha256:${"2".repeat(64)}`,contextDigest:`sha256:${"3".repeat(64)}`,generation:1};
 await f.host.seed(sourceThread,[source]);const rows=await f.host.readPage(sourceThread,0,100);
 const scan=await scanLearningSources({...f.binding,thread:sourceThread,readPage:(a,n)=>f.host.readPage(sourceThread,a,n)},parseThreadAddress(f.host.self(sourceThread)),0,new AbortController().signal,rows.at(-1)!.seq);
 const origin=scan.origins.find(o=>o.eventDigest===learningEventDigest(source))!;expect(origin).toBeDefined();
 const altered={...job("harness:promotion-source-001"),id:"hook:harness:promotion-source-001",cause:source.id,sourceThread,sourceDigest:learningEventDigest(source),origin};
 await f.host.seed(thread,[altered]);await f.host.wake(thread);
 const events=await f.host.read(thread);expect(events.some(e=>e.type==="AikoBackgroundFailed"&&e.id===altered.id)).toBe(true);
 expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id===altered.id)).toBe(false);expect(f.observations()).toHaveLength(0);
},30000);
for(const mutation of ["none","operation","identity"] as const) test(`legacy ready acquisition forwarded ${mutation}`,async()=>{
 const f=await setup(),sourceThread="user-123";
 await f.host.commitRoot(f.host.self(sourceThread),{type:"FixtureRoot",at:1});
 // Historical compatibility only: this controlled receipt attests neither current
 // readiness nor promotion, evaluation, notification eligibility or delivery.
 const source={type:"AikoHarnessAcquisitionSettled",owner:"123",id:"legacy-acquisition-001",at:1,status:"ready",name:"fixture",harnessDigest:`sha256:${"1".repeat(64)}`,contractDigest:`sha256:${"2".repeat(64)}`,contextDigest:`sha256:${"3".repeat(64)}`,generation:1};
 await f.host.seed(sourceThread,[source]);const rows=await f.host.readPage(sourceThread,0,100);
 const scan=await scanLearningSources({...f.binding,thread:sourceThread,readPage:(a,n)=>f.host.readPage(sourceThread,a,n)},parseThreadAddress(f.host.self(sourceThread)),0,new AbortController().signal,rows.at(-1)!.seq);
 const origin=scan.origins.find(o=>o.eventDigest===learningEventDigest(source))!;expect(origin).toBeDefined();
 const identity=harnessDigest(["aiko-capability-outcome/v1","123",harnessDigest([source.name,source.contractDigest,source.contextDigest]),source.harnessDigest,source.generation]);
 const input={id:`capability:${identity.slice(7)}`,subject:`capability:${source.name}:${source.contextDigest}`,title:`Verified capability ${source.name}`,kind:"skill",type:"capability-outcome",payload:{name:source.name,artifactDigest:source.harnessDigest,contractDigest:source.contractDigest,contextDigest:source.contextDigest,generation:source.generation,state:"verified"}};
 const forwarded={type:"AikoHookReceived",id:`hook:${input.id}`,operationId:source.id,cause:source.id,at:1,sourceThread,sourceDigest:learningEventDigest(source),origin,input,notification:{decision:"consider",outcome:{version:1,kind:"harness-acquisition",operationId:mutation==="operation"?"other-operation":source.id,identity:mutation==="identity"?`sha256:${"4".repeat(64)}`:identity,task:{thread:sourceThread,turn:"fixture-turn"}}}};
 await f.host.seed(thread,[forwarded]);await f.host.wake(thread);
 const events=await f.host.read(thread);
 expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id===forwarded.id)).toBe(mutation==="none");
 expect(events.some(e=>e.type==="AikoBackgroundFailed"&&e.id===forwarded.id)).toBe(mutation!=="none");
 expect(f.observations()).toHaveLength(mutation==="none"?1:0);
},30000);
for(const injected of [{revision:"attacker-revision"},{url:"https://attacker.invalid/"},{linkOffset:64},{notification:{decision:"consider"}},{awaitRevocation:true}]) test("awaitRevocation" in injected ? "source revoked during connection context prevents DB ingestion" : `forwarded connection rejects injected ${Object.keys(injected)[0]} before execution`,async()=>{
 const revoke="awaitRevocation" in injected;
 const f=await setup(revoke?"context-revoke":"normal"),sourceThread="user-123";
 await f.host.commitRoot(f.host.self(sourceThread),{type:"FixtureRoot",at:1});
 const source={type:"AikoConnectionChanged",owner:"123",id:"connection-source-001",at:1,status:"connected",connectionId:"fixture-connection"};
 await f.host.seed(sourceThread,[source]);const rows=await f.host.readPage(sourceThread,0,100);
 const scan=await scanLearningSources({...f.binding,thread:sourceThread,readPage:(a,n)=>f.host.readPage(sourceThread,a,n)},parseThreadAddress(f.host.self(sourceThread)),0,new AbortController().signal,rows.at(-1)!.seq);
 const origin=scan.origins.find(o=>o.eventDigest===learningEventDigest(source))!;expect(origin).toBeDefined();
 const forwarded={type:"AikoConnectionIndexRequested",id:source.id,connectionId:source.connectionId,cause:source.id,at:1,sourceThread,sourceDigest:learningEventDigest(source),origin,...(revoke?{}:injected)};
 await f.host.seed(thread,[forwarded]);await f.host.wake(thread);
 const events=await f.host.read(thread);
 expect(events.some(e=>e.type==="AikoBackgroundFailed"&&e.id===source.id)).toBe(true);
 expect(events.some(e=>e.type==="AikoLearningIndexed"&&e.id===source.id)).toBe(false);
 expect(f.connections()).toBe(revoke?1:0);expect(f.observations()).toHaveLength(0);
},30000);
