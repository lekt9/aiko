/** Actual local Workerd/SQLite verification; synthetic data only, no remote bindings. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp("/tmp/aiko-memory-workerd-");
const worker = `
import { DurableObject } from "cloudflare:workers";
import { cloudflareStorage } from ${JSON.stringify(join(root, "packages/entity-learn/lib/cloudflare.ts"))};
import { openGuardedMemory } from ${JSON.stringify(join(root, "apps/agent/src/memory-restore.ts"))};
import { createMemoryAuthorityRegistry } from ${JSON.stringify(join(root, "apps/agent/src/memory-authority-host.ts"))};
import { prepareMemoryErasure, memoryErasureAuthority, memoryAuthorityFingerprint } from ${JSON.stringify(join(root, "apps/agent/src/memory-erasure-authority.ts"))};
import { memoryRestoreAdmission } from ${JSON.stringify(join(root, "apps/agent/src/memory-restore-authority.ts"))};
import { nativeMemoryImportPublication } from ${JSON.stringify(join(root, "apps/agent/src/memory-import-publication.ts"))};
import { createMemoryWriteAuthority } from ${JSON.stringify(join(root, "apps/agent/src/memory-write-authority.ts"))};
import { createCloudflareAccountHost } from ${JSON.stringify(join(root, "apps/agent/src/cloudflare-host.ts"))};
import { Effect, Layer } from ${JSON.stringify(Bun.resolveSync("effect", join(root, "apps/agent")))};
import { Self } from ${JSON.stringify(Bun.resolveSync("tardie/core/runtime", join(root, "apps/agent")))};
import { memoryTools } from ${JSON.stringify(join(root, "apps/agent/src/memory.ts"))};
import { harnessBlobStore } from ${JSON.stringify(join(root, "apps/agent/src/harness-library.ts"))};
import { memoryObservationDependency } from ${JSON.stringify(join(root, "apps/agent/src/retained-result-dependencies.ts"))};
import { createHmac, createHash } from "node:crypto";
const check=(v,message)=>{if(!v)throw Error(message);};
const rejects=(run,pattern)=>{let message="";try{run();}catch(e){message=String(e);}check(message.includes(pattern),"Expected rejection: "+pattern+" got "+message);};
export class Fixture extends DurableObject {
 async fetch(request) {
  try {
   const storage=cloudflareStorage(this.ctx.storage), scope="aiko:fixture";
   let failWrite=false;
   const hooked={...storage,prepare(sql){const stmt=storage.prepare(sql);return {...stmt,run(...args){const result=stmt.run(...args);if(failWrite&&sql.startsWith("INSERT INTO aiko_memory_erasure_authority"))throw Error("injected checkpoint failure");return result;}};}};
   const memory=openGuardedMemory({storage:hooked,scope});
   const path=new URL(request.url).pathname;
   const claim=(subject,payload)=>({subject,title:subject,type:"note",payload});
   const write=key=>({key,producer:{kind:"agent",reference:"fixture"}});
   if(path==="/prepare") {
    rejects(()=>memory.checkArchiveErasure(new Proxy({}, {get(){throw Error("archive touched");}})),"authority");
    const a=memory.remember(claim("private-a","fixture-private"),write("a"));
    const kept=memory.remember({...claim("kept","independent"),links:[{subject:a.subject,relation:"see"}]},write("kept"));
    const old=memory.exportArchive(),beforeAuthority=storage.prepare("SELECT * FROM aiko_memory_erasure_authority").get();
    check(memory.prepareSubjectErasure({subject:a.subject,expectedHead:a.id,expectedScopeVersion:memory.scan().sourceVersion,key:"first-prepare"}).key==="first-prepare","first-write checkpoint unavailable");
    const input={subject:a.subject,expectedHead:a.id,expectedScopeVersion:memory.journal.scopeVersion(scope),key:"erase-a"};
    failWrite=true;rejects(()=>memory.eraseSubject(input),"injected checkpoint failure");failWrite=false;
    check(JSON.stringify(memory.exportArchive())===JSON.stringify(old),"deletion rollback failed");
    check(JSON.stringify(storage.prepare("SELECT * FROM aiko_memory_erasure_authority").get())===JSON.stringify(beforeAuthority),"checkpoint rollback failed");
    const erased=memory.eraseSubject(input), fence=memory.erasureFence();
    const retained=JSON.parse(String(storage.prepare("SELECT fence FROM aiko_memory_erasure_authority").get().fence));
    check(JSON.stringify(retained)===JSON.stringify(fence),"atomic fence mismatch");
    memory.eraseSubject(input);
    const current=memory.exportArchive(), replacement=erased.replacements.find(r=>r.previous===kept.id).observation;
    await this.ctx.storage.put("fixture",{old,current,fence,replacement,removed:a.id});
    await this.ctx.storage.sync();
    return Response.json({ok:true,atomic:true,rollback:true,missingAuthority:true});
   }
   const fixture=await this.ctx.storage.get("fixture");check(fixture,"fixture missing");
   if(path==="/lose") {
    check(JSON.stringify(memory.erasureFence())===JSON.stringify(fixture.fence),"cold fence mismatch");
    this.ctx.storage.transactionSync(()=>{for(const table of ["observations","heads","sources","artifacts","journal"])this.ctx.storage.sql.exec("DELETE FROM "+table);});
    await this.ctx.storage.sync();return Response.json({ok:true,lostTables:true});
   }
   if(path==="/restore") {
    rejects(()=>memory.remember(claim("new","forbidden"),write("new")),"restored before");
    rejects(()=>memory.importArchive(fixture.old),"fence");
    check(memory.journal.scopeVersion(scope)===0,"rejected restore changed journal");
    memory.checkArchiveErasure(fixture.current);memory.importArchive(fixture.current);
   }
   if(path==="/restore"||path==="/verify") {
    check(JSON.stringify(memory.erasureFence())===JSON.stringify(fixture.fence),"restored fence mismatch");
    check(memory.get(fixture.removed)===null,"deleted fact resurrected");
    const kept=memory.get(fixture.replacement).observation;
    check(kept.payload==="independent"&&kept.links.length===0,"canonical retained fact mismatch");
    memory.rebuild();await this.ctx.storage.sync();return Response.json({ok:true,canonical:true,fence:true});
   }
   return new Response("unknown",{status:404});
  } catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}
 }
}
export class ExternalMemory extends DurableObject {
 async fetch(request) {
  const path=new URL(request.url).pathname, scenario=path.split("/")[2], action=path.split("/")[3], owner="56789",scope="aiko:"+owner;
  const remote=this.env.AUTHORITY.get(this.env.AUTHORITY.idFromName("external-"+scenario));
  const command=(method,...args)=>remote.command(method,args);
  const fingerprint=value=>createHmac("sha256","synthetic-independent-key").update(JSON.stringify(value)).digest("hex");
  let dropClaim=true,dropComplete=true;
  const authority={owner,writer:1,fingerprint,read:owner=>command("read",owner),event:(owner,key)=>command("event",owner,key),
   erasureClaim:(owner,key)=>command("erasureClaim",owner,key),append:async(owner,event)=>{const result=await command("append",owner,event);
    if(event.type==="AikoMemoryAuthorityClaimed"&&dropClaim){dropClaim=false;throw Error("claim acknowledgement lost");}
    if(event.type==="AikoMemoryAuthorityEraseCommitted"&&dropComplete){dropComplete=false;throw Error("completion acknowledgement lost");}return result;}};
  const memory=openGuardedMemory({storage:cloudflareStorage(this.ctx.storage),scope});
  const blobs=harnessBlobStore({get:key=>this.ctx.storage.get(key),put:(key,value)=>this.ctx.storage.put(key,value),list:async prefix=>[...(await this.ctx.storage.list({prefix})).values()],
   update:(key,fn)=>this.ctx.storage.transaction(async tx=>{const value=fn(await tx.get(key));await tx.put(key,value);return value;})});
  const denied=async(run)=>{let failed=false;try{await run();}catch{failed=true;}check(failed,"expected external authority rejection");};
  try {
   if(action==="prepare") {
    await command("admit",owner);
    const target=memory.remember({subject:"private",title:"Private",type:"fact",payload:"SYNTHETIC_PRIVATE"},{key:"target",producer:{kind:"agent",reference:"fixture"}});
    const keep=memory.remember({subject:"keep",title:"Keep",type:"fact",payload:"INDEPENDENT",links:[{subject:target.subject,relation:"see"}]},{key:"keep",producer:{kind:"agent",reference:"fixture"}});
    const input={subject:target.subject,expectedHead:target.id,expectedScopeVersion:memory.scan().sourceVersion,key:"native-original"};
    const native=memoryTools({owner,thread:"user-"+owner,stateDir:"no-files",redact:value=>value,readPage:async()=>[],openMemory:()=>memory,withErasure:run=>run()}, {fixtures:false}).find(t=>t.spec.name==="memory_erase");
    const beforeDefault=JSON.stringify(memory.exportArchive());
    const refused=await Effect.runPromise(native.run({subject:input.subject,expected:input.expectedHead,expectedScopeVersion:input.expectedScopeVersion},{callId:"no-authority",signal:new AbortController().signal}).pipe(Effect.provideService(Self,{actor:"aiko",instance:"fixture",thread:"user-"+owner})));
    check(refused.outcome==="error"&&refused.result?.error?.code==="authority_unavailable"&&JSON.stringify(memory.exportArchive())===beforeDefault,"default native erasure bypassed independent authority");
    const privateRef=await blobs.putPrivate(owner,{value:"PRIVATE_COPY"},[memoryObservationDependency(target.id)]),keepRef=await blobs.putPrivate(owner,{value:"INDEPENDENT_COPY"});
    const controller=new AbortController();
    if(scenario==="cancel") {const append=authority.append;authority.append=async(owner,event)=>{try{return await append(owner,event);}finally{if(event.type==="AikoMemoryAuthorityClaimed")controller.abort();}};}
    const lease=await prepareMemoryErasure({memory,authority,input,signal:controller.signal});
    if(scenario==="cancel") {await denied(()=>lease.prepare());rejects(()=>lease.erase(),"abort");check(!memory.subjectErasureReceipt(input.key),"cancelled deletion");}
    else {await lease.prepare();if(scenario==="cleanup")lease.erase();}
    await this.ctx.storage.put("fixture",{input,privateRef,keepRef,receiptKey:lease.receiptKey,version:memory.scan().sourceVersion,target:target.id,keep:keep.id});
    // Entire synthetic account-side SQLite + KV loss, not just its memory
    // projection. The independent authority DO must retain the original claim.
    if(scenario==="loss")await this.ctx.storage.deleteAll();
    check((await authority.read(owner)).pending.native.receiptKey===lease.receiptKey,"external pending claim missing");
    await this.ctx.storage.sync();return Response.json({ok:true,scenario,claimRetained:true,claimAckLost:true});
   }
   const fixture=await this.ctx.storage.get("fixture"),current=await authority.read(owner);check(current.pending,"external claim lost on cold restart");
   await denied(()=>command("advanceWriter",owner)); // pending holds even against deployment handoff
   await denied(()=>authority.append(owner,{...current.pending,key:"competing-restore",kind:"restore",native:undefined,expectedRevision:current.revision}));
   if(scenario==="cleanup") {
    const lease=await prepareMemoryErasure({memory,authority,resume:fixture.receiptKey});
    check(!(await lease.prepare()).deletionRequired,"cleanup attempted new deletion");rejects(()=>lease.erase(),"not admitted");
    const row=memory.journal.receipt(scope,fixture.receiptKey).event,ids=[...row.erasure.observationIds,...row.erasure.replacements.map(r=>r.previous)];
    const copies=await blobs.eraseDependencies(owner,ids.map(memoryObservationDependency),fixture.receiptKey);
    const cleanup={status:"complete",reference:"registered-private-results:"+copies.operation,digest:fingerprint(copies)};
    await lease.complete(cleanup);await lease.complete(cleanup);
    await denied(()=>lease.complete({...cleanup,digest:"a".repeat(64)}));
    check(!(await authority.read(owner)).pending,"completion did not settle");check(memory.scan().sourceVersion===fixture.version,"cleanup changed memory revision");
    await denied(()=>blobs.get(owner,fixture.privateRef));check((await blobs.get(owner,fixture.keepRef)).value==="INDEPENDENT_COPY","unrelated copy lost");
    check(memory.get(row.erasure.replacements[0].observation).observation.payload==="INDEPENDENT","canonical fact lost");
    await this.ctx.storage.sync();return Response.json({ok:true,scenario,cleanupOnly:true,completionAckLost:true,unrelatedPreserved:true});
   }
   const lease=memoryErasureAuthority({memory,authority,claim:current.pending,fingerprint});
   if(scenario==="cancel") {await lease.abortUnchanged();check(!(await authority.read(owner)).pending,"verified abort held");check(memory.get(fixture.target),"abort lost original fact");}
   else {await denied(()=>lease.abortUnchanged());await denied(()=>lease.prepare());check((await authority.read(owner)).pending,"lost host released claim");}
   await this.ctx.storage.sync();return Response.json({ok:true,scenario,unchangedAbort:scenario==="cancel",hostLossHeld:scenario==="loss"});
  }catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}finally{memory.close();}
 }
}
export class NativeWrite extends DurableObject {
 async fetch(request) {
  const preparing=new URL(request.url).pathname.endsWith("/prepare"),owner="67890",writer=preparing?1:2;
  const remote=this.env.AUTHORITY.get(this.env.AUTHORITY.idFromName("native-write")),command=(method,...args)=>remote.command(method,args,writer);
  try {
   if(preparing)await command("admit",owner);
   const authority={owner,writer,fingerprint:memoryAuthorityFingerprint(await command("key",owner)),read:owner=>command("read",owner),
    event:(owner,key)=>command("event",owner,key),erasureClaim:(owner,key)=>command("erasureClaim",owner,key),append:(owner,event)=>command("append",owner,event)};
   const storage=cloudflareStorage(this.ctx.storage);let memory;
   const control=createMemoryWriteAuthority({storage,memory:()=>memory,authority});
   memory=openGuardedMemory({storage,scope:"aiko:"+owner,writeAuthority:control.guard});
   const write=key=>({key,producer:{kind:"agent",reference:"synthetic-workerd-write"}});
   if(preparing) {
    const entered=Promise.withResolvers();
    this.ctx.waitUntil(control.write("interrupted-source",{},async()=>{
     memory.remember({subject:"partial",title:"Partial",type:"fact",payload:"NATIVE_WRITE_PARTIAL"},write("partial"));
     entered.resolve();await new Promise(()=>{});
    }));
    await entered.promise;await this.ctx.storage.sync();
    check((await command("read",owner)).pending.kind==="write","write admission missing before process cut");
    return Response.json({ok:true,nativePartialCommit:true,executionHeld:true});
   }
   check((await control.reconcile("interrupted-source")).status==="pending","unknown writer released without native fence");
   let denied=false;try{await command("advanceWriter",owner);}catch{denied=true;}check(denied,"pending writer allowed takeover");
   const before=JSON.stringify(memory.exportArchive());
   const result=await control.reconcile("interrupted-source",{fence:true});
   check(result.status==="closed"&&result.receipt.outcome==="interrupted","native write closure not verified");
   check(before===JSON.stringify(memory.exportArchive()),"writer reconciliation changed native memory");
   rejects(()=>memory.remember({subject:"unadmitted",title:"Denied",type:"fact",payload:"denied"},write("unadmitted")),"admission");
   check((await command("advanceWriter",owner)).writer===2,"writer handoff blocked after native closure");
   await control.write("new-source",{},()=>memory.remember({subject:"new",title:"New",type:"fact",payload:"NEW_GENERATION"},write("new")));
   check(memory.scan().items.length===2,"partial memory lost or source executed again");
   await this.ctx.storage.sync();memory.close();
   return Response.json({ok:true,nativeExecutionFenced:true,partialPreserved:true,reexecuted:false,writerHandoff:true});
  }catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}
 }
}
export class NativeImport extends DurableObject {
 async fetch(request) {
  const path=new URL(request.url).pathname,owner="67890",scope="aiko:"+owner,importId="native-import-001",operationId="restore:account:"+importId;
  const writer=path.endsWith("/reconcile")?2:1;
  const remote=this.env.AUTHORITY.get(this.env.AUTHORITY.idFromName("native-import")),command=(method,...args)=>remote.command(method,args,writer);
  if(path.endsWith("/prepare"))await command("admit",owner);
  let failSync=false;
  const storage={sql:this.ctx.storage.sql,transactionSync:run=>this.ctx.storage.transactionSync(run),sync:async()=>{await this.ctx.storage.sync();if(failSync)throw Error("native import acknowledgement lost");},
   getAlarm:()=>this.ctx.storage.getAlarm(),setAlarm:at=>this.ctx.storage.setAlarm(at),deleteAlarm:()=>this.ctx.storage.deleteAlarm()};
  const host=await createCloudflareAccountHost({storage,actorName:"aiko",actorInstance:"native-import",ownsThread:t=>t==="user-"+owner,actorFor:()=>undefined,layersFor:()=>Layer.empty});
  const state=await command("read",owner),fence=state?.fence;
  const memory=openGuardedMemory({storage:cloudflareStorage(this.ctx.storage),scope,...(path.endsWith("/source")?{}:{restoreAuthority:()=>fence})});
  const denied=async(run)=>{let failed=false;try{await run();}catch{failed=true;}check(failed,"expected native import rejection");};
  try {
   if(path.endsWith("/source")) {
    const fact=memory.remember({subject:"kept",title:"Keep",type:"fact",payload:"NATIVE_IMPORT_SYNTHETIC"},{key:"keep",producer:{kind:"agent",reference:"fixture"}});
    await host.seed("user-"+owner,[{type:"Archived",id:"settled",at:1}]);
    return Response.json({archive:memory.exportArchive(),histories:host.exportHistory(),fact:fact.id});
   }
   let fixture=await this.ctx.storage.get("fixture");
   if(path.endsWith("/prepare")) {
    const source=this.env.IMPORT.get(this.env.IMPORT.idFromName("source"));
    const response=await source.fetch(new Request("http://fixture/native-import/source"));check(response.ok,"native source failed");fixture=await response.json();
    await this.ctx.storage.put("fixture",fixture);
   }
   check(fixture,"native fixture missing");
   const sidecarFingerprint=createHash("sha256").update(JSON.stringify(fixture.archive)).digest("hex");
   const nativeDigest=createHash("sha256").update(JSON.stringify([fixture.histories,sidecarFingerprint])).digest("hex");
   const fingerprint=memoryAuthorityFingerprint(await command("key",owner))(["native-import",owner,importId,nativeDigest]);
   const authority={read:owner=>command("read",owner),event:(owner,key)=>command("event",owner,key),append:async(owner,event)=>{const result=await command("append",owner,event);if(event.type==="AikoMemoryAuthorityRestoreSettled")throw Error("authority settlement acknowledgement lost");return result;}};
   const publication=nativeMemoryImportPublication({owner,memory,storage:cloudflareStorage(this.ctx.storage),importId,operationId,fingerprint,archive:fixture.archive,histories:fixture.histories,history:host.exportHistory});
   const lease=await memoryRestoreAdmission({owner,writer,authority,operationId:"account:"+importId,fingerprint,publication});
   if(path.endsWith("/prepare")) {
    check((await lease.prepare()).status==="admitted","native restore not admitted");
    check((await lease.reconcile()).status==="pending","absent import claimed success");
    failSync=true;
    await denied(()=>host.importHistory(importId,fixture.histories,{fingerprint:createHash("sha256").update(JSON.stringify(fixture.archive)).digest("hex"),import:()=>memory.importArchive(fixture.archive)}));
    failSync=false;
    check(memory.get(fixture.fact),"native commit lost with acknowledgement");
    check((await command("read",owner)).pending,"authority released before verification");
    await this.ctx.storage.sync();return Response.json({ok:true,nativeImportCommitted:true,acknowledgementLost:true});
   }
   const before=JSON.stringify(host.exportHistory());
   await denied(()=>lease.prepare());await denied(()=>lease.check());await denied(()=>command("advanceWriter",owner));
   check((await lease.reconcile()).status==="published","original import receipt not reconciled");
   check((await lease.prepare()).status==="published","terminal admitted new work");
   await denied(()=>lease.check());
   check((await lease.reconcile()).status==="published","exact terminal replay failed");
   check(JSON.stringify(host.exportHistory())===before,"reconciliation changed native logs");
   check(memory.get(fixture.fact).observation.payload==="NATIVE_IMPORT_SYNTHETIC","original citation lost");
   check(!(await command("read",owner)).pending,"native import claim held after verified completion");
   check((await command("advanceWriter",owner)).writer===2,"verified recovery did not permit writer handoff");
   await this.ctx.storage.sync();return Response.json({ok:true,publicationReconciled:true,secondImport:false,originalCitation:true,writerHandoff:true});
  }catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}finally{failSync=false;memory.close();await host.close();}
 }
}
export class Authority extends DurableObject {
 async command(method,args,writer=1) {
  check([1,2].includes(writer)&&["admit","key","read","append","event","erasureClaim","advanceWriter"].includes(method),"fixture command denied");
  const registry=await createMemoryAuthorityRegistry(this.ctx.storage,method==="advanceWriter"?2:writer);
  try{return await registry[method](...args);}finally{await registry.close();}
 }
 async fetch(request) {
  const path=new URL(request.url).pathname, writer=path==="/authority/prepare"?1:2;
  const registry=await createMemoryAuthorityRegistry(this.ctx.storage,writer);
  const denied=async(run)=>{let failed=false;try{await run();}catch{failed=true;}check(failed,"expected authority rejection");};
  try {
   const owner="12345", scope="aiko:"+owner;
   if(path==="/authority/prepare") {
    this.ctx.storage.sql.exec("CREATE TRIGGER reject_membership BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'membership failure'); END");
    await denied(()=>registry.admit(owner,1));
    check(!(await registry.list()).length&&!await registry.read(owner),"membership failure left authority");
    this.ctx.storage.sql.exec("DROP TRIGGER reject_membership");
    this.ctx.storage.sql.exec("CREATE TRIGGER reject_authority BEFORE INSERT ON aiko_thread_events WHEN NEW.key LIKE 'aiko-memory-authority:%' BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END");
    await denied(()=>registry.admit(owner,1));
    check(!(await registry.list()).length&&!await registry.read(owner),"authority failure left membership");
    this.ctx.storage.sql.exec("DROP TRIGGER reject_authority");
    check(await registry.admit(owner,1),"admission failed");
    check(!await registry.admit("23456",1),"cap admitted");
    check(!await registry.read("23456"),"cap retained checkpoint");
    check(!(await registry.list()).some(r=>r.owner==="23456"),"cap retained membership");
    this.ctx.storage.sql.exec("INSERT INTO accounts VALUES(?,?)","34567",0);
    check(await registry.admit("34567",1),"legacy admission lost");
    check(!await registry.read("34567"),"legacy invented zero");
    const initial=await registry.read(owner);check(initial.revision===1&&initial.fence.seq===0,"initial checkpoint");
    const claim={type:"AikoMemoryAuthorityClaimed",owner,scope,writer:1,key:"restore",at:1,expectedRevision:1,kind:"restore",fingerprint:"a".repeat(64),beforeFence:initial.fence};
    await registry.append(owner,claim);
    await denied(()=>registry.append(owner,{...claim,key:"competing"}));
    await denied(()=>registry.append(owner,{...claim,owner:"foreign"}));
    check((await registry.read(owner)).revision===2,"rejected append mutated log");
   } else {
    check((await registry.list()).length===2,"cold membership lost");
    check(!await registry.read("34567"),"cold legacy invented zero");
    const current=await registry.read(owner);
    if(path==="/authority/settle") {
     check(current.pending?.key==="restore"&&current.writer===1,"pending lost");
     await denied(()=>registry.advanceWriter(owner));
     const old=await createMemoryAuthorityRegistry(this.ctx.storage,1);
     try {await old.append(owner,{type:"AikoMemoryAuthorityRestoreSettled",owner,scope,writer:1,key:"settled",at:2,expectedRevision:2,claimKey:"restore",witness:{status:"cancelled",operationId:"restore",fingerprint:"a".repeat(64),fence:current.fence,reference:"controlled-cancellation",digest:"b".repeat(64)}});}finally{await old.close();}
     check((await registry.advanceWriter(owner)).writer===2,"writer advance failed");
    } else {
     check(current.writer===2&&!current.pending&&current.revision===4,"writer transition not durable");
     const old=await createMemoryAuthorityRegistry(this.ctx.storage,1);
     try {await denied(()=>old.advanceWriter(owner));}finally{await old.close();}
    }
   }
   check(await this.ctx.storage.getAlarm()===null,"registry scheduled alarm");
   await this.ctx.storage.sync();return Response.json({ok:true,phase:path,noAlarm:true});
  }catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}
  finally{await registry.close();}
 }
}
export default {fetch(request,env){const path=new URL(request.url).pathname;if(path==="/ready")return Response.json({ready:true});if(path.startsWith("/native-write/"))return env.WRITE.get(env.WRITE.idFromName("writer")).fetch(request);if(path.startsWith("/native-import/"))return env.IMPORT.get(env.IMPORT.idFromName("target")).fetch(request);if(path.startsWith("/external/"))return env.EXTERNAL.get(env.EXTERNAL.idFromName(path.split("/")[2])).fetch(request);if(path.startsWith("/authority/"))return env.AUTHORITY.get(env.AUTHORITY.idFromName("registry")).fetch(request);return env.FIXTURE.get(env.FIXTURE.idFromName("fixture")).fetch(request);}};
`;
await writeFile(join(dir,"worker.ts"),worker);
// Freeze the current dirty candidate, not HEAD. Discover the actual bundled
// dependency closure, hash it around a second build, and restart only the emitted
// immutable bundle. Shared source edits after this point cannot drift the run.
const buildOptions = { entrypoints: [join(dir,"worker.ts")], target: "browser" as const, conditions: ["workerd"],
  external: ["cloudflare:workers", "node:*"], metafile: true };
const discovered = await Bun.build(buildOptions);
if (!discovered.success) throw new AggregateError(discovered.logs,"Fixture bundle failed");
const inputs = Object.keys(discovered.metafile!.inputs).map(path => resolve(path));
inputs.push(fileURLToPath(import.meta.url),join(root,"pnpm-lock.yaml"),join(root,"apps/agent/package.json"),join(root,"packages/entity-learn/package.json"),join(root,"packages/entity-learn/provenance.json"));
const hashes = async () => Object.fromEntries(await Promise.all([...new Set(inputs)].sort().map(async path =>
  [path,createHash("sha256").update(await readFile(path)).digest("hex")])));
const before = await hashes(), built = await Bun.build(buildOptions), after = await hashes();
assert.equal(built.success,true,"Frozen fixture bundle failed");
assert.deepEqual(after,before,"Source changed while freezing fixture");
assert.deepEqual(Object.keys(built.metafile!.inputs).sort(),Object.keys(discovered.metafile!.inputs).sort(),"Bundle graph changed");
assert.equal(built.outputs.length,1,"Unexpected fixture build outputs");
const bundle = new Uint8Array(await built.outputs[0]!.arrayBuffer()), bundleSha256=createHash("sha256").update(bundle).digest("hex");
await writeFile(join(dir,"worker.js"),bundle);
await writeFile(join(dir,"source-freeze.json"),JSON.stringify({inputs:before,bundleSha256,bun:Bun.version},null,2));
await writeFile(join(dir,"wrangler.json"),JSON.stringify({name:"memory-restore-local",main:join(dir,"worker.js"),no_bundle:true,compatibility_date:"2026-09-01",compatibility_flags:["nodejs_compat"],durable_objects:{bindings:[{name:"FIXTURE",class_name:"Fixture"},{name:"AUTHORITY",class_name:"Authority"},{name:"EXTERNAL",class_name:"ExternalMemory"},{name:"IMPORT",class_name:"NativeImport"},{name:"WRITE",class_name:"NativeWrite"}]},migrations:[{tag:"v1",new_sqlite_classes:["Fixture","Authority","ExternalMemory","NativeImport","NativeWrite"]}]}));
const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));
const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
let child:ReturnType<typeof Bun.spawn>|undefined;let log="";
const evidence:unknown[]=[];
async function stop(){if(!child)return;const process=child;process.kill("SIGINT");const timer=setTimeout(()=>process.kill("SIGKILL"),10000);try{await process.exited;}finally{clearTimeout(timer);child=undefined;}}
async function start(){
 child=Bun.spawn(["node",join(root,"apps/agent/node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",join(dir,"wrangler.json"),"--persist-to",join(dir,".wrangler/state"),"--port",String(port),"--ip","127.0.0.1"],{cwd:dir,stdin:"ignore",stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH!,CI:"true",XDG_CONFIG_HOME:join(dir,"config"),WRANGLER_SEND_METRICS:"false"}});
 for(const stream of [child.stdout,child.stderr])void(async()=>{for await(const chunk of stream as ReadableStream<Uint8Array>)log+=new TextDecoder().decode(chunk);})();
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){if(child.exitCode!==null)throw Error("Workerd exited: "+child.exitCode);try{if((await fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await Bun.sleep(200);}
 throw Error("Workerd startup timeout");
}
async function call(path:string){const response=await fetch('http://127.0.0.1:'+port+path,{signal:AbortSignal.timeout(10000)});const body=await response.text();assert.equal(response.status,200,body);evidence.push({path,result:JSON.parse(body)});}
try{
 await start();await call("/prepare");await call("/authority/prepare");
 for(const scenario of ["cleanup","cancel","loss"])await call(`/external/${scenario}/prepare`);
 await call("/native-import/prepare");await call("/native-write/prepare");await stop();
 await start();await call("/lose");await call("/authority/settle");
 for(const scenario of ["cleanup","cancel","loss"])await call(`/external/${scenario}/recover`);
 await call("/native-import/reconcile");await call("/native-write/reconcile");await stop();
 await start();await call("/restore");await stop();
 await start();await call("/verify");await call("/authority/verify");
 const report={verified:true,runtime:"actual local workerd",coldRestarts:3,providerCalls:0,bundleSha256,sourceInputs:Object.keys(before).length,evidence,directory:dir};
 await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(log.slice(-12000));throw error;}
finally{await stop();await writeFile(join(dir,"workerd.log"),log);await writeFile(join(dir,"evidence.json"),JSON.stringify(evidence,null,2));await rm(join(dir,".wrangler"),{recursive:true,force:true});console.log("Retained fixture/logs: "+dir);}
