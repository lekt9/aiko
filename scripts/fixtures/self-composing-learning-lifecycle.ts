/** Independent S21.C04 lifecycle stimuli through the production learning journey.
 * All source data is synthetic. Mutations are native tools or the trusted source
 * owner's journal control, not injected success/verification/delivery receipts.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openMemory} from '../../apps/agent/src/memory.ts';
import {accountDirectory} from '../../apps/agent/src/accounts.ts';
import {defaultProactivePreferences,proactivePreferences} from '../../apps/agent/src/proactive-policy.ts';
import {harnessDigest} from '../../apps/agent/src/harness-library.ts';
import {builtinHarnessDefinitions} from '../../apps/agent/src/harness-builtins.ts';

export const lifecycleMarker=(nonce:string)=>`SYNTHETIC_DELETE_ME_${nonce}`;
export function lifecycleReflection(input:any,nonce:string){
 assert.equal(input.outcome,undefined);assert.equal(input.changed.length,1);
 assert(JSON.stringify(input.evidence).includes(lifecycleMarker(nonce)),'Reflection must read the actual original source payload');
 assert.equal(input.evidence[0].observation,input.changed[0].observation);
 return {kind:'complete' as const,output:JSON.stringify({decision:'notify',reason:'Relevant controlled source change',text:'Independent source update.',supports:[input.changed[0].observation]}),mode:{kind:'local',name:'validate-once'}};
}
const notice=(d:any)=>String(d.text).startsWith('Independent source update.')||String(d.text).startsWith('Independent capability ready.');
export async function learningLifecycle({service,dir,nonce,mode,counts,deliveries,runNative,capture}:any){
 const host=service.host,thread='user-123';
 const binding={owner:'123',stateDir:accountDirectory(dir,'123')};
 const setPreferences=async(preferences:any,id:string)=>{
  const current=proactivePreferences(await host.read(thread),'123');
  await host.commitRoot(host.self(thread),{type:'AikoProactivePreferencesSet',id,owner:'123',at:Date.now(),previousRevision:current.revision,preferences,preferencesDigest:harnessDigest(preferences)});
 };
 if(mode.endsWith('-cut')){
  await setPreferences({...defaultProactivePreferences,batchWindowMs:300000},'c04-hold');
  if(mode==='c04-artifact-cut')await runNative(501,`return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'verified-task'}});`);
  else{
   await runNative(501,'return "Initialize source lifecycle fixture";');
   const input={id:'independent-c04-source',subject:'independent/c04-source',title:'Controlled private source',type:'fixture',kind:'fact',payload:{marker:lifecycleMarker(nonce),value:'original'}};
   const response=await service.fetch(new Request('http://localhost/v1/hooks',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer independent-reader-123-00112233445566'},body:JSON.stringify(input)}));
   assert.equal(response.status,202,await response.text());await host.drive();
  }
  const {rows,nativeRows}=await capture('c04-held'),pending=rows[thread].find((e:any)=>e.type==='AikoProactiveDeferred');assert(pending);
  const decision=rows[thread].find((e:any)=>e.type==='AikoProactiveDecision'&&e.id===pending.decisionId);assert(decision);
  assert.equal(deliveries.filter(notice).length,0);assert.equal(counts.reflection,1);
  const memory=openMemory(binding);let observation;
  try{observation=memory.get(decision.supports[0])?.observation;assert(observation);}finally{memory.close();}
  writeFileSync(join(dir,'c04-cut.json'),JSON.stringify({nonce,pending,decision,observation,rows,nativeRows,counts:{...counts},deliveries:deliveries.length},null,2));
  process.exit(74);
 }
 const cut=JSON.parse(readFileSync(join(dir,'c04-cut.json'),'utf8'));assert.equal(cut.nonce,nonce);
 await service.ready;await host.drive();assert.deepEqual(counts,cut.counts);assert.equal(deliveries.length,cut.deliveries,'Cold restart must retain the pending outcome');
 const kind=mode.split('-').at(-1);let mutation:any;
 if(kind==='correction'){
  await runNative(502,`return await tools.call({name:'memory_remember',arguments:${JSON.stringify({subject:cut.observation.subject,title:'Corrected source',kind:'fact',type:'fixture',payload:{value:'corrected'},supersedes:cut.observation.id})}});`);
  const memory=openMemory(binding);try{assert.equal(memory.get(cut.observation.id)?.state,'superseded');mutation={oldState:'superseded',history:memory.history(cut.observation.subject)};}finally{memory.close();}
 }else if(kind==='deletion'){
  // Native memory_scan obtains the real optimistic revision immediately before
  // native memory_erase. The production host owns registered-result cleanup.
  await runNative(502,`const scan=await tools.call({name:'memory_scan',arguments:{limit:8}});const erased=await tools.call({name:'memory_erase',arguments:{subject:${JSON.stringify(cut.observation.subject)},expected:${JSON.stringify(cut.observation.id)},expectedScopeVersion:scan.result.sourceVersion}});if(erased.outcome!=='ok'||erased.result.erased!==true||erased.result.copies?.status!=='erased')throw Error('Native registered-copy cleanup did not complete');return erased;`);
  const memory=openMemory(binding);try{assert.equal(memory.get(cut.observation.id),null,'Native erase must delete the original observation');mutation={history:memory.history(cut.observation.subject),archiveContainsPayload:JSON.stringify(memory.journal.exportArchive(memory.scope)).includes(lifecycleMarker(nonce))};assert.deepEqual(mutation.history,[]);assert.equal(mutation.archiveContainsPayload,false);}finally{memory.close();}
 }else if(kind==='revocation'){
  const memory=openMemory(binding);try{const source=memory.sources().find(s=>s.id===cut.observation.producer.sourceId);assert(source);memory.approveSource(source.id,source.revision,false,'independent-c04-revoke');mutation={source:source.id,enabled:memory.sources().find(s=>s.id===source.id)?.enabled};assert.equal(mutation.enabled,false);}finally{memory.close();}
 }else if(kind==='supersession'){
  const seed=builtinHarnessDefinitions().find(x=>x.artifact.name==='text.chunk')!;
  const next={...seed.artifact,files:{...seed.artifact.files,'main.js':'// Independently equivalent next artifact\n'+seed.artifact.files['main.js']}};
  await runNative(502,`const recorded=await tools.call({name:'harness_record',arguments:{artifact:${JSON.stringify(next)}}});const checked=await tools.call({name:'harness_evaluate',arguments:{digest:recorded.digest,evaluationId:'c04-next'}});if(!checked.eligible)throw Error('Next artifact failed verification');return await tools.call({name:'harness_promote',arguments:{digest:recorded.digest,evaluationId:'c04-next',expectedGeneration:1}});`);
  const rows=await host.read(thread),promotion=rows.find((e:any)=>e.type==='AikoHarnessPromoted'&&e.generation===2&&e.harnessDigest===harnessDigest(next));assert(promotion);mutation={promotion};
 }else throw Error('Unknown lifecycle mode');
 await setPreferences(defaultProactivePreferences,'c04-release');await host.drive();
 const {rows,nativeRows}=await capture('c04-after-change'),suppressed=rows[thread].find((e:any)=>e.type==='AikoProactiveSuppressed'&&e.id===cut.decision.id);
 assert(suppressed,'Changed citation/status must settle the pending decision');
 assert.equal(deliveries.filter(notice).length,0,'Stale outcome must never reach physical sender');
 const turn='proactive:'+(cut.decision.outcome?.identity??cut.decision.id);
 assert(!rows[thread].some((e:any)=>e.type==='AikoDeliveryStarted'&&e.turn===turn),'No stale native dispatch may start');
 // Scan the actual retained native histories, not merely the memory projection.
 const retention=Object.entries(nativeRows).flatMap(([thread,events]:any)=>events.flatMap(({seq,event}:any)=>JSON.stringify(event).includes(lifecycleMarker(nonce))?[{thread,seq,type:event.type,id:event.id??event.turn??null}]:[]));
 const result={nonce,kind,mutation,suppressed,pendingId:cut.decision.id,counts:{...counts},deliveries:deliveries.length,staleDispatches:0,retainedPayloadLocations:retention,rows,nativeRows,wholeC04:false};
 writeFileSync(join(dir,'c04-observed.json'),JSON.stringify(result,null,2));
 if(kind==='deletion')assert.equal(retention.length,0,'C04: deleted private payload remains in native source/reflection history');
}
