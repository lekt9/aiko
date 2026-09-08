/** One native optimization execution, then full retained fact reconstruction.
 * Reuses an independent fixture, never application tests or child pass reports. */
import './self-composing-optimization.ts';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {harnessBlobStore,harnessDigest,harnessLibraryState} from '../../apps/agent/src/harness-library.ts';
import {harnessExperimentState} from '../../apps/agent/src/harness-experiment.ts';
import {compareHarnessTrials,harnessParetoFrontier} from '../../apps/agent/src/harness-pareto.ts';
import {sqliteWorkflowKV} from '../../apps/agent/src/workflow-store.ts';
import {builtinHarnessDefinitions} from '../../apps/agent/src/harness-builtins.ts';
const [mode,dir,nonce]=process.argv.slice(2),owner='321';
const db=new Database(join(dir,'custody.sqlite')),blobs=harnessBlobStore(sqliteWorkflowKV(db));
try{
 const trace=JSON.parse(readFileSync(join(dir,mode+'-trace.json'),'utf8')),events=trace.foreground;
 const library=harnessLibraryState(events,owner),experiment=harnessExperimentState(events,owner,'winner-fails-heldout');
 const brief:any=await blobs.get(owner,experiment.registered!.briefRef as string);
 assert.equal(harnessDigest(brief),experiment.registered!.briefDigest);
 const seed=builtinHarnessDefinitions().find(x=>x.artifact.name==='channel.text.echo')!;
 assert.equal(harnessDigest(seed.verifier.cases),brief.datasetDigest);
 const comparisons=experiment.candidates.map(hash=>{
  const trials=[...experiment.trials.values()].filter(e=>e.harnessDigest===hash).map(e=>{
   const witness=library.witnesses.get(String(e.id));assert(witness);assert.equal(harnessDigest(witness),e.witnessDigest);
   const fixture=seed.verifier.cases.find(c=>'experiment:'+harnessDigest([brief.id,hash,c.split,c.id,e.repeat]).slice(7)===e.id);assert(fixture);
   return {phase:e.phase,caseId:fixture.id,repeat:e.repeat,witness,accounting:e.accounting};
  });
  return compareHarnessTrials({harnessDigest:hash,contextDigest:brief.contextDigest,evaluatorDigest:brief.evaluatorDigest,datasetDigest:brief.datasetDigest,regimeDigest:brief.regimeDigest,policy:brief.policy,cases:seed.verifier.cases.map(c=>({id:c.id,split:c.split})),repeats:brief.repeats,trials} as any);
 });
 assert.deepEqual(comparisons,await blobs.get(owner,experiment.settled!.comparisonRef as string));
 const frontier=harnessParetoFrontier(comparisons,brief.policy).map(c=>c.harnessDigest);
 assert.deepEqual(frontier,experiment.settled!.frontier);
 const lineage=events.filter((e:any)=>e.type==='AikoHarnessExperimentProposalSettled').map((e:any)=>({parent:e.parentDigest,candidate:e.harnessDigest,sourceDiffRef:e.sourceDiffRef,feedbackRef:e.feedbackRef}));
 assert.equal(lineage.length,1);assert.equal(lineage[0].parent,brief.baselineDigest);assert(lineage[0].sourceDiffRef);
 assert(library.contracts.size>0&&library.evaluations.size>0&&library.heads.size>0);assert.equal(library.witnesses.size,21);assert.equal(experiment.trials.size,12);
 const foreign=harnessLibraryState(events,'foreign');assert(Object.values(foreign).every((x:any)=>x.size===0));
 const projection=JSON.parse(JSON.stringify({library,experiment,lineage,comparisons,frontier,policyDigest:harnessDigest(brief.policy)},(_k,v)=>v instanceof Map?[...v]:v));
 if(mode==='recover')assert.deepEqual(projection,JSON.parse(readFileSync(join(dir,'prepare-full-projection.json'),'utf8')));
 writeFileSync(join(dir,mode+'-full-projection.json'),JSON.stringify(projection,null,2));
 writeFileSync(join(dir,mode+'-fact-observed.json'),JSON.stringify({nonce,contracts:library.contracts.size,witnesses:21,trials:12,lineage:1,evaluations:library.evaluations.size,promotions:events.filter((e:any)=>e.type==='AikoHarnessPromoted').length,frontierFromWitnesses:true,policyPinned:true,foreignOwnerEmpty:true},null,2));
}finally{db.close();}
