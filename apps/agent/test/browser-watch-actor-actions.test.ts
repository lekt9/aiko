import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { agentMessageMethod } from "tardie";
import { deriveComponent } from "tardie/core/component";
import { methodCallKeys, methodResponseKeys, methodResponseDerivation } from "tardie/core/method";
import { EventLog } from "tardie/core/log";
import { Router } from "tardie/core/communication/router";
import { linkedEventOf, type ActorEnvelope } from "tardie/core/communication/envelope";
import { messageKeys } from "tardie/core/communication/message";
import { threadCreated } from "tardie/core/thread";
import { Self } from "tardie/core/runtime";
import { turnCompleted } from "tardie/log/events";
import type { Event } from "tardie/core/event";
import type { Transition } from "tardie/core/transition";
import { browserWatchActorActions, browserWatchActorEventKey, browserWatchActorAppendAllowed } from "../src/browser-watch-actor-actions.ts";
import { harnessBlobStore, harnessDigest } from "../src/harness-library.ts";
import { channelDigest } from "../src/channel-bindings.ts";
import { channelSeal } from "../src/channel-custody.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import type { WiringJournal } from "../src/channel-wiring.ts";
import type { BrowserWatchDispatch } from "../src/browser-watches.ts";
import { BROWSER_EVENT_SCHEMA } from "../src/browser-events.ts";
const closes:(()=>void)[]=[];afterEach(()=>{for(const close of closes.splice(0))close();});
const signal=()=>AbortSignal.timeout(5000);
async function fixture(){
  const owner="actor-owner",thread=`user-${owner}`,self={actor:"aiko",instance:"watch-actor-fixture",thread},db=new Database(":memory:");closes.push(()=>db.close());
  db.exec("CREATE TABLE actor_events(key TEXT PRIMARY KEY,body TEXT NOT NULL)");
  const read=()=>db.query("SELECT body FROM actor_events ORDER BY rowid").all().map(row=>JSON.parse((row as {body:string}).body) as Event);
  const key=(e:Event)=>methodCallKeys.keyOf(e)??methodResponseKeys.keyOf(e)??messageKeys.keyOf(e)??browserWatchActorEventKey(e)??`${e.type}:${e.id??e.call??e.turn??"root"}`;
  const append=(batch:readonly Event[])=>{
    const unique=batch.filter(e=>!db.query("SELECT key FROM actor_events WHERE key=?").get(key(e)));
    if(!browserWatchActorAppendAllowed(unique,read)||!adapter.admissionAllowed(unique,read))throw Error("fixture-actor-append-denied");
    db.transaction(()=>{for(const e of unique)db.query("INSERT INTO actor_events VALUES(?,?)").run(key(e),JSON.stringify(e));})();
  };
  const blobs=harnessBlobStore(sqliteWorkflowKV(db));
  let enabled=true,allowReceipt=true,hook=()=>{},sendHook=()=>{},mode:"normal"|"lost"|"fail"|"silent-denial"="normal",sends=0;
  const journal:WiringJournal={blobs,read:async()=>read(),transact:async(fn,before)=>{await before?.();const result=fn(read());append(result.events);return result.result;}};
  const binding={owner,thread,journal,self:()=>self,timeoutMs:30000,commitCurrent:()=>enabled,current:async(_i:BrowserWatchDispatch,_s:AbortSignal,operation:"execute"|"reconcile")=>{hook();return operation==="reconcile"?allowReceipt:enabled;}};
  let adapter=browserWatchActorActions(binding);
  append([threadCreated(self,undefined,Date.now())]);
  const event:BrowserWatchDispatch["event"]={type:"AikoBrowserPushObserved",schema:BROWSER_EVENT_SCHEMA,owner,id:"observed-1",producer:"watch-events",epoch:"profile-1",profile:"private-profile",generation:1,
    connectionId:"site",connectionRevision:"7",sequence:1,occurrence:"occurrence-1",kind:"push" as const,observedAt:Date.now(),at:Date.now(),sourceId:"opaque-source",
    fields:{origin:"https://site.example.com",outcome:"received" as const},payloadRef:await channelSeal(blobs,owner,{body:"PRIVATE_NOTIFICATION_BODY"}),commitment:await channelSeal(blobs,owner,{source:"private"})};
  const action={kind:"actor" as const,instruction:"Summarize the saved event"};
  const intent:BrowserWatchDispatch={operationId:`watch:notify:1:${channelDigest([owner,event.id,action])}`,watchId:"notify",generation:1,action,event};
  append([{type:"AikoBrowserWatchPrepared",owner,id:"notify:1",watchId:"notify",generation:1,at:Date.now()},
    {type:"AikoBrowserWatchStarted",owner,id:intent.operationId,watchId:intent.watchId,generation:1,eventId:event.id,source:"checked-source",at:Date.now()}]);
  const router={send:(envelope:import("tardie/core/communication/envelope").RoutedEnvelope)=>Effect.sync(()=>{
    sends++;sendHook();if(mode==="fail")throw Error("provider-send-rejected");
    if(mode==="silent-denial")return;
    if(envelope.event.type==="MessageReceived")append([linkedEventOf(envelope as ActorEnvelope)]);
    else append([envelope.event]);
    if(mode==="lost")throw Error("acknowledgement-lost");
  })};
  const log={append:(events:readonly Event[])=>Effect.sync(()=>append(events)),read:Effect.sync(read),head:Effect.sync(()=>read().length),readFrom:(mark:number)=>Effect.sync(()=>read().slice(mark))};
  const run=async(t:Transition<never,Router|Self>)=>{
    const returned=t.kind==="intent"?t.events(t.input,Date.now()):await Effect.runPromise(t.act(t.input,signal()).pipe(
      Effect.provideService(Router,router),Effect.provideService(Self,self),Effect.provideService(EventLog,log)));
    append(returned);
  };
  const accept=async()=>{
    const result=await adapter.execute(intent,signal());expect(result.status).toBe("pending");
    if(result.status!=="pending")throw Error("fixture-admission-unavailable");
    append([{type:"AikoBrowserWatchActionAccepted",owner,id:`${intent.operationId}:initial:accepted`,operationId:intent.operationId,watchId:intent.watchId,generation:1,
      receiptKey:harnessDigest(result.receipt),deadlineAt:result.deadlineAt,at:Date.now()}]);return result;
  };
  const transitions=()=>deriveComponent(adapter.component,read()).transitions;
  const dispatch=async()=>{for(const t of transitions())await run(t);};
  const complete=async()=>{
    expect(agentMessageMethod.state(read(),{method:"message",id:intent.operationId,epoch:0})?.status).toBe("pending");
    append([turnCompleted({turn:intent.operationId,output:"Deterministic fixture turn finished",at:Date.now()})]);
    for(const t of methodResponseDerivation({message:agentMessageMethod})(read()))await run(t);
  };
  return {owner,thread,self,intent,read,append,run,accept,dispatch,complete,transitions,binding,
    get adapter(){return adapter;},restart:()=>{adapter=browserWatchActorActions(binding);},sends:()=>sends,
    deny:()=>{enabled=false;},denyReceipt:()=>{allowReceipt=false;},hook:(f:typeof hook)=>{hook=f;},sendHook:(f:typeof sendHook)=>{sendHook=f;},mode:(value:typeof mode)=>{mode=value;},db};
}

test("native actor future waits acceptance, dispatches once, and reconstructs its exact pending and terminal receipt",async()=>{
  const f=await fixture();
  const initial=await f.adapter.execute(f.intent,signal());expect(initial.status).toBe("pending");
  expect(f.read().filter(e=>e.type==="CallPlanned")).toHaveLength(1);expect(f.transitions()).toEqual([]);expect(f.sends()).toBe(0);
  const accepted=await f.accept();f.restart();expect(await f.adapter.reconcile(f.intent,signal())).toEqual(accepted);
  await f.dispatch();expect(f.read().filter(e=>e.type==="MessageReceived")).toHaveLength(1);
  expect(f.read().some(e=>e.type==="CallDispatched")).toBe(true);
  expect(JSON.stringify(f.read())).not.toContain("PRIVATE_NOTIFICATION_BODY");
  f.restart();await f.dispatch();expect(f.sends()).toBe(1);
  await f.complete();expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"completed",result:{reason:"actor-turn-completed"}});
  const sends=f.sends();f.restart();await f.adapter.execute(f.intent,signal());await f.dispatch();expect(f.sends()).toBe(sends);
});

test("existing foreground work defers a watch; authority revoked after projection denies before Router send",async()=>{
  const f=await fixture();await f.accept();
  f.append([{type:"MessageReceived",id:"foreground",text:"User is working",at:Date.now()}]);
  expect(f.transitions()).toEqual([]);
  f.append([turnCompleted({turn:"foreground",output:"Done",at:Date.now()})]);
  const transition=f.transitions()[0]!;expect(transition).toBeDefined();
  f.deny();await f.run(transition);
  expect(f.sends()).toBe(0);expect(f.read().some(e=>e.type==="CallDispatched")).toBe(false);
  expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"failed",result:{reason:"authority-unavailable"}});
  f.restart();await f.dispatch();expect(f.sends()).toBe(0);
});

test("atomic message append fence rejects pause or foreground arrival during physical Router commit",async()=>{
  for(const busy of [false,true]){
    const f=await fixture();await f.accept();
    f.sendHook(()=>f.append([busy?{type:"MessageReceived",id:"user-race",text:"New user instruction",at:Date.now()}:
      {type:"AikoBrowserWatchControlled",owner:f.owner,id:"pause",watchId:f.intent.watchId,status:"paused",at:Date.now()}]));
    await f.dispatch();
    expect(f.read().some(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)).toBe(false);
    expect(f.read().some(e=>e.type==="CallDispatched")).toBe(false);
    expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  }
});

test("lost Router acknowledgement remains unknown but a later native response reconciles without another send",async()=>{
  const f=await fixture();await f.accept();f.mode("lost");await f.dispatch();
  expect(f.read().filter(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)).toHaveLength(1);
  expect(f.read().some(e=>e.type==="CallDispatched")).toBe(false);
  expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  f.restart();f.mode("normal");await f.dispatch();expect(f.sends()).toBe(1);
  await f.complete();expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"completed"});
});

test("synchronous authority revocation during Router send prevents native admission and cannot report dispatch",async()=>{
  const f=await fixture();await f.accept();
  f.sendHook(()=>f.deny());await f.dispatch();
  expect(f.sends()).toBe(1);
  expect(f.read().some(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)).toBe(false);
  expect(f.read().some(e=>e.type==="CallDispatched")).toBe(false);
  expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  f.restart();await f.dispatch();expect(f.sends()).toBe(1);
});

test("Router returning without an admitted native message cannot manufacture CallDispatched",async()=>{
  const f=await fixture();await f.accept();f.mode("silent-denial");await f.dispatch();
  expect(f.read().some(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)).toBe(false);
  expect(f.read().some(e=>e.type==="CallDispatched")).toBe(false);
  expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  f.restart();f.mode("normal");await f.dispatch();expect(f.sends()).toBe(1);
});

test("physical authority cache is short lived; only identical retained messages can replay after revocation",async()=>{
  const f=await fixture();await f.accept();await f.dispatch();
  const message=f.read().find(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)!;
  expect(message).toBeDefined();
  // Dispatch cleanup removes the hydrated capability even while authority remains enabled.
  expect(f.adapter.admissionAllowed([message],()=>[])).toBe(false);
  expect(f.adapter.admissionAllowed([message],f.read)).toBe(true);
  f.deny();f.restart();
  expect(f.adapter.admissionAllowed([message],f.read)).toBe(true);
  expect(browserWatchActorAppendAllowed([message],f.read)).toBe(true);
  expect(f.adapter.admissionAllowed([{...message,text:"Changed instruction"}],f.read)).toBe(false);
  expect(browserWatchActorAppendAllowed([{...message,text:"Changed instruction"}],f.read)).toBe(false);
  expect(f.adapter.admissionAllowed([message],()=>[])).toBe(false);
  await f.adapter.reconcile(f.intent,signal());
  expect(f.adapter.admissionAllowed([message],()=>[])).toBe(false);
  expect(f.adapter.admissionAllowed([{type:"MessageReceived",id:"ordinary",text:"User instruction",at:Date.now()}],()=>[])).toBe(true);
  expect(()=>browserWatchActorActions({...f.binding,commitCurrent:undefined} as unknown as Parameters<typeof browserWatchActorActions>[0])).toThrow();
});

test("late exact native response can resolve timeout; receipt checks never resubmit a missing or drifted plan",async()=>{
  const f=await fixture();await f.accept();await f.dispatch();
  const plan=f.read().find(e=>e.type==="CallPlanned")!;
  f.append([{type:"CallTimedOut",call:f.intent.operationId,method:"message",target:plan.target,timeoutMs:30000,deadlineAt:(plan.context as {deadlineAt:number}).deadlineAt,at:Date.now()}]);
  expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  await f.complete();const sends=f.sends();
  expect(await f.adapter.reconcile({...f.intent,reconciliationRequestId:"late-check"},signal())).toMatchObject({status:"completed"});
  expect(f.read().some(e=>e.type==="CallTimedOut")).toBe(true);expect(f.sends()).toBe(sends);
  expect(await f.adapter.reconcile({...f.intent,action:{kind:"actor",instruction:"Changed instruction"}},signal())).toMatchObject({status:"unknown"});
  f.denyReceipt();expect(await f.adapter.reconcile(f.intent,signal())).toMatchObject({status:"unknown"});
  const missing=await fixture();expect(await missing.adapter.reconcile(missing.intent,signal())).toMatchObject({status:"unknown"});
  expect(missing.read().some(e=>e.type==="CallPlanned")).toBe(false);expect(missing.sends()).toBe(0);
});

test("physical admission preserves an accepted old action pin but rejects deadline and epoch drift",async()=>{
  const f=await fixture();await f.accept();
  f.append([{type:"AikoBrowserWatchPrepared",owner:f.owner,id:"notify:2",watchId:f.intent.watchId,generation:2,at:Date.now()}]);
  const before=f.read();await f.dispatch();
  const message=f.read().find(e=>e.type==="MessageReceived"&&e.id===f.intent.operationId)!;
  expect(message).toBeDefined();expect(browserWatchActorAppendAllowed([message],()=>before)).toBe(true);
  const context=message.call as {invocation:{method:string;id:string;epoch:number};deadlineAt:number};
  expect(browserWatchActorAppendAllowed([{...message,call:{...context,invocation:{...context.invocation,epoch:1}}}],()=>before)).toBe(false);
  const clock=spyOn(Date,"now").mockImplementation(()=>context.deadlineAt+1);
  try{expect(browserWatchActorAppendAllowed([message],()=>before)).toBe(false);}finally{clock.mockRestore();}
  const late=await fixture();const receipt=await late.accept();
  late.hook(()=>{const clock=spyOn(Date,"now").mockImplementation(()=>receipt.deadlineAt+1);closes.push(()=>clock.mockRestore());});
  await late.dispatch();expect(late.sends()).toBe(0);
  expect(late.read().some(e=>e.type==="CallDispatched")).toBe(false);
});
