import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Event } from "tardie/core/event";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { channelHydrate } from "../src/channel-custody.ts";
import { BrowserObservationQueue } from "../src/browser-event-queue.ts";
import { BROWSER_EVENT_SCHEMA, browserBatchSignature, browserEventAppendAllowed, createBrowserEventAdmission, type BrowserEventBatch, type BrowserProducerGrant } from "../src/browser-events.ts";
import { normalizeChannelLogSource } from "../src/channel-log-source.ts";
const dirs:string[]=[];
afterEach(()=>{ for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true}); });
const clock=1_800_000_000_000;
const grant=():BrowserProducerGrant=>({owner:"alice",producer:"browser-1",epoch:"profile-1",profile:"owned",generation:1,connectionId:"site-1",connectionRevision:"r1",origins:["https://example.com"],kinds:["push","notification","network"],active:true,expiresAt:clock+100000,registeredAt:clock-100,secret:"fixture-only-private-key-00000000000000"});
const occurrence=()=>({kind:"push" as const,observedAt:clock,sourceId:"source-id",fields:{origin:"https://example.com",outcome:"received" as const},payload:{text:"private notification marker"}});
function host(db:Database,g:()=>BrowserProducerGrant|undefined) {
  db.exec("CREATE TABLE IF NOT EXISTS fixture_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL)");
  const read=async()=>db.query("SELECT event FROM fixture_events ORDER BY seq").all().map((row:any)=>JSON.parse(row.event) as Event);
  const blobs=harnessBlobStore(sqliteWorkflowKV(db));
  let before:()=>void=()=>{};
  const journal={blobs,read,transact:async<T>(fn:(rows:readonly Event[])=>{events:Event[];result:T},beforeCommit?:()=>Promise<void>)=>{
    await beforeCommit?.(); before();
    return db.transaction(()=>{
      const rows=db.query("SELECT event FROM fixture_events ORDER BY seq").all().map((row:any)=>JSON.parse(row.event) as Event);
      const {events,result}=fn(rows);if(!browserEventAppendAllowed(events,()=>rows))throw Error("append fence");
      for(const e of events)db.query("INSERT INTO fixture_events(event) VALUES(?)").run(JSON.stringify(e));return result;
    })();
  }};
  return {read,blobs,journal,interrupt:(f:()=>void)=>{before=f;},admit:createBrowserEventAdmission({owner:"alice",journal,grant:()=>g(),current:()=>true,now:()=>clock})};
}
test("encrypted VM queue and native admission survive lost ack and independent database reopen",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"aiko-browser-events-"));dirs.push(dir);
  let vm=new Database(join(dir,"vm.sqlite")), account=new Database(join(dir,"account.sqlite"));
  const g=grant();
  let queue=new BrowserObservationQueue(vm), receiver=host(account,()=>g);
  queue.append(g,occurrence(),"push-occurrence-1",clock);
  const first=queue.batch(g)!;
  expect((await receiver.admit(first.batch,first.signature)).accepted).toBe(1);
  expect(JSON.stringify(await receiver.read())).not.toContain("private notification marker");
  expect(JSON.stringify(vm.query("SELECT * FROM browser_observation_items").all())).not.toContain("private notification marker");
  vm.close();account.close();
  vm=new Database(join(dir,"vm.sqlite"));account=new Database(join(dir,"account.sqlite"));
  queue=new BrowserObservationQueue(vm);receiver=host(account,()=>g);
  const replay=queue.batch(g)!;
  expect(replay).toEqual(first);
  expect((await receiver.admit(replay.batch,replay.signature)).status).toBe("duplicate");
  expect(await receiver.read()).toHaveLength(1);
  const e=(await receiver.read())[0]!;
  expect(await channelHydrate(receiver.blobs,"alice",e.payloadRef)).toEqual(occurrence().payload);
  expect(normalizeChannelLogSource("browser-push",e,"alice",1,"a".repeat(64))).toMatchObject({kind:"push",connectionId:"site-1"});
  expect(normalizeChannelLogSource("browser-push",e,"bob",1,"a".repeat(64))).toBeUndefined();
  queue.acknowledge(g,1);
  expect(queue.batch(g)).toBeUndefined();
  expect(queue.append(g,occurrence(),"push-occurrence-1",clock).status).toBe("duplicate");
  // Identical notification text from a distinct source occurrence remains distinct.
  queue.append(g,occurrence(),"push-occurrence-2",clock);
  const second=queue.batch(g)!;
  expect(second.batch.items[0]!.sequence).toBe(2);
  expect((await receiver.admit(second.batch,second.signature)).accepted).toBe(1);
  expect(vm.query("SELECT sealed FROM browser_observation_items WHERE seq=1").get()).toEqual({sealed:null});
  vm.close();account.close();
// Both stores use actual disk commits; preserve that durability check without
// applying Bun's short in-memory unit-test timeout to the temp volume.
},30_000);
test("producer grants, signature, sequence, content and source scope fail before admission",async()=>{
  const db=new Database(":memory:");try{
    let g:BrowserProducerGrant|undefined=grant();const receiver=host(db,()=>g);
    const batch:BrowserEventBatch={schema:BROWSER_EVENT_SCHEMA,producer:g.producer,epoch:g.epoch,generation:1,items:[{...occurrence(),sequence:1,occurrence:"a".repeat(64)}]};
    const send=(b:BrowserEventBatch)=>receiver.admit(b,browserBatchSignature(b,grant().secret));
    await expect(receiver.admit(batch,"0".repeat(64))).rejects.toThrow("denied");
    await expect(send({...batch,items:[{...batch.items[0]!,sequence:2}]})).rejects.toThrow("gap");
    await expect(send({...batch,items:[{...batch.items[0]!,fields:{origin:"https://foreign.com",outcome:"received"}}]})).rejects.toThrow("scope");
    await expect(send({...batch,items:[{...batch.items[0]!,observedAt:clock-101}]})).rejects.toThrow("time");
    await expect(send({...batch,generation:2})).rejects.toThrow("unavailable");
    expect(await receiver.read()).toHaveLength(0);
    await send(batch);
    await expect(send({...batch,items:[{...batch.items[0]!,payload:{text:"changed"}}]})).rejects.toThrow("conflict");
    receiver.interrupt(()=>{g=undefined;});
    await expect(send({...batch,items:[{...batch.items[0]!,sequence:2,occurrence:"b".repeat(64)}]})).rejects.toThrow("unavailable");
    expect(await receiver.read()).toHaveLength(1);
  }finally{db.close();}
});
test("VM batches preserve contiguous bounded prefixes and reject content tampering, premature ack and stale profile",()=>{
  const db=new Database(":memory:");try{
    const queue=new BrowserObservationQueue(db),g=grant();
    expect(queue.append(g,{...occurrence(),observedAt:clock-101},"historical",clock).status).toBe("historical");
    for(let i=0;i<5;i++)queue.append(g,{...occurrence(),payload:{text:"x".repeat(40_000)}},`p${i}`,clock);
    expect(()=>queue.acknowledge(g,1)).toThrow("ack");
    const first=queue.batch(g)!;expect(first.batch.items).toHaveLength(3);expect(first.hasMore).toBe(true);
    expect(()=>queue.acknowledge(g,4)).toThrow("ack");
    queue.acknowledge(g,2);const second=queue.batch(g)!;expect(second.batch.items.map(x=>x.sequence)).toEqual([3,4,5]);
    expect(()=>queue.batch({...g,connectionRevision:"new"})).toThrow("context");
    const row=db.query("SELECT sealed FROM browser_observation_items WHERE seq=3").get() as {sealed:string};
    db.query("UPDATE browser_observation_items SET sealed=? WHERE seq=4").run(row.sealed);
    expect(()=>queue.batch(g)).toThrow();
  }finally{db.close();}
});
