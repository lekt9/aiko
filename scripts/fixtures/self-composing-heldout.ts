/** Independent held-out boundary: production native host, default registry, VM and trusted builtin checker. */
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
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'protected-heldout-'+nonce,ownsThread:t=>t===thread||t===background,actorFor:t=>t===thread?foreground:indexer,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer()),keyOf:harnessLibraryEventKey});
try {
 if(!recovering){await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Evaluate an ASCII shortcut under the fixed text contract',at:1});await host.drive();}else await host.recover();
 const foregroundTrace=await host.read(thread),indexerTrace=await host.read(background),trace={foreground:foregroundTrace,indexer:indexerTrace};
 writeFileSync(join(dir,mode+'-trace.json'),JSON.stringify(trace,null,2));
 assert.equal(foregroundTrace.find(e=>e.type==='TurnCompleted')?.output,'Held-out boundary settled');
 const codeSettled=foregroundTrace.filter(e=>e.type==='CodeSettled');assert.equal(codeSettled.length,1);assert.equal(codeSettled[0].error,undefined);
 const evaluated=foregroundTrace.find(e=>e.type==='AikoHarnessEvaluated'&&e.id==='ascii-shortcut') as any;
 assert(evaluated);assert.equal(evaluated.eligible,false);assert.equal(evaluated.harnessDigest,candidateDigest);
 const witnesses=evaluated.witnessIds.map((id:string)=>(foregroundTrace.find(e=>e.type==='AikoHarnessChecked'&&e.id===id) as any)?.witness);
 const starts=foregroundTrace.filter(e=>e.type==='AikoHarnessRunStarted');
 const cases=seed.verifier.cases.map(c=>{const start=starts.find(e=>e.harnessDigest===candidateDigest&&e.caseId===c.id);assert(start);const witness=witnesses.find((w:any)=>w.operationId===start.id);assert(witness);assert.equal(witness.contractDigest,harnessDigest(seed.contract));assert.equal(witness.verifierDigest,seed.verifier.digest);assert(witness.evidence.some((x:string)=>x.startsWith('sandbox-operation:')));assert(witness.evidence.includes('trusted-builtin:channel.text.echo:'+(c.split==='development'?'satisfied':'violated')));assert.equal(witness.status,c.split==='development'?'satisfied':'violated');return {id:c.id,split:c.split,status:witness.status};});
 const promotions=foregroundTrace.filter(e=>e.type==='AikoHarnessPromoted');assert.equal(promotions.length,1);assert.equal(promotions[0].harnessDigest,stableDigest);
 const library=new HarnessLibrary(binding,journal),view=await library.list();assert.equal(view.active.length,1);assert.equal(view.active[0].harnessDigest,stableDigest);assert.equal(view.active[0].generation,1);
 assert.equal(foregroundTrace.filter(e=>e.type==='AikoHarnessChecked').length,6);
 assert.equal(foregroundTrace.filter(e=>e.type==='AikoHarnessEvaluationStarted').length,2);
 const reused=foregroundTrace.find(e=>e.type==='AikoHarnessAcquisitionSettled'&&e.id==='stable-after-rejection');assert.equal(reused?.reused,true);
 const observed={nonce,pid:process.pid,counts,stableDigest,candidateDigest,cases,view,semantics:{developmentCasesPassed:2,heldoutCasesViolated:1,explicitPromotionRejected:true,stableGeneration:1,checkedExecutions:6,reuseWithoutEvaluation:true}};
 writeFileSync(join(dir,mode+'.json'),JSON.stringify(observed,null,2));
 if(!recovering){assert.equal(counts.sandbox,6);assert(counts.model>0&&counts.code>0);writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));}
 else {assert.deepEqual(counts,{model:0,build:0,fetch:0,subscribe:0,send:0,code:0,sandbox:0});const before=JSON.parse(readFileSync(join(dir,'prepare.json'),'utf8'));for(const key of ['stableDigest','candidateDigest','cases','view','semantics'])assert.deepEqual(observed[key as keyof typeof observed],before[key]);assert.deepEqual(trace,JSON.parse(readFileSync(join(dir,'prepare-trace.json'),'utf8')));}
}finally{await host.close();db.close();privateDb.close();}
