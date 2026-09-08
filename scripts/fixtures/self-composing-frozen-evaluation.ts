/** Unregistered adversarial controller audit. Records defects, not completion credit.
 * Native SQLite host, real VM/sandbox, fixed production checker; no test-module imports. */
import {HarnessExperiment,harnessExperimentAppendAllowed} from '../../apps/agent/src/harness-experiment.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Effect, Layer } from '../../apps/agent/node_modules/effect/dist/index.js';
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from '../../apps/agent/node_modules/tardie/src/agent/index.ts';
import { component } from '../../apps/agent/node_modules/tardie/src/core/component/index.ts';
import { createCloudflareAccountHost, type AccountStorage } from '../../apps/agent/src/cloudflare-host.ts';
import { CodeHarness } from '../../apps/agent/src/code-harness.ts';
import { runCodeSegment } from '../../apps/agent/src/code-sandbox-runner.ts';
import { HarnessLibrary, harnessDigest, harnessLibraryEventKey, harnessLibraryTools } from '../../apps/agent/src/harness-library.ts';
import { harnessAcquisitionTools } from '../../apps/agent/src/harness-acquisition.ts';
import { defaultRegistryBinding } from '../../apps/agent/src/registry-defaults.ts';
import { builtinHarnessDefinitions } from '../../apps/agent/src/harness-builtins.ts';
import { sqliteWorkflowKV } from '../../apps/agent/src/workflow-store.ts';
import { localHarnessSandbox } from '../../apps/agent/src/harness-sandbox-local.ts';
import { sandboxJobJournal } from '../../apps/agent/src/sandbox-job-journal.ts';
import { sandboxEnvironment } from '../../apps/agent/src/sandbox-job-runner.ts';
import { harnessSkillForwarder, harnessSkillDeriver } from '../../apps/agent/src/harness-skill.ts';

const [mode, dir, nonce] = process.argv.slice(2);
assert(['prepare','recover'].includes(mode)); assert(dir && nonce);
const recovering = mode === 'recover', owner = '321', thread = 'user-321', background = 'background-321-indexer';
const counts = { model:0, build:0, fetch:0, subscribe:0, send:0, code:0, sandbox:0 };
const count = (key: keyof typeof counts) => { counts[key]++; if(recovering) throw Error('replay attempted '+key); };
globalThis.fetch = Object.assign(async () => { count('fetch'); throw Error('No network permitted'); }, {preconnect:()=>{count('fetch');throw Error('No network permitted');}});
const originalBuild = Bun.build; Bun.build = ((...args:Parameters<typeof Bun.build>)=>{count('build');return originalBuild(...args);}) as typeof Bun.build;
const db = new Database(join(dir,'native.sqlite')), privateDb = new Database(join(dir,'custody.sqlite'));
const storage: AccountStorage = {sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
const environment = await sandboxEnvironment('protected-native-heldout-v1');
const sandbox = localHarnessSandbox({owner,environmentDigest:environment,journal:await sandboxJobJournal(privateDb,join(dir,'sandbox.key')),send:async()=>{count('send');throw Error('No provider configured');}});
const receipts:unknown[]=[];
const registry = defaultRegistryBinding({owner,thread,kv:sqliteWorkflowKV(privateDb),guard:()=>{},policy:()=>({owner,active:true,revision:'1'}),transport:{placement:'local',codeTransport:async(...args)=>{count('code');return runCodeSegment(...args);},sandbox:{harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(job,signal)=>{count('sandbox');const r=await sandbox.harnessJob(job,signal);receipts.push(r);return r;}}}});
assert(registry.library && registry.bootstrap && registry.authorizeReceiving && registry.codeTransport);
const binding = registry.library;
let host:Awaited<ReturnType<typeof createCloudflareAccountHost>>;
const journal = {read:()=>host.read(thread),append:async(events:any[])=>{for(const e of events)await host.commitRoot(host.self(thread),e);}};
const seed = builtinHarnessDefinitions().find(d => d.artifact.name === 'channel.text.echo')!;
// The candidate uses an ASCII-only shortcut, not a held-out expected answer.
const candidate = {...structuredClone(seed.artifact), files:{'main.js':"return {text: /^[\\x00-\\x7F]*$/.test(input.value.text) ? input.value.text : 'claimed success'};"}};
const stableDigest=harnessDigest(seed.artifact), candidateDigest=harnessDigest(candidate);
const code = `
const stable=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'stable'}});
if(stable.status!=='ready')throw Error('baseline unavailable');
const recorded=await tools.call({name:'harness_record',arguments:{artifact:${JSON.stringify(candidate)}}});
if(recorded.digest!==${JSON.stringify(candidateDigest)})throw Error('artifact mismatch');
const evaluation=await tools.call({name:'harness_evaluate',arguments:{digest:recorded.digest,evaluationId:'ascii-shortcut'}});
if(evaluation.eligible!==false)throw Error('held-out failure accepted');
const promotion=await tools.call({name:'harness_promote',arguments:{digest:recorded.digest,evaluationId:'ascii-shortcut',expectedGeneration:1}});
if(promotion.status!=='failed')throw Error('failed candidate promoted');
const selected=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'stable-after-rejection'}});
if(selected.status!=='ready'||selected.reused!==true||selected.harnessDigest!==stable.harnessDigest)throw Error('baseline replaced');
return {status:'held-out rejected'};`;
const harness=new CodeHarness(owner,thread,registry.codeTransport,s=>s,undefined,{blobs:binding.blobs,authorize:async scope=>scope.owner===owner&&scope.thread===thread&&['harness_acquire','harness_record','harness_evaluate','harness_promote'].includes(scope.tool)&&await registry.authorizeReceiving!(owner,registry.defaultAuthorityRef!,'connect',scope)});
const keys=component({name:'protected-heldout-keys',keys:{prefixes:['aiko-harness:'],keyOf:harnessLibraryEventKey},initial:()=>undefined,step:s=>s,output:()=>({view:undefined,transitions:[]})});
const foreground=actor({name:'aiko',methods:{message:agentMessageMethod},components:[keys,registry.bootstrap,harnessSkillForwarder(binding),infer([codeMode([harness.package([...harnessLibraryTools(binding),...harnessAcquisitionTools(binding)])]),outputValidateOnce])]});
const indexer=actor({name:'aiko',methods:{},components:[harnessSkillDeriver(binding)]});
const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:'protected-caller',model_id:'fixed-heldout-program'}}),react:(request:any)=>{count('model');return Effect.succeed(request.trajectory.some((e:any)=>e.type==='ToolReturned')?{kind:'complete' as const,output:'Held-out boundary settled'}:{kind:'call' as const,name:'execute',callId:'heldout',arguments:{code}});}});
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'protected-heldout-'+nonce,ownsThread:t=>t===thread||t===background,actorFor:t=>t===thread?foreground:indexer,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer()),keyOf:harnessLibraryEventKey,canAppend:(_t,batch,read)=>harnessExperimentAppendAllowed(batch,read)});

try{
 await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Bootstrap fixed evaluation',at:1});await host.drive();
 const baseVerifier=binding.verifiers.get(seed.contract.verifierDigest)!;
 const mutableVerifiers=new Map(binding.verifiers);
 const scoped={...binding,verifiers:mutableVerifiers,authorizeEvaluation:async()=>true};
 let proposals=0;
 const config={library:scoped,regime:{reset:'fixed-surface-audit'},authorize:async()=>true,prepare:async(input:any)=>({regimeDigest:input.regimeDigest,evidence:['controlled-pure-reset'],costUsd:null}),propose:async(input:any)=>{proposals++;input.mutableFiles.push('unlisted.js');input.parent.contractDigest=harnessDigest('attempted-contract-replacement');return {hypothesis:'Attempt to modify an undeclared file',files:{'unlisted.js':'return null'},tokens:1,costUsd:null};}};
 const scopedLibrary=new HarnessLibrary(scoped,journal);
 const controller=new HarnessExperiment(config,journal),signal=new AbortController().signal;
 const request={id:'policy',baselineDigest:stableDigest,mutableFiles:['main.js'],repeats:2,policy:{version:1 as const,objectives:[{metric:'latencyMs' as const,direction:'min' as const,tolerance:0}],qualityTolerance:0},limits:{candidates:1,runs:12,wallMs:30000,proposalTokens:100,costUsd:10}};
 await controller.start(request,signal);const jobsBefore=counts.sandbox;
 await assert.rejects(controller.start({...request,id:'widened-files',mutableFiles:['main.js','unlisted.js']},signal),/Mutable surface/);
 await assert.rejects(controller.start({...request,limits:{...request.limits,runs:24}},signal),/identity conflict/);
 await assert.rejects(controller.start({...request,policy:{...request.policy,qualityTolerance:1}},signal),/identity conflict/);assert.equal(counts.sandbox,jobsBefore);
 await controller.start({...request,id:'case-change'},signal);
 mutableVerifiers.set(baseVerifier.digest,{...baseVerifier,cases:[...baseVerifier.cases.slice(0,-1)]});
 assert.equal((await controller.advance('case-change',signal)).status,'blocked');assert.equal(counts.sandbox,jobsBefore);mutableVerifiers.set(baseVerifier.digest,baseVerifier);
 await controller.start({...request,id:'evaluator-change'},signal);
 mutableVerifiers.set(baseVerifier.digest,{...baseVerifier,evaluatorDigest:harnessDigest('changed-evaluator')});
 assert.equal((await controller.advance('evaluator-change',signal)).status,'blocked');assert.equal(counts.sandbox,jobsBefore);mutableVerifiers.set(baseVerifier.digest,baseVerifier);
 await controller.start({...request,id:'undeclared-file'},signal);for(let i=0;i<6;i++){const r=await controller.advance('undeclared-file',signal);if(r.status!=='pending')break;}
 assert.equal((await controller.status('undeclared-file')).status,'unknown');assert.equal((await controller.status('undeclared-file')).candidates.length,1);
 const candidatesBeforeProposal=(await scopedLibrary.list()).candidates.length;
 const replacing=new HarnessExperiment({...config,propose:async()=>{mutableVerifiers.set(baseVerifier.digest,{...baseVerifier,evaluatorDigest:harnessDigest('proposal-time-replacement')});return {hypothesis:'Change frozen evaluator while proposing',files:{'main.js':'return {text:input.value.text};'},tokens:1,costUsd:null};}},journal);
 await replacing.start({...request,id:'proposal-evaluator-change'},signal);for(let i=0;i<6;i++){const r=await replacing.advance('proposal-evaluator-change',signal);if(r.status!=='pending')break;}
 assert.equal((await replacing.status('proposal-evaluator-change')).status,'unknown');assert.equal((await scopedLibrary.list()).candidates.length,candidatesBeforeProposal);mutableVerifiers.set(baseVerifier.digest,baseVerifier);
 await controller.start({...request,id:'verifier-identity'},signal);
 const wrongDigest=harnessDigest('different-verifier-implementation');mutableVerifiers.set(baseVerifier.digest,{...baseVerifier,digest:wrongDigest});
 const beforeWrongJobs=counts.sandbox;
 let registrationRejected=false;try{await scopedLibrary.registerContract({...seed.contract,outcome:seed.contract.outcome+' registration mismatch probe'});}catch{registrationRejected=true;}
 let promotionRejected=false;const baselineEvaluation=(await host.read(thread)).find(e=>e.type==='AikoHarnessEvaluated'&&e.harnessDigest===stableDigest)!;try{await scopedLibrary.promote(stableDigest,String(baselineEvaluation.id),1,signal);}catch{promotionRejected=true;}
 const wrongResult=await controller.advance('verifier-identity',signal);
 const trace=await host.read(thread),wrong=trace.find(e=>e.type==='AikoHarnessChecked'&&(e.witness as any).verifierDigest===wrongDigest);
 const output={nonce,registrationRejected,promotionRejected,proposalEvaluatorReplacementRejected:true,proposalCannotWidenSurface:true,widenedFilesRejected:true,budgetReplacementRejected:true,wrongVerifierDispatched:counts.sandbox!==beforeWrongJobs,policyChangeRejected:true,caseChangeBlocked:true,evaluatorChangeBlocked:true,undeclaredFileRejected:true,wrongVerifierAccepted:!!wrong,wrongResult,counts,proposals};
 writeFileSync(join(dir,'observed.json'),JSON.stringify(output,null,2));writeFileSync(join(dir,'native-trace.json'),JSON.stringify(trace,null,2));console.log(JSON.stringify(output,null,2));
 assert.equal(registrationRejected,true,'registration must reject checker digest mismatching trusted map key');
 assert.equal(promotionRejected,true,'promotion must reject replaced checker identity');
 assert.equal(wrongResult.status,'blocked','advance must reject replaced checker identity');
 assert.equal(!!wrong,false,'no wrong-checker witness may be accepted');
 assert.equal(counts.sandbox,beforeWrongJobs,'wrong checker must be rejected before sandbox dispatch');
}finally{await host.close();db.close();privateDb.close();}
