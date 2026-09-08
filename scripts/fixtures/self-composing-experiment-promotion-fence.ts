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
import { HarnessLibrary, harnessLibraryAppendAllowed, harnessDigest, harnessLibraryEventKey, harnessLibraryTools } from '../../apps/agent/src/harness-library.ts';
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
let code = `
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
let activeCallId='heldout';
const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:'protected-caller',model_id:'fixed-heldout-program'}}),react:(request:any)=>{count('model');return Effect.succeed(request.trajectory.some((e:any)=>e.type==='ToolReturned'&&e.callId===activeCallId)?{kind:'complete' as const,output:'Held-out boundary settled'}:{kind:'call' as const,name:'execute',callId:activeCallId,arguments:{code}});}});
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'protected-heldout-'+nonce,ownsThread:t=>t===thread||t===background,actorFor:t=>t===thread?foreground:indexer,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer()),keyOf:harnessLibraryEventKey,canAppend:(_t,batch,read)=>harnessLibraryAppendAllowed(batch,read)});
writeFileSync(join(dir,'controller-source.ts'),readFileSync(new URL('../../apps/agent/src/harness-experiment.ts',import.meta.url)));
try {
 await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Establish a checked baseline',at:1});await host.drive();
 const lib=new HarnessLibrary(binding,journal),signal=new AbortController().signal;
 assert.equal((await lib.list()).active[0]?.harnessDigest,stableDigest);
 let prepared=0;
 const experimentBinding={library:{...binding,authorizeEvaluation:async()=>false},regime:{reset:'independent-controlled-fixture-v1'},authorize:async()=>true,prepare:async(input:any)=>{prepared++;return {regimeDigest:input.regimeDigest,evidence:['controlled-reset-executed'],costUsd:0};},propose:async()=>({hypothesis:'no proposal',files:null,tokens:0,costUsd:0})};
 const request={id:'denied-fixture',baselineDigest:stableDigest,mutableFiles:['main.js'],repeats:2,policy:{version:1 as const,objectives:[{metric:'latencyMs' as const,direction:'min' as const,tolerance:0}],qualityTolerance:0},limits:{candidates:1,runs:12,wallMs:20000,proposalTokens:100,costUsd:10}};
 const denied=new HarnessExperiment(experimentBinding,journal);
 await denied.start(request,signal);const beforeJobs=counts.sandbox;const deniedResult=await denied.advance(request.id,signal);
 const deniedPreparationBeforeGrant=prepared>0;assert.equal(counts.sandbox,beforeJobs);
 const expensivePreparation=new HarnessExperiment({...experimentBinding,library:{...binding,authorizeEvaluation:async()=>true},costCeilingUsd:{trial:1,proposal:1},prepare:async(input:any)=>({regimeDigest:input.regimeDigest,evidence:['controlled-prepare-cost-receipt'],costUsd:11})},journal);
 await expensivePreparation.start({...request,id:'prepare-cost-breach'},signal);const beforeCostJobs=counts.sandbox;
 const preparationCostResult=await expensivePreparation.advance('prepare-cost-breach',signal);
 const dispatchedAfterPreparationCostBreach=counts.sandbox>beforeCostJobs;
 // A deliberately slower but semantically identical stable version permits a
 // measured development comparison without fabricated timing or cost scores.
 const slow={...structuredClone(seed.artifact),files:{'main.js':"let n=0; for(let i=0;i<200000;i++) n+=i; return {text:input.value.text};"}};
 const slowDigest=await lib.record(slow);const slowEvaluation=await lib.evaluate(slowDigest,'slow-stable',signal);writeFileSync(join(dir,'slow-evaluation.json'),JSON.stringify({slowEvaluation,trace:await host.read(thread)},null,2));await lib.promote(slowDigest,'slow-stable',1,signal);
 let cancellationInjected=false;
 const racingJournal={read:journal.read,append:async(events:any[])=>{await journal.append(events);if(events.some(e=>e.type==='AikoHarnessEvaluated'&&e.experimentId==='cancel-at-final')){cancellationInjected=true;await journal.append([{type:'AikoHarnessExperimentCancelled',id:'cancel-at-final',experimentId:'cancel-at-final',owner,at:Date.now()}]);}}};
 const reflection:any[]=[];
 const race=new HarnessExperiment({...experimentBinding,library:{...binding,authorizeEvaluation:async()=>true},propose:async(input:any)=>{reflection.push(structuredClone(input));return {hypothesis:'Remove redundant busy wait while preserving exact text',files:{'main.js':seed.artifact.files['main.js']},tokens:12,costUsd:null};}},racingJournal);
 await race.start({...request,id:'cancel-at-final',baselineDigest:slowDigest,limits:{...request.limits,wallMs:30000}},signal);
 let result:any;
 for(let i=0;i<30;i++){result=await race.advance('cancel-at-final',signal);if(result.status!=='pending')break;}
 const evaluation=(await host.read(thread)).find(e=>e.type==='AikoHarnessEvaluated'&&e.experimentId==='cancel-at-final');assert(evaluation,'race must reach actual final evaluation');
 assert(cancellationInjected);assert.equal(result.status,'cancelled');
 const headBefore=(await lib.list()).active;
 activeCallId='manual-cancelled-promotion';
 code=`const result=await tools.call({name:'harness_promote',arguments:${JSON.stringify({digest:evaluation.harnessDigest,evaluationId:evaluation.id,expectedGeneration:2})}});if(result.status!=='failed')throw Error('cancelled evaluation promoted');return {rejected:true};`;
 await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce+'-manual',text:'Attempt manual promotion using cancelled experiment evaluation',at:Date.now()});await host.drive();
 const manual=(await host.read(thread)).find(e=>e.type==='CodeSettled'&&e.execId===activeCallId);assert(manual);writeFileSync(join(dir,'manual-code.json'),JSON.stringify({manual,headBefore,headAfter:(await lib.list()).active,trace:await host.read(thread)},null,2));assert.equal(manual.error,undefined);assert.deepEqual((await lib.list()).active,headBefore);
 const finalTrace=await host.read(thread);
 const cancelIndex=finalTrace.findIndex(e=>e.type==='AikoHarnessExperimentCancelled'&&e.experimentId==='cancel-at-final');
 const promotionAfterCancellation=cancelIndex>=0&&finalTrace.slice(cancelIndex+1).some(e=>e.type==='AikoHarnessPromoted');
 const reflectedHeldout=JSON.stringify(reflection).includes('声 🎧');
 assert.equal(reflectedHeldout,false);
 const output={nonce,manualCodeModePromotionRejected:true,productionLibraryFence:true,dispatchedAfterPreparationCostBreach,preparationCostResult,deniedPreparationBeforeGrant,prepared,deniedResult,cancellationInjected,promotionAfterCancellation,result,reflectionCount:reflection.length,reflectedHeldout,counts};
 writeFileSync(join(dir,'audit.json'),JSON.stringify(output,null,2));writeFileSync(join(dir,'native-trace.json'),JSON.stringify({foreground:finalTrace,indexer:await host.read(background)},null,2));writeFileSync(join(dir,'reflection.json'),JSON.stringify(reflection,null,2));writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));
 console.log(JSON.stringify(output,null,2));
}finally{await host.close();db.close();privateDb.close();}
