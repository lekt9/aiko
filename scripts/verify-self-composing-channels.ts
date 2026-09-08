/** Protected semantic entry for S24.C13/C22. The full gate separately fences
 * reviewed source/dependency pins. No application test files are imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2), report=args[args.indexOf('--report')+1], nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..'),fixture=resolve(import.meta.dir,'fixtures/self-composing-channels.ts');
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
for(const key of ['view','pin','doc','resources','semantics'])assert.deepEqual(after[key],before[key]);
assert.deepEqual(read('prepare-trace.json'),read('recover-trace.json'));
const semantics={typedPorts:2,versionedConnections:1,sourceCursor:1,checkedExecutions:7,falseCandidateRejected:true,reusedWithoutExtraJobs:true,joinedInvocation:true,privateChannelRows:true,foreignHydrationRejected:true,passiveExactBundle:true};
assert.deepEqual(before.semantics,semantics);
const zero={model:0,build:0,fetch:0,subscribe:0,send:0,code:0,sandbox:0};assert.deepEqual(after.counts,zero);
const observed={semantics,replay:{differentProcess:true,identicalNativeTraces:true,identicalWiring:true,identicalSkillBundle:true,counts:zero},positive:{sandboxJobs:before.counts.sandbox,codeSegments:before.counts.code>0,modelCalls:before.counts.model>0},sourceStableDuringRun:true};
assert.equal(observed.positive.sandboxJobs,7);
writeFileSync(join(dir,'observed.json'),JSON.stringify(observed,null,2));
const artifacts=Object.fromEntries(['observed.json','prepare.json','recover.json','prepare-trace.json','recover-trace.json','sandbox-receipts.json','source-observations.json'].map(path=>[path,sha(readFileSync(join(dir,path)))]));
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:Object.fromEntries(['S24.C13','S24.C22'].map(id=>[id,{status:'satisfied',operationId:nonce,traceRef:'recover-trace.json'}])),artifacts},null,2));
console.log(JSON.stringify({checks:['S24.C13','S24.C22'],report,semanticWitness:'passed'}));
