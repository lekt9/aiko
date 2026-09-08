/** Protected semantic entry proposed for S19.C06/C13; not registered while sources are active. The full gate separately fences
 * reviewed source/dependency pins. No application test files are imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2), report=args[args.indexOf('--report')+1], nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..'),fixture=resolve(import.meta.dir,'fixtures/self-composing-network-optimization.ts');
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const graph=await Bun.build({entrypoints:[import.meta.path,fixture],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
// Observations fence this direct run. They do not replace independently reviewed
// registration pins or the gate's installed dependency-tree inventories.
const paths=Object.keys(graph.metafile.inputs).sort();
const sourceDigests=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
const runtimeSha256=sha(readFileSync(process.execPath));
writeFileSync(join(dir,'source-observations.json'),JSON.stringify({runtimeSha256,sourceDigests},null,2));
for(const mode of ['prepare','recover']){
 const child=Bun.spawn([process.execPath,'--no-env-file',fixture,mode,dir,nonce],{cwd:root,env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(dir,mode+'.stdout')),stderr:Bun.file(join(dir,mode+'.stderr')),timeout:25000});
 assert.equal(await child.exited,0,mode+' failed; inspect retained stderr');
}
for(const [path,digest] of Object.entries(sourceDigests))assert.equal(sha(readFileSync(resolve(root,path))),digest,'source changed during witness: '+path);
assert.equal(sha(readFileSync(process.execPath)),runtimeSha256);
const read=(name:string)=>JSON.parse(readFileSync(join(dir,name),'utf8')),before=read('prepare.json'),after=read('recover.json');
assert.equal(before.nonce,nonce);assert.equal(after.nonce,nonce);assert.notEqual(before.pid,after.pid);
for(const key of ['projection','comparison','perturbations','semantics','origin','session','schema'])assert.deepEqual(after[key],before[key]);
assert.deepEqual(read('prepare-trace.json'),read('recover-trace.json'));
const semantics={composedLocalProjection:true,baselineRequestsPerSweep:9,candidateRequestsPerSweep:6,distinctMatchedTrials:12,exactIndependentOutputs:true,renewedSession:true,schemaDriftRejected:true};
assert.deepEqual(before.semantics,semantics);
const zero={requests:0,jobs:0,prepare:0,proposal:0,verifier:0};assert.deepEqual(after.counts,zero);
assert.deepEqual(before.counts,{requests:50,jobs:22,prepare:12,proposal:1,verifier:19});
const perturbations={renewedSessionInvalidatedOldRoute:true,renewedSessionReverified:true,schemaDriftInvalidatedOldRoute:true,schemaDriftFailedRevalidation:true};assert.deepEqual(before.perturbations,perturbations);
const observed={semantics,perturbations,replay:{differentProcess:true,identicalNativeTrace:true,identicalProjection:true,counts:zero},positive:before.counts,sourceStableDuringRun:true};
writeFileSync(join(dir,'observed.json'),JSON.stringify(observed,null,2));
const artifacts=Object.fromEntries(['observed.json','prepare.json','recover.json','prepare-trace.json','recover-trace.json','http.json','source-observations.json'].map(path=>[path,sha(readFileSync(join(dir,path)))]));
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:Object.fromEntries(['S19.C06','S19.C13'].map(id=>[id,{status:'satisfied',operationId:nonce,traceRef:'recover-trace.json'}])),artifacts},null,2));
console.log(JSON.stringify({registration:'deferred-pending-review-and-freeze',checks:['S19.C06','S19.C13'],report,semanticWitness:'passed'}));
