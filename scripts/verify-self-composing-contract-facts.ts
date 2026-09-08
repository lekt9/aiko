/** Unregistered whole-child proposal: S14.C05 and S18.C01. No parent credit. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2),report=args[args.indexOf('--report')+1],nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..');
const entries=['scripts/fixtures/self-composing-contract-graph.ts','scripts/fixtures/self-composing-fact-replay.ts'];
const sha=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex');
const graph=await Bun.build({entrypoints:[import.meta.path,...entries],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
const sourceDigests=Object.fromEntries(Object.keys(graph.metafile.inputs).sort().map(p=>[p,sha(readFileSync(resolve(root,p)))])),runtimeSha256=sha(readFileSync(process.execPath));
for(const [i,entry] of entries.entries()){
 const sub=join(dir,i===0?'graph':'facts');mkdirSync(sub);const childNonce=randomUUID();
 for(const mode of ['prepare','recover']){const p=Bun.spawn([process.execPath,'--no-env-file',entry,mode,sub,childNonce],{cwd:root,env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(sub,mode+'.stdout')),stderr:Bun.file(join(sub,mode+'.stderr')),timeout:25000});assert.equal(await p.exited,0,entry+' '+mode+' failed');}
}
const read=(p:string)=>JSON.parse(readFileSync(join(dir,p),'utf8'));
const a=read('graph/prepare.json'),b=read('graph/recover.json');assert.notEqual(a.pid,b.pid);assert.deepEqual(a.view,b.view);assert.deepEqual(read('graph/prepare-traces.json'),read('graph/recover-traces.json'));
const graphSemantics={passingChildren:2,parentFailed:true,wrongContractIgnored:true,staleCheckedAppendDenied:true,externalCheckedDenied:true,immutableGraph:true,repeatedOperationNoWork:true,changedInputDenied:true};assert.deepEqual(a.semantics,graphSemantics);
assert.deepEqual(a.counts,{jobs:2,verifier:2,worker:3,graphCheck:3,fetch:0});assert.deepEqual(b.counts,{jobs:0,verifier:0,worker:0,graphCheck:0,fetch:0});
assert.deepEqual(read('graph/missing-owned-output.json'),{missingOutputUnavailable:true,foreignOwnerDenied:true,historicalWitnessPreserved:true,noRepeatWork:true,counts:b.counts});
const f=read('facts/prepare.json'),r=read('facts/recover.json');assert.notEqual(f.pid,r.pid);assert.deepEqual(read('facts/prepare-full-projection.json'),read('facts/recover-full-projection.json'));assert.deepEqual(read('facts/prepare-trace.json'),read('facts/recover-trace.json'));assert.equal(f.counts.sandbox,21);assert.deepEqual(r.counts,{model:0,build:0,fetch:0,subscribe:0,send:0,code:0,sandbox:0,verifier:0,prepare:0,proposal:0});
const fact=read('facts/recover-fact-observed.json');assert.equal(fact.witnesses,21);assert.equal(fact.trials,12);assert.equal(fact.lineage,1);assert(fact.contracts>0&&fact.evaluations>0&&fact.promotions>0);assert(fact.frontierFromWitnesses&&fact.policyPinned&&fact.foreignOwnerEmpty);
for(const [p,h]of Object.entries(sourceDigests))assert.equal(sha(readFileSync(resolve(root,p))),h,'source changed: '+p);assert.equal(sha(readFileSync(process.execPath)),runtimeSha256);
writeFileSync(join(dir,'source-observations.json'),JSON.stringify({sourceDigests,runtimeSha256},null,2));
writeFileSync(join(dir,'observed.json'),JSON.stringify({graph:graphSemantics,graphReplay:b.counts,facts:{witnesses:21,trials:12,lineage:1,frontierFromWitnesses:true,policyPinned:true,foreignOwnerEmpty:true},factReplay:r.counts,sourceStableDuringRun:true},null,2));
const files=['observed.json','source-observations.json','graph/prepare-traces.json','graph/recover-traces.json','graph/sandbox-receipts.json','graph/missing-owned-output.json','facts/prepare-trace.json','facts/recover-trace.json','facts/prepare-full-projection.json','facts/recover-full-projection.json','facts/sandbox-receipts.json'];
writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:{'S14.C05':{status:'satisfied',operationId:nonce,traceRef:'graph/recover-traces.json'},'S18.C01':{status:'satisfied',operationId:nonce,traceRef:'facts/recover-trace.json'}},artifacts:Object.fromEntries(files.map(p=>[p,sha(readFileSync(join(dir,p)))]))},null,2));
console.log(JSON.stringify({proposed:['S14.C05','S18.C01'],report,registered:false}));
