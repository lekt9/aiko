import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {Effect,Layer} from 'effect';
import {actor,handles} from 'tardie';
import {createBunHost} from 'tardie/bun/host';
import {EventLog} from 'tardie/core/log';
import type {Event} from 'tardie/core/event';
import {createCloudflareAccountHost,type AccountStorage} from '../src/cloudflare-host.ts';
import {voiceAndOutbox} from '../src/actor.ts';
import {openMemory, type MemoryBinding} from '../src/memory.ts';
import {harnessDigest} from '../src/harness-library.ts';
import {defaultProactivePreferences,proactiveAppendAllowed,proactiveEventKey,proactiveEvidence,proactivePolicy,proactiveWaitMethod} from '../src/proactive-policy.ts';

// Trusted retained-row seeding exercises the native outbox/append boundary,
// not production HTTP admission or the upstream proactive decision producer.
type Backend='bun'|'account';
test('foreign lifecycle rows cannot reserve native outbox keys or change its projection',()=>{
 const outbox=voiceAndOutbox('123',()=>{throw Error('No voice in projection check');},async()=>{throw Error('No send in projection check');});
 const accepted=outbox.machine.step(outbox.machine.initial(),{type:'AikoProactiveAccepted',owner:'123',id:'projection',at:1,text:'Owned result',supports:['fixture'],chat:'123'});
 const prepared=outbox.machine.step(accepted,{type:'AikoReplyPrepared',turn:'proactive:projection',epoch:0,at:1,result:{text:'Owned draft',source:'template'}});
 expect(outbox.machine.output(prepared).transitions).toHaveLength(1);
 for(const type of ['AikoVoiceStarted','AikoReplySuppressed','AikoReplyPrepared','AikoDeliveryStarted','AikoDeliverySettled']){
  const foreign={type,owner:'456',turn:'proactive:projection',epoch:0,at:2,result:{status:'delivered',text:'Foreign draft',source:'template'}};
  expect(outbox.keys!.keyOf(foreign)).toBeUndefined();
  expect(outbox.machine.step(prepared,foreign)).toBe(prepared);
 }
 for(const owner of ['123',undefined]){
  const settled={type:'AikoDeliverySettled',owner,turn:'proactive:projection',epoch:0,at:3,result:{status:'unknown'}};
  expect(outbox.keys!.keyOf(settled)).toBe('aiko-send:proactive:projection:0');
  expect(outbox.machine.output(outbox.machine.step(prepared,settled)).transitions).toHaveLength(0);
 }
});
async function fixture(backend:Backend,at=Date.now()){
 const dir=await mkdtemp('/tmp/proactive-outbox-'),thread='user-123';
 const memory:MemoryBinding={stateDir:dir,owner:'123',thread,redact:s=>s,readPage:async()=>[]};
 const store=openMemory(memory);
 const saved=store.remember({subject:'runtime/ready',title:'Runtime ready',type:'decision',kind:'fact',payload:'Controlled verified outcome'}, {key:'fixture-evidence',producer:{kind:'agent',reference:'fixture:trusted-outcome'}});
 store.close();
 const supports=[saved.id],topics=proactiveEvidence(memory,supports)!.topics;
 let seeding=true,rejectClaim=false,afterClaim:(()=>void|Promise<void>)|undefined,substituteWinner=false;
 let sends=0,rejected=0,unknown=false,db:Database|undefined,host:any;
 let voiceStarted:(()=>Promise<void>)|undefined;
 const evidenceAtSend:boolean[]=[];
 const attempted:Event[][]=[],returned:Event[][]=[];
 const production=voiceAndOutbox('123',input=>Effect.promise(async()=>{await voiceStarted?.();return {text:input.kind==='task'?input.receipt:'Fixture answer',source:'template' as const};}),async(chat)=>{expect(chat).toBe('123');evidenceAtSend.push(!!proactiveEvidence(memory,supports));sends++;return {status:unknown?'unknown' as const:'delivered' as const};},{live:true,redact:s=>s,memory});
 const wrapped={...production,machine:{...production.machine,output:(state:any)=>{
  const output=production.machine.output(state);
  return {...output,transitions:seeding?[]:output.transitions.map((t:any)=>t.kind!=='effect'?t:{...t,act:(input:any,signal:AbortSignal)=>Effect.gen(function*(){
   const log=yield* EventLog;let claimed=false;
   const intercepted={...log,append:(events:readonly Event[])=>{
    if(!events.some(e=>e.type==='AikoProactiveDispatchAuthorized'))return log.append(events);
    claimed=true;
    attempted.push(structuredClone([...events]));
    const batch=substituteWinner?events.map(e=>e.type==='AikoProactiveDispatchAuthorized'?{...e,claimId:'other-native-claim'}:e.type==='AikoDeliveryStarted'?{...e,proactiveClaimId:'other-native-claim'}:e):events;
    return log.append(batch).pipe(Effect.tap(()=>Effect.promise(async()=>{await afterClaim?.();})));
   }};
   const result=yield* t.act(input,signal).pipe(Effect.provideService(EventLog,intercepted));
   // Trace this claim's effect, independently of other native activation effects.
   if(claimed)returned.push(structuredClone(result as Event[]));return result;
  })})};
 }}};
 const definition=actor({name:'aiko',methods:{proactiveWait:proactiveWaitMethod},components:[handles(proactiveWaitMethod,wrapped)]});
 const keyOf=(e:Event)=>proactiveEventKey(e)??production.keys!.keyOf(e)??(['AikoProactiveDecision','AikoProactiveAccepted'].includes(e.type)?`fixture:${e.type}:${e.owner}:${e.id}`:undefined);
 const canAppend=(t:string,events:readonly Event[],read:()=>readonly Event[])=>{
  if(!proactiveAppendAllowed(events,read,t)){rejected++;return false;}
  if(rejectClaim&&events.some(e=>e.type==='AikoProactiveDispatchAuthorized')){rejected++;return false;}
  return true;
 };
 async function open(){
  if(backend==='bun')host=await createBunHost({database:join(dir,'native.sqlite'),actorName:'aiko',actorInstance:'outbox-fixture',actorFor:()=>definition,keyOf,canAppend});
  else{
   db=new Database(join(dir,'native.sqlite'));
   const storage:AccountStorage={sql:{exec:(q,...args)=>{const rows=db!.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db!.transaction(fn)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
   host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'outbox-fixture',ownsThread:t=>t===thread,actorFor:()=>definition,layersFor:()=>Layer.empty,keyOf,canAppend});
  }
 }
 await open();
 const seed=async(events:Event[])=>{seeding=true;for(const e of events)await host.commitRoot(host.self(thread),e);};
 const decision=(id:string):Event[]=>[
  {type:'AikoProactiveDecision',owner:'123',id,at,text:'Runtime ready',supports,sourceThread:'background-123-indexer',root:'fixture-root'},
  {type:'AikoProactiveAccepted',owner:'123',id,at,decisionAt:at,text:'Runtime ready',supports,topics,sourceThread:'background-123-indexer',root:'fixture-root',chat:'123',policyRevision:'default',batchAt:at,batchWindowMs:0},
  {type:'AikoReplyPrepared',turn:`proactive:${id}`,epoch:0,at,result:{text:'Runtime ready',source:'template'}},
 ];
 const prefs=(limit:number,id='reduced'):Event=>{const preferences={...defaultProactivePreferences,dailyLimit:limit};return {type:'AikoProactivePreferencesSet',owner:'123',id,at,previousRevision:'default',preferences,preferencesDigest:harnessDigest(preferences)};};
 const claim=(id:string,claimId='retained-start'):Event[]=>[
  {type:'AikoProactiveDispatchAuthorized',owner:'123',id,decisionId:id,turn:`proactive:${id}`,epoch:0,chat:'123',at,topics,supports,claimId,policyRevision:'default'},
  {type:'AikoDeliveryStarted',turn:`proactive:${id}`,epoch:0,at,proactiveClaimId:claimId},
 ];
 return {seed,seedClaim:async(events:Event[])=>{seeding=true;await host.seed(thread,events);},decision,prefs,claim,topics,attempted,returned,memory,evidenceAtSend,
  setReject:()=>{rejectClaim=true;},setUnknown:()=>{unknown=true;},setWinner:()=>{substituteWinner=true;},after:(f:()=>void|Promise<void>)=>{afterClaim=f;},
  duringVoice:(f:()=>Promise<void>)=>{voiceStarted=f;},
  forget:()=>{const m=openMemory(memory);try{m.forget(saved.subject,saved.id,'fixture-forget-after-claim');}finally{m.close();}},
  counts:()=>({sends,rejected}),rows:()=>host.read(thread) as Promise<Event[]>,
  drive:async()=>{seeding=false;if(backend==='bun')await host.recover();else await host.wake(thread);},
  restart:async()=>{await host.close();db?.close();db=undefined;await open();},
  close:async()=>{await host.close();db?.close();await rm(dir,{recursive:true,force:true});},
 };
}
for(const backend of ['bun','account'] as const){
 test(`${backend}: foreign outbox lifecycle rows cannot consume an owned reply through restart`,async()=>{
  const f=await fixture(backend);
  try{
   const decision=f.decision('owner-collision'),turn='proactive:owner-collision';
   await f.seed(decision.slice(0,2));
   await f.seedClaim([
    {type:'AikoReplySuppressed',owner:'456',turn,epoch:0,at:Date.now()},
    {type:'AikoReplyPrepared',owner:'456',turn,epoch:0,at:Date.now(),result:{text:'Foreign draft',source:'template'}},
    {type:'AikoDeliverySettled',owner:'456',turn,epoch:0,at:Date.now(),result:{status:'delivered'}},
   ]);
   expect((await f.rows()).filter(e=>e.owner==='456')).toHaveLength(3);
   await f.seed(decision.slice(2));
   await f.restart();await f.drive();
   expect(f.counts().sends).toBe(1);
   const rows=await f.rows();
   expect(rows.filter(e=>e.type==='AikoDeliverySettled'&&e.owner!=='456'&&(e.result as any)?.status==='delivered')).toHaveLength(1);
   expect(rows.some(e=>e.type==='AikoReplyPrepared'&&e.owner!=='456'&&(e.result as any)?.text==='Runtime ready')).toBe(true);
   await f.restart();await f.drive();expect(f.counts().sends).toBe(1);
  }finally{await f.close();}
 });
 test(`${backend}: a foreign settlement after our dispatch claim does not suppress its send`,async()=>{
  const f=await fixture(backend);
  try{
   await f.seed(f.decision('foreign-after-claim'));
   f.after(()=>f.seedClaim([{type:'AikoDeliverySettled',owner:'456',turn:'proactive:foreign-after-claim',epoch:0,at:Date.now(),result:{status:'delivered'}}]));
   await f.drive();expect(f.counts().sends).toBe(1);
   expect((await f.rows()).filter(e=>e.type==='AikoDeliverySettled'&&e.owner==='456')).toHaveLength(1);
   await f.restart();await f.drive();expect(f.counts().sends).toBe(1);
  }finally{await f.close();}
 });
 test(`${backend}: an owner turn arriving during voice preparation retains the contribution through restart`,async()=>{
  const at=Date.now(),f=await fixture(backend,at);
  try{
   const contribution={version:2,topic:harnessDigest(['ready']),trigger:'ready',triggerSupports:f.decision('late-busy')[0]!.supports,createdAt:at,notBefore:at,expiresAt:at+86400000,action:'notify'};
   await f.seed(f.decision('late-busy').slice(0,2).map(e=>({...e,contribution})));
   f.duringVoice(async()=>{f.duringVoice(async()=>{});await f.seedClaim([{type:'MessageReceived',owner:'123',id:'direct',source:'telegram',chat:'123',text:'Please check my next meeting',at:Date.now()}]);});
   await f.drive();
   expect(f.counts().sends).toBe(0);
   expect((await f.rows()).find(e=>e.type==='AikoProactiveDeferred')).toMatchObject({stage:'dispatch',reason:'foreground-busy',contributionVersion:2});
   expect((await f.rows()).some(e=>e.type==='AikoDeliveryStarted')).toBe(false);
   await f.restart();await f.drive();expect(f.counts().sends).toBe(0);
   await f.seedClaim([{type:'TurnCompleted',turn:'direct',epoch:0,output:'Your meeting is at 3pm.',at:Date.now()}]);
   await f.drive();
   expect((await f.rows()).filter(e=>e.type==='AikoDeliverySettled'&&e.turn==='proactive:late-busy'&&(e.result as any)?.status==='delivered')).toHaveLength(1);
   const sent=f.counts().sends;await f.restart();await f.drive();expect(f.counts().sends).toBe(sent);
  }finally{await f.close();}
 });
 test(`${backend}: silent claim append rejection never reaches physical sender`,async()=>{
  const f=await fixture(backend);try{await f.seed(f.decision('reject'));f.setReject();await f.drive();
   expect(f.counts().sends).toBe(0);expect(f.counts().rejected).toBeGreaterThan(0);
   const rows=await f.rows();expect(rows.some(e=>e.type==='AikoProactiveDispatchAuthorized')).toBe(false);
   expect(rows.find(e=>e.type==='AikoDeliverySettled')?.result).toMatchObject({status:'rejected',reason:'proactive-dispatch-not-authorized'});
  }finally{await f.close();}
 });
 test(`${backend}: two prepared decisions compete for one reduced final slot`,async()=>{
  const f=await fixture(backend);try{await f.seed([...f.decision('one'),...f.decision('two'),f.prefs(1)]);
   const admitted=await f.rows();expect(admitted.filter(e=>e.type==='AikoProactiveAccepted')).toHaveLength(2);expect(admitted.filter(e=>e.type==='AikoReplyPrepared')).toHaveLength(2);expect(admitted.filter(e=>e.type==='AikoProactivePreferencesSet')).toHaveLength(1);await f.drive();
   expect(f.counts().sends).toBe(1);const rows=await f.rows();expect(rows.filter(e=>e.type==='AikoProactiveDispatchAuthorized')).toHaveLength(1);
   expect(rows.filter(e=>e.type==='AikoDeliverySettled'&&(e.result as any)?.status==='delivered')).toHaveLength(1);
   await f.restart();await f.drive();expect(f.counts().sends).toBe(1);
  }finally{await f.close();}
 });
 test(`${backend}: retained Started reopens as unknown without resending`,async()=>{
  const f=await fixture(backend);try{await f.seed(f.decision('crash')); // Claim pair is one actual atomic native append.
   await f.seedClaim(f.claim('crash'));
   expect((await f.rows()).filter(e=>e.type==='AikoDeliveryStarted')).toHaveLength(1);
   await f.restart();await f.drive();expect(f.counts().sends).toBe(0);
   expect((await f.rows()).find(e=>e.type==='AikoDeliverySettled')?.result).toMatchObject({status:'unknown'});
   await f.restart();await f.drive();expect(f.counts().sends).toBe(0);
   expect((await f.rows()).filter(e=>e.type==='AikoDeliverySettled')).toHaveLength(1);
  }finally{await f.close();}
 });
 test(`${backend}: unknown sender receipt stays spent after restart`,async()=>{
  const f=await fixture(backend);try{await f.seed(f.decision('unknown'));f.setUnknown();await f.drive();expect(f.counts().sends).toBe(1);
   expect((await f.rows()).find(e=>e.type==='AikoDeliverySettled')?.result).toMatchObject({status:'unknown'});
   await f.restart();await f.seed([...f.decision('later'),f.prefs(1)]);await f.drive();expect(f.counts().sends).toBe(1);
   expect(proactivePolicy(await f.rows(),'123',{id:'new',at:Date.now(),topics:f.topics},Date.now(),'dispatch').reason).toBe('daily-interruption-budget');
  }finally{await f.close();}
 });
 test(`${backend}: forgotten citation after committed claim prevents send`,async()=>{
  const f=await fixture(backend);try{await f.seed(f.decision('forgotten'));f.after(f.forget);await f.drive();expect(f.counts().sends).toBe(0);
   expect((await f.rows()).filter(e=>e.type==='AikoProactiveDispatchAuthorized')).toHaveLength(1);
   expect((await f.rows()).find(e=>e.type==='AikoDeliverySettled')?.result).toMatchObject({status:'rejected',reason:'proactive-evidence-or-policy-changed-before-send'});
  }finally{await f.close();}
 });
 test(`${backend}: final evidence check has no asynchronous hydration gap before the sender`,async()=>{
  const f=await fixture(backend);let restore:(()=>void)|undefined;
  try{
   await f.seed(f.decision('final-read-race'));
   f.after(()=>{
    const m=openMemory(f.memory),prototype=Object.getPrototypeOf(m),get=prototype.get;
    m.close();
    const intercepted=spyOn(prototype,'get').mockImplementation(function(this:typeof m,id:string){
     const hit=get.call(this,id);intercepted.mockRestore();
     // A native forget queued after the final synchronous citation read. An
     // awaited step before send would let that forget invalidate the draft.
     queueMicrotask(f.forget);return hit;
    });
    restore=()=>intercepted.mockRestore();
   });
   await f.drive();
   expect(f.counts().sends).toBe(1);
   expect(f.evidenceAtSend).toEqual([true]);
   expect(proactiveEvidence(f.memory,(f.decision('unused')[0] as any).supports)).toBeUndefined();
   await f.restart();await f.drive();expect(f.counts().sends).toBe(1);
  }finally{restore?.();await f.close();}
 });
 test(`${backend}: exact claim loser neither sends nor settles the winner`,async()=>{
  const f=await fixture(backend);try{await f.seed(f.decision('race'));f.setWinner();await f.drive();expect(f.counts().sends).toBe(0);
   expect(f.returned[0]).toEqual([]);const rows=await f.rows();expect(rows.find(e=>e.type==='AikoProactiveDispatchAuthorized')?.claimId).toBe('other-native-claim');
   expect(f.attempted[0]!.find(e=>e.type==='AikoProactiveDispatchAuthorized')?.claimId).not.toBe('other-native-claim');
   // A later native reconciliation may settle the retained Started as unknown;
   // the losing effect itself returned no settlement above.
  }finally{await f.close();}
 });
 test(`${backend}: UTC bucket crossing after claim is refused before final send`,async()=>{
  const day=86400000;let now=Math.floor(Date.now()/day)*day+day-10;
  const clock=spyOn(Date,'now').mockImplementation(()=>now);
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  try{f=await fixture(backend,now);await f.seed(f.decision('midnight'));f.after(()=>{now+=20;});await f.drive();expect(f.counts().sends).toBe(0);
   const rows=await f.rows();expect(rows.filter(e=>e.type==='AikoProactiveDispatchAuthorized')).toHaveLength(1);
   expect(rows.find(e=>e.type==='AikoDeliverySettled')?.result).toMatchObject({status:'rejected',reason:'proactive-dispatch-window-changed'});
  }finally{await f?.close();clock.mockRestore();}
  // Clock substitution tests a calendar fence, not native timer/scheduler behavior.
 });
}
