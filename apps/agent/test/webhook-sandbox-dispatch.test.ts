import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sandboxDigest } from "../src/sandbox-job.ts";
import type { WebhookRequest } from "../src/webhook-adapter.ts";
import type { HarnessSandboxClient } from "../src/harness-sandbox.ts";
import { setupWebhookSandbox } from "./webhook-sandbox-fixture.ts";

const owner = "alice", origin = "https://hooks.receiver.com", signingKey = "LOCAL_FIXTURE_SIGNING_KEY_00000000000000";
function input(operationId = crypto.randomUUID()): WebhookRequest {
  const deliveryId = `delivery:${operationId}`, url = `${origin}/items/order%20one?kind=notice`;
  const body = JSON.stringify({version:1,deliveryId,payload:'A local fixture: café ☀\n"signed"'});
  const proof = createHmac("sha256", signingKey).update(JSON.stringify([1,"send",deliveryId,url,body])).digest("hex");
  return {owner,operationId,policyDigest:"a".repeat(64),authorityRef:"authority-v1",url,method:"POST",body,
    headers:{"content-type":"application/json","x-aiko-delivery-id":deliveryId,"x-aiko-proof":`v1=${proof}`},
    redirect:"manual",maxResponseBytes:16384,notAcceptedStatuses:[],signal:AbortSignal.timeout(5000),
    beforeDispatch:()=>{throw Error("guarded delivery must not use the legacy admission callback");},
    // The durable native permit is deliberately substituted in this protocol
    // fixture. Native actor commit authority is covered by the assembly tests.
    authorizeDispatch:async()=>true};
}

async function fixture(run:(f:Awaited<ReturnType<typeof setupWebhookSandbox>>)=>Promise<void>){const f=await setupWebhookSandbox();try{await run(f);}finally{await f.close();}}

test("signed webhook crosses encrypted guarded runner only after permission; exact bytes survive and retained success needs no new permit",()=>fixture(async f=>{
  const request=input(),transport=f.transport();let release!:()=>void,entered!:()=>void,permits=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  request.authorizeDispatch=async challenge=>{
    permits++;expect(f.sockets).toBe(0);expect(f.dns).toBe(1);expect(f.sandbox.busy).toBe(true);
    expect(challenge.requestDigest).toBe(await sandboxDigest(challenge.prepared));
    expect(challenge.prepared.body).toBe(request.body);entered();await gate;return true;
  };
  expect(transport.dispatchBoundary).toBe("host-permit");
  const running=transport.request(request);
  try{await ready;expect(f.received).toHaveLength(0);release();expect(await running).toEqual({status:202});}finally{release();}
  expect(f.sockets).toBe(1);expect(f.received).toHaveLength(1);const wire=f.received[0]!;
  expect(wire.url).toBe(new URL(request.url).pathname+new URL(request.url).search);expect(wire.method).toBe(request.method);expect(wire.body).toBe(request.body!);
  for(const [name,value]of Object.entries(request.headers))expect(wire.headers[name]).toBe(value);
  expect(wire.headers["x-aiko-proof"]).toBe(`v1=${createHmac("sha256",signingKey).update(JSON.stringify([1,"send",wire.headers["x-aiko-delivery-id"],request.url,wire.body])).digest("hex")}`);
  expect(f.jobs[0]!.dispatch).toEqual({protocol:"host-request/v1"});expect(f.jobs[0]!.budget.requests).toBe(1);
  expect(JSON.stringify(f.jobs)).not.toContain(signingKey);expect([...f.uploads.values()].join()+f.commands.join()).not.toMatch(/signed|hooks.receiver.com|x-aiko-proof/);
  await f.restart();expect(await f.transport().request(request)).toEqual({status:202});expect(permits).toBe(1);expect(f.sockets).toBe(1);expect(f.dns).toBe(1);
}),30000);

test("denied webhook permit opens no socket and its failed receipt cannot generate another request",()=>fixture(async f=>{
  const request=input();let permits=0;request.authorizeDispatch=async()=>{permits++;return false;};
  await expect(f.transport().request(request)).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect((await f.receipt()).status).toBe("failed");expect(f.sockets).toBe(0);expect(f.operations.at(-1).input.allow).toBe(false);
  await f.restart();await expect(f.transport().request(request)).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect(permits).toBe(1);expect(f.sockets).toBe(0);
}),30000);

test("expired or byte-tampered encrypted challenges never reach the permit callback or open sockets",()=>fixture(async f=>{
  let permits=0;
  for(const changed of ["expired","body","url","header"]){
    const request=input();request.authorizeDispatch=async()=>{permits++;return true;};
    f.transform(async reply=>{
      if(reply.status!=="awaiting-dispatch")return reply;
      if(changed==="expired")return {...reply,expiresAt:Date.now()-1};
      const prepared=structuredClone(reply.prepared);
      if(changed==="body")prepared.body="changed";
      if(changed==="url")prepared.url=origin+"/different";
      if(changed==="header")prepared.headers={...prepared.headers,"x-aiko-proof":"changed"};
      return {...reply,prepared,requestDigest:await sandboxDigest(prepared)};
    });
    await expect(f.transport().request(request)).rejects.toThrow(changed==="expired"?"challenge mismatch":changed==="header"?"webhook_private_headers_changed":"webhook_private_request_changed");
    expect(f.sockets).toBe(0);expect(permits).toBe(0);
  }
  expect(f.operations.every(value=>value.operation==="guarded-start")).toBe(true);
}),30000);

test("authority-required webhook cannot downgrade to ordinary harness admission; ordinary delivery retains its legacy callback",()=>fixture(async f=>{
  const client:HarnessSandboxClient={harnessEnvironment:signal=>f.sandbox.harnessEnvironment(signal),harnessJob:(job,signal)=>f.sandbox.harnessJob(job,signal)};
  const transport=f.transport(client),request=input();expect(transport.dispatchBoundary).toBe("sandbox-admission");
  await expect(transport.request(request)).rejects.toThrow("webhook_private_permit_unavailable");expect(f.legacy).toBe(0);expect(f.sockets).toBe(0);
  let before=0;delete request.authorizeDispatch;request.beforeDispatch=()=>{before++;};
  expect(await transport.request(request)).toEqual({status:202});expect(before).toBe(1);expect(f.legacy).toBe(1);expect(f.sockets).toBe(1);
}),30000);

test("lost receiver acknowledgement remains unknown after private restart with no repeated socket or permit",()=>fixture(async f=>{
  const request=input();let permits=0;request.authorizeDispatch=async()=>{permits++;return true;};f.loseSocketReply();
  await expect(f.transport().request(request)).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect(f.received).toHaveLength(1);expect(f.sockets).toBe(1);expect((await f.receipt()).status).toBe("unknown");
  await f.restart();await expect(f.transport().request(request)).rejects.toThrow("webhook_sandbox_outcome_unknown");
  expect(permits).toBe(1);expect(f.sockets).toBe(1);expect(f.dns).toBe(1);
}),30000);

test("lost encrypted continuation reply is not resent and retained completion recovers without another permit",()=>fixture(async f=>{
  const request=input();let permits=0;request.authorizeDispatch=async()=>{permits++;return true;};f.loseContinuationReply();
  await expect(f.transport().request(request)).rejects.toThrow("encrypted_continuation_reply_lost");
  expect(f.sockets).toBe(1);expect(f.operations.filter(value=>value.operation==="guarded-continue")).toHaveLength(1);
  await f.restart();expect(await f.transport().request(request)).toEqual({status:202});
  expect(permits).toBe(1);expect(f.sockets).toBe(1);expect(f.operations.filter(value=>value.operation==="guarded-continue")).toHaveLength(1);
}),30000);
