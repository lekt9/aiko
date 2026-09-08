/** Unregistered independent process-boundary verifier. No application test imports. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {harnessDigest} from '../apps/agent/src/harness-library.ts';
import {learningEventDigest} from '../apps/agent/src/learning-origin.ts';
const root=await mkdtemp('/tmp/learning-process-proof-'),nonce=crypto.randomUUID();
console.log(root);
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const run=async(dir:string,mode:string,expected=0)=>{
 const child=Bun.spawn([process.execPath,'--no-env-file',resolve('scripts/fixtures/self-composing-learning-provenance.ts'),dir,nonce,mode],{env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),60000);
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);
 await writeFile(join(dir,`${mode}-${Date.now()}.log`),out+err);assert.equal(code,expected,err);
};
const graphSnapshot=async()=>{
 const build=await Bun.build({entrypoints:[import.meta.path,resolve('scripts/fixtures/self-composing-learning-provenance.ts')],target:'bun',metafile:true});assert(build.success&&build.metafile,'Dependency graph build failed');
 const paths=[...new Set([...Object.keys(build.metafile.inputs),'pnpm-lock.yaml','patches/tardie@0.22.0.patch'])].sort();
 return Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(resolve(p))).digest('hex')])));
};
const sourceBefore=await graphSnapshot();await writeFile(join(root,'source-before.json'),JSON.stringify(sourceBefore,null,2));
const result:any={nonce,root,sourceRoot:process.cwd(),runtimeSha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex'),registered:false,wholeC01:false,wholeC05:false,wholeC03:false,wholeC02:false,wholeC06:false,wholeC07:false,wholeS21:false,c01Failures:[],cases:[]};
try{
 for(const mode of ['baseline','db-cut','send-cut']){
 const dir=join(root,mode);await mkdir(dir,{mode:0o700});await run(dir,mode,mode==='db-cut'?71:mode==='send-cut'?72:0);
 const physical=await json(join(dir,'physical.json'));
 await run(dir,'recover');const recovered=await json(join(dir,'recovered.json'));const snapshot=recovered.snapshots.at(-1),events=snapshot.rows;
 if(mode==='baseline')assert.deepEqual({counts:recovered.counts,deliveries:recovered.deliveries},physical);
 if(mode==='baseline'){
 const silent=events['background-123-reflection'].filter((e:any)=>e.type==='AikoDecisionRecorded'&&e.decision==='silent');
 for(const reason of ['Capability lifecycle bookkeeping; a task outcome is required','Derived documentation is routine learning','Routine indexing and user-saved content do not require an interruption'])assert(silent.some((e:any)=>e.reason===reason));
 assert.equal(events['user-456'].filter((e:any)=>e.type==='AikoProactiveAccepted').length,0);
 assert.equal(events['user-123'].filter((e:any)=>e.type==='AikoProactiveAccepted').length,1);
 assert.equal(recovered.counts.reflection,1);assert.equal(recovered.counts.jobs,4);
 result.wholeC03=true;result.c02RepeatedContentNoReflection=true;
 const cycle=await json(join(dir,'c02.json'));assert.equal(cycle.nonce,nonce);assert.equal(cycle.reindexPasses,3);assert.deepEqual(cycle.countsBefore,cycle.countsAfter);assert.equal(cycle.deliveriesBefore,cycle.deliveriesAfter);
 for(const t of ['user-123','background-123-indexer','background-123-reflection'])assert(cycle.replayCounts[t]>0);
 result.wholeC02=true;
 }

 if(mode==='db-cut'){
  const cut=await json(join(dir,'db-cut.json'));const receipt=events['background-123-indexer'].find((e:any)=>e.type==='AikoLearningIndexed'&&e.ingestion?.readKey===cut.commit.event.key);assert(receipt,'Recovered DB receipt missing');
  assert.equal(receipt.ingestion.commit.sequence,cut.commit.seq);assert.equal(receipt.ingestion.commit.digest,cut.commit.digest);assert.equal(receipt.ingestion.commit.requestDigest,cut.commit.event.requestDigest);
  assert.equal(receipt.observation,cut.result.observations[0]);assert.equal(snapshot.memoryRows.filter((o:any)=>o.id===receipt.observation).length,1);
  const before=await json(join(dir,'cut-native.json'));assert(!before.at(-1).rows['background-123-indexer'].some((e:any)=>e.type==='AikoLearningIndexed'&&e.ingestion?.readKey===cut.commit.event.key));
  assert.equal(recovered.counts.jobs,physical.counts.jobs);
  const priorHook=before.at(-1).rows['background-123-indexer'].find((e:any)=>e.type==='AikoHookReceived'&&e.input?.id&&cut.commit.event.observations.some((o:any)=>o.producer?.evidenceReference?.includes(e.input.id)));
  assert(priorHook,'Cut hook must join original observation producer');
  const afterHook=events['background-123-indexer'].find((e:any)=>e.type==='AikoHookReceived'&&e.id===priorHook.id);assert.deepEqual(afterHook.origin,priorHook.origin);
  assert.deepEqual(snapshot.nativeRows[priorHook.origin.source.thread].find((r:any)=>r.seq===priorHook.origin.sequence),before.at(-1).nativeRows[priorHook.origin.source.thread].find((r:any)=>r.seq===priorHook.origin.sequence));
  const observation=snapshot.memoryRows.find((o:any)=>o.id===receipt.observation);assert(observation);assert.equal(snapshot.memoryHistory[observation.subject].length,1);
  assert.deepEqual(snapshot.memoryHistory[observation.subject],before.at(-1).memoryHistory[observation.subject]);
 }
 if(mode==='send-cut'){
  assert.equal(recovered.deliveries.length,physical.deliveries.length);
  assert(events['user-123'].some((e:any)=>e.type==='AikoDeliverySettled'&&String(e.turn).startsWith('proactive:')&&e.result?.status==='unknown'));
 }
 // Join source by native seq, never its array index.
 const hook=events['background-123-indexer'].find((e:any)=>e.type==='AikoHookReceived'&&e.origin?.eventType==='AikoHarnessPromoted');assert(hook);
 const origin=hook.origin,sourceRows=snapshot.nativeRows[origin.source.thread];
 const source=sourceRows.find((r:any)=>r.seq===origin.sequence);assert(source);assert.equal(learningEventDigest(source.event),origin.eventDigest);
 const window=sourceRows.filter((r:any)=>r.seq>origin.window.after&&r.seq<=origin.window.through);assert.equal(window.length,origin.window.through-origin.window.after);
 assert.equal(harnessDigest(window.map((r:any)=>[r.seq,learningEventDigest(r.event)])),origin.window.digest);
 const indexed=events['background-123-indexer'].find((e:any)=>e.type==='AikoLearningIndexed'&&e.id===hook.id);assert(indexed?.ingestion);
 const merkle=events['background-123-indexer'].find((e:any)=>e.type==='AikoKnowledgeChanged'&&e.id===hook.id);assert(merkle);assert.deepEqual(merkle.origin,origin);assert.deepEqual(merkle.ingestion,indexed.ingestion);assert(merkle.scopeVersion>=indexed.ingestion.commit.scopeVersion);assert.equal(merkle.scope,'aiko:123');assert.equal(merkle.hashPolicyVersion,'aiko-memory-semantic/v2');assert.equal(merkle.scopeVersion,merkle.endScopeVersion);
 assert.equal(events['background-123-indexer'].filter((e:any)=>e.type==='AikoLearningIndexed'&&e.id===hook.id).length,1);assert.equal(events['background-123-indexer'].filter((e:any)=>e.type==='AikoKnowledgeChanged'&&e.id===hook.id).length,1);assert.equal(events['background-123-reflection'].filter((e:any)=>e.type==='AikoDecisionRecorded'&&e.id===hook.id).length,1);
 const decision=events['background-123-reflection'].find((e:any)=>e.type==='AikoDecisionRecorded'&&e.id===hook.id);assert(decision);assert.deepEqual(decision.origin,origin);if(!Array.isArray(decision.supports)||!decision.supports.includes(indexed.observation))result.c01Failures.push({mode,cause:hook.cause,hookId:hook.id,observation:indexed.observation,decision:decision.decision,supports:decision.supports,reason:decision.reason});
 const outcomeHook=events['background-123-indexer'].find((e:any)=>e.type==='AikoHookReceived'&&e.notification?.outcome?.operationId==='verified-task');assert(outcomeHook);
 const outcomeDecision=events['background-123-reflection'].find((e:any)=>e.type==='AikoDecisionRecorded'&&e.id===outcomeHook.id);assert.equal(outcomeDecision?.decision,'notify');
 const outcomeIndex=events['background-123-indexer'].find((e:any)=>e.type==='AikoLearningIndexed'&&e.id===outcomeHook.id);assert(outcomeDecision.supports.includes(outcomeIndex.observation));
 const accepted=events['user-123'].filter((e:any)=>e.type==='AikoProactiveAccepted'&&e.outcome?.operationId==='verified-task');assert.equal(accepted.length,1);
 const a=accepted[0],turn='proactive:'+a.outcome.identity;
 assert.deepEqual(a.origin,outcomeHook.origin);assert.deepEqual(a.ingestion,outcomeIndex.ingestion);assert.equal(a.hashPolicyVersion,'aiko-memory-semantic/v2');assert.equal(a.chat,'123');
 const starts=events['user-123'].filter((e:any)=>e.type==='AikoDeliveryStarted'&&e.turn===turn);assert.equal(starts.length,1);assert.equal(typeof starts[0].proactiveClaimId,'string');
 const settled=events['user-123'].filter((e:any)=>e.type==='AikoDeliverySettled'&&e.turn===turn&&e.epoch===starts[0].epoch);assert.equal(settled.length,1);assert.equal(settled[0].result.status,mode==='send-cut'?'unknown':'delivered');
 const physicalNotice=recovered.deliveries.filter((d:any)=>String(d.text).startsWith('Independent capability ready.'));assert.equal(physicalNotice.length,1);assert.equal(String(physicalNotice[0].chat_id),'123');assert(String(physicalNotice[0].text).includes(outcomeIndex.observation));
 if(mode==='send-cut'){const original=(await json(join(dir,'cut-native.json'))).at(-1).rows['user-123'];assert.deepEqual(original.find((e:any)=>e.type==='AikoDeliveryStarted'&&e.turn===turn),starts[0]);assert(!original.some((e:any)=>e.type==='AikoDeliverySettled'&&e.turn===turn));assert.deepEqual(await json(join(dir,'send-cut.json')),physicalNotice[0]);}
 assert(recovered.deliveries.every((d:any)=>String(d.chat_id)==='123'));
 const before=await json(join(dir,'physical.json')),oldIds=snapshot.memoryRows.map((o:any)=>o.id).sort();await run(dir,'recover');assert.deepEqual(await json(join(dir,'physical.json')),before);
 const next=await json(join(dir,'recovered.json'));assert.deepEqual(next.snapshots.at(-1).memoryRows.map((o:any)=>o.id).sort(),oldIds);assert.deepEqual(next.snapshots.at(-1).memoryHistory,snapshot.memoryHistory);
 result.cases.push({mode,passed:true,counts:before.counts,directory:dir});
 }
 const batchDir=join(root,'batch-cut');await mkdir(batchDir,{mode:0o700});await run(batchDir,'batch-cut',73);
 const batchCut=await json(join(batchDir,'batch-cut.json'));assert.equal(batchCut.preferences.preferences.batchWindowMs,3000);
 assert(batchCut.rows['user-123'].some((e:any)=>e.type==='AikoProactiveDeferred'&&e.reason==='batch-window'));
 assert(!batchCut.rows['user-123'].some((e:any)=>e.type==='AikoDeliveryStarted'&&String(e.turn).startsWith('proactive:')));
 await run(batchDir,'recover');const batchRecovery=await json(join(batchDir,'recovered.json'));assert.deepEqual(batchRecovery.counts,batchCut.counts);
 const batchRows=batchRecovery.snapshots.at(-1).rows['user-123'];assert(batchRows.some((e:any)=>e.type==='AlarmFired'));
 assert.equal(batchRows.filter((e:any)=>e.type==='AikoProactiveAccepted').length,1);
 assert.equal(batchRecovery.deliveries.filter((d:any)=>String(d.text).startsWith('Independent capability ready.')).length,1);
 assert.equal(batchRows.filter((e:any)=>e.type==='AikoProactivePreferencesSet').length,1);
 const batchPhysical=await json(join(batchDir,'physical.json'));await run(batchDir,'recover');assert.deepEqual(await json(join(batchDir,'physical.json')),batchPhysical);
 result.c06BatchRestartAlarm={passed:true,directory:batchDir,counts:batchRecovery.counts};
 const quietDir=join(root,'quiet-cut');await mkdir(quietDir,{mode:0o700});await run(quietDir,'quiet-cut',73);const quietCut=await json(join(quietDir,'quiet-cut.json'));
 const quietBefore=await json(join(quietDir,'physical.json'));await run(quietDir,'recover');assert.deepEqual(await json(join(quietDir,'physical.json')),quietBefore);
 await run(quietDir,'quiet-expire');const quiet=await json(join(quietDir,'recovered.json'));assert.deepEqual(quiet.counts,quietCut.counts);
 const deferred=quietCut.rows['user-123'].find((e:any)=>e.type==='AikoProactiveDeferred'&&e.reason==='quiet-hours');assert(deferred);
 assert(quiet.snapshots.at(-1).rows['user-123'].some((e:any)=>e.type==='AlarmFired'&&e.scheduledFor===deferred.call.deadlineAt));
 assert.equal(quiet.deliveries.filter((d:any)=>String(d.text).startsWith('Independent capability ready.')).length,1);
 const quietPhysical=await json(join(quietDir,'physical.json'));await run(quietDir,'quiet-expire');assert.deepEqual(await json(join(quietDir,'physical.json')),quietPhysical);
 result.c06QuietExpiry={passed:true,directory:quietDir,controlledClock:'Process-local Date.now offset to retained native deadline; scheduler produces actual AlarmFired'};
 for(const name of ['disabled','dismissal','cooldown','budget']){
  const dir=join(root,name+'-cut');await mkdir(dir,{mode:0o700});await run(dir,name+'-cut',73);
  const cut=await json(join(dir,name+'-cut.json'));assert.equal(cut.nonce,nonce);
  const spent=['cooldown','budget'].includes(name),releases=spent;
  const reason={disabled:'notifications-disabled',dismissal:'topic-dismissed',cooldown:'cooldown',budget:'daily-interruption-budget'}[name]!;
  assert(cut.rows['user-123'].some((e:any)=>e.reason===reason));
  const priorDispatch=cut.rows['user-123'].filter((e:any)=>e.type==='AikoProactiveDispatchAuthorized');assert.equal(priorDispatch.length,spent?1:0);
  if(spent){
   assert.equal(cut.rows['user-123'].filter((e:any)=>e.type==='AikoHarnessAcquisitionSettled'&&['verified','ready'].includes(e.status)&&e.reused===false).length,2);
   assert.equal(cut.counts.reflection,2);assert.equal(cut.notices,1);
   assert(cut.rows['user-123'].some((e:any)=>e.type==='AikoDeliverySettled'&&e.turn===priorDispatch[0].turn&&e.result.status==='delivered'));
  }
  const before=await json(join(dir,'physical.json'));await run(dir,'recover');assert.deepEqual(await json(join(dir,'physical.json')),before);
  if(name!=='disabled')await run(dir,name+'-expire');
  const recovered=await json(join(dir,'recovered.json')),rows=recovered.snapshots.at(-1).rows['user-123'];assert.deepEqual(recovered.counts,cut.counts);
  assert.equal(recovered.deliveries.filter((d:any)=>String(d.text).startsWith('Independent capability ready.')).length,cut.notices+(releases?1:0));
  assert.deepEqual(rows.filter((e:any)=>e.type==='AikoProactiveDispatchAuthorized').slice(0,priorDispatch.length),priorDispatch);
  assert.equal(rows.filter((e:any)=>e.type==='AikoProactiveDispatchAuthorized').length,releases?2:0);
  if(releases){
   const wait=cut.rows['user-123'].findLast((e:any)=>e.type==='AikoProactiveDeferred'&&e.reason===reason);assert(wait);
   assert(rows.some((e:any)=>e.type==='AlarmFired'&&e.scheduledFor===wait.call.deadlineAt));
   if(name==='budget')assert.equal(wait.call.deadlineAt,(Math.floor(priorDispatch[0].at/86400000)+1)*86400000);
   if(name==='cooldown')assert.equal(wait.call.deadlineAt,priorDispatch[0].at+cut.preferences.preferences.cooldownMs);
  }
  const final=await json(join(dir,'physical.json'));await run(dir,name==='disabled'?'recover':name+'-expire');assert.deepEqual(await json(join(dir,'physical.json')),final);
  result.cases.push({mode:name,passed:true,directory:dir,counts:cut.counts,spentBefore:priorDispatch.length,noticesAfter:recovered.deliveries.filter((d:any)=>String(d.text).startsWith('Independent capability ready.')).length});
 }
 result.wholeC06=true;
 const negativeDir=join(root,'negatives');await mkdir(negativeDir,{mode:0o700});await run(negativeDir,'negatives');
 const negatives=await json(join(negativeDir,'negatives.json'));assert.equal(negatives.nonce,nonce);
 assert.deepEqual(negatives.faults.map((f:any)=>[f.kind,f.failure.errorCode]),[['gap','source_sequence_gap'],['unavailable','source_read_unavailable'],['incomplete','snapshot_capacity_exceeded']]);
 assert.equal(negatives.crossOwnerObservationDenied,true);assert.equal(negatives.crossOwnerNotificationDenied,true);assert.equal(negatives.unavailableCitationSuppressed,true);
 const negativePhysical=await json(join(negativeDir,'physical.json'));
 for(let pass=0;pass<2;pass++){
  await run(negativeDir,'recover');assert.deepEqual(await json(join(negativeDir,'physical.json')),negativePhysical);
  const recovered=await json(join(negativeDir,'recovered.json'));assert.deepEqual(recovered.snapshots.at(-1).rows,negatives.traces,'Exact causal history must replay without new effects or roots');
 }
 result.c07={passed:true,directory:negativeDir,faults:negatives.faults.map((f:any)=>f.kind),separateProcessReplays:2};result.wholeC07=true;
 result.wholeC05=true;assert.equal(result.c01Failures.length,0,'C01: own promotion-cause decision must cite its ingested observation');result.wholeC01=true;
}catch(error){result.error=String(error);process.exitCode=1;}
const sourceAfter=await graphSnapshot();await writeFile(join(root,'source-after.json'),JSON.stringify(sourceAfter,null,2));result.sourceDrift=Object.keys({...sourceBefore,...sourceAfter}).filter(p=>sourceBefore[p]!==sourceAfter[p]);result.sourceFiles=Object.keys(sourceBefore).length;result.sourceMatched=result.sourceDrift.length===0;if(result.sourceDrift.length){result.error='Source changed during proof';process.exitCode=1;}
await writeFile(join(root,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
