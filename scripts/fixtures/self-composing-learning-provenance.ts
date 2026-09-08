/** Independent S21.C01/C05 process-boundary proposal (unregistered). Actual default Bun actor, entity-learn and outbox.
 * Only model transport/voice/provider edges are controlled; no app-test imports. */
import {learningNegatives} from './self-composing-learning-negatives.ts';
import {learningLifecycle,lifecycleReflection} from './self-composing-learning-lifecycle.ts';
import {credentialDigest} from '../../apps/agent/src/plane-auth.ts';
import assert from 'node:assert/strict';import {writeFileSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {Database} from 'bun:sqlite';
import {Effect,Layer} from '../../apps/agent/node_modules/effect/dist/index.js';import {Infer} from '../../apps/agent/node_modules/tardie/src/agent/index.ts';
import {createService} from '../../apps/agent/src/server.ts';import {PERSONA} from '../../apps/agent/src/config.ts';import {localHarnessSandbox} from '../../apps/agent/src/harness-sandbox-local.ts';import {sandboxEnvironment} from '../../apps/agent/src/sandbox-job-runner.ts';import {sandboxJobJournal} from '../../apps/agent/src/sandbox-job-journal.ts';import {runCodeSegment} from '../../apps/agent/src/code-sandbox-runner.ts';import {harnessDigest} from '../../apps/agent/src/harness-library.ts';import {builtinHarnessDefinitions} from '../../apps/agent/src/harness-builtins.ts';import {defaultProactivePreferences,proactivePreferences,proactiveAcquisitionOutcome} from '../../apps/agent/src/proactive-policy.ts';import {openMemory} from '../../apps/agent/src/memory.ts';import {accountDirectory} from '../../apps/agent/src/accounts.ts';import {memorySnapshot} from '../../apps/agent/src/learning.ts';
const [dir,nonce,mode='baseline']=process.argv.slice(2);assert(dir&&nonce);const saved=existsSync(join(dir,'physical.json'))?JSON.parse(readFileSync(join(dir,'physical.json'),'utf8')):undefined;const counts=saved?.counts??{foreground:0,reflection:0,jobs:0,code:0},deliveries:any[]=saved?.deliveries??[],judgements:any[]=[],snapshots:any[]=[],receipts:any[]=[];
const policyReasons:Record<string,string>={'batch-cut':'batch-window','disabled-cut':'notifications-disabled','quiet-cut':'quiet-hours','dismissal-cut':'topic-dismissed','cooldown-cut':'cooldown','budget-cut':'daily-interruption-budget'};
const policyCut=Object.keys(policyReasons).find(key=>existsSync(join(dir,key+'.json')));
const expiring=mode.endsWith('-expire');
// Process-local wall-clock seam: native deadlines and policy use Date.now.
// Let the actual scheduler append AlarmFired; never manufacture an alarm/spend.
if(expiring){
 assert(policyCut,'Retained policy cut required');
 const prior=JSON.parse(readFileSync(join(dir,policyCut+'.json'),'utf8'));
 const deferred=prior.rows['user-123'].findLast((e:any)=>e.type==='AikoProactiveDeferred');
 assert(deferred&&Number.isFinite(deferred.call.deadlineAt),'Retained native deadline required');
 const actualNow=Date.now.bind(Date),offset=deferred.call.deadlineAt+1-actualNow();Date.now=()=>actualNow()+offset;
}
// Keep the daily-budget fixture away from midnight without any wall-clock sleep.
if(mode==='budget-cut'){
 const actualNow=Date.now.bind(Date),offset=Math.floor(actualNow()/86400000)*86400000+12*3600000-actualNow();Date.now=()=>actualNow()+offset;
}
const persist=()=>writeFileSync(join(dir,'physical.json'),JSON.stringify({counts,deliveries}));
// Override only this child process. Invoke real refresh first, then terminate
// before its caller can write AikoLearningIndexed. No receipt is fabricated.
const {Memory}=await import('../../apps/agent/node_modules/entity-learn/lib/cloudflare.ts');
if(mode==='db-cut'){
 const refresh=Memory.prototype.refresh;
 Memory.prototype.refresh=async function(id,options){const result=await refresh.call(this,id,options);
  if(options.key.startsWith('learning-read:')&&!result.error){
   const commit=this.journal.events(this.scope).find(r=>r.event.key===options.key);
   assert(commit);await capture('db-cut');writeFileSync(join(dir,'cut-native.json'),JSON.stringify(snapshots));persist();writeFileSync(join(dir,'db-cut.json'),JSON.stringify({commit,result}));process.exit(71);
  }return result;
 };
}
const privateDb=new Database(join(dir,'jobs.sqlite'));const sandbox=localHarnessSandbox({owner:'123',environmentDigest:await sandboxEnvironment('independent-proactive'),journal:await sandboxJobJournal(privateDb,join(dir,'jobs.key')),send:async()=>{throw Error('No sandbox network permitted');}});
let program='';const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:'controlled',model_id:'fixed-rubric'}}),react:(r:any)=>{
 if(r.identity.thread==='background-123-reflection'){counts.reflection++;persist();const msg=r.trajectory.findLast((e:any)=>e.type==='MessageReceived'&&e.source==='background');assert(msg);const input=JSON.parse(msg.text);judgements.push(input);if(mode.startsWith('c04-source'))return Effect.succeed(lifecycleReflection(input,nonce));assert(Array.isArray(input.changed)&&input.changed.length===1);assert.equal(input.outcome?.kind,'harness-acquisition');const second=input.outcome?.operationId==='verified-second'&&['cooldown-cut','budget-cut'].includes(mode);assert.equal(input.outcome?.operationId,second?'verified-second':'verified-task');assert.equal(input.outcome?.task?.thread,'user-123');assert.equal(input.outcome?.task?.turn,second?'telegram:502':'telegram:501');const pinned=builtinHarnessDefinitions().find(x=>x.artifact.name===(second?'json.project':'text.chunk'))!;assert.equal(input.evidence?.[0]?.payload?.data?.artifactDigest,harnessDigest(pinned.artifact));assert.equal(input.evidence?.[0]?.payload?.data?.contractDigest,harnessDigest(pinned.contract));assert.equal(input.evidence?.[0]?.payload?.data?.state,'verified');assert.equal(input.evidence?.[0]?.observation,input.changed[0].observation);return Effect.succeed({kind:'complete' as const,output:JSON.stringify({decision:'notify',reason:'Current task capability has independent verified evidence',text:'Independent capability ready.',supports:input.changed.map((x:any)=>x.observation).slice(0,1)}),mode:{kind:'local',name:'validate-once'}});}
 counts.foreground++;persist();const returned=r.trajectory.findLast((e:any)=>e.type==='ToolReturned'&&e.turn===r.identity.turn);if(returned){assert(!returned.result?.error,JSON.stringify(returned.result));return Effect.succeed({kind:'complete' as const,output:'Requested task completed.'});}return Effect.succeed({kind:'call' as const,name:'execute',callId:'independent-'+r.identity.turn,arguments:{code:program}});
}});
const config:any={stateDir:dir,mode:'live',codeMode:true,instanceId:'proactive-independent',port:0,operatorToken:'independent-operator-00112233445566',planeCredentials:['123','456'].map(account=>({account,digest:credentialDigest('independent-reader-'+account+'-00112233445566'),scopes:mode.startsWith('c04-source')&&account==='123'?['read','write']:['read']})),modelKey:'never-live-model-key',voiceKey:'never-live-voice-key',persona:PERSONA,voiceEnabled:false,allowedUsers:new Set(['123','456']),telegramPublic:true,botToken:'123:fixture-only',webhookSecret:'independent-webhook'};
const options:any={model,backgroundModel:model,voiceFetch:async(_u:any,i:any)=>Response.json({personified:JSON.parse(String(i.body)).raw}),telegramFetch:async(_u:any,i:any)=>{const payload=JSON.parse(String(i.body));deliveries.push(payload);persist();if(mode==='send-cut'&&String(payload.text).startsWith('Independent capability ready.')){await capture('send-cut');writeFileSync(join(dir,'cut-native.json'),JSON.stringify(snapshots));writeFileSync(join(dir,'send-cut.json'),JSON.stringify(payload));process.exit(72);}return Response.json({ok:true,result:{message_id:deliveries.length}});},registrySandbox:()=>({placement:'local',codeTransport:async(...a:any[])=>{counts.code++;persist();return runCodeSegment(...a as Parameters<typeof runCodeSegment>);},sandbox:{harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(j:any,s:any)=>{counts.jobs++;persist();const r=await sandbox.harnessJob(j,s);receipts.push(r);return r;}}})};
let service:Awaited<ReturnType<typeof createService>>|undefined;
const threads=['user-123','background-123-indexer','background-123-reflection','user-456'];
const capture=async(stage:string)=>{const rows=Object.fromEntries(await Promise.all(threads.map(async t=>[t,await service!.host.read(t)])));const nativeRows=Object.fromEntries(await Promise.all(threads.map(async t=>{const all=[];let after=0;for(;;){const page=await service!.host.readPage(t,after,128);if(!page.length)break;for(const row of page){assert.equal(row.seq,after+1);after=row.seq;all.push(row);}}return [t,all];})));const memory=openMemory({stateDir:accountDirectory(dir,'123'),owner:'123'});let memoryRows,memoryHistory;try{memoryRows=memory.journal.page(memory.scope,{limit:2000});memoryHistory=Object.fromEntries(memoryRows.map(o=>[o.subject,memory.history(o.subject)]));}finally{memory.close();}snapshots.push({stage,rows,nativeRows,memoryRows,memoryHistory});return rows;};
const send=async(id:number,text:string,owner=123)=>{const result=await service!.acceptTelegram(new Request('http://localhost/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':config.webhookSecret},body:JSON.stringify({update_id:id,message:{message_id:id,date:1,from:{id:owner,is_bot:false},chat:{id:owner,type:'private'},text}})}));assert.equal(result,'accepted');await service!.host.drive();};
try{
 service=await createService(config,options);
 if(mode.startsWith('c04-')){
  await learningLifecycle({service,dir,nonce,mode,counts,deliveries,capture:async(label:string)=>{await capture(label);return snapshots.at(-1);},runNative:async(id:number,code:string)=>{program=code;await send(id,'Run the synthetic lifecycle request');}});
  persist();await service.close();privateDb.close();process.exit(0);
 }
 if(mode==='recover'||expiring){
  // Ordinary fetch awaits the service's single native startup recovery promise.
  // This read-only unknown route creates no job and shares the process deadline.
  const barrier=await service.fetch(new Request('http://localhost/independent-recovery-barrier'));
  assert.notEqual(barrier.status,503,'Native recovery failed');
  await service.host.drive();
  if(policyCut){
   const prior=JSON.parse(readFileSync(join(dir,policyCut+'.json'),'utf8'));
   const noticeCount=()=>deliveries.filter(d=>String(d.text).startsWith('Independent capability ready.')).length;
   const releases=policyCut==='batch-cut'||expiring&&!['disabled-cut','dismissal-cut'].includes(policyCut);
   const expected=(prior.notices??0)+(releases?1:0);
   if(releases){
    const deadline=performance.now()+15000;
    while(noticeCount()<expected&&performance.now()<deadline)await new Promise(r=>setTimeout(r,20));
    assert.equal(noticeCount(),expected,'Native alarm must finish deferred policy outcome');await service.host.drive();
   }
   const events=await service.host.read('user-123');
   assert.deepEqual(proactivePreferences(events,'123'),prior.preferences);assert.deepEqual(counts,prior.counts);
   assert.equal(noticeCount(),expected);
  }
  await capture('recovered');persist();
  writeFileSync(join(dir,'recovered.json'),JSON.stringify({counts,deliveries,snapshots}));
  await service.close();privateDb.close();process.exit(0);
 }
 if(policyReasons[mode]){
  const minute=new Date(Date.now()).getUTCHours()*60+new Date(Date.now()).getUTCMinutes();
  const preferences={...defaultProactivePreferences,batchWindowMs:mode==='batch-cut'?3000:mode==='dismissal-cut'?3600000:0,enabled:mode!=='disabled-cut',cooldownMs:mode==='cooldown-cut'?120000:0,dailyLimit:mode==='budget-cut'?1:8,quietHours:mode==='quiet-cut'?{timeZone:'UTC',startMinute:minute,endMinute:(minute+2)%1440}:null};
  await service.host.commitRoot(service.host.self('user-123'),{type:'AikoProactivePreferencesSet',owner:'123',id:'independent-batch-policy',at:Date.now(),previousRevision:'default',preferences,preferencesDigest:harnessDigest(preferences)});
 }
 const seed=builtinHarnessDefinitions().find(x=>x.artifact.name==='text.chunk')!;
 const candidate={...seed.artifact,files:{'main.js':'return ["candidate claims success"];'}};
 program=`return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'verified-task'}});`;
 await send(501,'Acquire a verified text chunking capability for my task');let rows=await capture('verified');
 if(policyReasons[mode]){
  const spent=['cooldown-cut','budget-cut'].includes(mode);
  if(spent){
   const authorized=rows['user-123'].filter(e=>e.type==='AikoProactiveDispatchAuthorized');assert.equal(authorized.length,1,'Actual first send must spend capacity');
   assert(rows['user-123'].some(e=>e.type==='AikoDeliverySettled'&&e.turn===authorized[0].turn&&(e.result as any)?.status==='delivered'));
   program=`return await tools.call({name:'harness_acquire',arguments:{name:'json.project',operationId:'verified-second'}});`;
   await send(502,'Acquire a second distinct verified capability');rows=await capture('second-outcome');
  }
  if(mode==='dismissal-cut'){
   const pending=rows['user-123'].find(e=>e.type==='AikoProactiveDeferred');assert(pending&&Array.isArray(pending.topics)&&pending.topics.length);
   const current=proactivePreferences(rows['user-123'],'123'),preferences={...current.preferences,dismissedTopics:pending.topics};
   await service.host.commitRoot(service.host.self('user-123'),{type:'AikoProactivePreferencesSet',owner:'123',id:'independent-dismissal',at:Date.now(),previousRevision:current.revision,preferences,preferencesDigest:harnessDigest(preferences)});
   await service.host.drive();rows=await capture('dismissed');
  }
  const notices=deliveries.filter(d=>String(d.text).startsWith('Independent capability ready.')).length;assert.equal(notices,spent?1:0);
  const preferences=proactivePreferences(rows['user-123'],'123');assert.equal(preferences.preferences.batchWindowMs,mode==='batch-cut'?3000:mode==='dismissal-cut'?3600000:0);
  assert(rows['user-123'].some(e=>e.reason===policyReasons[mode]),'Native policy disposition missing: '+mode);
  // Re-deliver the real originating acquisition receipt. It must not restart
  // reflection or create a second deferred/accepted outcome for the same build.
  const before={...counts},sent=deliveries.length,ids=snapshots.at(-1).memoryRows.map((o:any)=>o.id).sort();
  const acquisition=rows['user-123'].findLast(e=>e.type==='AikoHarnessAcquisitionSettled');assert(acquisition);
  await service.host.seed('user-123',[acquisition]);await service.host.wake('user-123');await service.host.drive();rows=await capture('policy-duplicate');
  assert.deepEqual(counts,before);assert.equal(deliveries.length,sent);assert.deepEqual(snapshots.at(-1).memoryRows.map((o:any)=>o.id).sort(),ids);
  writeFileSync(join(dir,mode+'.json'),JSON.stringify({counts:{...counts},preferences,rows,notices,nonce}));persist();process.exit(73);
 }
 const outcome=proactiveAcquisitionOutcome(rows['user-123'],'123','verified-task');assert(outcome,'Task-bound verified acquisition missing');assert.equal(proactiveAcquisitionOutcome(rows['user-123'],'456','verified-task'),undefined);
 const accepted=rows['user-123'].filter(e=>e.type==='AikoProactiveAccepted');assert.equal(accepted.length,1,'Exactly one verified task notice must be accepted');assert.equal(accepted[0].chat,'123');assert.deepEqual(accepted[0].outcome,outcome);assert.equal(counts.reflection,1);assert(rows['user-123'].some(e=>e.type==='AikoDeliverySettled'&&e.turn==='proactive:'+outcome.identity&&(e.result as any)?.status==='delivered'));assert(deliveries.every(d=>String(d.chat_id)==='123'));assert.equal(rows['user-456'].filter(e=>e.type==='AikoProactiveAccepted').length,0);
 const duplicateBefore=JSON.stringify(snapshots.at(-1).memoryRows.map((o:any)=>o.id).sort()),duplicateSent=deliveries.length;const promotion=rows['user-123'].find(e=>e.type==='AikoHarnessPromoted');assert(promotion);await service.host.seed('user-123',[promotion]);await service.host.drive();await capture('duplicate');assert.equal(JSON.stringify(snapshots.at(-1).memoryRows.map((o:any)=>o.id).sort()),duplicateBefore);assert.equal(deliveries.length,duplicateSent);
 const before={...counts},sent=deliveries.length;await service.close();service=await createService(config,options);await service.host.drive();assert.deepEqual(counts,before);assert.equal(deliveries.length,sent);
 program=`return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'reuse-task'}});`;await send(502,'Reuse that verified capability');assert.equal(counts.jobs,before.jobs);assert.equal(counts.reflection,1);
 program=`return await tools.call({name:'harness_record',arguments:{artifact:${JSON.stringify(candidate)}}});`;await send(503,'Keep this intermediate draft without promoting it');assert.equal(counts.reflection,1);
 program=`return await tools.call({name:'memory_remember',arguments:{subject:'user/independent-note',title:'Saved note',type:'note',kind:'fact',payload:'USER_SAVED_INDEPENDENT_NOTE'}});`;await send(504,'Remember my note without notifying me about saving it');rows=await capture('silent');assert.equal(rows['user-123'].filter(e=>e.type==='AikoProactiveAccepted').length,1);assert.equal(counts.reflection,1);
 const silent=rows['background-123-reflection'].filter(e=>e.type==='AikoDecisionRecorded'&&e.decision==='silent');assert(silent.some(e=>e.reason==='Routine indexing and user-saved content do not require an interruption'));assert(silent.some(e=>e.reason==='Capability lifecycle bookkeeping; a task outcome is required'));assert(silent.every(e=>typeof e.reason==='string'&&e.reason.length>0));
 const memory=openMemory({stateDir:accountDirectory(dir,'123'),owner:'123'});try{assert(JSON.stringify(memory.recall({search:'USER_SAVED_INDEPENDENT_NOTE'})).includes('USER_SAVED_INDEPENDENT_NOTE'));}finally{memory.close();}
 assert.equal(deliveries.filter(d=>String(d.text).startsWith('Independent capability ready.')).length,1);assert.equal(deliveries.filter(d=>d.text==='Requested task completed.').length,4);assert.equal(counts.jobs,4);assert.equal(counts.code,8);assert.equal(counts.foreground,8);assert(rows['user-123'].some(e=>e.type==='AikoHarnessCandidateRecorded'&&e.harnessDigest===harnessDigest(candidate)));assert(!rows['user-123'].some(e=>e.type==='AikoHarnessPromoted'&&e.harnessDigest===harnessDigest(candidate)));
 // Additional C02 probe: identical saved bytes in a new native turn have a new
 // timestamp/receipt but must not trigger semantic reflection or another notice.
 const repeatRoot=memorySnapshot({stateDir:accountDirectory(dir,'123'),owner:'123'}).root;
 const repeatReflection=counts.reflection,repeatNotices=deliveries.filter(d=>String(d.text).startsWith('Independent capability ready.')).length;
 await send(505,'Save the exact same note again');await capture('identical-content');assert.equal(memorySnapshot({stateDir:accountDirectory(dir,'123'),owner:'123'}).root,repeatRoot);
 assert.equal(counts.reflection,repeatReflection);assert.equal(deliveries.filter(d=>String(d.text).startsWith('Independent capability ready.')).length,repeatNotices);
 const semantic=()=>memorySnapshot({stateDir:accountDirectory(dir,'123'),owner:'123'});
 const stableRoot=semantic().root,cycleBefore={...counts},cycleSent=deliveries.length;
 const settledRows=await capture('cycle-before');
 // Replay only genuine retained facts, with original IDs/contents. Native keyed
 // deduplication and the real components own their treatment; no forged success.
 const replayTypes=new Set(['AikoKnowledgeChanged','AikoKnowledgeUnchanged','AikoDecisionRecorded','AikoProactiveAccepted','AikoDeliveryStarted','AikoDeliverySettled']);
 const replayCounts:Record<string,number>={};
 for(const thread of threads){const facts=settledRows[thread].filter(e=>replayTypes.has(e.type));replayCounts[thread]=facts.length;if(facts.length)await service.host.seed(thread,facts);}
 assert(replayCounts['user-123']>0&&replayCounts['background-123-indexer']>0&&replayCounts['background-123-reflection']>0);
 await service.host.drive();assert.deepEqual(counts,cycleBefore);assert.equal(deliveries.length,cycleSent);assert.equal(semantic().root,stableRoot);
 // Explicit bounded indexing triggers revisit a corpus containing real transition,
 // notification and delivery history. These are requests, not fabricated receipts.
 for(let pass=0;pass<3;pass++){
  const id='independent-history-scan-'+pass;
  await service.host.seed('background-123-indexer',[{type:'AikoIndexRequested',id,cause:id,owner:'123',at:Date.now()+pass,notification:{decision:'silent',reason:'Independent history reindex'}}]);
  await service.host.wake('background-123-indexer');await service.host.drive();const events=await service.host.read('background-123-indexer');
  const unchanged=events.filter(e=>e.type==='AikoKnowledgeUnchanged'&&e.id===id);assert.equal(unchanged.length,1);assert.equal(unchanged[0].root,stableRoot);
  assert(!events.some(e=>e.type==='AikoKnowledgeChanged'&&e.id===id));assert.deepEqual(counts,cycleBefore);assert.equal(deliveries.length,cycleSent);
 }
 await capture('history-no-cycle');writeFileSync(join(dir,'c02.json'),JSON.stringify({nonce,stableRoot,replayCounts,reindexPasses:3,countsBefore:cycleBefore,countsAfter:counts,deliveriesBefore:cycleSent,deliveriesAfter:deliveries.length}));
 if(mode==='negatives'){
  // Enter the foreign owner through real ingress so startup activation is part
  // of the retained baseline, not an extra event on its first recovery.
  program='return "Foreign owner fixture initialized";';await send(601,'Initialize the independent foreign owner fixture',456);
  await learningNegatives({service,dir,nonce,counts,deliveries,Memory});
 }
 const observed={nonce,counts,noticeIdentity:outcome.identity,recipient:'123',foreignOwnerDenied:true,restartNoWork:true,reuseNoJobsOrNotice:true,silentReasons:silent.map(e=>e.reason),wholeCriterion:false};writeFileSync(join(dir,'observed.json'),JSON.stringify(observed,null,2));console.log(JSON.stringify(observed));
}finally{persist();if(service){await capture('final').catch(()=>{});await service.close();}writeFileSync(join(dir,'native-traces.json'),JSON.stringify(snapshots,null,2));writeFileSync(join(dir,'deliveries.json'),JSON.stringify(deliveries,null,2));writeFileSync(join(dir,'rubric-inputs.json'),JSON.stringify(judgements,null,2));writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));privateDb.close();}
