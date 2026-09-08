/** Unregistered S16.C06 and S16.P proposal: one native run, no child-report aggregation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2),report=args[args.indexOf('--report')+1],nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..'),fixture=resolve(import.meta.dir,'fixtures/self-composing-gepa-joined.ts');
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const graph=await Bun.build({entrypoints:[import.meta.path,fixture],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
const sourceDigests=Object.fromEntries(Object.keys(graph.metafile.inputs).sort().map(p=>[p,sha(readFileSync(resolve(root,p)))]));const runtimeSha256=sha(readFileSync(process.execPath));
const run=join(dir,'joined');mkdirSync(run,{mode:0o700});
const child=Bun.spawn([process.execPath,'--no-env-file',fixture,'prepare',run,nonce,'module-native'],{cwd:root,env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(dir,'stdout.txt')),stderr:Bun.file(join(dir,'stderr.txt')),timeout:30000});assert.equal(await child.exited,0,'native joined fixture failed; retained stderr');
const proof=JSON.parse(readFileSync(join(run,'module-native-evidence.json'),'utf8'));
assert.equal(proof.nonce,nonce);assert.equal(proof.outcome.status,'promoted');assert.deepEqual(proof.counts,{requests:0,jobs:20,prepare:16,proposal:2,verifier:20});assert.equal(proof.mapping.length,16);assert.equal(proof.wire.length,2);assert.equal(proof.sandboxProofs.length,20);
const semantics={nativeController:true,explicitAdvanceCalls:0,nonemptyDependencyLocks:true,realBunBuilds:true,immutableBrief:true,failedCandidateHistory:true,heldoutBaselineAndSurvivors:true,ordinaryNoNewOptimizer:true,wholeS16:false};assert.deepEqual(proof.semantics,semantics);
assert.deepEqual(proof.brief.mutableFiles,['src/project.js']);assert.equal(proof.proposalEvidence.length,2);assert(proof.proposalEvidence.every((p:any)=>p.hypothesis.length>0&&p.sourceDiff.length===1&&p.sourceDiff[0].path==='src/project.js'));
const {ordinary,...joined}=proof.parentObservation;
const expectedJoined={oneExperiment:1,developmentTrials:12,heldoutTrials:4,distinctChildThreads:16,sourceDiffs:2,failedCandidates:1,physicalInferCalls:2,trialReservations:16,trialLimit:20,proposalReservations:2,proposalLimit:2,physicalTokenCap:100,costUnavailable:true,baselineGeneration:1,promotedGeneration:2,closedBeforeHeldout:true,heldoutBeforePromotion:true,promotionBeforeTerminal:true,terminalBeforeDeadline:true,ordinaryAfterTerminal:true,actorSourceMutation:false,optionalMergePerformed:false};assert.deepEqual(joined,expectedJoined);
assert.deepEqual(ordinary.effects,{fetch:0,bunSpawn:0,bunSpawnSync:0,nodeProcess:0});assert.deepEqual(ordinary.delta,{requests:0,jobs:1,prepare:0,proposal:0,verifier:1});assert.deepEqual(ordinary.measurements,{networkRequests:0,browserStarts:0,modelCalls:0,tokens:0});assert.deepEqual(ordinary.nativeEvents.map((e:any)=>e.type),['AikoHarnessRunStarted','AikoHarnessChecked']);assert.equal(ordinary.actor,'aiko');assert.equal(ordinary.mutation,'artifact-only');assert.equal(ordinary.newOptimizer,0);
// The fixture independently validates all causal links inside this same trace,
// private retained brief/diff/feedback/output, exact build/source locks, and the
// full baseline/failed-candidate/survivor case matrix. No prior report is read.
writeFileSync(join(dir,'joined-native-trace.json'),JSON.stringify(proof.trace,null,2));
for(const [p,h]of Object.entries(sourceDigests))assert.equal(sha(readFileSync(resolve(root,p))),h,'source changed during native proof: '+p);assert.equal(sha(readFileSync(process.execPath)),runtimeSha256);
writeFileSync(join(dir,'source-observations.json'),JSON.stringify({runtimeSha256,sourceDigests},null,2));writeFileSync(join(dir,'observed.json'),JSON.stringify({semantics,joined,ordinary:{effects:ordinary.effects,delta:ordinary.delta,measurements:ordinary.measurements,eventTypes:ordinary.nativeEvents.map((e:any)=>e.type),actor:ordinary.actor,mutation:ordinary.mutation,newOptimizer:ordinary.newOptimizer},counts:proof.counts,sourceStableDuringRun:true,optionalMerge:'not exercised; no merge capability claimed',actorSource:'unchanged aiko; artifact-only mutation'},null,2));
const names=['observed.json','source-observations.json','joined/module-native-evidence.json','joined/native-trace.json','joined-native-trace.json'];const artifacts=Object.fromEntries(names.map(p=>[p,sha(readFileSync(join(dir,p)))]));
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:Object.fromEntries(['S16.C06','S16.P'].map(id=>[id,{status:'satisfied',operationId:nonce,traceRef:'joined-native-trace.json'}])),artifacts},null,2));console.log(JSON.stringify({unregistered:true,proposedChecks:['S16.C06','S16.P'],report}));
