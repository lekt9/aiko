import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { Codegraff } from "../apps/agent/src/codegraff.ts";
import { loadConfig } from "../apps/agent/src/config.ts";

export type ProbeCleanup = {stopRequested:boolean;deleteRequested:boolean;stopped:boolean;deleted:boolean};
/** DELETE acceptance is asynchronous. Only a following missing-resource response
 * (or an explicit terminal deleted state) confirms that the disposable VM is gone. */
export async function cleanupProviderProbe(options:{
  gateway:Pick<Codegraff,"request">;id:string;deadline:number;result:ProbeCleanup;
  observe:(kind:string,state?:string)=>void;checkpoint:()=>Promise<void>;
  now?:()=>number;wait?:(ms:number)=>Promise<void>;
}):Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(options.id))throw Error("probe_identity_invalid");
  const now=options.now??Date.now,wait=options.wait??(ms=>delay(ms));
  const signal=()=>AbortSignal.timeout(Math.max(1,Math.min(8_000,options.deadline-now())));
  const record=async(kind:string,state?:string)=>{options.observe(kind,state);await options.checkpoint().catch(()=>{});};
  const path=`/v1/sandboxes/${options.id}`;
  if(now()<options.deadline){
    options.result.stopRequested=true;await record("cleanup_stop_requested");
    try{await options.gateway.request(`${path}/stop`,{},signal());await record("cleanup_stop_accepted");}
    catch{await record("cleanup_stop_unconfirmed");}
  }
  if(now()<options.deadline){
    options.result.deleteRequested=true;await record("cleanup_delete_requested");
    try{await options.gateway.request(path,undefined,signal(),"DELETE");await record("cleanup_delete_accepted");}
    catch{await record("cleanup_delete_unconfirmed");}
  }
  while(now()<options.deadline){
    try{
      const value=await options.gateway.request(path,undefined,signal());
      const state=String(value.state??value.status??"unknown").toLowerCase();
      if(/^(stopped|archived)$/.test(state))options.result.stopped=true;
      if(state==="deleted")options.result.deleted=true;
      await record("cleanup_state_read",/^[a-z_-]{1,40}$/.test(state)?state:"unknown");
    }catch(error){
      if(error instanceof Error&&error.message==="codegraff_http_404"){
        options.result.deleted=true;await record("cleanup_delete_confirmed");
      }else await record("cleanup_state_unconfirmed");
    }
    if(options.result.deleted)return;
    await wait(Math.min(1000,Math.max(0,options.deadline-now())));
  }
}

async function main() {
// Isolated provider semantics witness. Never selects an existing account VM or browser profile.
if (process.argv[2] !== "--run") throw Error("Use --run to allocate one disposable provider activity probe");
process.umask(0o077);
const config = await loadConfig(process.env,{readonly:true});
if (!config.modelKey) throw Error("CODEGRAFF_API_KEY is required in the existing private test configuration");
const gateway = new Codegraff(config.modelKey);
const startedAt = Date.now(), cancellation = new AbortController();
const main = AbortSignal.any([cancellation.signal,AbortSignal.timeout(160_000)]);
const interrupt = () => cancellation.abort();
process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
const evidencePath = `artifacts/browser-events/provider-activity-${startedAt}.json`;
const receipt: {
  version:1; startedAt:number; finishedAt?:number; sandbox?:string; requestedAutoStopMinutes:1;
  observations:{at:number;kind:string;state?:string}[];
  keptAliveBeyondIdleWindow:boolean; providerAutoStopObserved:boolean; cleanup:ProbeCleanup; failure?:string;
} = {version:1,startedAt,requestedAutoStopMinutes:1,observations:[],keptAliveBeyondIdleWindow:false,providerAutoStopObserved:false,cleanup:{stopRequested:false,deleteRequested:false,stopped:false,deleted:false}};
const checkpoint = async () => {
  await mkdir("artifacts/browser-events",{recursive:true,mode:0o700});
  await writeFile(`${evidencePath}.partial`,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
  await rename(`${evidencePath}.partial`,evidencePath);
};
const observe = (kind:string,state?:string) => {
  const item={at:Date.now(),kind,...(state?{state}:{})};receipt.observations.push(item);console.log(JSON.stringify(item));
};
const waitUntil = async (at:number) => {
  while(Date.now()<at)await delay(Math.min(45_000,at-Date.now()),undefined,{signal:main});
};
try {
  await checkpoint();
  const created = await gateway.request("/v1/sandboxes",{language:"javascript",autoStopMinutes:1},main);
  if(typeof created.id!=="string"||!/^[A-Za-z0-9_-]{1,120}$/.test(created.id))throw Error("probe_identity_missing");
  receipt.sandbox=created.id;observe("allocated");await checkpoint();
  const execute=async()=>{
    const result=await gateway.request(`/v1/sandboxes/${receipt.sandbox}/exec`,{
      command:"node -e 'process.stdout.write(\"watch-activity-probe\")'",
    },main);
    if(result.exitCode!==0||String(result.result??result.output??"").trim()!=="watch-activity-probe")throw Error("probe_exec_unconfirmed");
    observe("external_exec_completed");await checkpoint();
  };
  await execute();
  const firstActivity=receipt.observations.at(-1)!.at;
  await waitUntil(firstActivity+35_000);await execute();
  await waitUntil(firstActivity+65_000);await execute();
  receipt.keptAliveBeyondIdleWindow=Date.now()-firstActivity>=65_000;await checkpoint();
  // No exec or toolbox calls after this point. State reads are explicitly recorded.
  await waitUntil(firstActivity+140_000);
  for(let attempt=0;attempt<2;attempt++){
    const result=await gateway.request(`/v1/sandboxes/${receipt.sandbox}`,undefined,main);
    const state=String(result.state??result.status??"unknown").toLowerCase();
    observe("provider_state_read",/^[a-z_-]{1,40}$/.test(state)?state:"unknown");
    if(/^(stopped|archived)$/.test(state))receipt.providerAutoStopObserved=true;
    await checkpoint();
    if(receipt.providerAutoStopObserved)break;
    if(attempt===0)await waitUntil(firstActivity+152_000);
  }
  if(!receipt.providerAutoStopObserved)receipt.failure="provider_autostop_not_observed_within_bound";
} catch(error) {
  receipt.failure=error instanceof Error&&/^codegraff_http_\d{3}$/.test(error.message)?error.message:
    cancellation.signal.aborted?"probe_cancelled":main.aborted?"probe_deadline":"provider_probe_failed";
} finally {
  if(receipt.sandbox){
    await cleanupProviderProbe({gateway,id:receipt.sandbox,deadline:startedAt+179_000,result:receipt.cleanup,observe,checkpoint});
  }
  receipt.finishedAt=Date.now();
  process.off("SIGINT",interrupt);process.off("SIGTERM",interrupt);
  await checkpoint();
  console.log(JSON.stringify({completed:true,elapsedMs:receipt.finishedAt-startedAt,
    keptAliveBeyondIdleWindow:receipt.keptAliveBeyondIdleWindow,providerAutoStopObserved:receipt.providerAutoStopObserved,
    cleanup:receipt.cleanup,...(receipt.failure?{failure:receipt.failure}:{})}));
}
if(!receipt.keptAliveBeyondIdleWindow||!receipt.providerAutoStopObserved||!receipt.cleanup.deleted)process.exitCode=1;

}
if(import.meta.main)await main();
