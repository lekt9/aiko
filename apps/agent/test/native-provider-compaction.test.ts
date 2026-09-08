import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, Infer, outputValidateOnce } from "tardie";
import { compaction, compactionReactor } from "tardie/component/compaction";
import { modelRequest } from "tardie/inference/request";
import { agentKeys } from "tardie/log/events";
import { usageIn } from "tardie/inference/usage";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const dbs:Database[]=[],hosts:Array<{close():Promise<void>}>=[];
afterEach(async()=>{for(const host of hosts.splice(0))await host.close();for(const db of dbs.splice(0))db.close();});
function storage():AccountStorage {const db=new Database(":memory:");dbs.push(db);let alarm:number|null=null;return {sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as never[]);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;}};}
const model={provider:"fixture",model_id:"compact"},other={provider:"fixture",model_id:"other"};
const policy={contextWindowTokens:1000,fireRatio:0.8,keepRatio:0.2};
const history=():Event[]=>Array.from({length:4},(_,i)=>[
  {type:"MessageReceived",id:`m${i}`,text:`SOURCE_${i} ${"x".repeat(1800)}`,at:i*3},
  {type:"TurnCompleted",turn:`m${i}`,output:`answer-${i}`,at:i*3+1},
]).flat();
function fixtureLog(rows:Event[]){return {read:Effect.sync(()=>rows),append:(events:readonly Event[])=>Effect.sync(()=>{rows.push(...events);}),head:Effect.sync(()=>rows.length),readFrom:(mark:number)=>Effect.sync(()=>rows.slice(mark))};}
async function compactOnce(rows:Event[],binding:typeof Infer.Service){const transition=compactionReactor(policy)(rows)[0];if(transition?.kind!=="effect")throw Error("Compaction did not schedule");return Effect.runPromise(transition.act(transition.input,new AbortController().signal).pipe(Effect.provideService(Infer,binding),Effect.provideService(Self,{actor:"aiko",instance:"fixture",thread:"user-123"}),Effect.provideService(EventLog,fixtureLog(rows))));}

test("native scheduled provider compaction records usage and survives cold host replay without another compaction",async()=>{
  let compacts=0;const seen:unknown[]=[];
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([compaction(policy),outputValidateOnce])]});
  const binding=Layer.succeed(Infer,{resolve:()=>({model}),compact:request=>Effect.sync(()=>{compacts++;expect(request.model).toEqual(model);return {state:{opaque:`state-${compacts}`},usage:{promptTokens:100,completionTokens:5}};}),react:request=>Effect.sync(()=>{seen.push(modelRequest(request.trajectory,{...request,model}).providerState);return {kind:"complete" as const,output:"ready"};})});
  const open=async(rows:readonly Event[])=>{const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"fixture",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>binding});hosts.push(host);for(const event of rows)await host.commitRoot(host.self("user-123"),event);return host;};
  const host=await open(history());await host.drive();
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"next",text:"Continue",at:30});await host.drive();
  const rows=await host.read("user-123"),checkpoint=rows.find(e=>e.type==="CompactionCompleted")!;
  expect(checkpoint.providerState).toEqual({opaque:"state-1"});expect(checkpoint.model).toEqual(model);expect(checkpoint.usage).toEqual({promptTokens:100,completionTokens:5});
  expect(seen).toEqual([{opaque:"state-1"}]);expect(compacts).toBe(1);expect(usageIn(rows,"m3").promptTokens).toBe(100);
  const end=rows.findIndex(e=>e.type==="CompactionCompleted");const restored=await open([...rows.slice(0,end+1),{type:"MessageReceived",id:"next",text:"Continue",at:30}]);await restored.drive();
  expect(compacts).toBe(1);expect(seen).toEqual([{opaque:"state-1"},{opaque:"state-1"}]);
});

test("successive native compactions receive previous opaque state; a different model restores raw context",async()=>{
  const rows=history();let previous:unknown;
  const first=await compactOnce(rows,{resolve:()=>({model}),compact:()=>Effect.succeed({state:{opaque:1}}),react:()=>Effect.die(Error("Client summary should not run"))});rows.push(...first);
  const initial=modelRequest(rows,{system:"",tools:[],model});expect(initial.providerState).toEqual({opaque:1});
  const switched=modelRequest(rows,{system:"",tools:[],model:other});expect(switched.providerState).toBeUndefined();expect(JSON.stringify(switched.messages)).toContain("SOURCE_0");
  rows.push({type:"MessageReceived",id:"new",text:"Y".repeat(5000),at:50},{type:"TurnCompleted",turn:"new",output:"done",at:51});
  const next=await compactOnce(rows,{resolve:()=>({model}),compact:request=>Effect.sync(()=>{previous=request.previous;return {state:{opaque:2}};}),react:()=>Effect.die(Error("Unexpected summary"))});
  expect(previous).toEqual({opaque:1});expect(next[0]?.providerState).toEqual({opaque:2});
});

test("failed provider and client compaction retain all prior context and journal the attempted boundary",async()=>{
  const rows=history(),before=modelRequest(rows,{system:"",tools:[],model});
  const failed=await compactOnce(rows,{resolve:()=>({model}),compact:()=>Effect.die(Error("provider unavailable")),react:()=>Effect.succeed({kind:"fail",error:"summary unavailable"})});
  expect(failed[0]?.keepFrom).toBe("");expect(failed[0]?.error).toContain("prior context retained");expect(failed[0]?.attemptKeepFrom).not.toBe("");
  expect(agentKeys.keyOf(failed[0]!)).toBe(`cc:${failed[0]?.attemptKeepFrom}`);
  expect(modelRequest([...rows,...failed],{system:"",tools:[],model}).messages).toEqual(before.messages);
});

test("portable fallback after opaque compaction summarizes raw earlier facts",async()=>{
  const rows=history();rows.push(...await compactOnce(rows,{resolve:()=>({model}),compact:()=>Effect.succeed({state:{opaque:1}}),react:()=>Effect.die(Error("unexpected"))}));
  rows.push({type:"MessageReceived",id:"new",text:"Y".repeat(5000),at:50},{type:"TurnCompleted",turn:"new",output:"done",at:51});
  let brief="";const next=await compactOnce(rows,{resolve:()=>({model:other}),compact:()=>Effect.succeed(undefined),react:request=>Effect.sync(()=>{brief=String(request.trajectory[0]?.text);return {kind:"complete",output:"Portable facts"};})});
  expect(brief).toContain("SOURCE_0");expect(next[0]?.providerState).toBeUndefined();expect(next[0]?.summary).toBe("Portable facts");
});


test("native compaction never cuts through a concurrently issued tool batch",async()=>{
  const rows:Event[]=[{type:"MessageReceived",id:"batch-turn",text:"Inspect "+"x".repeat(4000),at:0},
    {type:"ToolCalled",callId:"a",batchId:"batch",name:"read",arguments:{},turn:"batch-turn",at:1},
    {type:"ToolCalled",callId:"b",batchId:"batch",name:"read",arguments:{},turn:"batch-turn",at:1},
    {type:"ToolReturned",callId:"a",result:"x".repeat(6000),turn:"batch-turn",at:2},
    {type:"ToolReturned",callId:"b",result:"done",turn:"batch-turn",at:3},
    {type:"TurnCompleted",turn:"batch-turn",output:"done",at:4}];
  const result=await compactOnce(rows,{resolve:()=>({model}),react:()=>Effect.succeed({kind:"complete",output:"Prior facts"})});
  expect(result[0]?.keepFrom).toBe("c:a");
  const rendered=modelRequest([...rows,...result],{model,system:"",tools:[]}).messages;
  const calls=new Set(rendered.flatMap(message=>message.toolCalls?.map(call=>call.id)??[]));
  for(const message of rendered)if(message.role==="tool")expect(calls.has(message.toolCallId!)).toBe(true);
});
