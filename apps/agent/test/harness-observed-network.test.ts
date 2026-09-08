import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedObservedActions } from "../src/capability-builder-network.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { HarnessRevisions } from "../src/harness-revisions.ts";
import { observedNetworkHarnessBinding, type ObservedNetworkHarnessOptions } from "../src/harness-observed-network.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
const dbs: Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
const signal=()=>AbortSignal.timeout(10000);
async function fixture(){
 const events:Event[]=[];let sequence=0,sends=0,active=true,session=true,revision="1",allow=true,evaluation=true,runAllowed=true,beforeSend:(()=>void)|undefined;
 const learning=new BrowserLearning({threadId:"user-owner",nextSequence:()=>++sequence,emit:async event=>{events.push(event);}});
 const entry={startedDateTime:new Date(1000).toISOString(),time:20,_observationComplete:true,request:{method:"GET",url:"https://api.vendor.com/double?n=3",headers:[],cookies:[{name:"sid",value:"PRIVATE_COOKIE_CANARY"}]},response:{status:200,headers:[],cookies:[],content:{mimeType:"application/json",size:12,text:'{"result":6}'}}};
 await learning.observe(entry,0,true);await learning.compile([entry],[{callId:"capture",action:"click",startedAtMs:999,endedAtMs:1050,direct:true,resultObserved:true}],"https://api.vendor.com");
 const source=ownedObservedActions(events).find(row=>row.effect==="read"&&row.sessionRequired)!;expect(source).toBeDefined();
 const action=source.artifact.actions[0]!,query=action.steps.at(-1)!.query.n!;
 if(query.kind!=="input")throw Error("Expected learned fresh input");
 const input=(n:number)=>Object.fromEntries(action.inputs.map(row=>[row.name,row.name===query.name?String(n):"double"]));
 const verifier:HarnessVerifier={digest:harnessDigest("independent-doubled-read"),evaluatorDigest:harnessDigest("fixed-observed-read-cases"),cases:[{id:"positive",split:"development",input:input(3)},{id:"negative",split:"held-out",input:input(-9)}],verify:async({input:params,output})=>({passed:(output as any).result===Number((params as any)[query.name])*2,evidence:["independent-doubled-value"],quality:null})};
 const contract:HarnessContract={version:1,outcome:"Double the supplied number",inputSchema:{type:"object",properties:Object.fromEntries(action.inputs.map(row=>[row.name,{type:row.type}])),required:action.inputs.filter(row=>row.required).map(row=>row.name),additionalProperties:false},outputSchema:{type:"object",properties:{result:{type:"number"}},required:["result"],additionalProperties:false},effect:"read",verifierDigest:verifier.digest,evaluatorDigest:verifier.evaluatorDigest,applicability:{observedRequest:{version:1,toolDigest:source.artifactDigest,effect:"read"}},timeoutMs:3000,transfer:{version:1,minimumNovelHeldOutInputs:1}};
 const db=new Database(":memory:");dbs.push(db);
 const journal={read:async()=>[...events],append:async(batch:Event[])=>{const fresh=batch.filter(event=>!events.some(old=>harnessLibraryEventKey(old)===harnessLibraryEventKey(event)));if(!harnessLibraryAppendAllowed(fresh,()=>events))throw Error("Native append denied");events.push(...structuredClone(fresh));}};
 const base:HarnessLibraryBinding={owner:"owner",thread:"user-owner",blobs:harnessBlobStore(sqliteWorkflowKV(db)),verifiers:new Map(),guard:value=>{if(JSON.stringify(value).includes("PRIVATE_COOKIE_CANARY"))throw Error("Private output denied");},context:async()=>({placement:"local",runtimeDigest:harnessDigest("runtime"),bindings:{}}),authorize:async()=>false,execute:async()=>{throw Error("No alternate executor");}};
 const requests:string[]=[];
 const options:ObservedNetworkHarnessOptions={binding:{owner:"owner",thread:"user-owner",redact:text=>text,readEvents:async()=>events,checkArcade:async()=>allow,session:async()=>session?{connectionId:"connected",revision,domains:["api.vendor.com"],cookies:[{name:"sid",value:"PRIVATE_COOKIE_CANARY",domain:"api.vendor.com",path:"/",secure:true,expires:-1,httpOnly:true,sameSite:"Lax",hostOnly:true}]}:undefined},definitions:[{contract,verifier}],current:()=>({active,revision:"policy-1"}),authorize:async(_artifact,_input,purpose)=>allow&&(purpose==="evaluation"?evaluation:runAllowed),send:async(request,_s,guard)=>{beforeSend?.();await guard();sends++;requests.push(request.url);expect(request.headers.cookie).toContain("sid=PRIVATE_COOKIE_CANARY");return {status:200,headers:{},classification:"application",body:{result:Number(new URL(request.url).searchParams.get("n"))*2}};}};
 const binding=observedNetworkHarnessBinding(base,options),library=new HarnessLibrary(binding,journal),revisions=new HarnessRevisions(library);
 const contractDigest=await library.registerContract(contract),candidate=await revisions.fromRequest(source.artifactDigest as any,"session.double",contractDigest,signal());
 if(candidate.status!=="candidate"||!candidate.digest)throw Error("Candidate missing");
 return {events,journal,binding,base,options,library,revisions,source,contract,contractDigest,digest:candidate.digest,input,requests,kv:sqliteWorkflowKV(db),sends:()=>sends,revoke:()=>active=false,sessionOff:()=>session=false,rotate:()=>revision="2",denyEdits:()=>allow=false,denyEvaluation:()=>evaluation=false,denyRuns:()=>runAllowed=false,atSend:(work:()=>void)=>beforeSend=work};
}

test("edited session-bound read evaluates independently, promotes, recalls fresh input and replays native receipt after restart",async()=>{
 const f=await fixture(),inspected=await f.revisions.inspect(f.digest,signal()),request=JSON.parse(inspected.artifact.files[inspected.artifact.entrypoint]!);
 request.graph.actions[0].steps.at(-1).query.authored={kind:"constant",value:"yes"};
 const candidate=await f.revisions.derive(f.digest,{files:{"request.json":JSON.stringify(request)},description:"Authored query revision"},signal());
 expect((await f.revisions.evaluate(candidate.digest,"fixed-evaluation",signal())).status).toBe("eligible");
 expect((await f.revisions.promote(candidate.digest,"fixed-evaluation",0,signal())).status).toBe("promoted");
 expect(f.sends()).toBe(2);expect(f.requests.every(url=>new URL(url).searchParams.get("authored")==="yes")).toBe(true);
 const restarted=new HarnessRevisions(new HarnessLibrary(observedNetworkHarnessBinding(f.base,f.options),f.journal));
 expect((await restarted.recall("session.double",f.contractDigest,f.input(12),signal())).status).toBe("available");expect(f.sends()).toBe(2);
 const witness=await restarted.library.run(candidate.digest,f.input(12),"fresh-request",signal());expect(witness.status).toBe("satisfied");expect(f.sends()).toBe(3);
 expect(await restarted.library.run(candidate.digest,f.input(12),"fresh-request",signal())).toEqual(witness);expect(f.sends()).toBe(3);
 expect(await f.binding.blobs.get("owner",witness.outputRef!)).toEqual({result:24});expect(JSON.stringify(f.events)).not.toContain("PRIVATE_COOKIE_CANARY");
 f.revoke();expect(await restarted.library.run(candidate.digest,f.input(12),"fresh-request",signal())).toEqual(witness);
 expect((await restarted.recall("session.double",f.contractDigest,f.input(13),signal())).status).toBe("unavailable");
});
test("missing current session and separate evaluation grant cannot dispatch or produce eligibility",async()=>{
 const f=await fixture();f.sessionOff();expect((await f.library.run(f.digest,f.input(4),"no-session",signal())).status).toBe("blocked");expect(f.sends()).toBe(0);
 const other=await fixture();other.denyEvaluation();await expect(other.revisions.evaluate(other.digest,"denied-fixtures",signal())).rejects.toThrow("Controlled fixture authorization");expect(other.sends()).toBe(0);
});
test("revised origin/write/credential expansion and lost source evidence are denied",async()=>{
 const f=await fixture(),original=await f.revisions.inspect(f.digest,signal());
 for(const mutate of [(r:any)=>r.graph.actions[0].steps[0].method="POST",(r:any)=>{r.graph.allowedOrigins.push("https://foreign.example");r.graph.actions[0].steps[0].origin="https://foreign.example";},(r:any)=>r.graph.actions[0].steps[0].headers.cookie={kind:"constant",value:"injected"}]){
 const request=JSON.parse(original.artifact.files[original.artifact.entrypoint]!);mutate(request);const candidate=await f.revisions.derive(f.digest,{files:{"request.json":JSON.stringify(request)}},signal());
 expect((await f.library.run(candidate.digest,f.input(4),crypto.randomUUID(),signal())).status).toBe("blocked");}
 expect(f.sends()).toBe(0);f.events.splice(0,f.events.length,...f.events.filter(e=>e.type!=="NetworkFactObserved"));await expect(f.library.resolve(f.digest)).rejects.toThrow("evidence unavailable");
});
test("evaluation grant revoked after initial admission prevents the actual fixture request",async()=>{
 const f=await fixture();f.atSend(f.denyEvaluation);
 await expect(f.revisions.evaluate(f.digest,"revoked-evaluation",signal())).rejects.toThrow("Controlled fixture authorization");expect(f.sends()).toBe(0);
 const prepared=await f.library.resolve(f.digest);
 await expect(f.binding.execute({owner:"owner",operationId:"not-a-case",caseId:"positive",artifactDigest:f.digest,artifact:prepared.artifact,contract:f.contract,context:await f.binding.context(signal()),input:f.input(99)},signal())).rejects.toThrow("authority unavailable");expect(f.sends()).toBe(0);
 expect((await f.library.run(f.digest,f.input(11),"ordinary-after-eval-revocation",signal())).status).toBe("satisfied");expect(f.sends()).toBe(1);
});
test("physical dispatch rechecks current session and revocation after asynchronous transport work",async()=>{
 for(const change of ["rotate","revoke"] as const){const f=await fixture();f.atSend(f[change]);const result=await f.library.run(f.digest,f.input(7),"raced",signal());expect(result.status).not.toBe("satisfied");expect(f.sends()).toBe(0);}
});
test("interrupted native operation and receipt reconciliation never send again",async()=>{
 const f=await fixture();f.atSend(()=>{throw Error("transport outcome missing");});const witness=await f.library.run(f.digest,f.input(8),"interrupted",signal());expect(witness.status).toBe("unknown");
 f.atSend(()=>{});expect(await f.library.run(f.digest,f.input(8),"interrupted",signal())).toEqual(witness);expect(f.sends()).toBe(0);
 const execution=await f.binding.reconcile!({owner:"owner",operationId:"interrupted",artifactDigest:f.digest,artifact:(await f.library.resolve(f.digest)).artifact,contract:f.contract,context:await f.binding.context(signal()),input:f.input(8)},signal());expect(execution.status).toBe("unknown");expect(f.sends()).toBe(0);
});

test("default registry mounts observed read execution only with explicit host binding",async()=>{
 const {defaultRegistryBinding}=await import("../src/registry-defaults.ts");
 const f=await fixture(),artifact=(await f.library.resolve(f.digest)).artifact;
 const options={owner:"owner",thread:"user-owner",kv:f.kv,policy:()=>({owner:"owner",active:true,revision:"registry-1"}),guard:f.base.guard,transport:{placement:"local" as const,sandbox:{harnessEnvironment:async()=>harnessDigest("runtime"),harnessJob:async()=>{throw Error("Network must use existing session transport");}},codeTransport:{run:async()=>{throw Error("No code request expected");}}}};
 const absent=defaultRegistryBinding(options as any).library!;
 await expect(absent.authorize(artifact,f.contract,await absent.context(signal()),f.input(2),signal())).rejects.toThrow("pure JavaScript");
 const mounted=defaultRegistryBinding({...options,observedReads:{...f.options,definitions:[{artifact,contract:f.contract,verifier:f.options.definitions[0]!.verifier}]}} as any).library!;
 const library=new HarnessLibrary(mounted,f.journal);
 expect((await library.run(f.digest,f.input(17),"mounted-session-read",signal())).status).toBe("satisfied");expect(f.sends()).toBe(1);
});


test("an independent evaluation grant does not authorize ordinary execution",async()=>{
 const f=await fixture();f.denyRuns();
 expect((await f.revisions.evaluate(f.digest,"evaluation-only",signal())).status).toBe("eligible");expect(f.sends()).toBe(2);
 expect((await f.revisions.promote(f.digest,"evaluation-only",0,signal())).status).toBe("unavailable");
 expect((await f.library.run(f.digest,f.input(15),"not-granted",signal())).status).toBe("blocked");expect(f.sends()).toBe(2);
});
