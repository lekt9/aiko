import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codegraff, CodegraffSandbox, replayKeys, unwrapReplay, sealReplay } from "../src/codegraff.ts";
import { createSandboxDispatch, type SandboxDispatchReply } from "../src/sandbox-dispatch.ts";
import type { SandboxJob } from "../src/sandbox-job.ts";
import { sandboxEnvironment, readSandboxReceipt, runSandboxJob } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { createSandboxWebhookTransport } from "../src/webhook-sandbox.ts";
import type { HarnessSandboxClient } from "../src/harness-sandbox.ts";
const environmentDigest = await sandboxEnvironment("joined-webhook-private-protocol-fixture");

export async function setupWebhookSandbox(owner = "alice") {
  const directory = await mkdtemp(join(tmpdir(), "webhook-private-protocol-"));
  const path = join(directory,"receipts.sqlite"), keyPath = join(directory,"key");
  let db = new Database(path), journal = await sandboxJobJournal(db,keyPath);
  let sockets = 0, dns = 0, loseSocketReply = false, loseContinuationReply = false, legacy = 0;
  const received:{url:string;method:string;headers:Record<string,string|undefined>;body:string}[] = [];
  const server = createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    received.push({url:request.url!,method:request.method!,headers:request.headers as Record<string,string|undefined>,body:Buffer.concat(chunks).toString()});
    if(loseSocketReply){request.socket.destroy();return;}
    response.statusCode=202;response.setHeader("content-type","application/json");response.end('{"accepted":true}');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;
  const http={lookup:async()=>{dns++;return ["93.184.216.34"];},request:((target:string,options:any,callback:any)=>{
    sockets++;const url=new URL(target);
    // All production public URL/DNS checks and prepared bytes still run. Only
    // the final socket is routed to this disposable local receiver.
    return httpRequest({...options,hostname:"127.0.0.1",port,path:url.pathname+url.search},callback);
  }) as typeof httpRequest};
  const binding=()=>({owner,environmentDigest,journal,http});
  let helper=createSandboxDispatch(binding());
  const keys=replayKeys(),uploads=new Map<string,string>(),commands:string[]=[],operations:any[]=[],jobs:SandboxJob[]=[];
  const sandbox=new CodegraffSandbox({owner,gateway:new Codegraff("fixture-key",async()=>{throw Error("No provider calls in this fixture");}),
    store:{get:async()=>undefined,put:async()=>{}},emit:async()=>{},runnerBundle:"fixture",bootstrap:"fixture"});
  let beforeContinue: () => Promise<void> = async () => {};
  let transform:(reply:SandboxDispatchReply)=>Promise<SandboxDispatchReply>=async reply=>reply;
  const ensure=spyOn(sandbox,"ensure").mockResolvedValue("local-owned-vm");
  const upload=spyOn(sandbox,"upload").mockImplementation(async(_id,path,text)=>{uploads.set(path.split("/").at(-1)!.replace(/\.json$/,""),text);});
  const exec=spyOn(sandbox,"exec").mockImplementation(async(_id,command,signal)=>{
    commands.push(command);
    if(command.endsWith(" health"))return JSON.stringify({environmentDigest,replayPublicKey:keys.publicKey});
    if(command.includes(" runner.js cancel "))return '{"settled":true}';
    const id=command.split(" ").at(-1)!,{key,value}=unwrapReplay(JSON.parse(uploads.get(id)!),keys.privateKey);operations.push(value);
    let output:unknown;
    if(value.operation==="guarded-start"){
      jobs.push(structuredClone(value.input));output=await transform(await helper.start(value.input,signal));
    }else if(value.operation==="guarded-continue"){
      await beforeContinue();
      output=await transform(await helper.continue(value.input));
      if(loseContinuationReply){loseContinuationReply=false;throw Error("encrypted_continuation_reply_lost");}
    }else if(value.operation==="harness-receipt")output=await readSandboxReceipt(value.input,binding(),signal);
    else if(value.operation==="harness-job"){legacy++;jobs.push(structuredClone(value.input));output=await runSandboxJob(value.input,binding(),signal);}
    else throw Error("Unexpected private operation");
    return JSON.stringify(sealReplay({output},key));
  });
  const transport=(client:HarnessSandboxClient=sandbox)=>createSandboxWebhookTransport(owner,{sandbox:client,placement:"codegraff",codeTransport:async()=>{throw Error("unused");}});
  return {sandbox,transport,received,operations,jobs,uploads,commands,get sockets(){return sockets;},get dns(){return dns;},get legacy(){return legacy;},
    beforeContinue(fn:typeof beforeContinue){beforeContinue=fn;},
    transform(fn:typeof transform){transform=fn;},loseSocketReply(){loseSocketReply=true;},loseContinuationReply(){loseContinuationReply=true;},
    receipt:()=>readSandboxReceipt(jobs.at(-1)!,binding()),
    async restart(){helper.close();await Bun.sleep(20);db.close();db=new Database(path);journal=await sandboxJobJournal(db,keyPath);helper=createSandboxDispatch(binding());},
    async close(){helper.close();await Bun.sleep(20);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      ensure.mockRestore();upload.mockRestore();exec.mockRestore();db.close();await rm(directory,{recursive:true,force:true});}};
}
