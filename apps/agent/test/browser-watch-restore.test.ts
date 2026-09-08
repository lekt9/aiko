import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalKeyring, VaultCipher } from "../../server/src/crypto.ts";
import { BrowserWatchRunner, type BrowserWatchLease } from "../src/browser-watch-runner.ts";
import { BrowserObservationQueue } from "../src/browser-event-queue.ts";
import { snapshotVm, readVmSnapshot, writeVmRestore, verifyVmRestore, publishVmRestore } from "../src/vm-backup.ts";
import { BACKUP_CHUNK_BYTES } from "../src/cloud-backup.ts";

const cipher = new VaultCipher(new LocalKeyring("test", {test:Buffer.alloc(32,9).toString("base64")}));
const lease = (producer:string, now:number):BrowserWatchLease => ({grant:{owner:"alice",producer,epoch:"original-epoch",generation:1,profile:"original-profile",connectionId:"site",connectionRevision:"1",registeredAt:now-100,expiresAt:now+3_600_000,active:true,origins:["https://example.com"],kinds:["push","network"],secret:"private-test-key-not-a-production-secret"},ingestUrl:"https://account.example/v1/browser-events/alice",networkRoutes:[{method:"GET",route:"/messages"}]});
const exchange = (now:number) => ({startedDateTime:new Date(now).toISOString(),request:{url:"https://example.com/messages",method:"GET"},response:{status:200}});
function runtime(db:Database, now:number) {
  const calls={capture:0,send:0,endpoint:0};
  const runner=new BrowserWatchRunner({owner:"alice",db,cipher,now:()=>now,
    authorized:grant=>!!db.query("SELECT 1 FROM native_login WHERE id=? AND state=?").get(grant.connectionId,JSON.stringify({domain:"example.com",status:"connected",revision:1})),
    endpoint:async()=>{calls.endpoint++;return "ws://127.0.0.1:9999/unused";},
    networkHealth:()=>({state:"watching",reason:"ready"}),
    fetch:async()=>{calls.send++;return new Response(null,{status:503});},
    createCapture:()=>{calls.capture++;return {health:{state:"watching",reason:"ready",targets:1,atMs:now},connect:async()=>{},close:async()=>{},renewRecording:async()=>{},flush:async()=>{}};},
  });
  return {runner,calls};
}
function contents(db:Database) {
  return Object.fromEntries(["browser_watch_leases","browser_observation_heads","browser_observation_items"].map(table=>[table,db.query(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
}
async function fixture(missingIdentity=false) {
  const now=Date.now(),root=await mkdtemp(join(tmpdir(),"watch-snapshot-")),target=await mkdtemp(join(tmpdir(),"watch-restored-"));
  const handles:Database[]=[],runners:BrowserWatchRunner[]=[];
  const cleanup=async()=>{for(const runner of runners.reverse())await runner.close();for(const db of handles.reverse())db.close();await rm(root,{recursive:true,force:true});await rm(target,{recursive:true,force:true});};
  try {
    await mkdir(join(root,"browser"),{mode:0o700});
    for(const dir of [root,target])await writeFile(join(dir,"owner.json"),JSON.stringify({owner:"alice"}),{mode:0o600});
    const db=new Database(join(root,"browser/request-evidence.sqlite"));handles.push(db);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE native_login(id TEXT PRIMARY KEY,state TEXT NOT NULL)");
    db.query("INSERT INTO native_login VALUES(?,?)").run("site",JSON.stringify({domain:"example.com",status:"connected",revision:1}));
    const initial=runtime(db,now);runners.push(initial.runner);
    const leases=[lease("active",now),lease("paused",now),lease("deleted",now)];
    const queue=new BrowserObservationQueue(db);
    for(const l of leases)await initial.runner.configure(l);
    for(const l of leases){
      for(let n=1;n<=2;n++)queue.append(l.grant,{kind:"push",observedAt:now,sourceId:"worker",fields:{origin:"https://example.com",outcome:"received"}},`original-${n}`,now);
      queue.batch(l.grant);queue.acknowledge(l.grant,1);
      queue.append(l.grant,{kind:"push",observedAt:now,sourceId:"worker",fields:{origin:"https://example.com",outcome:"received"}},"original-3",now);
    }
    await initial.runner.pause("paused");
    // Host deletion has already performed the same confirmed native pause.
    await initial.runner.pause("deleted");
    await initial.runner.close();
    if(missingIdentity)db.exec("DELETE FROM browser_observation_heads");
    const original=contents(db),id=randomUUID(),snapshot=await snapshotVm(root,id);
    for(const file of snapshot.files)for(let offset=0;offset<file.bytes;offset+=BACKUP_CHUNK_BYTES){
      const size=Math.min(BACKUP_CHUNK_BYTES,file.bytes-offset);
      await writeVmRestore(target,id,file.path,offset,await readVmSnapshot(root,id,file.path,offset,size));
    }
    await verifyVmRestore(target,id,"alice",snapshot.files);
    await publishVmRestore(target,id,"alice",[{id:"site",domain:"example.com",revision:1}]);
    const reopened=new Database(join(target,"browser/request-evidence.sqlite"));handles.push(reopened);
    const current=runtime(reopened,now);runners.push(current.runner);
    const restart=async()=>{await current.runner.close();const next=runtime(reopened,now);runners.push(next.runner);await next.runner.restore();return next;};
    return {now,root,target,db:reopened,leases,original,current,restart,cleanup};
  } catch(error){await cleanup();throw error;}
}

test("actual snapshot publication holds every recovered producer before a connected runner can capture or deliver",async()=>{
  const f=await fixture();try{
    expect(contents(f.db)).toEqual(f.original);
    expect(f.db.query("SELECT * FROM browser_watch_restore_holds").all()).toHaveLength(3);
    await f.current.runner.restore();
    const statuses=f.current.runner.status(),active=statuses.find(s=>s.producer==="active")!;
    expect(active).toMatchObject({state:"needs-attention",reason:"restore-authorization-required",restore:{queue:{head:3,acknowledged:1,offered:2}}});
    expect(active.restore!.challenge).toMatch(/^[a-f0-9-]{36}$/);expect(active.restore!.at).toBeGreaterThan(0);
    for(const producer of ["paused","deleted"])expect(statuses.find(s=>s.producer===producer)).toMatchObject({state:"paused",reason:"paused",pausedThrough:3,restore:{queue:{head:3,acknowledged:1,offered:2}}});
    await f.current.runner.observeNetwork(exchange(f.now),0,true);await f.current.runner.tick();
    expect(f.current.calls).toEqual({capture:0,send:0,endpoint:0});expect(contents(f.db)).toEqual(f.original);
    const restarted=await f.restart();
    expect(restarted.runner.status()).toEqual(statuses);expect(restarted.calls).toEqual({capture:0,send:0,endpoint:0});
    // A genuinely unrelated producer retains ordinary configuration behavior.
    await restarted.runner.configure(lease("fresh",f.now));
    await restarted.runner.observeNetwork(exchange(f.now),0,true);await restarted.runner.tick();
    expect(restarted.runner.status().find(s=>s.producer==="fresh")!.restore).toBeUndefined();
    expect(restarted.calls.capture).toBe(1);expect(restarted.calls.send).toBe(1);
    expect(new BrowserObservationQueue(f.db).verifiedState(f.leases[0]!.grant)).toEqual({head:3,acknowledged:1,offered:2});
  }finally{await f.cleanup();}
},30_000);

test("configure, lease renewal, pause and lifecycle resume never clear restore authorization",async()=>{
  const f=await fixture();try{
    await f.current.runner.restore();const initial=f.leases[0]!,hold=f.current.runner.status()[0]!.restore;
    expect((await f.current.runner.configure(initial)).restore).toEqual(hold);
    const renewed={...initial,grant:{...initial.grant,expiresAt:initial.grant.expiresAt+60_000},leaseRevision:1,renewalFrom:{leaseRevision:0,expiresAt:initial.grant.expiresAt}};
    expect(await f.current.runner.configure(renewed)).toMatchObject({state:"needs-attention",reason:"restore-authorization-required",leaseRevision:1,restore:hold});
    expect(await f.current.runner.pause("active",0)).toMatchObject({state:"paused",pausedThrough:3,restore:hold});
    const resumed={...renewed,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:3}};
    expect(await f.current.runner.configure(resumed)).toMatchObject({state:"needs-attention",reason:"restore-authorization-required",lifecycleRevision:1,restore:hold});
    await f.current.runner.observeNetwork(exchange(f.now),0,true);await f.current.runner.tick();
    expect(f.current.calls).toEqual({capture:0,send:0,endpoint:0});
    const restarted=await f.restart();expect(restarted.runner.status().find(s=>s.producer==="active")).toMatchObject({restore:hold,lifecycleRevision:1,leaseRevision:1});
    expect(restarted.calls).toEqual({capture:0,send:0,endpoint:0});
    expect(f.db.query("SELECT * FROM browser_observation_items ORDER BY 1,2").all()).toEqual(f.original.browser_observation_items);
  }finally{await f.cleanup();}
},30_000);

test("missing restored queue identity stays unavailable through restart and never invents a pause watermark",async()=>{
  const f=await fixture(true);try{
    await f.current.runner.restore();
    for(const status of f.current.runner.status()){expect(status.restore).toBeDefined();expect(status.restore!.queue).toBeUndefined();}
    expect(f.current.runner.status().find(s=>s.producer==="paused")).toMatchObject({state:"paused",pausedThrough:3});
    await f.current.runner.configure(f.leases[0]!);
    await expect(f.current.runner.pause("active")).rejects.toThrow("queue_watermark_unavailable");
    await expect(f.current.runner.configure({...f.leases[1]!,lifecycleRevision:1,resumeFrom:{lifecycleRevision:0,pausedThrough:3}})).rejects.toThrow("queue_watermark_unavailable");
    expect(f.db.query("SELECT * FROM browser_observation_heads").all()).toEqual([]);
    expect(f.current.calls).toEqual({capture:0,send:0,endpoint:0});
    const restarted=await f.restart();await restarted.runner.observeNetwork(exchange(f.now),0,true);await restarted.runner.tick();
    expect(restarted.calls).toEqual({capture:0,send:0,endpoint:0});
    expect(contents(f.db).browser_observation_heads).toEqual(f.original.browser_observation_heads);
    expect(contents(f.db).browser_observation_items).toEqual(f.original.browser_observation_items);
    const row=f.db.query("SELECT envelope FROM browser_watch_leases WHERE producer='active'").get() as {envelope:string};
    expect(await cipher.open("unlock:browser-watch:v1:alice:active",JSON.parse(row.envelope))).toEqual(f.leases[0]);
  }finally{await f.cleanup();}
},30_000);

test("read-only restore queue evidence rejects changed owner, grant and impossible cursors without mutation",()=>{
  const db=new Database(":memory:");try{
    const queue=new BrowserObservationQueue(db),l=lease("watch",Date.now());
    expect(queue.verifiedState(l.grant)).toBeUndefined();expect(db.query("SELECT * FROM browser_observation_heads").all()).toEqual([]);
    queue.highWatermark(l.grant);expect(queue.verifiedState(l.grant)).toEqual({head:0,acknowledged:0,offered:0});
    expect(queue.verifiedState({...l.grant,owner:"other"})).toBeUndefined();expect(queue.verifiedState({...l.grant,profile:"changed"})).toBeUndefined();
    db.exec("UPDATE browser_observation_heads SET offered=1");expect(queue.verifiedState(l.grant)).toBeUndefined();
    expect(db.query("SELECT offered FROM browser_observation_heads").get()).toEqual({offered:1});
  }finally{db.close();}
});
