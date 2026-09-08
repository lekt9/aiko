import { expect, test } from "bun:test";
import { memoryAuthorityAppendAllowed as allowed, projectMemoryAuthority as project, memoryAuthorityEventKey } from "../src/memory-authority.ts";
const scope = { owner: "123", scope: "aiko:123" };
const hash = "a".repeat(64), zero = { version: 1 as const, scope: scope.scope, seq: 0, digest: "0".repeat(64) };
const init = { ...scope, at: 1, type: "AikoMemoryAuthorityInitialized", writer: 1, key: "bootstrap", expectedRevision: 0, fence: zero, bootstrap: { reference: "trusted-bootstrap", digest: hash } };
const claim = { ...scope, at: 1, type: "AikoMemoryAuthorityClaimed", writer: 1, key: "tool-call-1", expectedRevision: 1, kind: "erase", fingerprint: hash, beforeFence: zero, native: { tool: "memory_erase", callKey: "tool-call-1", requestFingerprint: hash } };
const after = { ...zero, seq: 9, digest: hash };
const commit = { ...scope, at: 1, type: "AikoMemoryAuthorityEraseCommitted", writer: 1, key: "commit-1", expectedRevision: 2, claimKey: claim.key, afterFence: after, requestFingerprint: hash, operation: "erase-subject", receipt: { key: "actual-native-receipt", requestDigest: hash, seq: 9, digest: hash, scopeVersion: 4 }, cleanup: { status: "complete", reference: "checked-copies", digest: hash } };
test("explicit bootstrap, full batch and closed erase lifecycle", () => {
  expect(project([], scope)).toBeUndefined();
  expect(allowed([], [claim], scope)).toBe(false);
  expect(allowed([], [{type:"ThreadCreated"}, init, claim, commit], scope)).toBe(true);
  expect(project([init, claim, commit], scope)).toEqual({ ...scope, revision: 3, writer: 1, fence: after });
  expect(allowed([], [{...init, fence:after}], scope)).toBe(true);
  expect(allowed([], [{...init, fence:{...zero,digest:hash}}], scope)).toBe(false);
});
test("lost acknowledgements replay exactly without releasing or advancing claims", () => {
  expect(project([init, claim, structuredClone(claim)], scope)?.revision).toBe(2);
  expect(project([init, claim, commit, claim, commit], scope)?.revision).toBe(3);
  expect(allowed([init,claim], [{...claim,fingerprint:"b".repeat(64)}], scope)).toBe(false);
  expect(allowed([init,claim,commit], [{...commit,cleanup:{...commit.cleanup,reference:"changed"}}], scope)).toBe(false);
  expect(memoryAuthorityEventKey(claim)).toBe(memoryAuthorityEventKey({...claim,fingerprint:hash}));
});
test("pending claim excludes competing work, stale revisions and writer takeover", () => {
  for(const event of [{...claim,key:"other",expectedRevision:2}, {...claim,key:"other",writer:0},
    {...scope,at:1,type:"AikoMemoryAuthorityWriterAdvanced",key:"rotate",writer:1,nextWriter:2,expectedRevision:2}])
    expect(allowed([init,claim],[event],scope)).toBe(false);
  const rotate={...scope,at:1,type:"AikoMemoryAuthorityWriterAdvanced",key:"rotate",writer:1,nextWriter:2,expectedRevision:1};
  expect(allowed([init],[rotate],scope)).toBe(true);
  expect(allowed([init,rotate],[{...claim,expectedRevision:2}],scope)).toBe(false);
  expect(allowed([init],[{...claim,owner:"foreign"}],scope)).toBe(false);
  expect(allowed([init],[{...claim,type:"AikoMemoryAuthorityInvented"}],scope)).toBe(false);
});
test("terminal witnesses must bind native receipt, fence and completed cleanup", () => {
  for(const bad of [{...commit,requestFingerprint:"b".repeat(64)}, {...commit,afterFence:zero},
    {...commit,cleanup:{...commit.cleanup,status:"pending"}}, {...commit,claimKey:"wrong"}])
    expect(allowed([init,claim],[bad],scope)).toBe(false);
  const abort={...scope,at:1,type:"AikoMemoryAuthorityEraseAborted",writer:1,key:"abort",expectedRevision:2,claimKey:claim.key,
    witness:{kind:"unchanged-native-state",fence:zero,callKey:claim.native.callKey,requestFingerprint:hash,reference:"native-read",digest:hash}};
  expect(allowed([init,claim],[abort],scope)).toBe(true);
  expect(allowed([init,claim],[{...abort,witness:true}],scope)).toBe(false);
  expect(allowed([init,claim],[{...abort,witness:{...abort.witness,fence:after}}],scope)).toBe(false);
});
test("restore remains exclusive indefinitely until linked publication or cancellation", () => {
  const {native,...rest}=claim;
  const restore={...rest,kind:"restore"};
  const history=[init,restore,{type:"AlarmFired",at:Number.MAX_SAFE_INTEGER}];
  expect(project(history,scope)?.pending?.key).toBe(claim.key);
  expect(allowed(history,[{...claim,key:"erase-later",expectedRevision:2}],scope)).toBe(false);
  for(const status of ["published","cancelled"]){
    const terminal={...scope,at:1,type:"AikoMemoryAuthorityRestoreSettled",key:`restore-${status}`,writer:1,expectedRevision:2,claimKey:restore.key,
      witness:{status,operationId:restore.key,fingerprint:hash,fence:zero,reference:"remote-readback",digest:hash}};
    expect(project([...history,terminal],scope)?.pending).toBeUndefined();
    expect(allowed(history,[{...terminal,witness:{...terminal.witness,operationId:"other"}}],scope)).toBe(false);
  }
});

test("metadata batches reject arbitrary events and non-finite timestamps", () => {
  expect(allowed([init],[{type:"MessageReceived",at:1}],scope)).toBe(false);
  expect(allowed([],[{...init,at:Infinity}],scope)).toBe(false);
  expect(allowed([],[{...init,at:undefined}],scope)).toBe(false);
  expect(allowed([init],[{...claim,unexpected:true}],scope)).toBe(false);
});

test("native SQLite appendControl retains claim across reopen and rejects changed replay atomically", async () => {
  const { Database } = await import("bun:sqlite");
  const { Layer } = await import("effect");
  const { createCloudflareAccountHost } = await import("../src/cloudflare-host.ts");
  const db = new Database(":memory:");
  let alarm: number | null = null, sidecars = 0;
  const storage = {
    sql: {exec: (sql: string,...args: any[]) => {
      if (!args.length && sql.trimStart().startsWith("CREATE")) { db.exec(sql); return {toArray:()=>[]}; }
      const rows=db.query(sql).all(...args.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x));
      return {toArray:()=>rows as never};
    }},
    transactionSync: <T>(fn:()=>T):T => db.transaction(fn)(), sync:async()=>{},
    getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;},deleteAlarm:async()=>{alarm=null;},
  };
  const options = {storage,actorName:"aiko",actorInstance:"authority",ownsThread:(t:string)=>t==="owner-123",
    actorFor:()=>undefined,layersFor:()=>Layer.empty,keyOf:memoryAuthorityEventKey,
    canAppend:(_thread:string,events:readonly unknown[],read:()=>readonly unknown[])=>allowed(read(),events,scope)};
  let host=await createCloudflareAccountHost(options);
  try {
    const sidecar=()=>{sidecars++;return undefined;};
    expect(await host.appendControl("owner-123",[{...init,expectedRevision:9}],{sidecar})).toEqual({appended:0,head:0});
    expect(sidecars).toBe(0);
    expect(await host.appendControl("owner-123",[init,claim],{sidecar})).toEqual({appended:3,head:3});
    expect(sidecars).toBe(1);
    await host.close(); host=await createCloudflareAccountHost(options);
    expect(project(await host.read("owner-123"),scope)?.pending?.key).toBe(claim.key);
    expect(await host.appendControl("owner-123",[claim],{sidecar})).toEqual({appended:0,head:3});
    expect(await host.appendControl("owner-123",[{...claim,fingerprint:"b".repeat(64)}],{sidecar})).toEqual({appended:0,head:3});
    expect(sidecars).toBe(1);
    expect(await host.appendControl("owner-123",[commit],{sidecar})).toEqual({appended:1,head:4});
    expect(project(await host.read("owner-123"),scope)?.fence).toEqual(after);
    expect(await storage.getAlarm()).toBeNull();
    expect(host.work()).toBe(0);
  } finally {await host.close();db.close();}
});
