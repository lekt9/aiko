import { cloudflareState, cloudflareOperatorConfig } from "./cloudflare-paths.ts";
/** Exercise the deployed Worker -> Codegraff -> encrypted R2 backup seam.
 * Uses only the existing canary account; retains the completed recovery point. */
import { mkdir, writeFile } from "node:fs/promises";
process.umask(0o077);
const state = await cloudflareState();
const config = await cloudflareOperatorConfig();
const base = state.AIKO_CLOUDFLARE_URL, owner = state.AIKO_E2E_OWNER;
if (!base?.startsWith("https://aiko-agent.") || owner !== "acct_cloudflare_e2e02") throw Error("Invalid canary binding");
const call = async (path:string,token:string,method="GET") => fetch(`${base}/api/control/${path}?account=${owner}`,{method,headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(300_000)});
if ((await call("backups",state.AIKO_E2E_TOKEN!)).status !== 403) throw Error("Account credential can access operator backups");
const response = await call("backup",config.operatorToken,"POST");
const result = await response.json() as {id?:string;status?:string;files?:number;error?:string};
if (response.status !== 201 || result.status !== "verified" || !result.id) throw Error(`Deployed backup failed: HTTP ${response.status}, ${result.error ?? "invalid_receipt"}`);
const listed = await call("backups",config.operatorToken);
const records = await listed.json() as {backups?:{id:string}[]};
if(!listed.ok || !records.backups?.some(record=>record.id===result.id)) throw Error("Verified backup registry readback missing");
await mkdir("artifacts/backups",{recursive:true});
await writeFile("artifacts/backups/deployed.json",JSON.stringify({at:new Date().toISOString(),owner,id:result.id,files:result.files,verified:true,scope:"deployed-worker-codegraff-r2-backup",operatorOnly:true,messagesSent:0},null,2));
console.log(JSON.stringify({verified:true,id:result.id,files:result.files}));
