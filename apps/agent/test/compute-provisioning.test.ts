import {expect,test} from "bun:test";
import {ProvisionedComputeHarness,trustedCodegraffMediaRecipe,type ComputeSetupReport} from "../src/compute-harness.ts";
import {Codegraff} from "../src/codegraff.ts";
import {sandboxDigest} from "../src/sandbox-job.ts";
import type {WorkflowKV} from "../src/workflow-host.ts";
async function fixture(){
 const rows=new Map<string,unknown>(),files=new Map<string,string>();let allocations=0,installs=0,missing=false,corrupt=false,loseAck=false,failed=false,runtimeMissing=false;
 const kv:WorkflowKV={get:async k=>structuredClone(rows.get(k)),put:async(k,v)=>{rows.set(k,structuredClone(v));},claim:async(k,v)=>{if(rows.has(k))return false;rows.set(k,structuredClone(v));return true;},update:async(k,fn)=>{rows.set(k,fn(rows.get(k)));},list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([,v])=>v)};
 const recipe=trustedCodegraffMediaRecipe("a==1 --hash=sha256:"+"a".repeat(64),{repository:"fixture/model",revision:"a".repeat(40),files:{"model.bin":{sha256:"a".repeat(64),bytes:1}}}),bundle="trusted setup bundle";
 const gateway=new Codegraff("fixture-private-key",async(url,init)=>{
  const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
  if(path==="/v1/sandboxes"){allocations++;return Response.json({id:"setup-vm"});}
  if(path.endsWith("/upload")){files.set(body.path,Buffer.from(body.contentBase64,"base64").toString());return Response.json({});}
    if (path.endsWith("/exec") && body.command.startsWith("bash /tmp/aiko-compute-cloak-")) return Response.json({execId:"cloak-setup"});
    if (path.includes("/exec/cloak-setup")) return Response.json({state:"completed",exitCode:0});
  if(path.endsWith("/exec")){
   const args=body.command.split(" ");
   if(args.includes("environment")) {
    const config=JSON.parse(files.get(args[args.indexOf("--config")+1])!);
    const value=runtimeMissing ? {ready:false,reason:"runtime-missing",runtimeLockDigest:config.runtimeLockDigest} : {runtimeLockDigest:config.runtimeLockDigest,environmentDigest:await sandboxDigest({abi:"unlock-compute-runner/1",runnerBundle:bundle,runtimeLockDigest:config.runtimeLockDigest,bunVersion:"1.4.0"})};
    files.set(args.at(-1)!,JSON.stringify(value));return Response.json({execId:"environment-exec"});
   }
   installs++;expect(body.async).toBe(true);expect(args[2]).toBe("setup");
   const lock={fixed:"runtime",generation:installs};
   const report:ComputeSetupReport={version:1,ready:true,bunVersion:"1.4.0",recipeDigest:await sandboxDigest(corrupt?{}:JSON.parse(files.get(args[3])!)),runnerDigest:await sandboxDigest(files.get(args[1])),runtimeLockDigest:await sandboxDigest(lock),lock,environmentDigest:await sandboxDigest({abi:"unlock-compute-runner/1",runnerBundle:bundle,runtimeLockDigest:await sandboxDigest(lock),bunVersion:"1.4.0"}),runtime:{python:"/usr/bin/python3"},cgroupRoot:"/sys/fs/cgroup/aiko-compute-fixture"};
   if(failed){report.ready=false;report.reason="isolation-probe";}
   if(!missing)files.set(args[4],JSON.stringify(report));
   if(loseAck)throw Error("lost ack");return Response.json({execId:"setup-exec"});
  }
  if(path.endsWith("/download"))return Response.json({contentBase64:Buffer.from(files.get(body.path)??JSON.stringify({statusCode:404,source:"DAYTONA_DAEMON",code:"FILE_NOT_FOUND"})).toString("base64")});
  if(path.includes("/exec/environment-exec"))return Response.json({state:"completed",exitCode:0});
  if(path.includes("/exec/"))return Response.json({state:"completed",exitCode:1,output:"diagnostic tail is not a setup report"});
  return Response.json({state:"running"});
 });
 const client=()=>new ProvisionedComputeHarness("123",gateway,kv,bundle,recipe);
 return {rows,files,client,kv,missingRuntime:(v:boolean)=>{runtimeMissing=v;},counts:()=>({allocations,installs}),settings:(v:{missing?:boolean;corrupt?:boolean;loseAck?:boolean;failed?:boolean})=>{failed=v.failed??failed;missing=v.missing??missing;corrupt=v.corrupt??corrupt;loseAck=v.loseAck??loseAck;}};
}
test("trusted setup is inert until called and recovers retained attestation without reinstalling",async()=>{
 const f=await fixture(),client=f.client();expect(f.rows.size).toBe(0);expect(client.pythonRuntimeLockDigest).toBeUndefined();
 const report=await client.configuration(AbortSignal.timeout(5000));expect(report.ready).toBe(true);expect(client.pythonRuntimeLockDigest).toBe(report.runtimeLockDigest);
 f.files.clear();expect(await f.client().configuration(AbortSignal.timeout(5000))).toEqual(report);expect(f.counts()).toEqual({allocations:1,installs:1});
});
test("lost setup acknowledgement recovers report; daemon missing-file envelopes never claim readiness",async()=>{
 const f=await fixture();f.settings({loseAck:true});expect((await f.client().configuration(AbortSignal.timeout(5000))).ready).toBe(true);expect(f.counts().installs).toBe(1);
 const unavailable=await fixture();unavailable.settings({missing:true});await expect(unavailable.client().configuration(AbortSignal.timeout(5000))).rejects.toThrow("no automatic reinstall");await expect(unavailable.client().configuration(AbortSignal.timeout(5000))).rejects.toThrow("no automatic reinstall");expect(unavailable.counts()).toEqual({allocations:1,installs:1});
});
test("foreign recipe attestation cannot enable a runtime",async()=>{const f=await fixture();f.settings({corrupt:true});await expect(f.client().configuration(AbortSignal.timeout(5000))).rejects.toThrow("attestation mismatch");});

test("failed isolation report stays unavailable after reopen without another install",async()=>{
 const f=await fixture();f.settings({failed:true});
 await expect(f.client().configuration(AbortSignal.timeout(5000))).rejects.toThrow("Compute runtime unavailable: isolation-probe");
 await expect(f.client().configuration(AbortSignal.timeout(5000))).rejects.toThrow("Compute runtime unavailable: isolation-probe");
 expect(f.counts()).toEqual({allocations:1,installs:1});
});

test("multilingual setup pins coexist with English and reject malformed model grants before allocation",async()=>{
 const english=(await import('../assets/media-model.lock.json')).default;
 const multilingual=(await import('../assets/media-multilingual-model.lock.json')).default;
 const requirements=await Bun.file(new URL('../assets/media-requirements.lock',import.meta.url)).text();
 const recipe=trustedCodegraffMediaRecipe(requirements,english.model,multilingual.model);
 expect(recipe.model).toEqual(english.model);expect(recipe.models?.['whisper-tiny']).toEqual(multilingual.model);
 expect(await sandboxDigest(recipe)).not.toBe(await sandboxDigest(trustedCodegraffMediaRecipe(requirements,english.model)));
 const {createHash}=await import('node:crypto');expect(createHash('sha256').update(requirements).digest('hex')).toBe(multilingual.runtimeDependenciesSha256);
 let requests=0;const kv:WorkflowKV={get:async()=>undefined,put:async()=>{},claim:async()=>true,update:async()=>{},list:async()=>[]};
 const gateway=new Codegraff('never-sent',async()=>{requests++;throw Error('No allocation during assembly');});
 expect(()=>new ProvisionedComputeHarness('123',gateway,kv,'bundle',{...recipe,models:{'../foreign':multilingual.model}})).toThrow('additional model');
 expect(()=>new ProvisionedComputeHarness('123',gateway,kv,'bundle',{...recipe,models:{'whisper-tiny':{...multilingual.model,files:{...multilingual.model.files,'model.bin':{sha256:'bad',bytes:1}}}}})).toThrow('model file');
 const client=new ProvisionedComputeHarness('123',gateway,kv,'bundle',recipe);const cancelled=new AbortController();cancelled.abort();await expect(client.configuration(cancelled.signal)).rejects.toThrow();expect(requests).toBe(0);
});


test("definite runtime miss repairs on retained VM with new setup identity, durable activation and scoped authority",async()=>{
 const {DefiniteComputeRuntimeFailure}=await import('../src/compute-runtime-recovery.ts');
 const f=await fixture(), original=await f.client().configuration(AbortSignal.timeout(5000));
 f.missingRuntime(true);
 let failure:any;
 try {await f.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(DefiniteComputeRuntimeFailure);
 const request={owner:"123",operationId:"media-repair:fixture",failureRef:failure.failureRef,grant:"configured-read-runtime",deadline:Date.now()+10000};
 const count=f.counts();
 await expect(f.client().repairRuntime({...request,owner:"999"},AbortSignal.timeout(5000),async()=>true)).rejects.toThrow("authority");
 await expect(f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>false)).rejects.toThrow("authority");
 expect(f.counts()).toEqual(count);
 f.missingRuntime(false);
 const repaired=await f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>true);
 expect(repaired.status).toBe("ready");expect(repaired.runtimeLockDigest).not.toBe(original.runtimeLockDigest);
 expect(f.counts()).toEqual({allocations:1,installs:2});
 const reopened=f.client();expect((await reopened.configuration(AbortSignal.timeout(5000))).runtimeLockDigest).toBe(repaired.runtimeLockDigest);
 expect(await reopened.repairRuntime(request,AbortSignal.timeout(5000),async()=>true)).toEqual(repaired);
 expect(f.counts()).toEqual({allocations:1,installs:2});
 await expect(f.client().repairRuntime({...request,grant:"changed"},AbortSignal.timeout(5000),async()=>true)).rejects.toThrow("identity");
 expect([...f.files.keys()].filter(k=>k.endsWith('.recipe.json'))).toHaveLength(2);
});

test("repair restart after setup report but before activation reuses known build; lost report cannot reinstall",async()=>{
 const f=await fixture();await f.client().configuration(AbortSignal.timeout(5000));f.missingRuntime(true);
 let failure:any;try{await f.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){failure=error;}
 const request={owner:"123",operationId:"repair-restart",failureRef:failure.failureRef,grant:"grant",deadline:Date.now()+20000};
 f.missingRuntime(false);
 const put=f.kv.put;let interrupt=true;
 f.kv.put=async(k,v)=>{if(k.includes(':active:')&&interrupt)throw Error('controlled process loss before activation');return put(k,v);};
 await expect(f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('process loss');
 expect(f.counts().installs).toBe(2);interrupt=false;
 expect((await f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>true)).status).toBe('ready');
 expect(f.counts().installs).toBe(2);
 const unknown=await fixture();await unknown.client().configuration(AbortSignal.timeout(5000));unknown.missingRuntime(true);
 let missing:any;try{await unknown.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){missing=error;}
 unknown.settings({missing:true});
 const r={...request,failureRef:missing.failureRef,operationId:'repair-unknown'};
 await expect(unknown.client().repairRuntime(r,AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('no automatic reinstall');
 await expect(unknown.client().repairRuntime(r,AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('no automatic reinstall');
 expect(unknown.counts()).toEqual({allocations:1,installs:2});
});

test('retained repair deadline cannot renew after restart and revoked build cannot activate',async()=>{
 const f=await fixture();await f.client().configuration(AbortSignal.timeout(5000));f.missingRuntime(true);
 let failure:any;try{await f.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){failure=error;}
 const request={owner:'123',operationId:'deadline-repair',failureRef:failure.failureRef,grant:'grant',deadline:Date.now()+20000};
 f.missingRuntime(false);const put=f.kv.put;
 f.kv.put=async(k,v)=>{if(k.includes(':active:'))throw Error('interrupt activation');await put(k,v);};
 await expect(f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('interrupt');
 for(const [k,v]of f.rows)if(k.includes(':setup:')&&(v as any)?.deadline)await put(k,{...(v as object),deadline:Date.now()-1});
 f.kv.put=put;
 await expect(f.client().repairRuntime(request,AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('budget expired');
 expect(f.counts()).toEqual({allocations:1,installs:2});
 expect([...f.rows.keys()].some(k=>k.includes(':active:'))).toBe(false);
 const revoked=await fixture();await revoked.client().configuration(AbortSignal.timeout(5000));revoked.missingRuntime(true);
 let denied:any;try{await revoked.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){denied=error;}
 await expect(revoked.client().repairRuntime({...request,failureRef:denied.failureRef},AbortSignal.timeout(5000),async()=>revoked.counts().installs<2)).rejects.toThrow('authority');
 expect([...revoked.rows.keys()].some(k=>k.includes(':active:'))).toBe(false);
 expect(revoked.counts()).toEqual({allocations:1,installs:2});
});

test('machine custody disappearing at repair dispatch cannot fall through to VM allocation',async()=>{
 const f=await fixture();await f.client().configuration(AbortSignal.timeout(5000));f.missingRuntime(true);
 let failure:any;try{await f.client().harnessEnvironment(AbortSignal.timeout(5000));}catch(error){failure=error;}
 const get=f.kv.get;let reads=0;
 f.kv.get=async key=>key.endsWith(':codegraff:compute')&&++reads>=3?undefined:get(key);
 await expect(f.client().repairRuntime({owner:'123',operationId:'vanishing-machine',failureRef:failure.failureRef,grant:'grant',deadline:Date.now()+10000},AbortSignal.timeout(5000),async()=>true)).rejects.toThrow('no allocation');
 expect(f.counts()).toEqual({allocations:1,installs:1});
});
