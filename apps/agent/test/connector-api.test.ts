import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const alice = "aiko_test_alice_12345678901234567890123456789012", bob = "aiko_test_bob_1234567890123456789012345678901234", reader = "aiko_test_reader_123456789012345678901234567890";
async function setup() {
 const stateDir = await mkdtemp('/tmp/aiko-connector-api-'); cleanup.push(() => rm(stateDir,{recursive:true,force:true}));
 const config: AikoConfig = { mode:'demo',port:4242,stateDir,operatorToken:'private-test-operator-1234567890123456',persona:PERSONA,voiceEnabled:false,allowedUsers:new Set(['123','456']),arcadeKey:'private-test-arcade-key-123456',planeCredentials:[{account:'123',digest:credentialDigest(alice),scopes:['read','write']},{account:'456',digest:credentialDigest(bob),scopes:['read','write']},{account:'123',digest:credentialDigest(reader),scopes:['read']}] };
 const calls: {url:string;body:any}[]=[];
 const connectorFetch = async (u: any, init?: RequestInit) => {
  const url=String(u), body=init?.body ? JSON.parse(String(init.body)):undefined; calls.push({url,body});
  if (url.includes('tools?')) return Response.json({items:[{qualified_name:'GitHub.List',toolkit:{name:'GitHub'},metadata:{classification:{service_domains:['github.com']}},input:{parameters:[]}}],total_count:1,offset:0});
  if (url.endsWith('/tools/authorize')) return Response.json({id:'fixture-auth',status:'pending',user_id:body.user_id,url:'https://api.arcade.dev/auth/fixture'});
  if (url.includes('/auth/status')) return Response.json({id:'fixture-auth',status:'completed',user_id:'123'});
  if (url.endsWith('/tools/execute')) return Response.json({success:true,output:{value:{items:['repo-a']}}});
  return Response.json({}, {status:404});
 };
 let service=await createService(config,{connectorFetch}); cleanup.push(()=>service.close());
 const request=(path:string,token:string|undefined=alice,body?:unknown)=>service.fetch(new Request('http://127.0.0.1:4242'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {request,calls,restart:async()=>{await service.close();service=await createService(config,{connectorFetch});}};
}
test('connector routes reject invalid arguments and private domains without secrets in error bodies',async()=>{
 const app=await setup();
 for(const [path,body] of [['/api/connectors/discover',{domain:'example.com',evidenceUrls:[1]}],['/api/connectors/execute',{connectionId:'x',input:[]}]] as const) expect((await app.request(path,alice,body)).status).toBe(400);
 const response=await app.request('/api/connectors/browser',alice,{domain:'127.0.0.1'}); expect(response.status).toBe(409);expect(await response.text()).not.toContain('private-test');
 expect((await app.request('/api/connectors?owner=456')).status).toBe(400);
});

test('router API executes the native account actor and returns separate task routes',async()=>{
 const app=await setup();
 const response=await app.request('/v1/connectors/route',alice,{tasks:[{id:'repos',query:'GitHub list repositories',domain:'github.com'}]});
 expect(response.status).toBe(200);
 const result=await response.json() as any;
 expect(result.owner).toBe('123');expect(result.state).toBe('needs_connection');expect(result.tasks[0].tools[0].id).toBe('arcade:GitHub.List');
 expect((await app.request('/api/connectors/route',reader,{query:'github'})).status).toBe(403);
 await app.restart();
 const next=await (await app.request('/api/connectors/route',bob,{query:'GitHub list'})).json() as any;
 expect(next.owner).toBe('456');expect(next.tasks[0].tools[0].connected).toBe(false);
});

test('routing rejects nested credentials and authorization URLs before native events',async()=>{
 const app=await setup();
 for (const tasks of [[{id:'x',query:'GitHub',arguments:{nested:{token:'opaque-secret-value'}}}],[{id:'x',query:'https://cloud.arcade.dev/auth?state=opaque'}],[{id:'x',query:'https://example.com/callback?code=opaque'}]]) {
  const response=await app.request('/api/connectors/route',alice,{tasks});expect(response.status).toBe(409);
 }
 expect(app.calls).toHaveLength(0);
});


test('oauth grant endpoints no longer exist',async()=>{
 const app=await setup();
 for(const path of ['/api/connectors/apps','/api/connectors/connect','/api/connectors/apps/connect']) expect((await app.request(path,alice,{connectorId:'arcade:GitHub.List'})).status).toBe(404);
 expect(app.calls).toHaveLength(0);
});
