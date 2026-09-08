/** Unregistered adversarial controller audit. Records defects, not completion credit.
 * Native SQLite host, real VM/sandbox, fixed production checker; no test-module imports. */
import {HarnessExperiment,harnessExperimentState,harnessExperimentAppendAllowed} from '../../apps/agent/src/harness-experiment.ts';
import {harnessDominates} from '../../apps/agent/src/harness-pareto.ts';
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
const counts = { model:0, build:0, fetch:0, subscribe:0, send:0, code:0, sandbox:0, verifier:0, prepare:0, proposal:0 };
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
const binding = {...registry.library,verifiers:new Map([...registry.library.verifiers].map(([id,v])=>[id,{...v,verify:async(...args:Parameters<typeof v.verify>)=>{count('verifier');return v.verify(...args);}}]))};
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

const signal=new AbortController().signal;
const slow={...structuredClone(seed.artifact),files:{'main.js':"let n=0; for(let i=0;i<500000;i++) n+=i; return {text:input.value.text};"}};
const slowDigest=harnessDigest(slow);
const policy={version:1 as const,objectives:[{metric:'latencyMs' as const,direction:'min' as const,tolerance:0}],qualityTolerance:0};
const experimentBinding={library:{...binding,authorizeEvaluation:async()=>true},regime:{reset:'independent-optimization-v1'},authorize:async()=>true,prepare:async(input:any)=>{count('prepare');return {regimeDigest:input.regimeDigest,evidence:['controlled-pure-input-reset'],costUsd:null};},propose:async(input:any)=>{count('proposal');assert(input.feedback.every((f:any)=>f.evidence.every((e:any)=>['ordinary','empty'].includes(e.caseId))));return {hypothesis:'Remove redundant work with an ASCII shortcut',files:candidate.files,tokens:16,costUsd:null};}};
const experiment=new HarnessExperiment(experimentBinding,journal),lib=new HarnessLibrary(binding,journal);
try {
 if(!recovering){
  await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Establish the fixed checked library',at:1});await host.drive();
  assert.equal(await lib.record(slow),slowDigest);await lib.evaluate(slowDigest,'slow-baseline',signal);await lib.promote(slowDigest,'slow-baseline',1,signal);
  await experiment.start({id:'winner-fails-heldout',baselineDigest:slowDigest,mutableFiles:['main.js'],repeats:2,policy,limits:{candidates:1,runs:12,wallMs:30000,proposalTokens:100,costUsd:10}},signal);
  for(let i=0;i<30;i++){const result=await experiment.advance('winner-fails-heldout',signal);if(result.status!=='pending')break;}
  await host.drive();
 }else await host.recover();
 const trace={foreground:await host.read(thread),indexer:await host.read(background)},events=trace.foreground;
 const state=harnessExperimentState(events,owner,'winner-fails-heldout');assert(state.closed&&state.settled);
 const status=await experiment.status('winner-fails-heldout');assert.equal(status.status,'retained-baseline');assert.equal(status.trials,12);assert.equal(status.proposals,1);assert.equal(status.costUsd,null);
 const dev=await binding.blobs.get(owner,state.closed.developmentComparisonRef as string) as any[];
 const final=await binding.blobs.get(owner,state.settled.comparisonRef as string) as any[];
 const devBaseline=dev.find(c=>c.harnessDigest===slowDigest),devCandidate=dev.find(c=>c.harnessDigest===candidateDigest);
 assert(devBaseline&&devCandidate);assert.equal(harnessDominates(devCandidate,devBaseline,policy),true,'must be a measured development winner, not merely passing development cases');
 const finalBaseline=final.find(c=>c.harnessDigest===slowDigest),finalCandidate=final.find(c=>c.harnessDigest===candidateDigest);
 assert.equal(finalBaseline.eligible,true);assert.equal(finalCandidate.eligible,false);assert.equal(finalCandidate.statuses.violated,2);assert.equal(finalCandidate.statuses.satisfied,4);
 assert.deepEqual(state.settled.frontier,[slowDigest]);assert.equal(state.settled.selectedDigest,slowDigest);
 const view=await lib.list();assert.equal(view.active.length,1);assert.equal(view.active[0].harnessDigest,slowDigest);assert.equal(view.active[0].generation,2);
 const trials=[...state.trials.values()];assert.equal(new Set(trials.map(t=>t.id)).size,12);assert(trials.every(t=>typeof t.accounting==='object'));
 const checked=events.filter(e=>e.type==='AikoHarnessChecked');assert.equal(checked.length,21);
 for(const trial of trials){const w=checked.find(e=>e.id===trial.id)?.witness as any;assert(w);assert.equal(harnessDigest(w),trial.witnessDigest);assert(w.evidence.some((e:string)=>e.startsWith('sandbox-operation:')));assert.equal(w.contractDigest,harnessDigest(seed.contract));}
 const retained:any={};for(const e of events.filter(e=>e.experimentId==='winner-fails-heldout'))for(const [key,value] of Object.entries(e))if(key.endsWith('Ref')&&typeof value==='string'&&key!=='caseRef'){retained[value]=await binding.blobs.get(owner,value);}
 const projection=JSON.parse(JSON.stringify({view,state},(_k,v)=>v instanceof Map?[...v.entries()]:v));
 const semantics={actualDevelopmentWinner:true,heldoutViolations:2,stableBaselineRetained:true,uniqueNativeTrials:12,checkedExecutions:21,costRemainsUnknown:true,frontierRebuilt:true};
 const observed={nonce,pid:process.pid,counts,semantics,projection,retained,dev,final,slowDigest,candidateDigest};
 writeFileSync(join(dir,mode+'.json'),JSON.stringify(observed,null,2));writeFileSync(join(dir,mode+'-trace.json'),JSON.stringify(trace,null,2));
 if(!recovering){assert.equal(counts.sandbox,21);assert.equal(counts.verifier,21);assert.equal(counts.prepare,12);assert.equal(counts.proposal,1);writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));}
 else {assert(Object.values(counts).every(v=>v===0));const before=JSON.parse(readFileSync(join(dir,'prepare.json'),'utf8'));assert.notEqual(before.pid,process.pid);for(const key of ['semantics','projection','retained','dev','final','slowDigest','candidateDigest'])assert.deepEqual(observed[key as keyof typeof observed],before[key]);assert.deepEqual(trace,JSON.parse(readFileSync(join(dir,'prepare-trace.json'),'utf8')));}
}finally{await host.close();db.close();privateDb.close();}
