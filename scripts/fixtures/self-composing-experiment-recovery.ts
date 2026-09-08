/** Unregistered native process-boundary recovery audit. No completion credit.
 * Native SQLite host, real VM/sandbox, fixed production checker; no test-module imports. */
import {HarnessExperiment,harnessExperimentAppendAllowed,harnessExperimentComponent,harnessExperimentTools,harnessExperimentWaitMethod} from '../../apps/agent/src/harness-experiment.ts';
import assert from 'node:assert/strict';
import {handles} from '../../apps/agent/node_modules/tardie/src/core/actor/contract.ts';
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

const [mode, dir, nonce, scenario='trial'] = process.argv.slice(2);
assert(['prepare','recover'].includes(mode)); assert(dir && nonce);
const recovering = mode === 'recover', owner = '321', thread = 'user-321', background = 'background-321-indexer';
const counts = { model:0, build:0, fetch:0, subscribe:0, send:0, code:0, sandbox:0 };
const count = (key: keyof typeof counts) => { counts[key]++; if(recovering && !scenario.startsWith('component')) throw Error('replay attempted '+key); };
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
${scenario==='component'?`await tools.call({name:'harness_experiment_start',arguments:{request:{id:'recovery',baselineDigest:${JSON.stringify(stableDigest)},mutableFiles:['main.js'],repeats:2,policy:{version:1,objectives:[{metric:'latencyMs',direction:'min',tolerance:0}],qualityTolerance:0},limits:{candidates:1,runs:12,wallMs:60000,proposalTokens:100,costUsd:10}}}});`:''}
return {status:'held-out rejected'};`;
const harness=new CodeHarness(owner,thread,registry.codeTransport,s=>s,undefined,{blobs:binding.blobs,authorize:async scope=>scope.owner===owner&&scope.thread===thread&&['harness_acquire','harness_record','harness_evaluate','harness_promote','harness_experiment_start'].includes(scope.tool)&&await registry.authorizeReceiving!(owner,registry.defaultAuthorityRef!,'connect',scope)});
const keys=component({name:'protected-heldout-keys',keys:{prefixes:['aiko-harness:'],keyOf:harnessLibraryEventKey},initial:()=>undefined,step:s=>s,output:()=>({view:undefined,transitions:[]})});
let preparationCalls=0,proposalCalls=0;
const experimentBinding={library:{...binding,authorizeEvaluation:async()=>true},regime:{reset:'independent-restart-v1'},authorize:async()=>true,prepare:async(input:any)=>{preparationCalls++;return {regimeDigest:input.regimeDigest,evidence:['native-controlled-reset'],costUsd:0};},propose:async()=>{proposalCalls++;return {hypothesis:'No supported change',files:null,tokens:0,costUsd:null};}};
const request={id:'recovery',baselineDigest:stableDigest,mutableFiles:['main.js'],repeats:2,policy:{version:1 as const,objectives:[{metric:'latencyMs' as const,direction:'min' as const,tolerance:0}],qualityTolerance:0},limits:{candidates:1,runs:12,wallMs:60000,proposalTokens:100,costUsd:10}};
const boundary=(batch:any[])=>{if(recovering)return;const target=scenario==='proposal'?'AikoHarnessExperimentProposalSettled':scenario==='reservation'?'AikoHarnessExperimentPrepared':'AikoHarnessExperimentTrialSettled';if(['trial','proposal','reservation','component','component-direct'].includes(scenario)&&batch.some(e=>e.type===target)){writeFileSync(join(dir,'cut.json'),JSON.stringify({counts,preparationCalls,proposalCalls,pid:process.pid}));process.exit(0);}};
const foreground=actor({name:'aiko',methods:{message:agentMessageMethod,...(scenario.startsWith('component')?{harnessExperimentWait:harnessExperimentWaitMethod}:{})},components:[keys,...(scenario.startsWith('component')?[handles(harnessExperimentWaitMethod,harnessExperimentComponent(experimentBinding))]:[]),registry.bootstrap,harnessSkillForwarder(binding),infer([codeMode([harness.package([...harnessLibraryTools(binding),...harnessAcquisitionTools(binding),...harnessExperimentTools(experimentBinding)])]),outputValidateOnce])]});
const indexer=actor({name:'aiko',methods:{},components:[harnessSkillDeriver(binding)]});
const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:'protected-caller',model_id:'fixed-heldout-program'}}),react:(request:any)=>{count('model');return Effect.succeed(request.trajectory.some((e:any)=>e.type==='ToolReturned')?{kind:'complete' as const,output:'Held-out boundary settled'}:{kind:'call' as const,name:'execute',callId:'heldout',arguments:{code}});}});
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'protected-heldout-'+nonce,ownsThread:t=>t===thread||t===background,actorFor:t=>t===thread?foreground:indexer,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer()),keyOf:harnessLibraryEventKey,canAppend:(_t,batch,read)=>{boundary(batch);return harnessExperimentAppendAllowed(batch,read);}});

const commit=host.commitRoot;host.commitRoot=async(address,event)=>{boundary([event]);return commit(address,event);};
try {
 const experiment=new HarnessExperiment(experimentBinding,journal),signal=new AbortController().signal;
 if(!recovering){
  await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Native experiment recovery',at:1});await host.drive();
  if(scenario==='component-direct'){await experiment.start(request,signal);await host.drive();}
  if(!scenario.startsWith('component')){await experiment.start(request,signal);if(['deadline','missing'].includes(scenario)){writeFileSync(join(dir,'cut.json'),JSON.stringify({counts,preparationCalls,proposalCalls,pid:process.pid}));}else if(scenario==='concurrent'){let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const racer=new HarnessExperiment({...experimentBinding,prepare:async(input:any)=>{entered();await waiting;return experimentBinding.prepare(input);}},journal);const first=racer.advance('recovery',signal);await started;const follower=await experiment.advance('recovery',signal);assert.equal(follower.status,'unknown');assert(!(await host.read(thread)).some(e=>e.type==='AikoHarnessExperimentSettled'));release();await first;assert.equal((await experiment.status('recovery')).trials,1);assert.equal(preparationCalls,1);writeFileSync(join(dir,'concurrent.json'),JSON.stringify({follower,preparationCalls,counts,trace:await host.read(thread)},null,2));}else for(let i=0;i<10;i++)await experiment.advance('recovery',signal);}
 }else{
  assert.notEqual(JSON.parse(readFileSync(join(dir,'cut.json'),'utf8')).pid,process.pid);
  let advanceResult:any;
  const before=await host.read(thread),registered=before.find(e=>e.type==='AikoHarnessExperimentRegistered')!;writeFileSync(join(dir,'before-trace.json'),JSON.stringify(before,null,2));assert(registered);
  if(scenario==='deadline'){const wall=Date.now;Date.now=()=>Number(registered.deadlineAt)+1;try{await experiment.advance('recovery',signal);}finally{Date.now=wall;}}
  else if(scenario==='missing'){const deleted=privateDb.query("DELETE FROM workflow_records WHERE key LIKE '%' || ? || '%'").run(String(registered.briefRef));assert(deleted.changes>0);await assert.rejects(experiment.advance('recovery',signal));assert.equal(preparationCalls,0);assert.equal(counts.sandbox,0);}
  else if(scenario.startsWith('component'))await host.recover();
  else advanceResult=await experiment.advance('recovery',signal);
  const trace=await host.read(thread),status=await experiment.status('recovery');
  if(scenario==='trial'){assert.equal(trace.filter(e=>e.type==='AikoHarnessExperimentTrialSettled').length,1);assert.equal(preparationCalls,0);assert.equal(counts.sandbox,0);}
  if(['reservation','proposal'].includes(scenario)){assert.equal(advanceResult.status,'unknown');assert(!trace.some(e=>e.type==='AikoHarnessExperimentSettled'));assert.equal(preparationCalls,0);assert.equal(proposalCalls,0);assert.equal(counts.sandbox,0);}
  if(scenario==='deadline'){assert.equal(status.status,'budget-exhausted');assert.equal(status.deadlineAt,registered.deadlineAt);assert.equal(counts.sandbox,0);}
  if(scenario.startsWith('component')){assert.equal(status.status,'retained-baseline');assert.equal(preparationCalls,5);assert.equal(counts.sandbox,5);const turn=trace.findIndex(e=>e.type==='TurnCompleted'),first=trace.findIndex(e=>e.type==='AikoHarnessExperimentReserved');assert(turn>=0&&first>turn);}
  writeFileSync(join(dir,'recovered.json'),JSON.stringify({scenario,status,advanceResult,counts,preparationCalls,proposalCalls,pid:process.pid},null,2));writeFileSync(join(dir,'recovered-trace.json'),JSON.stringify(trace,null,2));console.log(JSON.stringify({scenario,status:status.status,counts,preparationCalls,proposalCalls}));
 }
}finally{await host.close();db.close();privateDb.close();}
