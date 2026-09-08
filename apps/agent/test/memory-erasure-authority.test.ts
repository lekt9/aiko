import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
import { createMemoryAuthorityRegistry } from "../src/memory-authority-host.ts";
import { memoryErasureAuthority, prepareMemoryErasure } from "../src/memory-erasure-authority.ts";
import type { MemoryAuthorityClaim } from "../src/memory-authority.ts";

function storage(db:Database) {
 return {sql:{exec:(sql:string,...args:any[])=>{
  if(!args.length&&sql.trimStart().startsWith("CREATE")){db.exec(sql);return {toArray:()=>[],*[Symbol.iterator](){}};}
  const rows=db.query(sql).all(...args.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v)) as Record<string, string | number | null | Uint8Array>[];return {toArray:()=>rows as never,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
 }},transactionSync:<T>(f:()=>T)=>db.transaction(f)(),sync:async()=>{},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
}
for (const cut of ["prepare", "complete", "cancel"] as const)
test(`native erase authority ${cut} acknowledgement/cancellation recovery`,async()=>{
 const db=new Database(":memory:"),nativeDb=new Database(":memory:");
 const registry=await createMemoryAuthorityRegistry(storage(db),1);
 const memory=new Memory({storage:cloudflareStorage(storage(nativeDb)),scope:"aiko:123"});
 try {
  await registry.admit("123");
  const row=memory.remember({subject:"private",title:"Private",type:"fact",payload:"secret"},{key:"seed",producer:{kind:"agent",reference:"fixture"}});
  const input={subject:row.subject,expectedHead:row.id,expectedScopeVersion:memory.scan().sourceVersion,key:"original-tool-call"};
  const initial=(await registry.read("123"))!;
  const claim:MemoryAuthorityClaim={type:"AikoMemoryAuthorityClaimed",owner:"123",scope:"aiko:123",writer:1,key:input.key,
    expectedRevision:initial.revision,at:1,kind:"erase",fingerprint:"a".repeat(64),beforeFence:initial.fence,
    native:{tool:"memory_erase",callKey:input.key,requestFingerprint:"b".repeat(64)}};
  const controller=new AbortController();let dropped=false;
  const port={read:registry.read,event:registry.event,append:async(owner:string,event:Parameters<typeof registry.append>[1])=>{
    const result=await registry.append(owner,event);
    if(!dropped&&((cut==="prepare"&&event.type==="AikoMemoryAuthorityClaimed")||(cut==="complete"&&event.type==="AikoMemoryAuthorityEraseCommitted"))){dropped=true;throw Error("lost ack");}
    if(cut==="cancel"&&event.type==="AikoMemoryAuthorityClaimed")controller.abort();
    return result;
  }};
  let lease=memoryErasureAuthority({memory,authority:port,claim,input,signal:controller.signal});
  if(cut==="cancel"){
    await expect(lease.prepare()).rejects.toThrow();
    expect(memory.subjectErasureReceipt(input.key)).toBeUndefined();
    expect((await registry.read("123"))?.pending?.key).toBe(input.key);
    lease=memoryErasureAuthority({memory,authority:registry,claim,input});
  }
  expect(await lease.prepare()).toEqual({deletionRequired:true});
  const conflictInput={...input,key:"different-tool-call"};
  const conflict=memoryErasureAuthority({memory,authority:registry,input:conflictInput,
    claim:{...claim,key:conflictInput.key,native:{...claim.native!,callKey:conflictInput.key}}});
  await expect(conflict.prepare()).rejects.toThrow();
  memory.eraseSubject(input);
  const resumed=memoryErasureAuthority({memory,authority:port,claim,input});
  expect(await resumed.prepare()).toEqual({deletionRequired:false});
  await expect(resumed.complete({status:"unknown" as any,reference:"copies",digest:"c".repeat(64)})).rejects.toThrow();
  expect((await registry.read("123"))?.pending?.key).toBe(input.key);
  const controlledCopies=new Map([[row.id,"private fixture copy"]]);
  controlledCopies.delete(row.id);
  expect(controlledCopies.size).toBe(0);
  const cleanup={status:"complete" as const,reference:"controlled-owner-copies",digest:"c".repeat(64)};
  const done=await resumed.complete(cleanup);
  expect(done.pending).toBeUndefined();expect(done.fence).toEqual(memory.erasureFence());
  expect(await resumed.complete(cleanup)).toEqual(done);
  await expect(resumed.complete({...cleanup,digest:"d".repeat(64)})).rejects.toThrow();
  expect(await resumed.prepare()).toEqual({deletionRequired:false});
  expect(() => resumed.erase()).toThrow("not admitted");
  expect((await registry.read("123"))?.revision).toBe(3);
 }finally{memory.close();await registry.close();nativeDb.close();db.close();}
});
