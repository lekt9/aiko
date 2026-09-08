import { cloudflareState } from "./cloudflare-paths.ts";
/** Download the deployed canary snapshot and recover it into an empty private
 * local directory with the production decrypt/verify/publish implementation. */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { CloudBackups } from "../apps/agent/src/cloud-backup.ts";
import { writeVmRestore, verifyVmRestore, publishVmRestore } from "../apps/agent/src/vm-backup.ts";
import { NativeLoginVault, nativeLoginCipher } from "../apps/agent/src/native-login-vault.ts";
process.umask(0o077);
const state=await cloudflareState();
const receipt=await Bun.file("artifacts/backups/deployed.json").json();
if(receipt.owner!==state.AIKO_E2E_OWNER || receipt.verified!==true) throw Error("Canary backup receipt missing");
const directory=await mkdtemp("/tmp/unlock-deployed-recovery-");
let sequence=0;
const backups=new CloudBackups({
  put:async()=>{throw Error("Read-only recovery check");},
  delete:async()=>{throw Error("Read-only recovery check");},
  get:async(key)=>{
    const path=`${directory}/ciphertext-${++sequence}`;
    const child=Bun.spawn(["pnpm","--filter","@unlock/agent","exec","wrangler","r2","object","get",`aiko-state-backups/${key}`,"--file",path,"--remote"],{stdout:"pipe",stderr:"pipe"});
    const [code]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0)throw Error("Recovery download failed");
    const bytes=await readFile(path);await rm(path);
    return {arrayBuffer:async()=>new Uint8Array(bytes).buffer};
  },
},state.AIKO_BACKUP_KEY!);
const staged=crypto.randomUUID();
let account:Uint8Array,verified=false,verifiedCredentialsRecovered=false;
try {
 const manifest=await backups.manifest(receipt.owner,receipt.id);
 const size=manifest.files.find(file=>file.path==="account.json")?.bytes;
 if(size===undefined || size>64*1024*1024)throw Error("Account archive unavailable");
 account=new Uint8Array(size);
 await writeFile(`${directory}/owner.json`,JSON.stringify({owner:receipt.owner}),{mode:0o600});
 await backups.restore(receipt.owner,receipt.id,{
  write:async(path,offset,bytes)=>{if(path==="account.json")account.set(bytes,offset);else await writeVmRestore(directory,staged,path,offset,Buffer.from(bytes).toString("base64"));},
  abort:async()=>{},
  commit:async(manifest)=>{
   const archive=JSON.parse(new TextDecoder().decode(account));
   if(archive.owner!==receipt.owner || !Array.isArray(archive.threads) || !Array.isArray(archive.state))throw Error("Account recovery mismatch");
   await verifyVmRestore(directory,staged,receipt.owner,manifest.files.filter(file=>file.path!=="account.json"));
   const browser=`${directory}/backups/${staged}/browser`;
   const evidence=new Database(`${browser}/request-evidence.sqlite`);
   try {
    const saved=(evidence.query("SELECT state FROM native_login").all() as {state:string}[]).map(row=>JSON.parse(row.state)).find(state=>state.domain==="unlock-login-canary.lewis-6d8.workers.dev"&&state.status==="connected");
    if(!saved)throw Error("Verified synthetic login missing from backup");
    const vault=new NativeLoginVault(evidence,receipt.owner,nativeLoginCipher(browser,evidence));
    try {verifiedCredentialsRecovered=await vault.renew(saved,async credentials=>credentials.username==="fixture-user"&&credentials.password==="fixture-password")===true;} finally {vault.close();}
    if(!verifiedCredentialsRecovered)throw Error("Backed-up synthetic credentials did not decrypt");
   } finally {evidence.close();}
   // This isolated verification grants no login access. It tests the same
   // revocation filtering used when the live account has no matching grant.
   await publishVmRestore(directory,staged,receipt.owner,[]);
   for(const file of manifest.files.filter(file=>file.path.startsWith("browser/")&&file.path.endsWith(".sqlite"))) {
    const db=new Database(`${directory}/${file.path}`,{readonly:true});
    try {
     if((db.query("PRAGMA integrity_check").get() as any).integrity_check!=="ok")throw Error("Recovered SQLite integrity failed");
     if(file.path.endsWith("request-evidence.sqlite")&&(db.query("SELECT COUNT(*) AS n FROM native_vault").get() as any).n!==0)throw Error("Recovery retained an ungranted credential");
    } finally {db.close();}
   }
   verified=true;
  },
 });
 await writeFile("artifacts/backups/deployed-recovery.json",JSON.stringify({at:new Date().toISOString(),id:receipt.id,verified,verifiedCredentialsRecovered,revokedGrantsRemoved:true,scope:"real-r2-to-empty-local-store",files:manifest.files.length,productionVmReplaced:false},null,2));
 console.log(JSON.stringify({verified,files:manifest.files.length}));
} finally {await rm(directory,{recursive:true,force:true});}
