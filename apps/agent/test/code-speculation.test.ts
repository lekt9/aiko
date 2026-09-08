import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, outputValidateOnce } from "tardie";
import { infer as modelInfer } from "tardie/model";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { modelAdapters } from "tardie/model/adapter";
import { CodeHarness } from "../src/code-harness.ts";
import { codeResultCustody } from "../src/code-result-custody.ts";
import { partialExecuteCode, safeReadPrefix } from "../src/code-speculation.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { harnessDigest, type HarnessBlobStore } from "../src/harness-library.ts";

const databases: Database[] = [], hosts: Array<{close():Promise<void>}> = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const db of databases.splice(0)) db.close(); });
function storage(): AccountStorage {
  const db = new Database(":memory:"); databases.push(db); let alarm:number|null = null;
  return { sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as never[]);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;}};
}
const packageNames = new Set(["tools"]);
const allow = (call: {packageName:string;method:string;args:unknown}) => call.packageName === "tools" && call.method === "call" && (call.args as any)?.name === "read";
const prefix = "const row = await tools.call({name:'read',arguments:{id:1}});";
const gate = () => { let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release}; };
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Speculative read did not run before final model tokens")),1500);})]);}finally{if(timer)clearTimeout(timer);}}

test("only parsed literal read prefixes receive speculative authority", () => {
  expect(safeReadPrefix(prefix+"return row;",packageNames,allow)).toBe(prefix);
  for(const unsafe of [
    "const tools = await tools.call({name:'read'});", "await tools['call']({name:'read'});",
    "await tools.call({name:'read',arguments:{x:evil()}});", "await tools.call({name:'read',arguments:{...input}});",
    "await tools.call({name:'read',arguments:{get x(){return evil()}}});", "await tools.call({name:'read',arguments:{__proto__:{}}});",
    "await tools.call({name:'write'});", "if(true) await tools.call({name:'read'});", "await tools.call(input);",
    "const alias=tools.call;await alias({name:'read'});", "await tools.constructor({name:'read'});", "await tools.call({name:'read',arguments:{x:`${evil()}`}});",
  ]) expect(safeReadPrefix(unsafe,packageNames,allow)).toBeUndefined();
  expect(safeReadPrefix(prefix+"await tools.call({name:'write'});",packageNames,allow)).toBe(prefix);
});
test("partial JSON decoding preserves escapes and never manufactures unfinished source", () => {
  const json=JSON.stringify({summary:"Read a page",code:prefix+'return "a\\b";'});
  expect(partialExecuteCode(json)).toBe(prefix+'return "a\\b";');
  expect(partialExecuteCode('{"code":"'+prefix+'\\u00')).toBe(prefix);
  expect(partialExecuteCode('{"code":"bad\\x')).toBeUndefined();
  expect(partialExecuteCode('{"code":null}')).toBeUndefined();
});

async function streamedFixture(options:{mutate?:boolean;cancel?:boolean}={}) {
  const owner="123",thread="user-123",privateText="PRIVATE_STREAMED_BROWSER_EVIDENCE_317";
  const readStarted=gate(),releaseRead=gate();let reads=0,writes=0,aborted=false,modelCalls=0;
  const order:string[]=[];const blobs=new Map<string,unknown>();
  const blobStore:HarnessBlobStore={
    put:async (_owner,value)=>{const key=harnessDigest(value);blobs.set(key,structuredClone(value));return key;},
    putPrivate:async (_owner,value)=>{const key=harnessDigest(value);blobs.set(key,structuredClone(value));return key;},
    get:async (_owner,key)=>blobs.get(key),
  };
  let host!:Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const native=[{spec:{name:"read",description:"Read owner evidence",inputSchema:{type:"object" as const,properties:{id:{type:"integer"}},required:["id"]}},speculativeRead:true,
    run:(_:unknown,context:{signal:AbortSignal})=>Effect.promise(async()=>{reads++;order.push("read");readStarted.release();if(options.cancel)await new Promise<void>(resolve=>context.signal.addEventListener("abort",()=>{aborted=true;resolve();},{once:true}));return {text:privateText};})},
    {spec:{name:"write",description:"A mutation",inputSchema:{type:"object" as const}},run:()=>Effect.sync(()=>{writes++;order.push("write");return {ok:true};})}];
  const custody=codeResultCustody({owner,thread,blobs:blobStore,read:()=>host.read(thread),current:()=>true,tools:()=>native.map(tool=>tool.spec)});
  const makeHarness = () => {
    const harness=new CodeHarness(owner,thread,runCodeSegment,value=>value,undefined,custody);
    const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package(native)]),outputValidateOnce])]});
    return {harness,definition};
  };
  const {harness,definition}=makeHarness();
  const finalCode=prefix+(options.mutate?"await tools.call({name:'write',arguments:{}});":"")+"return row.text;";
  const adapters=modelAdapters({id:"fixture",protocols:["openai-chat-completions"],start:context=>({stream:{async *[Symbol.asyncIterator](){
    if(++modelCalls>1){
      const pairs=context.messages.filter(message=>(message as any).toolCalls);
      expect((pairs[0] as any)?.toolCalls[0].id).toBe("wire-call");
      yield {type:"TEXT_MESSAGE_START",messageId:"final",role:"assistant"} as any;
      yield {type:"TEXT_MESSAGE_CONTENT",messageId:"final",delta:"Verified private read"} as any;
      yield {type:"TEXT_MESSAGE_END",messageId:"final"} as any;return;
    }
    yield {type:"TOOL_CALL_START",toolCallId:"wire-call",toolCallName:"execute",toolName:"execute"} as any;
    order.push("prefix tokens");
    // Keep the code JSON string open while the already closed statement executes.
    yield {type:"TOOL_CALL_ARGS",toolCallId:"wire-call",delta:JSON.stringify({code:prefix}).slice(0,-2)} as any;
    await bounded(readStarted.promise);
    order.push("tail tokens");
    if(options.cancel)await releaseRead.promise;
    yield {type:"TOOL_CALL_ARGS",toolCallId:"wire-call",delta:JSON.stringify(finalCode.slice(prefix.length)).slice(1)+'}'} as any;
    yield {type:"TOOL_CALL_END",toolCallId:"wire-call"} as any;
  }}})});
  const provider=modelInfer({provider:"fixture",model:"fixture",protocol:"openai-chat-completions",apiKey:"unused",baseUrl:"https://fixture.invalid",contextWindowTokens:32000,maxTokensLadder:[1000]},adapters,{physicalAttemptId:()=>"physical-fixture"});
  host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"fixture",ownsThread:t=>t===thread,actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(provider),harness.sandboxLayer())});hosts.push(host);
  return {host,thread,privateText,order,reads:()=>reads,writes:()=>writes,aborted:()=>aborted,readStarted,releaseRead,
    restore:async(events:readonly any[])=>{
      const fresh=makeHarness();
      host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"fixture",ownsThread:t=>t===thread,actorFor:()=>fresh.definition,layersFor:()=>Layer.merge(fresh.harness.inference(provider),fresh.harness.sandboxLayer())});hosts.push(host);
      for(const event of events)await host.commitRoot(host.self(thread),event);
      return host;
    }
  };
}

test("actual model tool-argument streaming executes native safe reads before final tokens and adopts custody without duplicate calls",async()=>{
  const f=await streamedFixture({mutate:true});
  await f.host.commitRoot(f.host.self(f.thread),{type:"MessageReceived",id:"stream-turn",text:"Read and then update",at:1});
  await bounded(f.host.drive());
  const events=await f.host.read(f.thread);
  expect(f.order).toEqual(["prefix tokens","read","tail tokens","write"]);
  expect(f.reads()).toBe(1);expect(f.writes()).toBe(1);
  const called=events.find(event=>event.type==="ToolCalled")!;
  expect(called.providerCallId).toBe("wire-call");expect(String(called.callId)).toStartWith("spec-");
  expect(events.filter(event=>event.type==="CodeDispatched")).toHaveLength(1);
  expect(events.filter(event=>event.type==="CodeSettled")).toHaveLength(1);
  expect(events.filter(event=>event.type==="CodeSpeculationAdopted")).toHaveLength(1);
  expect(events.find(event=>event.type==="TurnCompleted")?.output).toBe("Verified private read");
  expect(JSON.stringify(events)).not.toContain(f.privateText);
  await f.host.drive();expect(f.reads()).toBe(1);expect(f.writes()).toBe(1);
});

test("private speculative results survive a cold harness replay with their original call identity",async()=>{
  const f=await streamedFixture();
  await f.host.commitRoot(f.host.self(f.thread),{type:"MessageReceived",id:"cold-stream",text:"Read evidence",at:1});await bounded(f.host.drive());
  const events=await f.host.read(f.thread),dispatch=events.findIndex(event=>event.type==="CodeDispatched");
  expect(dispatch).toBeGreaterThan(0);
  const restored=await f.restore(events.slice(0,dispatch+1));await bounded(restored.drive());
  const replay=await restored.read(f.thread);
  expect(f.reads()).toBe(1);
  expect(replay.find(event=>event.type==="CodeSettled")?.error).toBeUndefined();
  expect(replay.find(event=>event.type==="TurnCompleted")?.output).toBe("Verified private read");
  expect(JSON.stringify(replay)).not.toContain(f.privateText);
});

test("native cancellation aborts an in-flight speculative read and never adopts its result",async()=>{
  const f=await streamedFixture({cancel:true});
  await f.host.commitRoot(f.host.self(f.thread),{type:"MessageReceived",id:"cancel-stream",text:"Read evidence",at:1});const driving=f.host.drive();
  try{await bounded(f.readStarted.promise);}finally{
    await f.host.commitRoot(f.host.self(f.thread),cancellationRequested({invocation:{method:"message",id:"cancel-stream",epoch:0},request:"cancel-spec",cause:"requested",at:Date.now()}));
    f.releaseRead.release();
  }
  await bounded(driving);const events=await f.host.read(f.thread);
  expect(f.aborted()).toBe(true);expect(f.reads()).toBe(1);
  expect(events.some(event=>event.type==="CodeSpeculationAdopted")).toBe(false);
  expect(events.some(event=>event.type==="CodeDispatched")).toBe(false);
  expect(events.some(event=>event.type==="TurnCancelled")).toBe(true);
});

test("native adoption rejects changed source, physical attempts, missing inference authority and cancellation",async()=>{
  const {adoptSpeculativePrefix}=await import("tardie/code/execution/reactor");
  const {EventLog}=await import("tardie/core/log");
  const authority={execId:"spec-fixture",turn:"turn",epoch:0,attempt:"turn/infer/0",physicalAttempt:"physical-1",providerCallId:"wire",prefix,at:1};
  const initial=[{type:"MessageReceived",id:"turn",text:"read",at:0},{type:"ModelCalled",turn:"turn",callId:authority.attempt,at:0},
    {type:"CodeSpeculationStarted",...authority},{type:"CodeSpeculationSettled",execId:authority.execId,turn:"turn",at:2}];
  for(const changed of [{code:"return 0;"},{physicalAttempt:"physical-2"},{attempt:"turn/infer/1"},{providerCallId:"other-wire"},{prefix:prefix.replace("id:1","id:2")}]){
    const rows:any[]=[...initial];const log={read:Effect.sync(()=>rows),append:(events:readonly any[])=>Effect.sync(()=>{rows.push(...events);}),head:Effect.sync(()=>rows.length),readFrom:(n:number)=>Effect.sync(()=>rows.slice(n))};
    expect(await Effect.runPromise(adoptSpeculativePrefix({...authority,code:prefix+"return row;",...changed}).pipe(Effect.provideService(EventLog,log)))).toBe(false);
    expect(rows.some(e=>e.type==="CodeSpeculationAdopted")).toBe(false);
  }
  const rows:any[]=[...initial];const log={read:Effect.sync(()=>rows),append:(events:readonly any[])=>Effect.sync(()=>{rows.push(...events);}),head:Effect.sync(()=>rows.length),readFrom:(n:number)=>Effect.sync(()=>rows.slice(n))};
  const adopt=()=>Effect.runPromise(adoptSpeculativePrefix({...authority,code:prefix+"return row;"}).pipe(Effect.provideService(EventLog,log)));
  expect(await adopt()).toBe(true);expect(await adopt()).toBe(true);expect(rows.filter(e=>e.type==="CodeSpeculationAdopted")).toHaveLength(1);
  rows.push(cancellationRequested({invocation:{method:"message",id:"turn",epoch:0},request:"stop",cause:"requested",at:3}));
  expect(await adopt()).toBe(false);
});

test("native speculative execution refuses unclassified writes even when guest catches the rejection",async()=>{
  const {speculateCodePrefix}=await import("tardie/code/execution/reactor");
  const {definePackage}=await import("tardie/code/package/definition");
  const {Infer}=await import("tardie");
  const {codegraffSandboxLayer}=await import("../src/code-sandbox.ts");
  let writes=0;
  const pkg=definePackage({name:"unsafe",description:"Unclassified package",methods:{write:()=>Effect.sync(()=>{writes++;return {ok:true};})}});
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([pkg]),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"gate"}}),react:(request,key)=>Effect.promise(async()=>{
    await request.nativeCode!.run(speculateCodePrefix({execId:"spec-native-gate",turn:request.identity.turn,epoch:0,attempt:key!,physicalAttempt:"gate-physical",providerCallId:"wire",prefix:"try { await unsafe.write({}); } catch {}",at:1},[pkg]));
    return {kind:"complete",output:"gate checked"};
  })});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"fixture",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(model,codegraffSandboxLayer(runCodeSegment))});hosts.push(host);
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"gate-turn",text:"check native authority",at:0});await bounded(host.drive());
  const rows=await host.read("user-123");expect(writes).toBe(0);expect(String(rows.find(e=>e.type==="CodeSpeculationSettled")?.error)).toContain("read-only authority");
  expect(rows.some(e=>e.type==="CodeSpeculationReadAuthorized")).toBe(false);expect(rows.some(e=>e.type==="CodeSettled")).toBe(false);
});
