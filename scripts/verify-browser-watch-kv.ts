/** Actual local workerd storage witness. Synthetic records, no remote bindings. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "aiko-watch-kv-workerd-"));
// Keep mutable SQLite files outside Wrangler's watched immutable bundle tree.
const stateDirectory = await mkdtemp(join(tmpdir(), "aiko-watch-kv-state-"));
const worker = `
import { DurableObject } from "cloudflare:workers";
import { ConnectorEngine, connectorStorePrefix } from ${JSON.stringify(join(root, "apps/agent/src/connectors.ts"))};
const check=(value,message)=>{if(!value)throw Error(message);};
export class AuthorityFixture extends DurableObject {
 async fetch(request) {
  try {
   const storage=this.ctx.storage, owner="123", id="11111111-1111-4111-8111-111111111111";
   const key=connectorStorePrefix(owner)+"connection:"+id;
   let providerCalls=0;
   const denied=async()=>{providerCalls++;throw Error("Fixture provider call forbidden");};
   const engine=new ConnectorEngine({owner,env:{},fetch:denied,onEvent:denied,
    secureBrowser:{native:true,begin:denied,status:denied,control:denied,readContext:denied,disconnect:denied},
    store:{get:key=>storage.get(key),getSync:key=>storage.kv.get(key),set:(key,value)=>storage.put(key,value),list:async prefix=>[...(await storage.list({prefix})).values()]}});
   storage.sql.exec("CREATE TABLE IF NOT EXISTS fixture_admissions(id TEXT PRIMARY KEY)");
   if(new URL(request.url).pathname==="/cold") {
    check((await storage.get(key)).status==="disconnected","Async revocation lost across restart");
    check(storage.kv.get(key).status==="disconnected","Sync revocation lost across restart");
    storage.transactionSync(()=>check(engine.browserWatchCommitAuthority(id)===undefined,"Cold commit admitted revoked connection"));
    check(storage.sql.exec("SELECT COUNT(*) AS n FROM fixture_admissions").one().n===0,"Denied admission created a record");
    return Response.json({ok:true,coldRevocation:true,admissions:0,providerCalls});
   }
   const row={id,owner,connectorId:"browser:example.com",provider:"browser",status:"connected",createdAt:Date.now(),expiresAt:1,
    browserVerification:{verified:true,revision:7,expiresAt:Date.now()+60000}};
   await storage.put(key,row);
   check(JSON.stringify(await storage.get(key))===JSON.stringify(storage.kv.get(key)),"Async and sync namespaces differ");
   const proof=await engine.browserWatchAuthority(id);
   check(proof?.revision===7&&proof.native===true,"Initial async authority missing");
   storage.transactionSync(()=>check(engine.browserWatchCommitAuthority(id)?.revision===7,"Sync authority missing"));
   await storage.put(key,{...row,browserVerification:{...row.browserVerification,revision:8}});
   storage.transactionSync(()=>{
    const current=engine.browserWatchCommitAuthority(id);
    check(current?.revision===8&&current.revision!==proof.revision,"Stale async revision reused");
   });
   // A committed async revocation must be visible at the final synchronous
   // admission read, in the same transaction as the potential local append.
   await storage.put(key,{...row,status:"disconnected"});
   storage.transactionSync(()=>{
    const authority=engine.browserWatchCommitAuthority(id);
    if(authority?.native&&authority.revision===proof.revision)storage.sql.exec("INSERT INTO fixture_admissions VALUES(?)","forbidden");
    check(authority===undefined,"Revoked async record admitted synchronously");
   });
   check(storage.sql.exec("SELECT COUNT(*) AS n FROM fixture_admissions").one().n===0,"Revocation failed to fence append");
   storage.kv.put("reverse-read",{revision:9});
   check((await storage.get("reverse-read")).revision===9,"Sync write invisible to async read");
   try{storage.transactionSync(()=>{storage.kv.put(key,row);throw Error("fixture-rollback");});}catch(error){check(String(error).includes("fixture-rollback"),"Unexpected transaction error");}
   check((await storage.get(key)).status==="disconnected","Sync transaction rollback escaped into async namespace");
   check(engine.browserWatchCommitAuthority(id)===undefined,"Rolled-back grant became authority");
   check(providerCalls===0,"Provider called");await storage.sync();
   return Response.json({ok:true,asyncToSync:true,syncToAsync:true,revisionDrift:true,revocationAtCommit:true,rollback:true,admissions:0,providerCalls});
  }catch(error){return Response.json({error:String(error)},{status:500});}
 }
}
export default {fetch(request,env){if(new URL(request.url).pathname==="/ready")return Response.json({ready:true});return env.FIXTURE.get(env.FIXTURE.idFromName("authority")).fetch(request);}};
`;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
const evidence: unknown[] = [];
async function stop() {
  if (!child) return;
  const running = child; running.kill("SIGINT");
  const timer = setTimeout(() => running.kill("SIGKILL"), 5000);
  try { await running.exited; } finally { clearTimeout(timer); child = undefined; }
}
try {
  await writeFile(join(directory, "worker.ts"), worker);
  const options = { entrypoints: [join(directory, "worker.ts")], target: "browser" as const,
    conditions: ["workerd"], external: ["cloudflare:workers", "node:*"], metafile: true };
  const discovered = await Bun.build(options);
  if (!discovered.success) throw new AggregateError(discovered.logs, "Fixture build failed");
  const inputs = [...new Set([...Object.keys(discovered.metafile!.inputs).map(path => resolve(path)),
    fileURLToPath(import.meta.url), join(root, "pnpm-lock.yaml")])].sort();
  const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async path =>
    [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  const before = await hashes(), built = await Bun.build(options), after = await hashes();
  assert.equal(built.success, true); assert.deepEqual(after, before, "Source changed during fixture freeze");
  assert.deepEqual(Object.keys(built.metafile!.inputs).sort(), Object.keys(discovered.metafile!.inputs).sort());
  assert.equal(built.outputs.length, 1);
  const bytes = new Uint8Array(await built.outputs[0]!.arrayBuffer());
  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(directory, "worker.js"), bytes);
  await writeFile(join(directory, "source-freeze.json"), JSON.stringify({ inputs: before, bundleSha256, bun: Bun.version }, null, 2));
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "browser-watch-kv-local", main: join(directory, "worker.js"), no_bundle: true,
    compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "FIXTURE", class_name: "AuthorityFixture" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["AuthorityFixture"] }] }));
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  async function start() {
    child = Bun.spawn(["node", join(root, "apps/agent/node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", join(directory, "wrangler.json"),
      "--persist-to", stateDirectory, "--port", String(port), "--ip", "127.0.0.1"], {
      cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH!, CI: "true", XDG_CONFIG_HOME: join(directory, "config"), WRANGLER_SEND_METRICS: "false" },
    });
    for (const stream of [child.stdout, child.stderr]) void (async () => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) output = (output + new TextDecoder().decode(chunk)).slice(-16000);
    })();
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`Local Worker stopped (${child.exitCode})`);
      try { if ((await fetch(origin + "/ready", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Bounded startup. */ }
      await Bun.sleep(200);
    }
    throw Error("Local Worker startup timeout");
  }
  async function call(path: string) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(10000) });
    const body = await response.text(); assert.equal(response.status, 200, body);
    const result = JSON.parse(body); assert.equal(result.ok, true); evidence.push({ path, result });
  }
  await start(); await call("/verify"); await stop();
  await start(); await call("/cold"); await stop();
  const report = { verified: true, runtime: "actual local workerd", coldRestarts: 1, providerCalls: 0,
    scope: "Connector KV namespace and synchronous authority read at storage transaction; not a full actor dispatch test",
    bundleSha256, sourceInputs: inputs.length, evidence, directory };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) { console.error(output); throw error; }
finally {
  await stop(); await writeFile(join(directory, "workerd.log"), output);
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(join(directory, ".wrangler"), { recursive: true, force: true });
  console.log("Retained synthetic fixture evidence: " + directory);
}
