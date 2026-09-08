/** Independent native network-read + structural transformation experiment.
 * Controlled loopback service and fixed oracle; no application test imports. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {actor} from '../../apps/agent/node_modules/tardie/src/agent/index.ts';
import {Layer} from '../../apps/agent/node_modules/effect/dist/index.js';
import {createCloudflareAccountHost,type AccountStorage} from '../../apps/agent/src/cloudflare-host.ts';
import {HarnessLibrary,harnessBlobStore,harnessDigest,harnessLibraryAppendAllowed,harnessLibraryComponent,harnessLibraryEventKey,type HarnessContract,type HarnessArtifact} from '../../apps/agent/src/harness-library.ts';
import {HarnessExperiment,harnessExperimentState} from '../../apps/agent/src/harness-experiment.ts';
import {createHarnessSandboxBinding} from '../../apps/agent/src/harness-sandbox.ts';
import {localHarnessSandbox} from '../../apps/agent/src/harness-sandbox-local.ts';
import {sandboxEnvironment} from '../../apps/agent/src/sandbox-job-runner.ts';
import {sandboxJobJournal} from '../../apps/agent/src/sandbox-job-journal.ts';
import {sqliteWorkflowKV} from '../../apps/agent/src/workflow-store.ts';
const [mode,dir,nonce]=process.argv.slice(2),recovering=mode==='recover';assert(dir&&nonce&&['prepare','recover'].includes(mode));
const owner='321',thread='user-321',counts={requests:0,jobs:0,prepare:0,proposal:0,verifier:0};
const tick=(k:keyof typeof counts)=>{counts[k]++;assert(!recovering,'replay dispatched '+k);};
const db=new Database(join(dir,'native.sqlite')),privateDb=new Database(join(dir,'private.sqlite'));
const storage:AccountStorage={sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
let session='session-1',schema='schema-1';const http:any[]=[];
const server=recovering?undefined:Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){tick('requests');const u=new URL(req.url);http.push({path:u.pathname,query:Object.fromEntries(u.searchParams)});if(u.pathname==='/records'){const n=Number(u.searchParams.get('n'));return Response.json(schema==='schema-1'?{record:{id:n,display:'item-'+n},unwanted:'must-not-propagate'}:{renamed:{id:n,label:'item-'+n}});}assert.equal(u.pathname,'/echo');return Response.json(JSON.parse(u.searchParams.get('projection')!));}});
const saved=recovering?JSON.parse(readFileSync(join(dir,'prepare.json'),'utf8')):null;
const origin=server?.url.origin??saved.origin;if(recovering){session=saved.session;schema=saved.schema;}
const environment=await sandboxEnvironment('independent-network-composition-v1');
const sandbox=localHarnessSandbox({owner,environmentDigest:environment,journal:await sandboxJobJournal(privateDb,join(dir,'sandbox.key')),send:async(req,signal)=>{assert.equal(new URL(req.url).origin,origin);assert.equal(req.method,'GET');const r=await fetch(req.url,{method:'GET',signal,redirect:'manual'});return {status:r.status,headers:{'content-type':'application/json'},body:await r.json(),classification:'application'};}});
const bridge=createHarnessSandboxBinding({owner,thread,placement:'local',sandbox:{harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(job,s)=>{tick('jobs');return sandbox.harnessJob(job,s);}},current:async()=>({owner,active:true,runtimeDigest:environment,contextRef:schema,authorityRef:'controlled-read-only',sessionRevision:session,effects:['read'],origins:[origin],methods:['GET'],budget:{wallMs:5000,requests:4,outputBytes:32768}})});
const verifier={digest:harnessDigest('fixed-independent-projection-oracle-v1'),evaluatorDigest:harnessDigest('fixed-independent-projection-dataset-v1'),cases:[{id:'positive',split:'development',input:{n:7}},{id:'zero',split:'development',input:{n:0}},{id:'negative',split:'held-out',input:{n:-619}}],verify:async({input,output}:any)=>{tick('verifier');const passed=JSON.stringify(output)===JSON.stringify({identifier:input.n,label:'item-'+input.n});return {passed,quality:passed?1:0,evidence:['independent-exact-projection-'+passed]};}};
const verifiers=new Map([[verifier.digest,verifier]]);
const binding:any={owner,thread,blobs:harnessBlobStore(sqliteWorkflowKV(privateDb)),verifiers,guard:()=>{},authorizeEvaluation:async()=>true,...bridge};
const native=actor({name:'aiko',methods:{},components:[harnessLibraryComponent(owner)]});
const host=await createCloudflareAccountHost({storage,actorName:'aiko',actorInstance:'independent-network-'+nonce,ownsThread:t=>t===thread,actorFor:()=>native,layersFor:()=>Layer.empty,keyOf:harnessLibraryEventKey,canAppend:(_t,batch,read)=>harnessLibraryAppendAllowed(batch,read)});
const journal={read:()=>host.read(thread),append:async(events:any[])=>{for(const e of events)await host.commitRoot(host.self(thread),e);}};
const library=new HarnessLibrary(binding,journal),signal=AbortSignal.timeout(30000);
const contract:HarnessContract={version:1,outcome:'Read a record, project identifier and label locally, discard unrelated fields, and return exactly that transformed JSON through the read-only echo fixture',effect:'read',verifierDigest:verifier.digest,evaluatorDigest:verifier.evaluatorDigest,inputSchema:{type:'object',properties:{n:{type:'number'}},required:['n'],additionalProperties:false},outputSchema:{type:'object',properties:{identifier:{type:'number'},label:{type:'string'}},required:['identifier','label'],additionalProperties:false},applicability:{fixture:'independent-record-projection'},timeoutMs:5000};
const read=(id:string,dependsOn:string[]=[])=>({id,dependsOn,method:'GET',origin,path:'/records',pathParameters:{},query:{n:{kind:'input',name:'n'}},headers:{},expectedStatuses:[200]});
const transform={id:'transform',dependsOn:['read'],method:'GET',origin,path:'/echo',pathParameters:{},query:{projection:{kind:'object',fields:{identifier:{kind:'response_json',stepId:'read',pointer:'/record/id'},label:{kind:'response_json',stepId:'read',pointer:'/record/display'}}}},headers:{},expectedStatuses:[200]};
const graph={schemaVersion:2,executorAbi:'site-harness/1',siteId:'independent-records',version:'1',sourceCaptureDigest:harnessDigest('independent-record-fixture'),allowedOrigins:[origin],actions:[{id:'project',inputs:[{name:'n',type:'number',required:true}],steps:[read('redundant'),read('read',['redundant']),transform]}]};
const optimized=structuredClone(graph);optimized.actions[0].steps=[read('read'),transform];
const source=JSON.stringify({graph,actionId:'project'}),optimizedSource=JSON.stringify({graph:optimized,actionId:'project'});
const artifact:HarnessArtifact={version:1,name:'independent.record.project',description:contract.outcome,runtime:'network',entrypoint:'network.json',files:{'network.json':source},dependencies:[],contractDigest:harnessDigest(contract),sources:[{uri:'fixture:independent-records',revision:'v1',digest:harnessDigest(source),license:'fixture'}]};
const baseline=harnessDigest(artifact),candidate=harnessDigest({...artifact,files:{'network.json':optimizedSource}});
const regime={reset:'stateless',cache:'uncached',placement:'local',fixtures:'fixed-records-v1'};
const experiment=new HarnessExperiment({library:binding,regime,authorize:async()=>true,prepare:async()=>{tick('prepare');return {regimeDigest:harnessDigest(regime),evidence:['controlled-stateless-reset'],costUsd:null,measurements:{networkRequests:0,browserStarts:0,modelCalls:0,tokens:0}};},propose:async(input)=>{tick('proposal');assert(!JSON.stringify(input).includes('-619'));return {hypothesis:'Remove only the redundant record GET; preserve the local projection and echo sink',files:{'network.json':optimizedSource},tokens:0,costUsd:null};}},journal);
const request={id:'compose',baselineDigest:baseline,mutableFiles:['network.json'],repeats:2,policy:{version:1 as const,objectives:[{metric:'networkRequests' as const,direction:'min' as const,tolerance:0}],qualityTolerance:0},limits:{candidates:1,runs:12,wallMs:30000,proposalTokens:100,costUsd:10}};
try{
 let perturbations=saved?.perturbations;
 if(!recovering){
  await library.registerContract(contract);assert.equal(await library.record(artifact),baseline);await library.evaluate(baseline,'baseline',signal);await library.promote(baseline,'baseline',0,signal);
  await experiment.start(request,signal);for(let i=0;i<30;i++){const r=await experiment.advance('compose',signal);if(r.status!=='pending')break;}
  const finished=await experiment.status('compose');assert.equal(finished.status,'promoted');assert.equal(finished.trials,12);
  const comparison=await binding.blobs.get(owner,(finished.result as any).comparisonRef);assert.deepEqual(comparison.map((c:any)=>c.metrics.networkRequests.mean),[9,6]);
  const beforeRenew=counts.jobs;session='session-2';await assert.rejects(library.call(artifact.name,artifact.contractDigest,{n:19},'stale-session-call',signal));assert.equal(counts.jobs,beforeRenew);
  await library.evaluate(candidate,'renewed-session',signal);await library.promote(candidate,'renewed-session',0,signal);assert.equal((await library.call(artifact.name,artifact.contractDigest,{n:19},'renewed-call',signal)).status,'satisfied');
  schema='schema-2';const beforeDrift=counts.jobs;await assert.rejects(library.call(artifact.name,artifact.contractDigest,{n:19},'stale-schema-call',signal));assert.equal(counts.jobs,beforeDrift);
  const drift=await library.evaluate(candidate,'schema-drift',signal);assert.equal(drift.eligible,false);await assert.rejects(library.promote(candidate,'schema-drift',0,signal));
  perturbations={renewedSessionInvalidatedOldRoute:true,renewedSessionReverified:true,schemaDriftInvalidatedOldRoute:true,schemaDriftFailedRevalidation:true};
 }else await host.recover();
 const trace=await host.read(thread),projection={library:await library.list(),experiment:harnessExperimentState(trace,owner,'compose')};
 const state=harnessExperimentState(trace,owner,'compose');const comparison=await binding.blobs.get(owner,state.settled!.comparisonRef as string);
 const trialRows=trace.filter(e=>e.type==='AikoHarnessExperimentTrialSettled'&&e.experimentId==='compose');assert.equal(trialRows.length,12);assert.equal(new Set(trialRows.map(e=>e.id)).size,12);
 const trialWitnesses=trialRows.map(t=>{const w=trace.find(e=>e.type==='AikoHarnessChecked'&&e.id===t.id)?.witness as any;assert(w&&w.status==='satisfied');assert.equal(harnessDigest(w),t.witnessDigest);return w;});assert.equal(new Set(trialWitnesses.map(w=>w.contextDigest)).size,1);assert.equal(new Set(trialWitnesses.map(w=>w.evaluatorDigest)).size,1);assert.equal(new Set(trialWitnesses.map(w=>w.verifierDigest)).size,1);
 for(const w of trialWitnesses){const started=trace.find(e=>e.type==='AikoHarnessRunStarted'&&e.id===w.operationId)!;const c=verifier.cases.find(c=>c.id===started.caseId)!;assert.deepEqual(await binding.blobs.get(owner,w.outputRef),{identifier:c.input.n,label:'item-'+c.input.n});}
 const semantics={composedLocalProjection:true,baselineRequestsPerSweep:9,candidateRequestsPerSweep:6,distinctMatchedTrials:12,exactIndependentOutputs:true,renewedSession:true,schemaDriftRejected:true};
 const serial=JSON.parse(JSON.stringify(projection,(_k,v)=>v instanceof Map?[...v.entries()]:v));
 const out={nonce,pid:process.pid,origin,session,schema,counts,semantics,perturbations,projection:serial,comparison};
 writeFileSync(join(dir,mode+'.json'),JSON.stringify(out,null,2));writeFileSync(join(dir,mode+'-trace.json'),JSON.stringify(trace,null,2));
 if(!recovering)writeFileSync(join(dir,'http.json'),JSON.stringify(http,null,2));else{assert.notEqual(saved.pid,process.pid);assert(Object.values(counts).every(n=>n===0));assert.deepEqual(serial,saved.projection);assert.deepEqual(comparison,saved.comparison);assert.deepEqual(trace,JSON.parse(readFileSync(join(dir,'prepare-trace.json'),'utf8')));}
 console.log(JSON.stringify({mode,counts,perturbations}));
}finally{await host.close();await server?.stop(true);db.close();privateDb.close();}
