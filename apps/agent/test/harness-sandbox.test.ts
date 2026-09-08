import {afterEach,expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect,Layer} from "effect";
import {actor,agentMessageMethod,codeMode,infer,Infer,outputValidateOnce} from "tardie";
import {component} from "tardie/core/component";
import type {Event} from "tardie/core/event";
import {createCloudflareAccountHost,type AccountStorage} from "../src/cloudflare-host.ts";
import {CodeHarness} from "../src/code-harness.ts";
import {runCodeSegment} from "../src/code-sandbox-runner.ts";
import {sqliteWorkflowKV} from "../src/workflow-store.ts";
import {HarnessLibrary,harnessBlobStore,harnessDigest,harnessLibraryEventKey,harnessLibraryTools,type HarnessArtifact,type HarnessContract,type HarnessLibraryBinding,type HarnessVerifier} from "../src/harness-library.ts";
import {createHarnessSandboxBinding,type HarnessSandboxAuthority} from "../src/harness-sandbox.ts";
import {localHarnessSandbox} from "../src/harness-sandbox-local.ts";
import {sandboxJobJournal} from "../src/sandbox-job-journal.ts";
import {sandboxEnvironment} from "../src/sandbox-job-runner.ts";

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const signal=()=>AbortSignal.timeout(15000);
async function fixture(send?:any,placement:"local"|"codegraff"="local") {
  const directory=await mkdtemp(join(tmpdir(),"harness-sandbox-"));
  const db=new Database(join(directory,"db.sqlite"));
  cleanups.push(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const runtimeDigest=await sandboxEnvironment("fixture-v1");
  const authority:HarnessSandboxAuthority={owner:"123",active:true,runtimeDigest,contextRef:"connection-v1",authorityRef:"read-grant-v1",sessionRevision:"session-v1",effects:["read"],origins:[],methods:["GET"],budget:{wallMs:5000,requests:4,outputBytes:32768}};
  const sandbox=localHarnessSandbox({owner:"123",environmentDigest:runtimeDigest,journal:await sandboxJobJournal(db,join(directory,"key")),...(send?{send}: {})});
  const receipts:any[]=[];
  const tracked={harnessEnvironment:sandbox.harnessEnvironment,harnessJob:async(job:any,signal?:AbortSignal)=>{const receipt=await sandbox.harnessJob(job,signal);receipts.push(receipt);return receipt;}};
  const bridge=createHarnessSandboxBinding({owner:"123",thread:"user-123",placement,sandbox:tracked,current:async()=>authority});
  const verifier:HarnessVerifier={digest:harnessDigest("independent-double-check"),evaluatorDigest:harnessDigest("double-cases-v1"),cases:[{id:"positive",input:{n:2},split:"development"},{id:"negative",input:{n:-13},split:"held-out"}],async verify({input,output}){return {passed:typeof output === "number" ? output === (input as any).n*2 : (output as any).value === (input as any).n*2 && (output as any).sequence>0,evidence:["trusted-double-check"],quality:1};}};
  const binding:HarnessLibraryBinding={owner:"123",thread:"user-123",blobs:harnessBlobStore(sqliteWorkflowKV(db)),verifiers:new Map([[verifier.digest,verifier]]),guard:()=>{},...bridge};
  const events:Event[]=[];
  const journal={read:async()=>[...events],append:async(batch:Event[])=>{for(const event of batch)if(!events.some(e=>harnessLibraryEventKey(e)===harnessLibraryEventKey(event)))events.push(structuredClone(event));}};
  const library=new HarnessLibrary(binding,journal);
  const contract:HarnessContract={version:1,outcome:"Double input using fresh execution",inputSchema:{type:"object",properties:{n:{type:"number"}},required:["n"],additionalProperties:false},outputSchema:{},effect:"read",verifierDigest:verifier.digest,evaluatorDigest:verifier.evaluatorDigest,applicability:{},timeoutMs:5000};
  const seed=async(files:Record<string,string>={"main.js":"return input.n*2;"},runtime:HarnessArtifact["runtime"]="javascript",dependencies:HarnessArtifact["dependencies"]=[])=>{
    const contractDigest=await library.registerContract(contract);
    const artifact:HarnessArtifact={version:1,name:"double",description:"Fixture doubling",runtime,entrypoint:Object.keys(files)[0]!,files,dependencies,sources:[{uri:"fixture:double",revision:"v1",digest:harnessDigest(files),license:"fixture"}],contractDigest};
    return {artifact,artifactDigest:await library.record(artifact)};
  };
  return {db,bridge,binding,library,events,authority,contract,seed,sandbox,receipts};
}

test("async body and pinned ESM modules run through real sandbox, including JSON scalar input",async()=>{
  const f=await fixture();
  const first=await f.seed({"main.js":"const value=await Promise.resolve(input.n*2); return value;"});
  expect((await f.library.run(first.artifactDigest,{n:9},"body",signal())).status).toBe("satisfied");
  const math="export const double=n=>n*2;";
  const esm=await f.seed({"main.js":'import {double} from "math.js"; export default input => double(input.n);',"math.js":math},"javascript",[{name:"math.js",digest:harnessDigest(math)}]);
  const witness=await f.library.run(esm.artifactDigest,{n:11},"modules",signal());
  expect(witness.status).toBe("satisfied");
  expect(f.receipts.at(-1).builtDigest).toMatch(/^sha256:/);
  const scalar=await f.seed({"main.js":"return input * 3;"});
  const result=await f.bridge.execute({owner:"123",operationId:"scalar",...scalar,contract:f.contract,context:await f.bridge.context(signal()),input:4},signal());
  expect(result.output).toBe(12);
  expect(result.evidence).toContain(`sandbox-operation:${f.receipts.at(-1).operationId}`);
  expect(JSON.stringify(result.evidence)).not.toContain(f.receipts.at(-1).outputDigest);
  expect(JSON.stringify(result.evidence)).not.toContain(f.receipts.at(-1).jobDigest);
});

test("current owner, session, runtime, revocation, candidate pins and Python are checked at execution",async()=>{
  const f=await fixture(),candidate=await f.seed();
  const context=await f.bridge.context(signal());
  const request={owner:"123",operationId:"guard",...candidate,contract:f.contract,context,input:{n:4}};
  for(const change of [{owner:"other"},{sessionRevision:"session-v2"},{runtimeDigest:harnessDigest("runtime-v2")},{active:false},{methods:["GET","POST"]}]){
    const old=structuredClone(f.authority);Object.assign(f.authority,change);
    await expect(f.bridge.execute(request,signal())).rejects.toThrow();
    Object.assign(f.authority,old);
  }
  await expect(f.bridge.execute({...request,owner:"other"},signal())).rejects.toThrow("owner/pin");
  await expect(f.bridge.execute({...request,artifact:{...candidate.artifact,files:{"main.js":"return 99"}}},signal())).rejects.toThrow("owner/pin");
  const python=await f.seed({"main.py":"print(8)"},"python");
  await expect(f.bridge.execute({...request,...python},signal())).rejects.toThrow("Python unavailable");
  expect(await f.bridge.authorize(python.artifact,f.contract,context,{n:4},signal())).toBe(false);
});

async function networkFixture() {
  let requests=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>Response.json({value:Number(new URL(request.url).searchParams.get("n"))*2,sequence:++requests})});
  cleanups.push(async()=>{await server.stop(true);});
  const origin=server.url.origin;
  const f=await fixture(async(request:any,signal:AbortSignal)=>{const response=await fetch(request.url,{signal,method:request.method,redirect:"manual"});return {status:response.status,headers:{"content-type":"application/json"},body:await response.json(),classification:"application"};});
  const graph={schemaVersion:2,executorAbi:"site-harness/1",siteId:"fixture",version:"1",sourceCaptureDigest:harnessDigest("capture"),allowedOrigins:[origin],actions:[{id:"double",inputs:[{name:"n",type:"number",required:true}],steps:[{id:"read",dependsOn:[],method:"GET",origin,path:"/double",pathParameters:{},query:{n:{kind:"input",name:"n"}},headers:{},expectedStatuses:[200]}]}]};
  const seed=()=>f.seed({"network.json":JSON.stringify({graph,actionId:"double"})},"network");
  return {...f,graph,seed,origin,requests:()=>requests};
}

test("candidate origins grant nothing, and read contracts cannot execute writes even with host write permission",async()=>{
  const f=await networkFixture();
  const candidate=await f.seed();
  expect((await f.library.run(candidate.artifactDigest,{n:2},"denied-origin",signal())).status).toBe("blocked");
  expect(f.requests()).toBe(0);
  f.authority.origins=[f.origin];f.authority.methods=["GET","POST"];
  f.graph.actions[0]!.steps[0]!.method="POST";
  const write=await f.seed();
  expect((await f.library.run(write.artifactDigest,{n:2},"denied-method",signal())).status).toBe("blocked");
  expect(f.requests()).toBe(0);
  f.graph.actions[0]!.steps[0]!.method="GET";
  const read=await f.seed();
  expect((await f.library.run(read.artifactDigest,{n:3},"allowed",signal())).status).toBe("satisfied");
  expect(f.requests()).toBe(1);
});

test("native codeMode evaluates, verifies, promotes, and performs a fresh network read through the sandbox",async()=>{
  const f=await networkFixture();f.authority.origins=[f.origin];
  const {artifactDigest}=await f.seed();
  const db=new Database(":memory:");cleanups.push(async()=>{db.close();});
  let alarm:number|null=null;
  const storage:AccountStorage={sql:{exec:(query,...args)=>{const rows=db.query(query).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;}};
  const harness=new CodeHarness("123","user-123",runCodeSegment,s=>s);
  const keys=component({name:"sandbox-library-keys",keys:{prefixes:["aiko-harness:"],keyOf:harnessLibraryEventKey},initial:()=>undefined,step:s=>s,output:()=>({view:undefined,transitions:[]})});
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[keys,infer([codeMode([harness.package(harnessLibraryTools(f.binding))]),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:(request:any)=>{
    const returned=request.trajectory.find((e:Event)=>e.type==="ToolReturned");
    if(!returned)return Effect.succeed({kind:"call" as const,name:"execute",callId:"pipeline",arguments:{code:`await tools.call({name:"harness_evaluate",arguments:{digest:"${artifactDigest}",evaluationId:"native-eval"}}); await tools.call({name:"harness_promote",arguments:{digest:"${artifactDigest}",evaluationId:"native-eval",expectedGeneration:0}}); return await tools.call({name:"harness_run",arguments:{digest:"${artifactDigest}",input:{n:17},operationId:"native-fresh"}});`}});
    expect(returned.result.result.status).toBe("satisfied");
    return Effect.succeed({kind:"complete" as const,output:"Verified fresh network result"});
  }});
  const host=await createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:"sandbox-library",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  for(const event of f.events)await host.commitRoot(host.self("user-123"),event);
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"turn",text:"Evaluate and use the network harness",at:1});
  await host.drive();
  const events=await host.read("user-123");
  expect(events.find(e=>e.type==="TurnCompleted")?.output).toBe("Verified fresh network result");
  expect(events.filter(e=>e.type==="AikoHarnessChecked")).toHaveLength(3);
  const promoted=events.find(e=>e.type==="AikoHarnessPromoted")!;
  expect(promoted.skillRef).toBeUndefined();
  expect((await f.library.skill(artifactDigest)).status).toBe("pending");
  const witness=events.find(e=>e.type==="AikoHarnessChecked"&&e.id==="native-fresh")!.witness as any;
  expect(await f.binding.blobs.get("123",witness.outputRef)).toEqual({value:34,sequence:3});
  expect(witness.evidence).toContain("trusted-double-check");
  expect(f.receipts.at(-1).outputDigest).toMatch(/^sha256:/);
  expect(f.receipts.every(r=>r.browserStarts===0)).toBe(true);
  await host.drive();expect(f.requests()).toBe(3);
});

test("Codegraff-shaped client verifies receipts and thread scopes do not alias",async()=>{
  const f=await fixture(undefined,"codegraff"),candidate=await f.seed();
  const context=await f.bridge.context(signal());
  expect(context.placement).toBe("codegraff");
  const request={owner:"123",operationId:"shared-name",...candidate,contract:f.contract,context,input:{n:6}};
  expect((await f.bridge.execute(request,signal())).output).toBe(12);
  const other=createHarnessSandboxBinding({owner:"123",thread:"user-other",placement:"codegraff",sandbox:f.sandbox,current:async()=>f.authority});
  expect((await other.execute({...request,input:{n:7}},signal())).output).toBe(14);
  const tampered=createHarnessSandboxBinding({owner:"123",thread:"user-tampered",placement:"codegraff",current:async()=>f.authority,sandbox:{harnessEnvironment:f.sandbox.harnessEnvironment,harnessJob:async(job,signal)=>({...await f.sandbox.harnessJob(job,signal),output:999})}});
  await expect(tampered.execute(request,signal())).rejects.toThrow("integrity");
});

test("dependency pin mismatch and malformed network entry are rejected without dispatch",async()=>{
  const f=await fixture();
  const candidate=await f.seed({"main.js":'import f from "dep.js"; export default f;',"dep.js":"export default input=>input.n*2;"},"javascript",[{name:"dep.js",digest:harnessDigest("wrong-source")}]);
  expect((await f.library.run(candidate.artifactDigest,{n:2},"bad-lock",signal())).status).toBe("blocked");
  const malformed=await f.seed({"network.json":"not json"},"network");
  expect((await f.library.run(malformed.artifactDigest,{n:2},"bad-network",signal())).status).toBe("blocked");
  expect(f.receipts).toHaveLength(0);
});

test("session change during dispatch does not release stale output to verification",async()=>{
  const f=await fixture(),candidate=await f.seed();
  const bridge=createHarnessSandboxBinding({owner:"123",thread:"session-fence",placement:"local",current:async()=>f.authority,sandbox:{harnessEnvironment:f.sandbox.harnessEnvironment,harnessJob:async(job,signal)=>{const receipt=await f.sandbox.harnessJob(job,signal);f.authority.sessionRevision="session-v2";return receipt;}}});
  const context=await bridge.context(signal());
  const result=await bridge.execute({owner:"123",operationId:"session-change",...candidate,contract:f.contract,context,input:{n:2}},signal());
  expect(result.status).toBe("unknown");
  expect(result.output).toBeUndefined();
  expect(result.evidence).toContain("sandbox-context-changed-after-dispatch");
});

test("Python mapping pins declared modules and hydrates assets only through trusted owner binding",async()=>{
 const {sandboxArtifactDependencies,sandboxDigest}=await import("../src/sandbox-job.ts");
 const f=await fixture();
 const lock=await sandboxDigest("controlled-isolated-runtime");
 Object.assign(f.authority,{pythonRuntimeLockDigest:lock,methods:[],origins:[],budget:{wallMs:60000,requests:0,outputBytes:262144}});
 const source="def twice(n): return n*2",seed=await f.seed({"main.py":"from helper import twice\ndef run(input): return twice(input['n'])","helper.py":source},"python",[{name:"helper.py",digest:harnessDigest(source)}]);
 let hydrated=0,dispatched=0;
 const data=Buffer.from([0,255,128]).toString("base64");
 const bridge=createHarnessSandboxBinding({owner:"123",thread:"user-123",placement:"local",current:async()=>f.authority,assets:async request=>{expect(request.owner).toBe("123");hydrated++;return {"owned.bin":{data,bytes:3,digest:await sandboxDigest(data)}};},sandbox:{pythonRuntimeLockDigest:lock,harnessEnvironment:async()=>f.authority.runtimeDigest,harnessJob:async job=>{
  dispatched++;expect(job.artifact.kind).toBe("python");expect(job.dependencyLock).toEqual(sandboxArtifactDependencies(job.artifact));expect(job.input).toEqual({n:7});expect(job.assets?.["owned.bin"]?.data).toBe(data);expect(job.authority).toEqual({origins:[],methods:[]});
  // Transport-shape fixture only; physical resource enforcement is covered by
  // sandbox-python.test.ts using the actual kernel supervisor.
  const resources={version:1 as const,backend:"cgroup-v2" as const,memoryPeakBytes:1,cpuUsec:1,processPeak:1,memoryLimitBytes:job.budget.memoryBytes??536870912,processLimit:job.budget.processes??32,scratchLimitBytes:job.budget.scratchBytes??67108864,oomKills:0,processLimitHits:0,cleaned:true};
  const output=14;return {operationId:job.operationId,jobDigest:await sandboxDigest(job),harnessDigest:job.harnessDigest,environmentDigest:job.environmentDigest,status:"completed",output,outputDigest:await sandboxDigest(output),requests:0,browserStarts:0,resources};
 }}});
 const context=await bridge.context(signal());
 const request={owner:"123",operationId:"python-mapping",...seed,contract:f.contract,context,input:{n:7}};
 expect(await bridge.execute(request,signal())).toMatchObject({status:"succeeded",output:14});expect(hydrated).toBe(1);expect(dispatched).toBe(1);
 f.authority.pythonRuntimeLockDigest=await sandboxDigest("changed-runtime-lock");
 await expect(bridge.execute(request,signal())).rejects.toThrow("context/session changed");expect(dispatched).toBe(1);
});
