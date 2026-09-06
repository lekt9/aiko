import {expect,test} from "bun:test";
import {createBrowserUnlockAuth,type BrowserUnlockNavigation,type PrivateUnlockInstall,type PrivateUnlockScope,type BrowserUnlockAuthOptions} from "../src/browser-unlock-auth.ts";
import type {ConnectorVaultConfig} from "../src/connector-vault.ts";
import type {ConnectorSearch} from "../src/connectors.ts";
const tenant="11111111-1111-4111-8111-111111111111",profile="22222222-2222-4222-8222-222222222222",runtime="33333333-3333-4333-8333-333333333333",connection="44444444-4444-4444-8444-444444444444",job="55555555-5555-4555-8555-555555555555";
const nav:BrowserUnlockNavigation={owner:"123",contextId:"context_a",generation:1,url:"https://example.com/dashboard"};
const absent:ConnectorSearch={status:"absent",connectors:[],fallbackAllowed:true,message:"Catalog fixture confirmed absent"};
function fixture(overrides:Partial<BrowserUnlockAuthOptions>={}) {
 let config:ConnectorVaultConfig|undefined={origin:"https://vault.example.net",accounts:{"123":{token:"fixture-runtime-private-token",tenantId:tenant,profileId:profile,runtimeId:runtime,connections:{"example.com":connection}}}};
 let current={owner:nav.owner,contextId:nav.contextId,generation:nav.generation};
 let search:ConnectorSearch=absent;
 const expiry=Date.now()+60000;
 const status:{tenantId:string;profileId:string;runtimeId:string;connectionId:string;allowedDomains:string[];verified:boolean;revision:number;expiresAt:number;renewable?:boolean}={tenantId:tenant,profileId:profile,runtimeId:runtime,connectionId:connection,allowedDomains:["example.com"],verified:true,revision:7,expiresAt:expiry};
 const metadata={id:connection,name:"Example",identity:"owner@example.com",website:"https://example.com",domains:["example.com"],recipeId:"approved-login",maintenance:true,version:2,sourceId:null,sourceReference:null,hasPassword:true,deleted:false};
 const material={connectionId:connection,profileId:profile,runtimeId:runtime,allowedDomains:["example.com"],revision:7,expiresAt:expiry,cookies:[{name:"sid",value:"fixture-private-cookie-value",domain:"example.com",path:"/",expires:-1,secure:true,httpOnly:true,sameSite:"Lax" as const,hostOnly:true}]};
 const calls:{path:string;method:string}[]=[],installs:PrivateUnlockInstall[]=[],clears:PrivateUnlockScope[]=[];
 let statusReads=0;let custom:((path:string)=>Response|undefined)|undefined;
 const broker=createBrowserUnlockAuth({owner:"123",config:()=>config,context:{contextId:nav.contextId,generation:nav.generation},currentContext:async()=>current,engine:{search:async()=>search},
  install:async packet=>{installs.push(structuredClone(packet));const {cookies,connectionGeneration,expiresAt,...ack}=packet;return ack;},
  clear:async scope=>{clears.push(structuredClone(scope));},
  transport:async(target,init)=>{
   const url=new URL(String(target));expect(url.origin).toBe("https://vault.example.net");expect(init?.redirect).toBe("manual");expect(init?.credentials).toBe("omit");
   expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-runtime-private-token");
   calls.push({path:url.pathname,method:init?.method??"GET"});
   const altered=custom?.(url.pathname);if(altered)return altered;
   if(url.pathname.endsWith("/status")){statusReads++;return Response.json(status);}
   if(url.pathname.endsWith("/session"))return Response.json(material);
   if(url.pathname.endsWith("/renew")){expect(init?.body).toBe("{}");return Response.json({id:job},{status:202});}
   if(url.pathname==="/v1/runtime/connections")return Response.json([metadata]);
   throw new Error("Unexpected private fixture request");
  },...overrides});
 return {broker,calls,installs,clears,status,material,metadata,getStatusReads:()=>statusReads,
  setConfig:(next:ConnectorVaultConfig|undefined)=>{config=next;},getConfig:()=>config!,setContext:(next:typeof current)=>{current=next;},setSearch:(next:ConnectorSearch)=>{search=next;},setTransport:(handler:typeof custom)=>{custom=handler;}};
}

test("actual SDK paths verify, retrieve, install through private seam; receipt has no material or identities",async()=>{
 const f=fixture();const receipt=await f.broker.beforeNavigate(nav);
 expect(receipt).toEqual({status:"ready",revision:7});expect(f.installs).toHaveLength(1);
 expect(f.installs[0]).toMatchObject({owner:"123",contextId:"context_a",generation:1,tenantId:tenant,profileId:profile,runtimeId:runtime,connectionId:connection,connectionGeneration:2,revision:7,allowedDomains:["example.com"]});
 expect(f.installs[0]?.cookies[0]?.value).toBe("fixture-private-cookie-value");
 expect(JSON.stringify(f.installs)).not.toContain("fixture-runtime-private-token");
 expect(JSON.stringify(receipt)).not.toMatch(/cookie|token|tenant|runtime|profile|password|sid/);
 expect(f.calls.map(c=>c.path)).toEqual(["/v1/runtime/connections",`/v1/runtime/connections/${connection}/status`,`/v1/runtime/connections/${connection}/session`,"/v1/runtime/connections",`/v1/runtime/connections/${connection}/status`,`/v1/runtime/connections/${connection}/status`]);
 expect(f.getStatusReads()).toBe(3);
 expect(await f.broker.beforeNavigate({...nav,url:"https://example.com/next"})).toEqual(receipt);expect(f.installs).toHaveLength(1);
 expect(f.calls.filter(c=>c.path.endsWith("/session"))).toHaveLength(1);
});

for(const state of ["available","unavailable","absent_without_authority"] as const)test(`Arcade ${state} never authorizes cookie fallback`,async()=>{
 const f=fixture();f.setSearch({...absent,status:state==="absent_without_authority"?"absent":state,fallbackAllowed:state==="available"});
 const r=await f.broker.beforeNavigate(nav);expect(r.status).toBe(state==="available"?"not_applicable":"unavailable");expect(f.calls).toHaveLength(0);expect(f.installs).toHaveLength(0);
});

for(const field of ["tenantId","profileId","runtimeId","connectionId"] as const)test(`foreign runtime status ${field} cannot retrieve/install`,async()=>{
 const f=fixture();f.status[field]=job;expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.installs).toHaveLength(0);expect(f.calls.some(c=>c.path.endsWith("/session"))).toBe(false);
});

test("foreign owner, unassigned domain, stale context generation and removed config never install",async()=>{
 for(const change of [{owner:"456"},{contextId:"other"},{generation:2},{url:"https://unassigned.com"}]) {
  const f=fixture();const r=await f.broker.beforeNavigate({...nav,...change});expect(r.status).not.toBe("ready");expect(f.calls).toHaveLength(0);expect(f.installs).toHaveLength(0);
 }
 const f=fixture();f.setConfig(undefined);expect((await f.broker.beforeNavigate(nav)).status).toBe("not_applicable");expect(f.calls).toHaveLength(0);
});

for(const reason of ["revoked","expired","generation","revision","domain","cookie"] as const)test(`${reason} session evidence is rejected without installation`,async()=>{
 const f=fixture();
 if(reason==="revoked")f.status.verified=false;
 if(reason==="expired")f.status.expiresAt=Date.now()-1;
 if(reason==="generation")f.setTransport(path=>{if(path.endsWith("/session")){f.metadata.version++;return Response.json(f.material);}return undefined;});
 if(reason==="revision")f.material.revision++;
 if(reason==="domain")f.material.allowedDomains=["other.com"];
 if(reason==="cookie")f.material.cookies[0]!.domain="other.com";
 expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.installs).toHaveLength(0);
});

test("revocation, owner mapping rotation or browser generation change during retrieve prevents install",async()=>{
 for(const change of ["revoked","context","config"] as const){
  const f=fixture();f.setTransport(path=>{if(path.endsWith("/session")){
   if(change==="revoked")f.status.verified=false;
   if(change==="context")f.setContext({...nav,generation:2});
   if(change==="config")f.getConfig().accounts["123"]!.connections["example.com"]=job;
   return Response.json(f.material);
  }return undefined;});
  expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.installs).toHaveLength(0);
 }
});

test("already installed scope is cleared when access is revoked or Arcade authority changes",async()=>{
 for(const reason of ["revoked","arcade"] as const){
  const f=fixture();expect((await f.broker.beforeNavigate(nav)).status).toBe("ready");
  if(reason==="revoked")f.status.verified=false;else f.setSearch({...absent,status:"unavailable",fallbackAllowed:false});
  expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.installs).toHaveLength(1);expect(f.clears).toHaveLength(1);expect(f.clears[0]?.allowedDomains).toEqual(["example.com"]);
 }
});

test("SDK renewal delegates a reviewed recipe once, returns pending, never supplies a password or installs",async()=>{
 const f=fixture();f.status.verified=false;f.status.revision=0;f.status.expiresAt=0;
 expect(await f.broker.requestRenewal(nav)).toEqual({status:"renewal_pending"});
 expect(await f.broker.requestRenewal(nav)).toEqual({status:"renewal_pending"});
 expect(f.calls.filter(c=>c.method==="POST")).toEqual([{path:`/v1/runtime/connections/${connection}/renew`,method:"POST"}]);expect(f.installs).toHaveLength(0);
 expect((await f.broker.beforeNavigate(nav)).status).toBe("renewal_pending");
});

test("revoked/stale/expired rows cannot be renewed by ambiguous metadata; uncertain renewal is never retried",async()=>{
 const revoked=fixture();revoked.status.verified=false;expect((await revoked.broker.requestRenewal(nav)).status).toBe("unavailable");expect(revoked.calls.some(c=>c.method==="POST")).toBe(false);
 const failed=fixture();failed.setTransport(path=>path.endsWith("/renew")?Response.json({error:{code:"UNAVAILABLE",password:"private error"}},{status:503}):undefined);
 const r=await failed.broker.requestRenewal(nav);expect(r.status).toBe("unavailable");expect((await failed.broker.requestRenewal(nav)).status).toBe("unavailable");expect(failed.calls.filter(c=>c.method==="POST")).toHaveLength(1);expect(JSON.stringify(r)).not.toContain("private error");
});

test("redirects, non-approved vault origin, revoked HTTP grants and malformed SDK material fail closed",async()=>{
 for(const response of [new Response(null,{status:302,headers:{Location:"https://evil.test"}}),Response.json({error:{code:"REVOKED"}},{status:403}),Response.json({secret:"private"})]) {
  const f=fixture();f.setTransport(()=>response.clone());expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.calls).toHaveLength(1);expect(f.installs).toHaveLength(0);
 }
 const f=fixture();f.getConfig().origin="http://127.0.0.1";expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.calls).toHaveLength(0);
});

test("broader unassigned allowed domain cannot smuggle cookies into another site",async()=>{
 const f=fixture();f.status.allowedDomains.push("other.com");f.metadata.domains.push("other.com");
 expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(f.installs).toHaveLength(0);expect(f.calls.some(c=>c.path.endsWith("/session"))).toBe(false);
});

test("private ack binding mismatch or revocation during installation clears partial jar",async()=>{
 for(const fault of ["ack","revoked"] as const){
  let state:ReturnType<typeof fixture>;
  state=fixture({install:async packet=>{state.installs.push(packet);if(fault==="revoked")state.status.verified=false;return {...packet,owner:fault==="ack"?"456":packet.owner};}});
  expect((await state.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(state.installs).toHaveLength(1);expect(state.clears).toHaveLength(1);
 }
});

test("uncooperative transport is deadline bounded and pre-cancelled calls cannot install",async()=>{
 const f=fixture({timeoutMs:15,transport:async()=>new Promise(()=>{})});const start=Date.now();expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect(Date.now()-start).toBeLessThan(500);expect(f.installs).toHaveLength(0);
 const c=new AbortController();c.abort();const cancelled=fixture();expect((await cancelled.broker.beforeNavigate(nav,c.signal)).status).toBe("unavailable");expect(cancelled.calls).toHaveLength(0);
});

test("failed installation and failed cleanup cannot become a cached ready session",async()=>{
 let attempts=0,clears=0;
 const f=fixture({install:async()=>{attempts++;throw new Error("Private install failed");},clear:async()=>{clears++;throw new Error("Private clear failed");}});
 expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");
 expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");
 expect(attempts).toBe(1);expect(clears).toBeGreaterThan(1);
});

test("first navigation of never-published assigned recipe mechanically requests renewal, but does not install",async()=>{
 const f=fixture();f.status.verified=false;f.status.revision=0;f.status.expiresAt=0;
 expect(await f.broker.beforeNavigate(nav)).toEqual({status:"renewal_pending"});
 expect(await f.broker.beforeNavigate(nav)).toEqual({status:"renewal_pending"});
 expect(f.calls.filter(c=>c.method==="POST")).toHaveLength(1);expect(f.installs).toHaveLength(0);
});

test("switching assigned connections clears the old jar before new metadata is fetched",async()=>{
 const f=fixture();expect((await f.broker.beforeNavigate(nav)).status).toBe("ready");
 f.getConfig().accounts["123"]!.connections["other.com"]=job;
 f.setTransport(path=>{expect(f.clears).toHaveLength(1);return Response.json({error:{code:"REVOKED"}},{status:403});});
 expect((await f.broker.beforeNavigate({...nav,url:"https://other.com"})).status).toBe("unavailable");expect(f.installs).toHaveLength(1);
});

for (const initial of [false,true]) test(`authoritative renewable flag permits ${initial?"initial":"expired"} SDK maintenance once`,async()=>{
 const f=fixture();f.status.verified=false;f.status.renewable=true;f.status.expiresAt=initial?0:Date.now()-1000;if(initial)f.status.revision=0;
 expect(await f.broker.beforeNavigate(nav)).toEqual({status:"renewal_pending"});
 expect(await f.broker.requestRenewal(nav)).toEqual({status:"renewal_pending"});
 expect(f.calls.filter(c=>c.method==="POST")).toHaveLength(1);expect(f.installs).toHaveLength(0);
});

test("authoritative renewable false blocks initial and revoked rows, and legacy expired stays denied",async()=>{
 for(const initial of [false,true]){
  const f=fixture();f.status.verified=false;f.status.renewable=false;f.status.expiresAt=0;if(initial)f.status.revision=0;
  expect((await f.broker.beforeNavigate(nav)).status).toBe("unavailable");expect((await f.broker.requestRenewal(nav)).status).toBe("unavailable");expect(f.calls.some(c=>c.method==="POST")).toBe(false);expect(f.installs).toHaveLength(0);
 }
 const legacy=fixture();legacy.status.verified=false;legacy.status.expiresAt=Date.now()-1;
 expect((await legacy.broker.requestRenewal(nav)).status).toBe("unavailable");expect(legacy.calls.some(c=>c.method==="POST")).toBe(false);
});

test("a later published revision can renew independently without replaying an uncertain prior POST",async()=>{
 const f=fixture();f.status.verified=false;f.status.renewable=true;f.status.expiresAt=Date.now()-1;
 expect((await f.broker.beforeNavigate(nav)).status).toBe("renewal_pending");
 f.status.revision++;expect((await f.broker.requestRenewal(nav)).status).toBe("renewal_pending");
 expect((await f.broker.beforeNavigate(nav)).status).toBe("renewal_pending");expect(f.calls.filter(c=>c.method==="POST")).toHaveLength(2);
});
