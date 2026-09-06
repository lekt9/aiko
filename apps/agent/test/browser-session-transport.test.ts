import {expect,test} from "bun:test";
import {createCdpCookieAdapter,type PrivateCdp} from "../../../packages/sdk/src/cdp.ts";
import {PrivateBrowserSessions,type PrivateSessionInstall,type PrivateSessionRecord,type PrivateBrowserContext,openPrivateBrowserCdp,createOwnedCookieAdapter} from "../src/browser-driver.ts";
import {replayKeys,wrapReplay,unwrapReplay,sealReplay,openReplay} from "../src/codegraff.ts";

const context:PrivateBrowserContext={owner:"alice",contextId:"owned-context",generation:1};
const domain="private.vendor.com";
function material(revision=1):PrivateSessionInstall{return {...context,domain,tenantId:"11111111-1111-4111-8111-111111111111",profileId:"22222222-2222-4222-8222-222222222222",runtimeId:"33333333-3333-4333-8333-333333333333",connectionId:"44444444-4444-4444-8444-444444444444",allowedDomains:[domain],connectionGeneration:1,revision,expiresAt:Date.now()+60000,cookies:[{name:"session",value:"PRIVATE_COOKIE_SENTINEL",domain,path:"/",expires:-1,secure:true,httpOnly:true,sameSite:"Strict",hostOnly:true}]};}
async function fixture(records:PrivateSessionRecord[]=[]){
 let jar:any[]=[{name:"unrelated",value:"KEEP_OTHER_DOMAIN",domain:"other.vendor.com",path:"/",session:true,secure:true,httpOnly:true,sameSite:"Lax"}];
 const calls:{method:string;params:any}[]=[];const saved:PrivateSessionRecord[]=[];
 let now=Date.now(),failSet=false;
 const cdp:PrivateCdp={send:async(method,params)=>{
  calls.push({method,params});
  if(method==="Target.getTargetInfo")return {targetInfo:{browserContextId:"sdk-context"}};
  if(method==="Target.attachToTarget")return {sessionId:"sdk-target-session"};
  if(method==="Storage.getCookies")return {cookies:structuredClone(jar)};
  if(method==="Network.deleteCookies")jar=jar.filter(c=>!(c.name===params.name&&c.domain===params.domain&&c.path===params.path&&JSON.stringify(c.partitionKey)===JSON.stringify(params.partitionKey)));
  if(method==="Storage.setCookies"){
   if(failSet){failSet=false;throw new Error("PRIVATE_BACKEND_ERROR");}
   jar.push(...(params.cookies as any[]).map(c=>({...c,domain:c.domain??new URL(c.url).hostname,session:c.expires===undefined})));
  }
  return {};
 }};
 const adapter=await createCdpCookieAdapter(cdp,{browserContextId:"sdk-context",targetId:"sdk-target"});
 const sessions=new PrivateBrowserSessions(context,async()=>adapter,row=>{saved.push(structuredClone(row))},records,()=>now);
 return {sessions,adapter,calls,saved,jar:()=>structuredClone(jar),advance:()=>{now+=120000},failNextSet:()=>{failSet=true}};
}

test("actual SDK CDP adapter installs privately, replaces deletions and partitions, and preserves unrelated domains",async()=>{
 const f=await fixture();
 try{
  const input=material();input.cookies.push({...input.cookies[0]!,name:"deleted",partitionKey:{topLevelSite:"https://private.vendor.com",hasCrossSiteAncestor:false}});
  const ack=await f.sessions.install(input);
  expect(ack).toEqual({owner:context.owner,contextId:context.contextId,generation:1,domain,tenantId:input.tenantId,profileId:input.profileId,runtimeId:input.runtimeId,connectionId:input.connectionId,allowedDomains:[domain],revision:1});
  expect(JSON.stringify(ack)).not.toContain("PRIVATE_COOKIE_SENTINEL");
  expect(f.jar().some(c=>c.httpOnly&&c.value==="PRIVATE_COOKIE_SENTINEL")).toBe(true);
  const next=material(2);next.cookies[0]!.value="NEW_PRIVATE_COOKIE";await f.sessions.install(next);
  expect(f.jar().filter(c=>c.domain===domain)).toHaveLength(1);
  expect(f.jar().find(c=>c.domain===domain).value).toBe("NEW_PRIVATE_COOKIE");
  expect(f.jar().find(c=>c.domain==="other.vendor.com").value).toBe("KEEP_OTHER_DOMAIN");
  expect(f.calls.some(c=>c.method==="Storage.clearCookies")).toBe(false);
  expect(f.calls.some(c=>c.method==="Network.deleteCookies"&&c.params.partitionKey)).toBe(true);
  expect(JSON.stringify(f.saved)).not.toMatch(/PRIVATE_COOKIE|cookies|password/);
 }finally{await f.sessions.close();}
});

test("owner/context/generation/domain mismatch, stale revision and expired material cannot install",async()=>{
 const f=await fixture();
 try{
  await f.sessions.install(material(3));const before=f.calls.length;
  for(const input of [{...material(4),owner:"bob"},{...material(4),contextId:"prior-context"},{...material(4),generation:2},{...material(4),allowedDomains:["other.vendor.com"]},{...material(4),expiresAt:0},material(2),{...material(4),connectionGeneration:0},{...material(4),cookies:[{...material().cookies[0]!,domain:".vendor.com",hostOnly:false}]}])await expect(f.sessions.install(input)).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
  expect(f.jar().find(c=>c.domain===domain).value).toBe("PRIVATE_COOKIE_SENTINEL");
 }finally{await f.sessions.close();}
});

test("same revision does not restore browser-deleted cookies; revocation fences stale reinstall",async()=>{
 const f=await fixture();
 try{
  const first=material();await f.sessions.install(first);
  await f.adapter.replaceCookies([],first.allowedDomains);
  await f.sessions.install(first);expect(f.jar().filter(c=>c.domain===domain)).toHaveLength(0);
  await f.sessions.clear(first);
  await expect(f.sessions.install(first)).rejects.toThrow("Stale");
  await f.sessions.install({...first,revision:2});expect(f.jar().some(c=>c.domain===domain)).toBe(true);
  f.advance();let performed=false;
  await expect(f.sessions.run(`https://${domain}/`,async()=>{performed=true})).rejects.toThrow("expired");
  expect(performed).toBe(false);expect(f.jar().filter(c=>c.domain===domain)).toHaveLength(0);
 }finally{await f.sessions.close();}
});

test("session reset on reconstruction clears prior profile jar; failure never acknowledges material",async()=>{
 const f=await fixture();
 const input=material();await f.sessions.install(input);const metadata=f.saved.at(-1)!;await f.sessions.close();
 const restored=await fixture([metadata]);
 try{
  await restored.adapter.replaceCookies(input.cookies,input.allowedDomains);
  await restored.sessions.run(`https://${domain}/`,async()=>{expect(restored.jar().some(c=>c.domain===domain)).toBe(false)});
  restored.failNextSet();await expect(restored.sessions.install({...input,revision:2})).rejects.toThrow("installation failed");
  expect(restored.jar().some(c=>c.domain===domain)).toBe(false);
  await expect(restored.sessions.install({...input,revision:2})).rejects.toThrow("Stale");
 }finally{await restored.sessions.close();}
});

test("encrypted private install channel contains no cookie values; acknowledgement is metadata only",async()=>{
 const f=await fixture(),keys=replayKeys();
 try{
  const sent=wrapReplay({operation:"session-install",input:material()},keys.publicKey);
  expect(JSON.stringify(sent.envelope)).not.toContain("PRIVATE_COOKIE_SENTINEL");
  const received=unwrapReplay(sent.envelope,keys.privateKey);
  const ack=await f.sessions.install(received.value.input);
  const response=sealReplay({output:ack},received.key);
  expect(openReplay(response,sent.key).output.revision).toBe(1);
  expect(JSON.stringify(f.saved)).not.toContain("PRIVATE_COOKIE_SENTINEL");
  expect(JSON.stringify(response)).not.toContain("PRIVATE_COOKIE_SENTINEL");
 }finally{await f.sessions.close();}
});

test("clear-before-install and cancellation fence in-flight stale session deliveries",async()=>{
 const f=await fixture();
 try{
  await f.sessions.clear(material());await expect(f.sessions.install(material())).rejects.toThrow("Stale");
  const aborted=new AbortController();aborted.abort();
  await expect(f.sessions.install({...material(),connectionId:crypto.randomUUID()},aborted.signal)).rejects.toThrow();
  expect(f.jar().some(c=>c.domain===domain)).toBe(false);
 }finally{await f.sessions.close();}
});

const liveEndpoint=process.env.AIKO_SESSION_TEST_CDP;
(liveEndpoint?test:test.skip)("live Chrome SDK adapter physically installs and revokes an HttpOnly session without model tools",async()=>{
 const cdp=await openPrivateBrowserCdp(liveEndpoint!);
 const targets=await cdp.send("Target.getTargets",{});const target=targets.targetInfos.find((t:any)=>t.type==="page");
 const adapter=await createOwnedCookieAdapter(cdp,{browserContextId:target.browserContextId,targetId:target.targetId});
 const metadata:PrivateSessionRecord[]=[];const sessions=new PrivateBrowserSessions(context,async()=>adapter,r=>{metadata.push(r)});
 try{
  await sessions.install(material());
  const actual=await adapter.exportCookies([domain]);expect(actual[0]?.value).toBe("PRIVATE_COOKIE_SENTINEL");expect(actual[0]?.httpOnly).toBe(true);
  await sessions.clear(material());expect(await adapter.exportCookies([domain])).toEqual([]);
  await expect(sessions.install(material())).rejects.toThrow("Stale");
  expect(JSON.stringify(metadata)).not.toContain("PRIVATE_COOKIE_SENTINEL");
 }finally{await sessions.close();cdp.close();}
});
