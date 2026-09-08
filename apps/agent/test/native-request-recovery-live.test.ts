import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { browserDriverFactory } from "../src/browser-driver.ts";
import { Database } from "bun:sqlite";
const chrome=process.env.AIKO_NATIVE_SESSION_CHROME;
const domain=process.env.AIKO_NATIVE_LOGIN_TEST_DOMAIN;
(chrome&&domain?test:test.skip)("pending sign-in reopens its form after the browser driver restarts",async()=>{
 if(domain!=="unlock-login-canary.lewis-6d8.workers.dev")throw Error("Use only the synthetic public canary");
 const directory=await mkdtemp("/tmp/unlock-pending-login-");
 const open=()=>browserDriverFactory(chrome!,{persistentDirectory:directory})({owner:"pending_login_fixture",domains:["*"],emit:async()=>{}});
 let driver=await open();
 const input={connectionId:crypto.randomUUID(),domain:domain!,action:"form" as const};
 try {
  const first=await driver.nativeAuth!(input);
  expect(first.status).toBe("pending");
  await driver.close();driver=await open();
  let reopened=await driver.nativeAuth!(input);
  for(let attempt=0;attempt<20&&!reopened.fields?.includes("password");attempt++){
   await Bun.sleep(100);reopened=await driver.nativeAuth!(input);
  }
  expect(reopened.status).toBe("pending");
  expect(reopened.revision).toBe(first.revision+1);
  expect(reopened.fields).toEqual(["username","password"]);
  expect(reopened.credentialsSaved).not.toBe(true);
  // Exercise the actual persisted expiry path, including private-page cleanup,
  // rather than testing only the helper's decision to reopen.
  await driver.close();
  const db=new Database(`${directory}/request-evidence.sqlite`);
  try {
   const row=db.query("SELECT state FROM native_login WHERE id=?").get(input.connectionId) as {state:string};
   const expired={...JSON.parse(row.state),expiresAt:1};
   db.query("UPDATE native_login SET state=? WHERE id=?").run(JSON.stringify(expired),input.connectionId);
  } finally {db.close();}
  driver=await open();
  expect((await driver.nativeAuth!({...input,action:"status"})).status).toBe("pending");
  let refreshed=await driver.nativeAuth!(input);
  for(let attempt=0;attempt<20&&!refreshed.fields?.includes("password");attempt++){
   await Bun.sleep(100);refreshed=await driver.nativeAuth!(input);
  }
  expect(refreshed).toMatchObject({status:"pending",revision:reopened.revision+2,fields:["username","password"]});
  expect(refreshed.credentialsSaved).not.toBe(true);
 } finally {await driver.close();await rm(directory,{recursive:true,force:true});}
},90000);
(chrome&&domain?test:test.skip)("real native browser reopens saved session for a request after driver restart",async()=>{
 if(domain!=="unlock-login-canary.lewis-6d8.workers.dev")throw Error("Use only the synthetic public canary");
 const directory=await mkdtemp("/tmp/unlock-cold-request-");
 const open=()=>browserDriverFactory(chrome!,{persistentDirectory:directory})({owner:"cold_request_fixture",domains:["*"],emit:async()=>{}});
 let driver=await open();
 try {
  const view=await driver.nativeAuth!({connectionId:crypto.randomUUID(),domain:domain!,action:"login",username:"fixture-user",password:"fixture-password"});
  expect(view.status).toBe("connected");expect(view.credentialsSaved).toBe(true);
  await driver.close();driver=await open();
  const request={stepId:"items",attempt:1,method:"GET" as const,url:`https://${domain}/api/items`,headers:{},redirect:"manual" as const};
  const response=await driver.requestTransport!.send(request);
  expect(response.status).toBe(200);expect(typeof (response.body as any).item).toBe("string");
  const page=await driver.requestTransport!.send({...request,url:`https://${domain}/`});
  expect(page.classification).toBe("application");
  expect(typeof page.body).toBe("string");
  await driver.execute({action:"url"});
  const found=await driver.requestSearch!("canary project details",10);
  const pointer=found.items.find(item=>item.requestIds.length===3 && item.inputs.length===4);
  expect(pointer).toBeDefined();
  const detailStep=Object.entries(pointer!.shapes).find(([,fields])=>fields.some(field=>field.path==="$.name"))![0];
  const inputs=Object.fromEntries(pointer!.inputs.map(input=>[input.name,input.name.endsWith("segment-1")?"api":input.name.startsWith(`${detailStep}-`)?"details":"items"]));
  const hydrated=await driver.requestRehydrate!(pointer!.pointerId,inputs);
  expect({status:hydrated.status,code:hydrated.code}).toEqual({status:"completed",code:"completed"});
  expect(hydrated.counts.requests).toBe(3);
  expect((hydrated.hydration?.body as any)?.name).toBe("Verified live canary project");
  expect((await driver.requestTransport!.send({...request,url:`https://${domain}/test-challenge`})).classification).toBe("site_control");
  expect((await driver.requestTransport!.send({...request,url:`https://${domain}/test-login`})).classification).toBe("browser_session_required");
  await expect(driver.requestTransport!.send({...request,method:"POST"})).rejects.toThrow("read requests");
  await expect(driver.requestTransport!.send({...request,url:"https://example.com/"})).rejects.toThrow("Reconnect");
 } finally {await driver.close();await rm(directory,{recursive:true,force:true});}
},180000);

(chrome&&domain?test:test.skip)("public browsing cleans an expired private sign-in but preserves an active lock",async()=>{
 if(domain!=="unlock-login-canary.lewis-6d8.workers.dev")throw Error("Use only the synthetic public canary");
 const directory=await mkdtemp("/tmp/unlock-public-expiry-");
 const open=()=>browserDriverFactory(chrome!,{persistentDirectory:directory,nativeAssetDirectory:process.env.AIKO_NATIVE_ASSET_DIRECTORY,browserBackend:process.env.AIKO_NATIVE_BROWSER_BACKEND === "cloakbrowser" ? "cloakbrowser" : "chromium"})({owner:"public_expiry_fixture",domains:["*"],emit:async()=>{}});
 let driver=await open();
 const input={connectionId:crypto.randomUUID(),domain:domain!,action:"form" as const};
 try {
  expect((await driver.nativeAuth!(input)).status).toBe("pending");
  await expect(driver.execute({action:"url"})).rejects.toMatchObject({code:"private_sign_in_pending"});
  await driver.close();
  const db=new Database(`${directory}/request-evidence.sqlite`);
  try {
   const row=db.query("SELECT state FROM native_login WHERE id=?").get(input.connectionId) as {state:string};
   db.query("UPDATE native_login SET state=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.state),expiresAt:1}),input.connectionId);
  } finally {db.close();}
  driver=await open();
  await driver.execute({action:"navigate",url:`https://${domain}/`});
  const current=await driver.execute({action:"url"}) as {url:string};
  expect(new URL(current.url).hostname).toBe(domain!);
  const read=new Database(`${directory}/request-evidence.sqlite`,{readonly:true});
  try {
   const row=read.query("SELECT state FROM native_login WHERE id=?").get(input.connectionId) as {state:string};
   expect(JSON.parse(row.state)).toMatchObject({status:"disconnected",expired:true});
  } finally {read.close();}
 } finally {await driver.close();await rm(directory,{recursive:true,force:true});}
},90000);
