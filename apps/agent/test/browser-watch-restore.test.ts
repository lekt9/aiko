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
import { holdRestoredBrowserWatches, type BrowserWatchReauthorizeRequest } from "../src/browser-watch-restore.ts";

const cipher = new VaultCipher(new LocalKeyring("test", {test:Buffer.alloc(32,9).toString("base64")}));
const lease = (producer:string, now:number):BrowserWatchLease => ({grant:{owner:"alice",producer,epoch:"original-epoch",generation:1,profile:"original-profile",connectionId:"site",connectionRevision:"1",registeredAt:now-100,expiresAt:now+3_600_000,active:true,origins:["https://example.com"],kinds:["push","network"],secret:"private-test-key-not-a-production-secret"},ingestUrl:"https://account.example/v1/browser-events/alice",networkRoutes:[{method:"GET",route:"/messages"}]});
const exchange = (now:number) => ({startedDateTime:new Date(now).toISOString(),request:{url:"https://example.com/messages",method:"GET"},response:{status:200}});
function runtime(db:Database, now:number,accept=false) {
  const calls={capture:0,send:0,endpoint:0};
  const runner=new BrowserWatchRunner({owner:"alice",db,cipher,now:()=>now,
    authorized:grant=>!!db.query("SELECT 1 FROM native_login WHERE id=? AND state=?").get(grant.connectionId,JSON.stringify({domain:"example.com",status:"connected",revision:1})),
    endpoint:async()=>{calls.endpoint++;return "ws://127.0.0.1:9999/unused";},
    networkHealth:()=>({state:"watching",reason:"ready"}),
    fetch:async(_url,init)=>{calls.send++;return accept?Response.json({status:"accepted",through:JSON.parse(String(init?.body)).items.at(-1).sequence},{status:202}):new Response(null,{status:503});},
    createCapture:()=>{calls.capture++;return {health:{state:"watching",reason:"ready",targets:1,atMs:now},connect:async()=>{},close:async()=>{},renewRecording:async()=>{},flush:async()=>{}};},
  });
  return {runner,calls};
}
async function heldMemory(accept=false){
  const db=new Database(":memory:"),now=Date.now(),l=lease("active",now);
  db.exec("CREATE TABLE native_login(id TEXT PRIMARY KEY,state TEXT NOT NULL)");
  db.query("INSERT INTO native_login VALUES(?,?)").run("site",JSON.stringify({domain:"example.com",status:"connected",revision:1}));
  const current=runtime(db,now);await current.runner.configure(l);
  const queue=new BrowserObservationQueue(db);
  for(let n=1;n<=3;n++)queue.append(l.grant,{kind:"push",observedAt:now,sourceId:"worker",fields:{origin:"https://example.com",outcome:"received"}},`prefix-${n}`,now);
  queue.batch(l.grant);queue.acknowledge(l.grant,1);
  await current.runner.close();holdRestoredBrowserWatches(db,"alice",now);
  const reopened=runtime(db,now,accept);await reopened.runner.restore();
  const challenge=reopened.runner.status()[0]!.restore!.challenge;
  const proof=reopened.runner.restoreProof("active",challenge,2);
  const {deliveryEpoch:previous,...scope}=proof;
  const request:BrowserWatchReauthorizeRequest={...scope,previousDeliveryEpoch:previous??null,deliveryEpoch:"restored-delivery-epoch"};
  return {db,now,l,queue,...reopened,request,cleanup:async()=>{await reopened.runner.close();db.close();}};
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
},60_000);

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
},60_000);

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
    expect(await cipher.open<BrowserWatchLease>("unlock:browser-watch:v1:alice:active",JSON.parse(row.envelope))).toEqual(f.leases[0]!);
  }finally{await f.cleanup();}
},60_000);

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

test("explicit prefix proof atomically rotates transport identity and keeps the original queued occurrences across restart",async()=>{
  const f=await heldMemory();let restarted:BrowserWatchRunner|undefined;try{
    const before=f.db.query("SELECT source,seq,fingerprint FROM browser_observation_items ORDER BY seq").all();
    const result=await f.runner.reauthorize("active",f.request);
    expect(result.restore).toBeUndefined();expect(result).toMatchObject({deliveryEpoch:f.request.deliveryEpoch,acknowledged:2});
    expect(f.calls).toEqual({capture:1,send:1,endpoint:1});
    const grant={...f.l.grant,deliveryEpoch:f.request.deliveryEpoch},batch=f.queue.batch(grant)!.batch;
    expect(batch).toMatchObject({producer:"active",epoch:f.l.grant.epoch,generation:1,deliveryEpoch:f.request.deliveryEpoch});
    expect(batch.items.map(item=>item.sequence)).toEqual([3]);
    expect(f.db.query("SELECT source,seq,fingerprint FROM browser_observation_items ORDER BY seq").all()).toEqual(before);
    expect(f.queue.append(grant,{kind:"push",observedAt:f.now,sourceId:"worker",fields:{origin:"https://example.com",outcome:"received"}},"prefix-1",f.now)).toMatchObject({status:"duplicate",sequence:1});
    await expect(f.runner.configure(f.l)).rejects.toThrow("delivery_epoch_changed");
    await f.runner.close();restarted=runtime(f.db,f.now).runner;await restarted.restore();
    expect((await restarted.reauthorize("active",f.request)).restore).toBeUndefined();
    expect(restarted.status()[0]).toMatchObject({deliveryEpoch:f.request.deliveryEpoch,acknowledged:2});
    await expect(restarted.reauthorize("active",{...f.request,deliveryEpoch:"another-epoch"})).rejects.toThrow("challenge_changed");
    expect(()=>restarted!.restoreProof("active",f.request.challenge,2)).toThrow("challenge_changed");
  }finally{await restarted?.close();await f.cleanup();}
});

test("restore proof and authorization reject identity, prefix, cursor and lease drift without releasing custody",async()=>{
  const f=await heldMemory();try{
    const original=contents(f.db);
    const changes:Partial<BrowserWatchReauthorizeRequest>[]=[{owner:"other"},{profile:"other"},{connectionRevision:"2"},{lifecycleRevision:1},{leaseRevision:1},{previousDeliveryEpoch:"not-current"},{challenge:randomUUID()},{at:f.request.at+1},{prefixDigest:"0".repeat(64)},{hostThrough:3},{queue:{...f.request.queue,head:4}}];
    for(const change of changes)await expect(f.runner.reauthorize("active",{...f.request,...change})).rejects.toThrow();
    expect(()=>f.runner.restoreProof("active",f.request.challenge,0)).toThrow("proof_unavailable");
    expect(()=>f.runner.restoreProof("active",f.request.challenge,4)).toThrow("proof_unavailable");
    expect(contents(f.db)).toEqual(original);expect(f.runner.status()[0]!.restore).toBeDefined();expect(f.calls.send).toBe(0);
    // The acknowledged prefix still needs its original fingerprints; row count alone is insufficient.
    f.db.exec("UPDATE browser_observation_items SET seq=0 WHERE seq=1");
    expect(()=>f.runner.restoreProof("active",f.request.challenge,2)).toThrow("prefix_unavailable");
  }finally{await f.cleanup();}
});

test("paused or disconnected producers cannot reauthorize, including revocation while the new lease is being sealed",async()=>{
  const f=await heldMemory();try{
    const seal=cipher.seal.bind(cipher);
    cipher.seal=async(...args)=>{const envelope=await seal(...args);f.db.exec("DELETE FROM native_login");return envelope;};
    try{await expect(f.runner.reauthorize("active",f.request)).rejects.toThrow("authority_unavailable");}finally{cipher.seal=seal;}
    expect(f.queue.verifiedState(f.l.grant)!.acknowledged).toBe(1);expect(f.runner.status()[0]!.restore).toBeDefined();expect(f.calls.send).toBe(0);
    f.db.query("INSERT INTO native_login VALUES(?,?)").run("site",JSON.stringify({domain:"example.com",status:"connected",revision:1}));
    await f.runner.pause("active");
    await expect(f.runner.reauthorize("active",f.request)).rejects.toThrow("authority_unavailable");
    expect(f.runner.status()[0]).toMatchObject({state:"paused",restore:{challenge:f.request.challenge}});
  }finally{await f.cleanup();}
});

test("a failed restore receipt commit rolls back the epoch, proven acknowledgment and hold removal together",async()=>{
  const f=await heldMemory();try{
    const original=contents(f.db);
    f.db.exec("CREATE TRIGGER reject_restore_receipt BEFORE INSERT ON browser_watch_restore_receipts BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
    await expect(f.runner.reauthorize("active",f.request)).rejects.toThrow("fixture commit failure");
    expect(contents(f.db)).toEqual(original);expect(f.runner.status()[0]!.restore).toBeDefined();expect(f.calls.send).toBe(0);
    f.db.exec("DROP TRIGGER reject_restore_receipt");
    expect((await f.runner.reauthorize("active",f.request)).restore).toBeUndefined();
  }finally{await f.cleanup();}
});

test("successful immediate tail delivery returns its actual advanced acknowledgment on an identical authorization retry",async()=>{
  const f=await heldMemory(true);try{
    expect(await f.runner.reauthorize("active",f.request)).toMatchObject({deliveryEpoch:f.request.deliveryEpoch,acknowledged:3});
    expect(await f.runner.reauthorize("active",f.request)).toMatchObject({deliveryEpoch:f.request.deliveryEpoch,acknowledged:3});
    expect(f.calls.send).toBe(1);
    expect(f.queue.verifiedState({...f.l.grant,deliveryEpoch:f.request.deliveryEpoch})).toEqual({head:3,acknowledged:3,offered:3});
  }finally{await f.cleanup();}
});

test("rotated delivery epoch is included when splitting a near-limit queue batch",()=>{
  const db=new Database(":memory:"),measurement=new Database(":memory:");try{
    const now=Date.now(),l=lease("sized",now),sample=new BrowserObservationQueue(measurement),queue=new BrowserObservationQueue(db);
    const input={kind:"push" as const,observedAt:now,sourceId:"worker",fields:{origin:"https://example.com",outcome:"received" as const},payload:{text:""}};
    for(let n=1;n<=2;n++)sample.append(l.grant,input,`sized-${n}`,now);
    const room=127_900-Buffer.byteLength(JSON.stringify(sample.batch(l.grant)!.batch));
    for(let n=1;n<=2;n++)queue.append(l.grant,{...input,payload:{text:"x".repeat(n===1?Math.floor(room/2):Math.ceil(room/2))}},`sized-${n}`,now);
    const batch=queue.batch({...l.grant,deliveryEpoch:"e".repeat(160)})!;
    expect(batch.batch.items).toHaveLength(1);expect(batch.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(batch.batch))).toBeLessThanOrEqual(128_000);
  }finally{db.close();measurement.close();}
});
