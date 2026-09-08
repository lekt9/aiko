/** Protected semantic entry proposed for S19.C03; not registered while sources are active. The full gate separately fences
 * reviewed source/dependency pins. No application test files are imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const args=process.argv.slice(2), report=args[args.indexOf('--report')+1], nonce=args[args.indexOf('--nonce')+1];
assert(report&&nonce&&process.env.SELF_COMPOSING_EVIDENCE_DIR===dirname(report));
const dir=dirname(report),root=resolve(import.meta.dir,'..'),fixture=resolve(import.meta.dir,'fixtures/self-composing-candidate-frozen.ts');
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const graph=await Bun.build({entrypoints:[import.meta.path,fixture],target:'bun',metafile:true});assert(graph.success&&graph.metafile);
// Observations fence this direct run. They do not replace independently reviewed
// registration pins or the gate's installed dependency-tree inventories.
const paths=Object.keys(graph.metafile.inputs).sort();
const sourceDigests=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
const runtimeSha256=sha(readFileSync(process.execPath));
writeFileSync(join(dir,'source-observations.json'),JSON.stringify({runtimeSha256,sourceDigests},null,2));
const cases=['verifier','cases','policy','evaluator-file','cases-file','policy-file'];const semantics={proposalRefused:true,noAcceptedCandidate:true,noPromotion:true,checkerUnchanged:true,casesUnchanged:true,policyUnchanged:true,baselineUnchanged:true,noRecall:true};const matrix:any[]=[];const names=['source-observations.json'];
for(const scenario of cases){const folder=join(dir,scenario);mkdirSync(folder,{mode:0o700});const child=Bun.spawn([process.execPath,'--no-env-file',fixture,'prepare',folder,nonce,scenario],{cwd:root,env:{PATH:process.env.PATH??'',TMPDIR:'/tmp'},stdout:Bun.file(join(folder,'stdout')),stderr:Bun.file(join(folder,'stderr')),timeout:8000});assert.equal(await child.exited,0,scenario+' failed; inspect retained stderr');const observed=JSON.parse(readFileSync(join(folder,'observed.json'),'utf8'));assert.equal(observed.nonce,nonce);assert.equal(observed.scenario,scenario);assert.equal(observed.candidateOrigin,'controlled-provider-response-through-production-native-Infer');assert.deepEqual(observed.semantics,semantics);assert.deepEqual(observed.frozenBefore,observed.frozenAfter);assert.equal(observed.physicalCalls,1);assert.deepEqual(observed.counts,{model:2,build:0,fetch:0,subscribe:0,send:0,code:6,sandbox:10});matrix.push({scenario,physicalCalls:1,...semantics});for(const file of ['observed.json','native-trace.json','wire.json'])names.push(scenario+'/'+file);}
for(const [path,digest] of Object.entries(sourceDigests))assert.equal(sha(readFileSync(resolve(root,path))),digest,'source changed during witness: '+path);assert.equal(sha(readFileSync(process.execPath)),runtimeSha256);
writeFileSync(join(dir,'observed.json'),JSON.stringify({candidateOrigin:true,attackKinds:cases,allFrozen:true,noCandidateAcceptance:true,noPromotion:true,noRecall:true,matrix,sourceStableDuringRun:true},null,2));names.push('observed.json');const artifacts=Object.fromEntries(names.map(path=>[path,sha(readFileSync(join(dir,path)))]));writeFileSync(report,JSON.stringify({schemaVersion:1,nonce,checks:{'S19.C03':{status:'satisfied',operationId:nonce,traceRef:'verifier/native-trace.json'}},artifacts},null,2));console.log(JSON.stringify({registration:'deferred-pending-review-and-freeze',checks:['S19.C03'],report,semanticWitness:'passed'}));
