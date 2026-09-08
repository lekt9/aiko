/** Fault injection at actual native append boundaries, never synthetic success facts. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {HarnessLibrary,harnessDigest} from '../../apps/agent/src/harness-library.ts';
import {channelHydrate} from '../../apps/agent/src/channel-custody.ts';
export const boundaryScenarios=['resume','missing-before-claim','missing-after-handoff','unknown','late','cancel','missing-output'] as const;
export function channelBoundary(scenario:string,mode:string,dir:string,counts:unknown,receipts:unknown[]) {
 return (batch:readonly any[],read:()=>readonly any[])=>{
  if(mode!=='prepare'||!boundaryScenarios.includes(scenario as any))return;
  const rows=read();
  const cut=scenario==='missing-output'?'AikoChannelWiringWaitDelivered':scenario==='missing-before-claim'?'AikoChannelWiringClaimed':scenario==='unknown'?'AikoHarnessChecked':'AikoChannelWiringStarted';
  const claim=rows.find(e=>e.type==='AikoChannelWiringClaimed');
  if(!batch.some(e=>e.type===cut&&(scenario!=='unknown'||e.id===claim?.id)))return;
  assert(rows.some(e=>e.type==='AikoChannelWiringWaitRegistered'));
  assert(rows.some(e=>e.type==='BlockedOn'));
  writeFileSync(join(dir,'boundary.json'),JSON.stringify({scenario,pid:process.pid,trace:rows,counts,receipts},null,2));
  // The preceding SQLite transactions are committed; terminate before this append.
  process.exit(0);
 };
}
export async function exerciseChannelBoundary(o:any) {
 const {scenario,dir,host,thread,hosted,binding,privateDb,counts,pin,authority,setNow}=o;
 const before=JSON.parse(readFileSync(join(dir,'boundary.json'),'utf8'));
 const source=before.trace.find((e:any)=>e.type==='AikoChannelWiringAccepted');
 const waiter=before.trace.find((e:any)=>e.type==='AikoChannelWiringWaitRegistered');
 assert.notEqual(process.pid,before.pid);
 const sourceKey=`harness-blobs:${harnessDigest(binding.owner)}:${source.valueRef.ref}`;
 const original=privateDb.query('SELECT value FROM workflow_records WHERE key=?').get(sourceKey) as any;
 assert(original);const sealed=JSON.parse(original.value);assert.equal(sealed.private,true);assert.equal(typeof sealed.ciphertext,'string');
 await assert.rejects(channelHydrate(binding.blobs,'foreign',source.valueRef),/unavailable/);
 await assert.rejects(channelHydrate(binding.blobs,'foreign',{...source.valueRef,owner:'foreign'}),/unavailable/);
 const tampered=structuredClone(sealed),raw=Buffer.from(tampered.ciphertext,'base64');raw[0]^=1;tampered.ciphertext=raw.toString('base64');
 privateDb.query('UPDATE workflow_records SET value=? WHERE key=?').run(JSON.stringify(tampered),sourceKey);
 await assert.rejects(channelHydrate(binding.blobs,binding.owner,source.valueRef),/unavailable/);
 privateDb.query('UPDATE workflow_records SET value=? WHERE key=?').run(original.value,sourceKey);
 assert.equal(typeof (await channelHydrate(binding.blobs,binding.owner,source.valueRef)).text,'string');
 if(scenario==='missing-output'){
  const output=before.trace.find((e:any)=>e.type==='AikoHarnessChecked'&&e.id===waiter.invocation);assert.equal(output.witness.status,'satisfied');
  const key=`harness-blobs:${harnessDigest(binding.owner)}:${output.witness.outputRef}`;
  assert.equal(privateDb.query('DELETE FROM workflow_records WHERE key=?').run(key).changes,1);
  const library=new HarnessLibrary(binding,{read:()=>host.read(thread),append:async()=>{throw Error('Read-only evidence access');}});
  await assert.rejects(library.output(waiter.invocation),/unavailable/);
 }

 if(scenario.startsWith('missing-') && scenario!=='missing-output'){
  const key=`harness-blobs:${harnessDigest(binding.owner)}:${source.valueRef.ref}`;
  assert.equal(privateDb.query('DELETE FROM workflow_records WHERE key=?').run(key).changes,1);
  await assert.rejects(channelHydrate(binding.blobs,binding.owner,source.valueRef),/unavailable/);
 }
 if(scenario==='late')setNow(waiter.deadline+1);
 if(scenario==='cancel'){
  const call=before.trace.find((e:any)=>e.type==='PackageCalled'&&e.callId===waiter.callId);assert(call);
  await host.commitRoot(host.self(thread),{type:'TurnCancelled',id:'controlled-cancel',turn:call.turn,epoch:call.epoch??0,at:Date.now()});
 }
 await host.recover();
 let rows=await host.read(thread);
 for(let i=0;i<before.trace.length;i++)assert.deepEqual(rows[i],before.trace[i]);
 const find=(type:string)=>rows.find((e:any)=>e.type===type);
 const outcome:any={scenario,pid:process.pid,differentProcess:true,causalPrefix:true,ownerAndCiphertextAuthentication:true};
 if(scenario==='resume'){
  assert.equal(find('AikoChannelWiringWaitReady')?.result.status,'satisfied');assert.equal(counts.sandbox,1);
  assert.equal(rows.filter((e:any)=>e.type==='AikoChannelWiringWaitDelivered').length,1);
  const i=rows.findIndex((e:any)=>e.type==='AikoChannelWiringWaitReady'),j=rows.findIndex((e:any)=>e.type==='CodeSettled');assert(j>i);assert(!rows.slice(i,j).some((e:any)=>e.type==='ModelCalled'));
  const code=rows[j];
  writeFileSync(join(dir,'boundary-recover-trace.json'),JSON.stringify(rows,null,2));
  writeFileSync(join(dir,'boundary-result.json'),JSON.stringify({...outcome,counts,waiterDelivered:true,resumedCodeError:code.error??null},null,2));
  assert.equal(code.error,undefined,'Matched waiter must resume successful guest code, not merely deliver a wakeup');
  assert(code.result,'Successful CodeSettled must retain its result reference');
  for(const type of ['AikoCodeToolStarted','AikoCodeToolSettled','AikoHarnessAcquisitionRequested','AikoHarnessAcquisitionSettled','AikoHarnessEvaluated','AikoHarnessPromoted'])assert.deepEqual(rows.filter((e:any)=>e.type===type),before.trace.filter((e:any)=>e.type===type),'No repeated '+type);
  assert.equal(rows.filter((e:any)=>e.type==='AikoHarnessRunStarted'&&e.id===waiter.invocation).length,1);
  assert.equal(rows.filter((e:any)=>e.type==='AikoHarnessChecked'&&e.id===waiter.invocation).length,1);
  assert.equal(counts.send,0);assert.equal(counts.subscribe,0);
  outcome.noDuplicateToolsAcquisitionOrHandler=true;
  outcome.matchedContinuationWithoutInference=true;
 }else if(scenario==='missing-before-claim'){
  assert.equal(find('AikoChannelWiringSettled')?.reason,'input_unavailable');assert.equal(find('AikoChannelWiringWaitReady')?.result.status,'unavailable');assert.equal(counts.sandbox,0);outcome.missingInputUnavailable=true;
 }else if(scenario==='missing-after-handoff'){
  assert.equal(counts.sandbox,0);
  if(find('AikoChannelWiringWaitReady')?.result.status!=='unavailable'){
   outcome.gap='Deleted input after durable handoff but before dispatch is classified pending/dispatch_outcome_unknown, not unavailable';
   writeFileSync(join(dir,'boundary-recover-trace.json'),JSON.stringify(rows,null,2));
   writeFileSync(join(dir,'boundary-result.json'),JSON.stringify({...outcome,counts},null,2));
  }
  assert.equal(find('AikoChannelWiringWaitReady')?.result.status,'unavailable','Missing retained input before dispatch must be unavailable');
  outcome.missingInputAfterHandoffUnavailable=true;
 }else if(scenario==='late'){
  assert.equal(find('AikoChannelWiringWaitReady')?.result.status,'expired');assert.equal(counts.sandbox,1);outcome.lateCheckedOutputCannotSatisfy=true;
 }else if(scenario==='cancel'){
  assert.equal(find('AikoChannelWiringWaitCancelled')?.status,'cancelled');assert.equal(find('AikoChannelWiringWaitDelivered'),undefined);outcome.noCancelledContinuation=true;
 }else if(scenario==='missing-output'){
  assert.equal(counts.sandbox,0);outcome.missingCheckedOutputUnavailable=true;outcome.noRepeatedProcessingOrSend=true;
 }else if(scenario==='unknown'){
  assert.equal(find('AikoChannelWiringSettled')?.status,'pending');assert.equal(find('AikoChannelWiringWaitReady'),undefined);assert.equal(counts.sandbox,0);
  const view=await hosted.wiring.view(),input=[...view.ports.values()].find((p:any)=>p.name==='input') as any,output=[...view.ports.values()].find((p:any)=>p.name==='output') as any;
  const emit={port:{channel:input.channel,generation:1},schema:'text.message.v1',value:{text:'independent foreign occurrence'},occurrence:'foreign',correlation:'correlation-one',authorityRef:authority};
  // Untrusted output-port admission is not a checked handler result.
  await hosted.run(hosted.wiring.api.emit({...emit,port:{channel:output.channel,generation:1},occurrence:'unverified-output'}));
  for(const invalid of [{...emit,authorityRef:'foreign-owner'},{...emit,port:{channel:input.channel,generation:2}},{...emit,schema:'wrong.schema'}])await assert.rejects(hosted.run(hosted.wiring.api.emit(invalid)));
  await hosted.run(hosted.wiring.api.emit(emit));await host.recover();rows=await host.read(thread);
  assert.equal(counts.sandbox,1);assert(rows.some((e:any)=>e.type==='AikoHarnessChecked'&&e.witness.status==='satisfied'&&e.id!==waiter.invocation));
  assert.equal(rows.find((e:any)=>e.type==='AikoChannelWiringWaitReady'),undefined);
  outcome.foreignCheckedAndUnverifiedOutputIgnored=true;outcome.wrongAuthorityGenerationSchemaRejected=true;outcome.unknownNeverRedispatched=true;
 }
 const priorCounts=structuredClone(counts),priorRows=await host.read(thread);await host.recover();assert.deepEqual(await host.read(thread),priorRows);assert.deepEqual(counts,priorCounts);
 outcome.idleRecoveryNoExtraWork=true;outcome.counts=counts;
 const privateText='private-channel-payload-'+before.trace.find((e:any)=>e.type==='MessageReceived').id;
 assert(!JSON.stringify(priorRows).includes(privateText));outcome.privateInputAbsentFromGeneralLog=true;
 writeFileSync(join(dir,'boundary-recover-trace.json'),JSON.stringify(await host.read(thread),null,2));
 writeFileSync(join(dir,'boundary-result.json'),JSON.stringify(outcome,null,2));
 return outcome;
}
