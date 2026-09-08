import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxDigest, verifySandboxReceipt, type SandboxJob, type SandboxArtifact } from "../src/sandbox-job.ts";
import { runSandboxJob, readSandboxReceipt, sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";

// These tests perform encrypted SQLite I/O and multiple bounded jobs. Keep the
// fixture deadline separate from each job’s unchanged execution budget.
const environmentDigest = await sandboxEnvironment("fixture-runner-v1");
async function job(artifact:SandboxArtifact, extra:Partial<SandboxJob>={}):Promise<SandboxJob> {
  const dependencyLock = artifact.kind === "library" ? Object.fromEntries(Object.entries(artifact.modules).map(([k,v])=>[k,v.digest])) : {};
  return {version:1,owner:"owner",operationId:crypto.randomUUID(),contextRef:"context-v1",authorityRef:"authority-v1",artifact,harnessDigest:await sandboxDigest(artifact),dependencyLock,dependencyLockDigest:await sandboxDigest(dependencyLock),environmentDigest,input:{n:7},authority:{origins:[],methods:["GET"]},budget:{wallMs:5000,requests:4,outputBytes:32768},...extra};
}
async function fixture(run:(binding:any, db:Database, directory:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),"sandbox-job-"));
  const db=new Database(join(directory,"receipts.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  try { await run({owner:"owner",environmentDigest,journal:await sandboxJobJournal(db,join(directory,"key"))},db,directory); }
  finally { db.close(); await rm(directory,{recursive:true,force:true}); }
}
test("pinned library build executes bundled dependency in QuickJS and supports held-out input",()=>fixture(async binding=>{
  const source='import {double} from "math"; export default input => ({value:double(input.n), ambient:[typeof Bun,typeof process,typeof fetch]});';
  const dependency='export const double = n => n*2;';
  const artifact:SandboxArtifact={kind:"library",entry:"main",modules:{main:{source,digest:await sandboxDigest(source)},math:{source:dependency,digest:await sandboxDigest(dependency)}}};
  const first=await job(artifact);
  const receipt=await runSandboxJob(first,binding);
  expect(receipt.status).toBe("completed");
  expect(receipt.output).toEqual({value:14,ambient:["undefined","undefined","undefined"]});
  expect(receipt.builtDigest).toBe(await sandboxDigest(receipt.builtArtifact));
  expect(await verifySandboxReceipt(first,receipt)).toEqual(receipt);
  const heldout=await runSandboxJob(await job(receipt.builtArtifact!,{input:{n:-3}}),binding);
  expect(heldout.output).toEqual({value:-6,ambient:["undefined","undefined","undefined"]});
  await expect(verifySandboxReceipt(first,{...receipt,output:{value:999}})).rejects.toThrow("integrity");
}), 30_000);
test("owner, artifact, environment, lock and operation conflicts fail closed",()=>fixture(async binding=>{
  const input=await job({kind:"code",code:"return input.n"});
  for(const change of [{owner:"other"},{environmentDigest:await sandboxDigest("other")},{artifact:{kind:"code",code:"return 999"}},{dependencyLock:{unresolved:await sandboxDigest("x")}}])
    await expect(runSandboxJob({...input,...change} as SandboxJob,binding)).rejects.toThrow();
  await runSandboxJob(input,binding);
  await expect(runSandboxJob({...input,input:{n:8}},binding)).rejects.toThrow("identity conflict");
}), 30_000);
test("unresolved imports, CPU exhaustion, output bounds and cancellation are terminal failures",()=>fixture(async binding=>{
  const source='import fs from "node:fs"; export default () => fs.readFileSync("/etc/passwd");';
  const artifact:SandboxArtifact={kind:"library",entry:"main",modules:{main:{source,digest:await sandboxDigest(source)}}};
  expect((await runSandboxJob(await job(artifact),binding)).status).toBe("failed");
  expect((await runSandboxJob(await job({kind:"code",code:"while(true){}"}),binding)).status).toBe("failed");
  expect((await runSandboxJob(await job({kind:"code",code:'return "x".repeat(50000)'}),binding)).status).toBe("failed");
  expect((await runSandboxJob(await job({kind:"code",code:"return 1"}),binding,AbortSignal.abort())).status).toBe("failed");
}), 30_000);
test("durable receipt survives reopen; interrupted dispatch never reruns; private output is encrypted",()=>fixture(async(binding,db,directory)=>{
  const input=await job({kind:"code",code:'return "PRIVATE_FIXTURE_VALUE"'});
  const receipt=await runSandboxJob(input,binding);
  const reopened=new Database(join(directory,"receipts.sqlite"));
  try {
    const journal=await sandboxJobJournal(reopened,join(directory,"key"));
    expect(await runSandboxJob(input,{...binding,journal})).toEqual(receipt);
    const interrupted=await job({kind:"code",code:"return 88"});
    await journal.claim("owner",interrupted.operationId,await sandboxDigest(interrupted));
    expect((await runSandboxJob(interrupted,{...binding,journal})).status).toBe("unknown");
    const row=db.query("SELECT receipt FROM sandbox_jobs WHERE id=?").get(input.operationId) as any;
    expect(row.receipt).not.toContain("PRIVATE_FIXTURE_VALUE");
  } finally {reopened.close();}
}), 30_000);
test("vendored network DAG fetches fresh fixture data with no browser and does not duplicate uncertain writes",()=>fixture(async binding=>{
  let requests=0;
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>Response.json({sequence:++requests})});
  try {
    const origin=server.url.origin;
    const graph:any={schemaVersion:2,executorAbi:"site-harness/1",siteId:"fixture",version:"1",sourceCaptureDigest:await sandboxDigest("capture"),allowedOrigins:[origin],actions:[{id:"read",inputs:[],steps:[{id:"fetch",dependsOn:[],method:"GET",origin,path:"/items",pathParameters:{},query:{},headers:{},expectedStatuses:[200]}]}]};
    const input=await job({kind:"network",graph,actionId:"read"},{input:{},authority:{origins:[origin],methods:["GET"]}});
    const local={...binding,send:async(req:any,signal:AbortSignal)=>{const response=await fetch(req.url,{method:req.method,redirect:"manual",signal});return {status:response.status,headers:{"content-type":"application/json"},body:await response.json(),classification:"application"};}};
    const first=await runSandboxJob(input,local);
    expect(first.status).toBe("completed");
    expect((first.output as any).terminal).toEqual({sequence:1});
    expect(first.browserStarts).toBe(0);
    expect(await runSandboxJob(input,local)).toEqual(first);
    expect(requests).toBe(1);
    expect(((await runSandboxJob({...input,operationId:crypto.randomUUID()},local)).output as any).terminal).toEqual({sequence:2});
    const writeGraph=structuredClone(graph); writeGraph.actions[0].steps[0].method="POST";
    const write=await job({kind:"network",graph:writeGraph,actionId:"read"},{input:{},authority:{origins:[origin],methods:["POST"]}});
    let writes=0;
    const lost={...binding,send:async()=>{writes++;throw Error("lost acknowledgement");}};
    expect((await runSandboxJob(write,lost)).status).toBe("unknown");
    expect((await runSandboxJob(write,lost)).status).toBe("unknown");
    expect(writes).toBe(1);
  } finally {await server.stop(true);}
}), 30_000);
test("network origin/method/request budgets reject before transport and tight CPU budget interrupts",()=>fixture(async binding=>{
  const origin="https://fixture.example";
  const graph:any={schemaVersion:2,executorAbi:"site-harness/1",siteId:"fixture",version:"1",sourceCaptureDigest:await sandboxDigest("capture"),allowedOrigins:[origin],actions:[{id:"read",inputs:[],steps:[{id:"fetch",dependsOn:[],method:"GET",origin,path:"/items",pathParameters:{},query:{},headers:{},expectedStatuses:[200]}]}]};
  let calls=0;
  const local={...binding,send:async()=>{calls++;return {status:200,headers:{},body:{ok:true},classification:"application"};}};
  for(const authority of [{origins:[],methods:["GET"]},{origins:[origin],methods:["HEAD"]}])
    expect((await runSandboxJob(await job({kind:"network",graph,actionId:"read"},{input:{},authority}),local)).status).toBe("failed");
  expect((await runSandboxJob(await job({kind:"network",graph,actionId:"read"},{input:{},authority:{origins:[origin],methods:["GET"]},budget:{wallMs:1000,requests:0,outputBytes:1000}}),local)).status).toBe("failed");
  expect(calls).toBe(0);
  // The execution budget starts after the durable claim and ends before receipt
  // persistence. Disk fsync latency is not QuickJS execution time.
  let executionStarted = 0, executionElapsed = Infinity;
  const timed = { ...binding, journal: { ...binding.journal,
    claim: async (...args: Parameters<typeof binding.journal.claim>) => {
      const claimed = await binding.journal.claim(...args);
      executionStarted = performance.now();
      return claimed;
    },
    settle: async (...args: Parameters<typeof binding.journal.settle>) => {
      executionElapsed = performance.now() - executionStarted;
      return binding.journal.settle(...args);
    },
  } };
  expect((await runSandboxJob(await job({kind:"code",code:"while(true){}"},{budget:{wallMs:10,requests:0,outputBytes:1000}}),timed)).status).toBe("failed");
  expect(executionElapsed).toBeLessThan(500);
}), 30_000);

test("receipt-only inspection cannot reserve or execute missing work and verifies exact retained identity", () => fixture(async binding => {
  const input = await job({ kind: "code", code: "return input.n * 2;" });
  expect((await readSandboxReceipt(input, binding)).status).toBe("unknown");
  expect(await binding.journal.read("owner", input.operationId)).toBeUndefined();
  const completed = await runSandboxJob(input, binding);
  const readOnly = { ...binding, journal: { ...binding.journal, claim: async () => { throw Error("must not claim"); }, settle: async () => { throw Error("must not settle"); } } };
  expect(await readSandboxReceipt(input, readOnly)).toEqual(completed);
  await expect(readSandboxReceipt({ ...input, input: { n: 8 } }, readOnly)).rejects.toThrow("identity conflict");
  await expect(readSandboxReceipt({ ...input, owner: "other" }, readOnly)).rejects.toThrow("scope");
  await expect(readSandboxReceipt(input, readOnly, AbortSignal.abort())).rejects.toThrow();
}), 30_000);
