import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {Codegraff} from "../src/codegraff.ts";
import {SandboxCompute,type ComputeStore} from "../src/sandbox-compute.ts";

function fixture() {
  const owner="owner",thread="worker",jobId=createHash("sha256").update(JSON.stringify([owner,thread,"coding:original"])).digest("hex");
  const key=`codegraff:compute-job:${jobId}`;
  const rows=new Map<string,any>([[key,{owner,thread,jobId,sandboxId:"owned-machine",execId:"original-exec",commandDigest:"original-command",state:"running"}]]);
  let writes=0;
  const store:ComputeStore={get:async<T>(key:string)=>structuredClone(rows.get(key)) as T,put:async(key,value)=>{writes++;rows.set(key,structuredClone(value));}};
  const calls:{path:string;method:string}[]=[];
  let response:any={state:"running",output:"PRIVATE_OUTPUT"},duringRead:(()=>void)|undefined;
  const gateway=new Codegraff("private-gateway-key",async(url,init)=>{
    const target=new URL(String(url));calls.push({path:target.pathname+target.search,method:init?.method??"GET"});
    if(init?.method==="DELETE")return Response.json({ok:true});
    duringRead?.();return Response.json(response);
  });
  return {owner,thread,jobId,key,rows,store,gateway,calls,compute:new SandboxCompute(owner,gateway,store),writes:()=>writes,
    reply:(value:any)=>{response=value;},during:(callback:()=>void)=>{duringRead=callback;}};
}
const signal=()=>AbortSignal.timeout(5000);

test("fresh terminal observation follows cancelled acknowledgement through running to actual completion without state changes or redispatch",async()=>{
  const f=fixture();
  expect(await f.compute.poll(f.thread,f.jobId,signal(),true)).toMatchObject({state:"cancelled"});
  const snapshot=structuredClone(f.rows.get(f.key)),writes=f.writes();
  expect(await f.compute.confirmTerminal(f.thread,f.jobId,signal())).toEqual({jobId:f.jobId,state:"running"});
  expect(await f.compute.poll(f.thread,f.jobId,signal())).toEqual({jobId:f.jobId,state:"cancelled"});
  f.reply({state:"completed",exitCode:137,output:"PRIVATE_OUTPUT"});
  const restarted=new SandboxCompute(f.owner,f.gateway,f.store);
  expect(await restarted.confirmTerminal(f.thread,f.jobId,signal())).toEqual({jobId:f.jobId,state:"completed",exitCode:137});
  expect(f.rows.get(f.key)).toEqual(snapshot);expect(f.writes()).toBe(writes);
  expect(f.calls).toEqual([
    {method:"DELETE",path:"/v1/sandboxes/owned-machine/exec/original-exec"},
    {method:"GET",path:"/v1/sandboxes/owned-machine/exec/original-exec?tail=32768"},
    {method:"GET",path:"/v1/sandboxes/owned-machine/exec/original-exec?tail=32768"},
  ]);
});

test("terminal observation rejects foreign or lost mapping, malformed completion, in-flight remapping and cancellation",async()=>{
  const f=fixture();
  await expect(f.compute.confirmTerminal("foreign",f.jobId,signal())).rejects.toThrow("account/thread");
  await expect(new SandboxCompute("foreign",f.gateway,f.store).confirmTerminal(f.thread,f.jobId,signal())).rejects.toThrow("account/thread");
  await expect(f.compute.confirmTerminal(f.thread,"../exec",signal())).rejects.toThrow("reference");
  expect(f.calls).toHaveLength(0);
  const job=structuredClone(f.rows.get(f.key));delete f.rows.get(f.key).execId;
  expect(await f.compute.confirmTerminal(f.thread,f.jobId,signal())).toEqual({jobId:f.jobId,state:"unknown"});expect(f.calls).toHaveLength(0);
  f.rows.set(f.key,job);
  for(const response of [{state:"cancelled"},{state:"completed"},{state:"completed",exitCode:"0"},{state:"completed",exitCode:0.5}]) {
    f.reply(response);await expect(f.compute.confirmTerminal(f.thread,f.jobId,signal())).rejects.toThrow("completion and an exit code");
  }
  f.reply({state:"completed",exitCode:0});f.during(()=>{f.rows.get(f.key).execId="replacement";});
  await expect(f.compute.confirmTerminal(f.thread,f.jobId,signal())).rejects.toThrow("mapping changed");
  f.rows.set(f.key,job);const aborted=new AbortController();f.during(()=>aborted.abort());
  await expect(f.compute.confirmTerminal(f.thread,f.jobId,aborted.signal)).rejects.toThrow();
  expect(f.writes()).toBe(0);expect(f.calls.every(call=>call.method==="GET")).toBe(true);
});
