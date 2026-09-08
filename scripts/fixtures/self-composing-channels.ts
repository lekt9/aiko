import {channelBoundary,exerciseChannelBoundary} from './self-composing-channel-boundaries.ts';
/** Independent native channel witness. Uses production builtin verifier/default assembly;
 * the fixture supplies a deterministic caller, never a candidate-controlled checker. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
import { channelHarnessHandlers, createHostedChannels } from '../../apps/agent/src/channel-host.ts';
import { channelWiringAppendAllowed, channelWiringEventKey } from '../../apps/agent/src/channel-wiring.ts';
import { channelHydrate } from '../../apps/agent/src/channel-custody.ts';

const [mode, dir, nonce, scenario = 'baseline'] = process.argv.slice(2);
assert(['prepare','recover'].includes(mode)); assert(dir && nonce);
const recovering = mode === 'recover', owner = '321', thread = 'user-321', background = 'background-321-indexer';
const counts = { model:0, build:0, fetch:0, subscribe:0, send:0, code:0, sandbox:0 };
const count = (key: keyof typeof counts) => { counts[key]++; if(recovering && scenario === 'baseline') throw Error('replay attempted '+key); };
globalThis.fetch = Object.assign(async () => { count('fetch'); throw Error('No network permitted'); }, {preconnect:()=>{count('fetch');throw Error('No network permitted');}});
const originalBuild = Bun.build; Bun.build = ((...args:Parameters<typeof Bun.build>)=>{count('build');return originalBuild(...args);}) as typeof Bun.build;
const db = new Database(join(dir,'native.sqlite')), privateDb = new Database(join(dir,'custody.sqlite'));
const storage: AccountStorage = {sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
const environment = await sandboxEnvironment('protected-native-channel-v1');
const sandbox = localHarnessSandbox({owner,environmentDigest:environment,journal:await sandboxJobJournal(privateDb,join(dir,'sandbox.key')),send:async()=>{count('send');throw Error('No provider configured');}});
const receipts:unknown[]=[];
const registry = defaultRegistryBinding({owner,thread,kv:sqliteWorkflowKV(privateDb),guard:()=>{},policy:()=>({owner,active:true,revision:'1'}),transport:{placement:'local',codeTransport:async(...args)=>{count('code');return runCodeSegment(...args);},sandbox:{harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(job,signal)=>{count('sandbox');const r=await sandbox.harnessJob(job,signal);receipts.push(r);return r;}}}});
assert(registry.library && registry.bootstrap && registry.authorizeReceiving && registry.codeTransport);
const binding = registry.library;
let host:Awaited<ReturnType<typeof createCloudflareAccountHost>>;
const journal = {read:()=>host.read(thread),append:async(events:any[])=>{for(const e of events)await host.commitRoot(host.self(thread),e);}};
let channelNow: number | undefined;
const hosted = createHostedChannels(owner,()=>host,undefined,{wiring:{...channelHarnessHandlers(binding,journal,registry.authorizeReceiving),now:()=>channelNow??Date.now()}});
assert(hosted.wiring);
const echo=builtinHarnessDefinitions().find(d=>d.artifact.name==='channel.text.echo')!;
const pin={harness:harnessDigest(echo.artifact),contract:harnessDigest(echo.contract)};
const authority=registry.defaultAuthorityRef!;
const privateText='private-channel-payload-'+nonce;
const falseCandidate={...structuredClone(echo.artifact),files:{'main.js':"return {text:'claimed success'};"}};
let code=`const rejected=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'reject-false',candidate:${JSON.stringify(falseCandidate)}}}); if(rejected.status!=='failed')throw Error('false candidate accepted'); const selected=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'acquire-echo'}}); if(selected.status!=='ready')throw Error('acquisition unavailable'); const reused=await tools.call({name:'harness_acquire',arguments:{name:'channel.text.echo',operationId:'reuse-echo'}}); if(reused.status!=='ready'||reused.reused!==true||reused.harnessDigest!==selected.harnessDigest)throw Error('reuse failed'); const input=await channels.bind({name:'input',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:${JSON.stringify(authority)},operationId:'bind-input'}); const output=await channels.bind({name:'output',schema:'text.message.v1',directions:['inbox','outbox'],authorityRef:${JSON.stringify(authority)},operationId:'bind-output'}); await channels.connect({name:'echo',generation:1,input:{channel:input.channel,generation:1},accepts:'text.message.v1',handler:${JSON.stringify(pin)},output:{channel:output.channel,generation:1,mode:'port'},authorityRef:${JSON.stringify(authority)},start:'after-registration',operationId:'connect-echo'}); const reply=await channels.request({operationId:'request-echo',send:{port:{channel:input.channel,generation:1},schema:'text.message.v1',value:{text:${JSON.stringify(privateText)}},occurrence:'source-one',correlation:'correlation-one',authorityRef:${JSON.stringify(authority)}},reply:{port:{channel:output.channel,generation:1},handler:${JSON.stringify(pin)},schema:'text.message.v1',correlation:'correlation-one',deadline:${Date.now()+120000},authorityRef:${JSON.stringify(authority)}}}); if(reply.status!=='satisfied'||reply.value.text!==${JSON.stringify(privateText)})throw Error('incorrect typed reply'); return {status:'satisfied'};`;
if(scenario!=='baseline')code=code.replaceAll(JSON.stringify(privateText),'privateInput.text').replace('const rejected=',"const privateInput=await tools.call({name:'fixture_private_input',arguments:{}}); const rejected=");
const privateInputTools=scenario==='baseline'?[]:[{spec:{name:'fixture_private_input',description:'Read the controlled owner-private fixture input',inputSchema:{type:'object',additionalProperties:false}},run:()=>Effect.succeed({text:privateText})}];
const harness = new CodeHarness(owner,thread,registry.codeTransport,s=>s,undefined,{blobs:binding.blobs,authorize:async scope=>scope.owner===owner && scope.thread===thread && ['fixture_private_input','harness_acquire'].includes(scope.tool) && await registry.authorizeReceiving!(owner,authority,'connect',scope)});
const keys=component({name:'protected-channel-library-keys',keys:{prefixes:['aiko-harness:'],keyOf:harnessLibraryEventKey},initial:()=>undefined,step:s=>s,output:()=>({view:undefined,transitions:[]})});
const foreground=actor({name:'aiko',methods:{message:agentMessageMethod},components:[keys,registry.bootstrap,harnessSkillForwarder(binding),hosted.wiring.component,infer([codeMode([harness.package([...harnessLibraryTools(binding),...harnessAcquisitionTools(binding),...privateInputTools]),hosted.wiring.package]),outputValidateOnce])]});
const indexer=actor({name:'aiko',methods:{},components:[harnessSkillDeriver(binding)]});
const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:'protected-caller',model_id:'fixed-native-program'}}),react:(request:any)=>{count('model');if(!request.trajectory.some((e:any)=>e.type==='ToolReturned'))return Effect.succeed({kind:'call' as const,name:'execute',callId:'create-hook',arguments:{code}});return Effect.succeed({kind:'complete' as const,output:'Native channel settled'});}});
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'protected-channel-'+nonce,ownsThread:t=>t===thread||t===background,actorFor:t=>t===thread?foreground:indexer,layersFor:()=>Layer.merge(harness.inference(model),hosted.wiring!.sandboxLayer(harness.sandboxLayer())),keyOf:e=>channelWiringEventKey(e)??harnessLibraryEventKey(e),canAppend:(_t,batch,read)=>{channelBoundary(scenario,mode,dir,counts,receipts)(batch,read);return channelWiringAppendAllowed(batch,read);}});
if(scenario!=='baseline'){
 const seed=host.seed,commitRoot=host.commitRoot;
 host.seed=async(t,events)=>{const rows=await host.read(t);channelBoundary(scenario,mode,dir,counts,receipts)(events,()=>rows);return seed(t,events);};
 host.commitRoot=async(address,event)=>{const rows=await host.read(thread);channelBoundary(scenario,mode,dir,counts,receipts)([event],()=>rows);return commitRoot(address,event);};
}
try {
 if(recovering && scenario !== 'baseline'){await exerciseChannelBoundary({scenario,dir,host,thread,hosted,binding,privateDb,counts,pin,authority,setNow:(n:number)=>{channelNow=n;}});process.exitCode=0;}else{
 if(!recovering){await host.commitRoot(host.self(thread),{type:'MessageReceived',id:nonce,text:'Compose the typed echo hook',at:1});await host.drive();}
 else {unlinkSync(join(dir,'disposable-wiring.json'));await host.recover();}
 const trace=await host.read(thread), indexerTrace=await host.read(background);
 writeFileSync(join(dir,mode+'-trace.json'),JSON.stringify({foreground:trace,indexer:indexerTrace},null,2));
 assert.equal(trace.find(e=>e.type==='TurnCompleted')?.output,'Native channel settled');
 const one=(type:string)=>{const rows=trace.filter(e=>e.type===type);assert.equal(rows.length,1,type);return rows[0] as any;};
 const connected=one('AikoChannelWiringConnected'), claimed=one('AikoChannelWiringClaimed'), handoff=one('AikoChannelWiringHandoff'), cursor=one('AikoChannelWiringCursor'), started=one('AikoChannelWiringStarted'), settled=one('AikoChannelWiringSettled'), waiter=one('AikoChannelWiringWaitRegistered'), ready=one('AikoChannelWiringWaitReady');
 one('AikoChannelWiringWaitDelivered');one('BlockedOn');
 assert.deepEqual(connected.wire.handler,pin);assert.equal(connected.wire.generation,1);assert.equal(connected.watermark,0);assert.equal(cursor.sequence,1);
 assert.equal(cursor.source,claimed.source);assert.equal(cursor.id,handoff.id);assert.equal(started.id,claimed.id);assert.equal(settled.invocation,claimed.id);assert.equal(settled.status,'satisfied');assert.equal(waiter.invocation,claimed.id);assert.equal(ready.result.invocation,claimed.id);assert.equal(ready.result.status,'satisfied');
 assert(trace.indexOf(handoff)<trace.indexOf(cursor));assert(trace.indexOf(waiter)<trace.findIndex(e=>e.type==='AikoChannelWiringAccepted'));assert(trace.indexOf(settled)<trace.indexOf(ready));
 const checked=trace.filter(e=>e.type==='AikoHarnessChecked');assert.equal(checked.length,7);const ordinary=checked.find(e=>e.id===claimed.id) as any;assert.equal(ordinary.witness.status,'satisfied');assert.equal(ordinary.witness.harnessDigest,pin.harness);assert.equal(ordinary.witness.contractDigest,pin.contract);assert(ordinary.witness.evidence.some((e:string)=>e.startsWith('sandbox-operation:')));
 assert.equal(trace.filter(e=>e.type==='AikoHarnessPromoted').length,1);assert(!trace.some(e=>e.type==='AikoHarnessPromoted'&&e.harnessDigest===harnessDigest(falseCandidate)));
 assert.equal(trace.filter(e=>e.type==='AikoHarnessEvaluationStarted').length,2);assert.equal(trace.find(e=>e.type==='AikoHarnessAcquisitionSettled'&&e.id==='reuse-echo')?.reused,true);
 const rejected=trace.find(e=>e.type==='AikoHarnessAcquisitionSettled'&&e.id==='reject-false');assert.equal(rejected?.status,'failed');
 const accepted=trace.filter(e=>e.type==='AikoChannelWiringAccepted');assert.equal(accepted.length,2);for(const e of accepted){assert.equal(e.value,undefined);assert.deepEqual(await channelHydrate(binding.blobs,owner,e.valueRef),{text:privateText});await assert.rejects(channelHydrate(binding.blobs,'foreign-owner',e.valueRef),/unavailable/);}
 assert(!JSON.stringify(trace.filter(e=>e.type.startsWith('AikoChannelWiring'))).includes(privateText));
 const view=await hosted.wiring.view();
 const serial=JSON.parse(JSON.stringify(view,(_key,value)=>value instanceof Map?[...value.entries()]:value instanceof Set?[...value]:value));
 const types=Object.fromEntries([...new Set(trace.map(e=>e.type))].map(type=>[type,trace.filter(e=>e.type===type).length]));
 const library=new HarnessLibrary(binding,journal), doc=await library.skill(pin.harness);
 assert.equal(doc.status,'evaluated');assert.equal(harnessDigest(doc.markdown),doc.skillRef);assert(!JSON.stringify(doc).includes(privateText));
 const resources={};for(const path of Object.keys(doc.resources as object)){(resources as any)[path]=await library.skill(pin.harness,path);assert(!JSON.stringify((resources as any)[path]).includes(privateText));}
 const semantics={typedPorts:2,versionedConnections:1,sourceCursor:1,checkedExecutions:7,falseCandidateRejected:true,reusedWithoutExtraJobs:true,joinedInvocation:true,privateChannelRows:true,foreignHydrationRejected:true,passiveExactBundle:true};
 const observed={semantics,nonce,pid:process.pid,counts,types,pin,view:serial,doc,resources};
 writeFileSync(join(dir,mode+'.json'),JSON.stringify(observed,null,2));
 if(!recovering){assert(counts.model>0&&counts.code>0&&counts.sandbox===7);writeFileSync(join(dir,'disposable-wiring.json'),JSON.stringify(serial));writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));}
 else {assert.deepEqual(counts,{model:0,build:0,fetch:0,subscribe:0,send:0,code:0,sandbox:0});const before=JSON.parse(readFileSync(join(dir,'prepare.json'),'utf8'));for(const key of ['view','pin','doc','resources','semantics'])assert.deepEqual(observed[key as keyof typeof observed],before[key]);assert.deepEqual(JSON.parse(readFileSync(join(dir,'prepare-trace.json'),'utf8')),{foreground:trace,indexer:indexerTrace});}
}}finally{await host.close();db.close();privateDb.close();}
