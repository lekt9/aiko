/** Independent S14 composition boundary. Real native children + local sandbox;
 * a successful process is never the parent oracle. Not a registration. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {Layer} from '../../apps/agent/node_modules/effect/dist/index.js';
import {actor} from '../../apps/agent/node_modules/tardie/src/agent/index.ts';
import {createCloudflareAccountHost,type AccountStorage} from '../../apps/agent/src/cloudflare-host.ts';
import {configureExecutionGraph,executionGraphComponent,executionGraphWorker,executionGraphEventKey,executionGraphAppendAllowed,executionGraphExternalEventAllowed,executionGraphView,executionGraphState,executionGraphDigest,executionGraphAttempt,executionGraphChildThread,invalidateExecutionGraph,type ExecutionGraph} from '../../apps/agent/src/execution-graph.ts';
import {HarnessLibrary,harnessDigest,harnessLibraryState,harnessLibraryEventKey,harnessLibraryAppendAllowed} from '../../apps/agent/src/harness-library.ts';
import {defaultRegistryBinding} from '../../apps/agent/src/registry-defaults.ts';
import {builtinHarnessDefinitions} from '../../apps/agent/src/harness-builtins.ts';
import {sqliteWorkflowKV} from '../../apps/agent/src/workflow-store.ts';
import {localHarnessSandbox} from '../../apps/agent/src/harness-sandbox-local.ts';
import {sandboxJobJournal} from '../../apps/agent/src/sandbox-job-journal.ts';
import {sandboxEnvironment} from '../../apps/agent/src/sandbox-job-runner.ts';
const [mode,dir,nonce]=process.argv.slice(2);assert(['prepare','recover'].includes(mode)&&dir&&nonce);
const replay=mode==='recover',owner='321',thread='user-321',counts={jobs:0,verifier:0,worker:0,graphCheck:0,fetch:0};
function tick(k:keyof typeof counts){counts[k]++;assert(!replay,'replay attempted '+k);}
globalThis.fetch=Object.assign(async()=>{tick('fetch');throw Error('No external transport');},{preconnect:()=>{throw Error('No external transport');}});
const db=new Database(join(dir,'native.sqlite')),privateDb=new Database(join(dir,'private.sqlite'));
const storage:AccountStorage={sql:{exec:(q,...a)=>{const rows=db.query(q).all(...a as any);return{toArray:()=>rows as never};}},transactionSync:f=>db.transaction(f)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
const sandbox=localHarnessSandbox({owner,environmentDigest:await sandboxEnvironment('contract-graph-independent'),journal:await sandboxJobJournal(privateDb,join(dir,'sandbox.key')),send:async()=>{throw Error('No sends');}});
const receipts:any[]=[];
const registry=defaultRegistryBinding({owner,thread,kv:sqliteWorkflowKV(privateDb),guard:()=>{},policy:()=>({owner,active:true,revision:'1'}),transport:{placement:'local',codeTransport:async()=>{throw Error('No model execution required');},sandbox:{harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(j,s)=>{tick('jobs');const r=await sandbox.harnessJob(j,s);receipts.push(r);return r;}}}});assert(registry.library);
const binding={...registry.library,verifiers:new Map([...registry.library.verifiers].map(([k,v])=>[k,{...v,verify:async(...a:Parameters<typeof v.verify>)=>{tick('verifier');return v.verify(...a);}}]))};
let host:Awaited<ReturnType<typeof createCloudflareAccountHost>>;
const journal={read:()=>host.read(thread),append:async(events:any[])=>{for(const e of events)await host.commitRoot(host.self(thread),e);}};
const lib=new HarnessLibrary(binding,journal),seed=builtinHarnessDefinitions().find(x=>x.artifact.name==='channel.text.echo')!,digest=harnessDigest(seed.artifact);
const graph:ExecutionGraph={id:'join',version:'fixed-v1',nodes:['left','right','parent'].map(id=>({id,task:id==='parent'?'Both child outputs must denote the same identity':'Preserve the requested identity',dependsOn:id==='parent'?['left','right']:[],reads:id==='parent'?['out/left','out/right']:[],writes:[],outputs:['out/'+id],check:{id:id==='parent'?'equal-identities':'exact-identity',version:'fixed-v1'}}))};
const operation=(id:string)=>executionGraphAttempt(executionGraphState([configureExecutionGraph(graph)]),id);
const parent=actor({name:'aiko',methods:{},components:[executionGraphComponent({check:async({node,attempt})=>{tick('graphCheck');if(node.id==='parent'){const a=await lib.output(operation('left')),b=await lib.output(operation('right'));return{passed:JSON.stringify(a.output)===JSON.stringify(b.output),evidence:[a.outputRef,b.outputRef]};}const out=await lib.output(attempt);assert.deepEqual(out.output,{text:node.id});return{passed:true,evidence:[out.outputRef]};}})]});
const child=actor({name:'aiko',methods:{},components:[executionGraphWorker(async(node,attempt,signal)=>{tick('worker');if(node.id==='parent')return;const w=await lib.run(digest,{value:{text:node.id},schema:'text.message.v1',correlation:node.id},attempt,signal);assert.equal(w.status,'satisfied');})]});
host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'independent-contract-'+nonce,ownsThread:t=>t===thread||/^execution-[a-f0-9]{64}$/.test(t),actorFor:t=>t===thread?parent:child,layersFor:()=>Layer.empty,keyOf:e=>executionGraphEventKey(e)??harnessLibraryEventKey(e),canAppend:(_t,es,read)=>executionGraphAppendAllowed(es,read)&&harnessLibraryAppendAllowed(es,read)});
try{
 if(!replay){await lib.registerContract(seed.contract);await lib.record(seed.artifact);await host.commitRoot(host.self(thread),configureExecutionGraph(graph));}
 await host.recover();
 const rows=await host.read(thread),view=executionGraphView(rows);assert.equal(view.nodes.left.status,'passed');assert.equal(view.nodes.right.status,'passed');assert.equal(view.nodes.parent.status,'failed');assert.equal(view.complete,false);
 const traces:any={parent:rows};for(const n of graph.nodes)traces[n.id]=await host.read(executionGraphChildThread(thread,operation(n.id)));
 assert(graph.nodes.every(n=>traces[n.id].some((e:any)=>e.type==='ExecutionGraphWork')));
 const checked=rows.find(e=>e.type==='ExecutionGraphChecked'&&e.node==='left')!;assert(checked);
 assert.equal(executionGraphExternalEventAllowed(checked),false);
 const wrong=structuredClone(checked) as any;wrong.receipt.contractDigest=harnessDigest('wrong');assert.equal(executionGraphView(rows.map(e=>e===checked?wrong:e)).nodes.left.status,'returned');
 const invalidated=[...rows,invalidateExecutionGraph(graph.id,'left','recheck')];assert.equal(executionGraphAppendAllowed([checked],()=>invalidated),false);
 const changed=structuredClone(graph);changed.version='candidate-v2';assert.equal(executionGraphState([...rows,configureExecutionGraph(changed)]).graph?.version,'fixed-v1');
 const before={...counts};const repeated=await lib.run(digest,{value:{text:'left'},schema:'text.message.v1',correlation:'left'},operation('left'),new AbortController().signal);assert.equal(repeated.status,'satisfied');await assert.rejects(lib.run(digest,{value:{text:'altered'},schema:'text.message.v1',correlation:'left'},operation('left'),new AbortController().signal));assert.deepEqual(counts,before);
 const observed={nonce,pid:process.pid,counts,view,library:JSON.parse(JSON.stringify(harnessLibraryState(rows,owner),(_k,v)=>v instanceof Map?[...v]:v)),semantics:{passingChildren:2,parentFailed:true,wrongContractIgnored:true,staleCheckedAppendDenied:true,externalCheckedDenied:true,immutableGraph:true,repeatedOperationNoWork:true,changedInputDenied:true}};
 if(replay){const prior=JSON.parse(readFileSync(join(dir,'prepare.json'),'utf8'));assert.notEqual(prior.pid,process.pid);for(const k of ['view','library','semantics'])assert.deepEqual(observed[k as keyof typeof observed],prior[k]);assert.deepEqual(traces,JSON.parse(readFileSync(join(dir,'prepare-traces.json'),'utf8')));assert(Object.values(counts).every(n=>n===0));}
 else {assert.deepEqual(counts,{jobs:2,verifier:2,worker:3,graphCheck:3,fetch:0});writeFileSync(join(dir,'sandbox-receipts.json'),JSON.stringify(receipts,null,2));}
 if(replay){
  const w=harnessLibraryState(rows,owner).witnesses.get(operation('left'))!;assert(w.outputRef);
  await assert.rejects(binding.blobs.get('foreign-owner',w.outputRef));
  const key='harness-blobs:'+harnessDigest(owner)+':'+w.outputRef;
  assert.equal(privateDb.query('DELETE FROM workflow_records WHERE key=?').run(key).changes,1);
  await assert.rejects(lib.output(operation('left')));
  assert.equal((await lib.run(digest,{value:{text:'left'},schema:'text.message.v1',correlation:'left'},operation('left'),new AbortController().signal)).status,'satisfied','historical witness remains historical');
  await host.recover();assert.deepEqual(counts,before);assert.deepEqual(await host.read(thread),rows);
  writeFileSync(join(dir,'missing-owned-output.json'),JSON.stringify({missingOutputUnavailable:true,foreignOwnerDenied:true,historicalWitnessPreserved:true,noRepeatWork:true,counts},null,2));
 }
 writeFileSync(join(dir,mode+'.json'),JSON.stringify(observed,null,2));writeFileSync(join(dir,mode+'-traces.json'),JSON.stringify(traces,null,2));console.log(JSON.stringify({mode,counts,semantics:observed.semantics}));
}finally{await host.close();db.close();privateDb.close();}
