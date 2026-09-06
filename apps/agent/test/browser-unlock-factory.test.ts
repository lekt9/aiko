import { afterEach, expect, spyOn, test } from "bun:test";
import { withUnlockBrowser } from "../src/browser-unlock-factory.ts";
import type { BrowserDriver } from "../src/browser-driver.ts";
import type { ConnectorVaultConfig } from "../src/connector-vault.ts";
import type { ConnectorSearch } from "../src/connectors.ts";
import type { PrivateUnlockInstall } from "../src/browser-unlock-auth.ts";

const tenant="11111111-1111-4111-8111-111111111111",profile="22222222-2222-4222-8222-222222222222",runtime="33333333-3333-4333-8333-333333333333",connection="44444444-4444-4444-8444-444444444444",job="55555555-5555-4555-8555-555555555555";
let restore:undefined|(()=>void);
afterEach(()=>{restore?.();restore=undefined;});
async function fixture() {
 const order:string[]=[],events:object[]=[],packets:PrivateUnlockInstall[]=[];
 const config:ConnectorVaultConfig={origin:"https://vault.example.net",accounts:{"123":{token:"fixture-private-runtime-key",tenantId:tenant,profileId:profile,runtimeId:runtime,connections:{"example.com":connection}}}};
 const context={owner:"123",contextId:"private_browser",generation:1};
 const status={tenantId:tenant,profileId:profile,runtimeId:runtime,connectionId:connection,allowedDomains:["example.com"],verified:true,revision:4,expiresAt:Date.now()+60000,renewable:false};
 const meta={id:connection,name:"Example",identity:"owner@example.com",website:"https://example.com",domains:["example.com"],recipeId:"approved-recipe",maintenance:true,version:2,sourceId:null,sourceReference:null,hasPassword:true,deleted:false};
 let failClear=false,denyHttp=false;
 const mock=spyOn(globalThis,"fetch").mockImplementation(async(target,init)=>{
  const url=new URL(String(target));expect(url.origin).toBe(config.origin);expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-private-runtime-key");
  const endpoint=url.pathname.split("/").at(-1)!;order.push(`sdk:${endpoint}`);
  if(denyHttp)return Response.json({error:{code:"REVOKED"}},{status:403});
  if(endpoint==="connections")return Response.json([meta]);
  if(endpoint==="status")return Response.json(status);
  if(endpoint==="renew"){expect(init?.method).toBe("POST");expect(init?.body).toBe("{}");return Response.json({id:job},{status:202});}
  if(endpoint==="session")return Response.json({connectionId:connection,profileId:profile,runtimeId:runtime,revision:status.revision,expiresAt:status.expiresAt,allowedDomains:["example.com"],cookies:[{name:"sid",value:"fixture-private-session",domain:"example.com",path:"/",secure:true,httpOnly:true,sameSite:"Lax",hostOnly:true,expires:-1}]});
  throw new Error("Unexpected SDK fixture path");
 });restore=()=>mock.mockRestore();
 const driver:BrowserDriver={
  sessionContext:async()=>({...context}),
  installSession:async packet=>{order.push(`install:${packet.revision}`);packets.push(structuredClone(packet));const {cookies,expiresAt,connectionGeneration,...ack}=packet;return ack;},
  clearSession:async()=>{order.push("clear");if(failClear)throw new Error("Private clear failed");},
  execute:async action=>{order.push(`execute:${action.action}`);return {completed:true};},
  screenshot:async()=>{order.push("screenshot");return new Uint8Array([1,2,3]);},
  requestRehydrate:async pointerId=>{order.push("replay");return {pointerId,status:"completed",code:"completed",counts:{steps:1,requests:1,redirects:0,producerEvaluations:0,wasmCalls:0,jsCalls:0},consumed:true};},
  requestTransport:{send:async()=>{order.push("transport");return {status:200,headers:{},body:{ok:true}};}},
  close:async()=>{order.push("close");},
 };
 const absent:ConnectorSearch={status:"absent",connectors:[],fallbackAllowed:true,message:"Confirmed fixture catalog absence"};
 let search=absent;
 const wrapped=await withUnlockBrowser(async()=>driver,{config,engine:owner=>{expect(owner).toBe("123");return {search:async()=>search};}})({owner:"123",domains:["*"],emit:async e=>{events.push(e);}});
 return {wrapped,driver,order,events,packets,status,meta,context,config,setSearch:(next:ConnectorSearch)=>{search=next;},failClear:()=>{failClear=true;},denyHttp:()=>{denyHttp=true;}};
}
const navigation={action:"navigate" as const,url:"https://example.com/dashboard"};

test("actual host wrapper and SDK install before first navigation, recheck without reinjection, replace changed revision",async()=>{
 const f=await fixture();const first=await f.wrapped.execute(navigation);
 expect(first).toEqual({completed:true});expect(f.order.indexOf("install:4")).toBeGreaterThan(f.order.indexOf("sdk:session"));expect(f.order.indexOf("execute:navigate")).toBeGreaterThan(f.order.indexOf("install:4"));
 expect(f.packets).toHaveLength(1);expect(f.packets[0]?.cookies[0]?.value).toBe("fixture-private-session");expect(JSON.stringify(f.packets)).not.toContain("fixture-private-runtime-key");
 const before=f.order.length;await f.wrapped.execute({...navigation,url:"https://example.com/next"});
 expect(f.order.slice(before)).toContain("sdk:status");expect(f.order.slice(before)).not.toContain("sdk:session");expect(f.packets).toHaveLength(1);
 f.status.revision=5;await f.wrapped.execute(navigation);expect(f.packets).toHaveLength(2);expect(f.packets[1]?.revision).toBe(5);expect(f.order.lastIndexOf("install:5")).toBeLessThan(f.order.lastIndexOf("execute:navigate"));
 expect(f.events).toEqual([]);expect(JSON.stringify(first)).not.toMatch(/fixture-private|cookies|tenant|runtime|password/);
});

test("revocation clears jar and blocks screenshot, response replay, transport and ordinary execution",async()=>{
 const f=await fixture();await f.wrapped.execute(navigation);const before=f.order.length;f.status.verified=false;f.status.renewable=false;
 await expect(f.wrapped.screenshot!()).rejects.toThrow("Unlock session");expect(f.order.slice(before)).toContain("clear");expect(f.order).not.toContain("screenshot");
 await expect(f.wrapped.requestRehydrate!("pointer")).rejects.toThrow("Unlock session");expect(f.order).not.toContain("replay");
 await expect(Promise.resolve(f.wrapped.requestTransport!.send({stepId:"request",attempt:1,method:"GET",url:"https://example.com/api",headers:{},redirect:"manual"}))).rejects.toThrow("Unlock session");expect(f.order).not.toContain("transport");
 await expect(f.wrapped.execute(navigation)).rejects.toThrow("Unlock session");expect(f.order.filter(x=>x.startsWith("execute:"))).toHaveLength(1);
});

test("failed cleanup never permits screenshot or replay, and close still destroys driver",async()=>{
 const f=await fixture();await f.wrapped.execute(navigation);f.failClear();f.denyHttp();
 await expect(f.wrapped.screenshot!()).rejects.toThrow();await expect(f.wrapped.requestRehydrate!("pointer")).rejects.toThrow();expect(f.order).not.toContain("screenshot");expect(f.order).not.toContain("replay");
 await f.wrapped.close();expect(f.order.at(-1)).toBe("close");
});

test("unassigned public domain uses ordinary browser without any SDK request or install",async()=>{
 const f=await fixture();await f.wrapped.execute({...navigation,url:"https://public.example.org/page"});await f.wrapped.screenshot!();await f.wrapped.requestRehydrate!("public-pointer");
 expect(f.order).toEqual(["execute:navigate","screenshot","replay"]);expect(f.packets).toHaveLength(0);
});

test("screenshot and replay are blocked before first owner-validated navigation",async()=>{
 const f=await fixture();await expect(f.wrapped.screenshot!()).rejects.toThrow("Navigate");await expect(f.wrapped.requestRehydrate!("pointer")).rejects.toThrow("Navigate");expect(f.order).toEqual([]);
});

test("renewable expired session queues one SDK recipe and blocks navigation until verified renewal arrives",async()=>{
 const f=await fixture();f.status.verified=false;f.status.renewable=true;f.status.expiresAt=Date.now()-1000;
 await expect(f.wrapped.execute(navigation)).rejects.toThrow("Unlock session");await expect(f.wrapped.execute(navigation)).rejects.toThrow("Unlock session");
 expect(f.order.filter(x=>x==="sdk:renew")).toHaveLength(1);expect(f.packets).toHaveLength(0);expect(f.order).not.toContain("execute:navigate");
 f.status.verified=true;f.status.renewable=false;f.status.revision++;f.status.expiresAt=Date.now()+60000;
 await f.wrapped.execute(navigation);expect(f.packets).toHaveLength(1);expect(f.order.at(-1)).toBe("execute:navigate");
});

test("generation change invalidates cached jar before private screenshot",async()=>{
 const f=await fixture();await f.wrapped.execute(navigation);f.context.generation++;
 await expect(f.wrapped.screenshot!()).rejects.toThrow("Unlock session");expect(f.order).toContain("clear");expect(f.order).not.toContain("screenshot");
});

test("Arcade failure never invokes SDK or native session installation",async()=>{
 const f=await fixture();f.setSearch({status:"unavailable",connectors:[],fallbackAllowed:false,message:"Catalog unavailable"});
 await expect(f.wrapped.execute(navigation)).rejects.toThrow("Unlock session");expect(f.order).toEqual([]);
});
