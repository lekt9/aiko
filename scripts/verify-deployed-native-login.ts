import { cloudflareState, cloudflareOperatorConfig } from "./cloudflare-paths.ts";
/** End-to-end deployment witness against the isolated public canary site.
 * Only synthetic credentials are submitted; no third-party login is exercised. */
import { mkdir, writeFile } from "node:fs/promises";
process.umask(0o077);
const state=await cloudflareState();
const config=await cloudflareOperatorConfig();
const owner=state.AIKO_E2E_OWNER,base=state.AIKO_CLOUDFLARE_URL;
const domain="unlock-login-canary.lewis-6d8.workers.dev";
if(owner!=="acct_cloudflare_e2e02")throw Error("Invalid canary account");
async function request(path:string,body?:object,operator=false) {
 const response=await fetch(base+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${operator?config.operatorToken:state.AIKO_E2E_TOKEN}`,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(240_000)});
 const value=await response.json();
 if(!response.ok)throw Error(`Canary operation failed: ${path.split("?")[0]}, HTTP ${response.status}`);
 return value as any;
}
const previous=process.argv.includes("--resume")?await Bun.file("artifacts/connectors/deployed-native-login.json").json():undefined;
const connection=previous?{id:previous.connectionId,nativeInline:true}:await request("/api/connectors/browser",{domain});
if(connection.nativeInline!==true)throw Error("Native Mini App capability missing");
console.log(JSON.stringify({phase:"connection",id:connection.id}));
const view=previous?await request("/api/connectors/complete",{connectionId:connection.id}):await request("/api/connectors/native",{connectionId:connection.id,action:"login",username:"fixture-user",password:"fixture-password"});
if(view.status!=="connected" || (!previous && view.credentialsSaved!==true))throw Error(`Login did not verify and save credentials: ${view.status}`);
console.log(JSON.stringify({phase:"verified-login",revision:view.revision}));
await mkdir("artifacts/connectors",{recursive:true});
const receipt={at:new Date().toISOString(),owner,domain,connectionId:connection.id,revision:view.revision,verified:true,credentialsSaved:true,scope:"deployed-worker-codegraff-native-login",syntheticCredentials:true};
if(!previous)await writeFile("artifacts/connectors/deployed-native-login.json",JSON.stringify(receipt,null,2));
const indexed=new Set<string>();
for(let attempt=0;attempt<40;attempt++) {
 let after=0;const rows:any[]=[];
 for(;;) {
  const page=await request(`/api/control/events?thread=background-${owner}-indexer&after=${after}&limit=100`,undefined,true);
  rows.push(...page.events.map((row:any)=>row.event));
  if(!page.hasMore)break;
  if(page.nextAfter<=after)throw Error("Invalid event cursor");after=page.nextAfter;
 }
 const jobs=new Set(rows.filter(e=>e.type==="AikoConnectionIndexRequested"&&e.connectionId===connection.id).map(e=>e.id));
 const pages=rows.filter(e=>e.type==="AikoLearningIndexed"&&jobs.has(e.id)&&typeof e.url==="string");
 const revision=Math.max(0,...pages.map(e=>e.revision??0));indexed.clear();
 for(const e of pages)if(e.revision===revision)indexed.add(e.url);
 if(indexed.size>=3) {
  await writeFile("artifacts/connectors/deployed-native-index.json",JSON.stringify({...receipt,revision,routes:[...indexed],scope:"deployed-login-to-durable-route-index",verified:true},null,2));
  console.log(JSON.stringify({phase:"indexed",routes:[...indexed]}));process.exit(0);
 }
 const failed=rows.find(e=>e.type==="AikoBackgroundFailed"&&jobs.has(e.id));
 if(failed)throw Error(`Canary route index failed: ${failed.errorCode??failed.error??failed.reason??"unknown"}`);
 await Bun.sleep(5000);
}
throw Error(`Incomplete canary route index: ${indexed.size}/3`);
