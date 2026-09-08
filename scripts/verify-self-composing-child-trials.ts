/** Protected semantic entry proposed for S16.C02; not registered while sources are active. The full gate separately fences
 * reviewed source/dependency pins. No application test files are imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2), report=args[args.indexOf('--report')+1], nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..'),fixture=resolve(import.meta.dir,'fixtures/self-composing-child-controller.ts');
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const graph=await Bun.build({entrypoints:[import.meta.path,fixture],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
// Observations fence this direct run. They do not replace independently reviewed
// registration pins or the gate's installed dependency-tree inventories.
const paths=Object.keys(graph.metafile.inputs).sort();
const sourceDigests=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
const runtimeSha256=sha(readFileSync(process.execPath));
writeFileSync(join(dir,'source-observations.json'),JSON.stringify({runtimeSha256,sourceDigests},null,2));
for(const name of ['full','cut'])mkdirSync(join(dir,name),{mode:0o700});
for(const [mode,folder,scenario] of [['prepare','full','complete'],['prepare','cut','cut-mirror'],['recover','cut','cut-mirror']]){
 const child=Bun.spawn([process.execPath,'--no-env-file',fixture,mode,join(dir,folder),nonce,scenario],{cwd:root,env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(dir,folder,mode+'.stdout')),stderr:Bun.file(join(dir,folder,mode+'.stderr')),timeout:15000});assert.equal(await child.exited,0,folder+'/'+mode+' failed; inspect retained stderr');
}
for(const [path,digest] of Object.entries(sourceDigests))assert.equal(sha(readFileSync(resolve(root,path))),digest,'source changed during witness: '+path);assert.equal(sha(readFileSync(process.execPath)),runtimeSha256);
const read=(name:string)=>JSON.parse(readFileSync(join(dir,name),'utf8')),full=read('full/observed.json'),mapping=read('full/trial-mapping.json'),cut=read('cut/prepare.json'),recovered=read('cut/recovered.json');
const semantics={unchangedBaseline:true,exactCandidate:true,sameSandboxAndFixtures:true,freshNativeThreads:12,exactDigestTraceMapping:true,exactCheckedOutputs:true};assert.deepEqual(mapping.semantics,semantics);assert.equal(mapping.nonce,nonce);assert.equal(mapping.mapping.length,12);assert.equal(new Set(mapping.mapping.map((m:any)=>m.childThread)).size,12);assert.equal(full.outcome.status,'promoted');assert.equal(full.changedInputAccepted,false);assert.deepEqual(full.counts,{requests:39,jobs:15,prepare:12,proposal:1,verifier:15});assert.equal(recovered.outcome.trials,1);const zero={requests:0,jobs:0,prepare:0,proposal:0,verifier:0};assert.deepEqual(recovered.counts,zero);
const cutTrace=read('cut/cut-trace.json'),recoveredTrace=read('cut/recovered-trace.json');assert.deepEqual(recoveredTrace.slice(0,cutTrace.length),cutTrace);assert.equal(cutTrace.filter((e:any)=>e.type==='AikoHarnessExperimentTrialWitness').length,1);assert.equal(cutTrace.filter((e:any)=>e.type==='AikoHarnessExperimentTrialSettled').length,0);assert.equal(recoveredTrace.filter((e:any)=>e.type==='AikoHarnessExperimentTrialSettled').length,1);
// Fixture additionally asserts different prepare/recover PIDs and every private
// case/input/output, child lineage, witness and retained artifact mapping.
const observed={semantics,counts:full.counts,mirrorInputFence:true,partialMirrorRecovery:{differentProcess:true,originalTracePrefix:true,settledTrials:1,counts:zero},sourceStableDuringRun:true};writeFileSync(join(dir,'observed.json'),JSON.stringify(observed,null,2));
const names=['observed.json','source-observations.json','full/observed.json','full/trial-mapping.json','full/native-trace.json','full/child-traces.json','cut/prepare.json','cut/cut-trace.json','cut/recovered.json','cut/recovered-trace.json'];const artifacts=Object.fromEntries(names.map(path=>[path,sha(readFileSync(join(dir,path)))]));
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:{'S16.C02':{status:'satisfied',operationId:nonce,traceRef:'full/native-trace.json'}},artifacts},null,2));console.log(JSON.stringify({registration:'deferred-pending-review-and-freeze',checks:['S16.C02'],report,semanticWitness:'passed'}));
