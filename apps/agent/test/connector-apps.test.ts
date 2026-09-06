import { describe, expect, test } from "bun:test";
import { ConnectorEngine } from "../src/connectors.ts";
function fixture(pendingUrl?: string, verifiedAuthId = "grant", arcadeOAuthEnabled = true) {
  const rows = new Map<string, unknown>(); const calls: Array<{path:string; body:any}> = [];
  const tools = ["Gmail", "Linkedin", "ApiKeyOnly"].flatMap(name => Array.from({length:name === "Linkedin" ? 1 : 3},(_, i) => ({ qualified_name: `${name}.Action${i}`, toolkit:{name}, description:"app action", requirements:{authorization:{provider_id:name.toLowerCase(), provider_type:name === "ApiKeyOnly" ? "api_key" : "oauth2", oauth2:{scopes:[`scope${i}`]}}} })));
  const engine = new ConnectorEngine({arcadeOAuthEnabled,owner:"acct_app_test01", env:{ARCADE_API_KEY:"test"}, store:{get:async k=>rows.get(k),set:async(k,v)=>{rows.set(k,v)},list:async p=>[...rows].filter(([k])=>k.startsWith(p)).map(([,v])=>v)},fetch:async(url,init)=>{
    const path = String(url).replace("https://api.arcade.dev/v1/", ""); const body = init?.body ? JSON.parse(String(init.body)):undefined; calls.push({path,body});
    if(String(url)==="https://cloud.arcade.dev/api/v1/oauth/confirm_user") return Response.json({auth_id:verifiedAuthId,next_uri:"https://untrusted.example"});
    if (path.startsWith("tools?")) return Response.json({items:tools,total_count:tools.length,offset:0});
    if(path.startsWith("admin/auth_providers")) return Response.json({items:["gmail","linkedin"].map(provider_id=>({id:`arcade-${provider_id}`,provider_id,type:"oauth2",status:"active"}))});
    if(path === "auth/authorize") return Response.json({id:"grant",provider_id:"gmail",user_id:"acct_app_test01",status:pendingUrl?"pending":"completed",...(pendingUrl?{url:pendingUrl}:{})});
    if(path.startsWith("auth/status?")) return Response.json({id:"grant",provider_id:"gmail",user_id:"acct_app_test01",status:"pending"});
    if(path === "tools/execute") return Response.json({success:true,output:{value:{ok:true}}});
    throw Error(path);
  }}); return {engine,calls};
}
describe("app OAuth",()=>{
 test("groups only full OAuth apps and authorizes their scope union once",async()=>{
  const {engine,calls}=fixture(); const {apps}=await engine.apps(); expect(apps.map(a=>a.name)).toEqual(["Gmail"]);
  expect((await engine.apps("linkedin")).apps).toHaveLength(0);
  const grant=await engine.connectApp(apps[0]!.id); expect(grant.toolIds).toHaveLength(3);
  expect((await engine.connectApp(apps[0]!.id)).id).toBe(grant.id);
  expect(calls.filter(c=>c.path === "auth/authorize")).toHaveLength(1);
  expect(calls.find(c=>c.path === "auth/authorize")!.body.auth_requirement.oauth2.scopes).toEqual(["scope0","scope1","scope2"]);
  expect((await engine.execute(grant.id,{},"arcade:Gmail.Action2")).status).toBe("succeeded");
  await expect(engine.execute(grant.id,{},"arcade:Linkedin.Action0")).rejects.toThrow();
  await engine.disconnect(grant.id); await expect(engine.execute(grant.id,{},"arcade:Gmail.Action2")).rejects.toThrow();
 });
});

test("app OAuth accepts the provider URL returned by the owner/provider-bound Arcade response", async()=>{
 const {engine}=fixture("https://accounts.google.com/o/oauth2/v2/auth?state=opaque");
 const app=(await engine.apps()).apps[0]!;
 const connection=await engine.connectApp(app.id);
 expect(connection.status).toBe("pending");expect(new URL(connection.authorizationUrl!).hostname).toBe("accounts.google.com");
 expect((await engine.completeAuth(connection.id)).authorizationUrl).toBe(connection.authorizationUrl);
});
test("app OAuth rejects unsafe authorization destinations",async()=>{
 const {engine}=fixture("http://127.0.0.1/login");const app=(await engine.apps()).apps[0]!;
 await expect(engine.connectApp(app.id)).rejects.toThrow();
});

test("native verifier checks the saved auth ID and never uses a caller-supplied owner or redirect",async()=>{
 const {engine,calls}=fixture("https://accounts.google.com/oauth");const app=(await engine.apps()).apps[0]!;
 const connection=await engine.connectApp(app.id,{origin:"https://aiko.example",key:"test-key-with-at-least-24-characters"});
 expect(connection.authorizationUrl).toStartWith("https://aiko.example/connect/oauth/launch?");
 expect(calls.find(c=>c.path === "auth/authorize")!.body.auth_requirement.id).toBe("arcade-gmail");
 expect(calls.find(c=>c.path === "auth/authorize")!.body.next_uri).toBeUndefined();
 expect((await engine.oauthBrowser(connection.id,"launch")).authorizationUrl).toBe("https://accounts.google.com/oauth");
 expect((await engine.oauthBrowser(connection.id,"verify","flow_123")).status).toBe("pending");
 expect(calls.find(c=>c.path.includes("confirm_user"))!.body).toEqual({flow_id:"flow_123",user_id:"acct_app_test01"});
 await engine.disconnect(connection.id);await expect(engine.oauthBrowser(connection.id,"verify","flow_123")).rejects.toThrow();
 const other=fixture("https://accounts.google.com/oauth","foreign-auth");const otherApp=(await other.engine.apps()).apps[0]!;const grant=await other.engine.connectApp(otherApp.id,{origin:"https://aiko.example",key:"test-key-with-at-least-24-characters"});
 await expect(other.engine.oauthBrowser(grant.id,"verify","flow_123")).rejects.toThrow("flow mismatch");
});


test("disabled OAuth exposes no apps and blocks grants and browser callbacks without contacting Arcade", async()=>{
 const {engine,calls}=fixture(undefined,"grant",false);
 expect(await engine.apps()).toMatchObject({apps:[],oauthEnabled:false});
 await expect(engine.connectApp("app:gmail:gmail")).rejects.toThrow("disabled");
 await expect(engine.connect("arcade:Gmail.Action0")).rejects.toThrow("disabled");
 await expect(engine.oauthBrowser("00000000-0000-0000-0000-000000000000","verify","flow_123")).rejects.toThrow("disabled");
 expect(calls).toHaveLength(0);
});
