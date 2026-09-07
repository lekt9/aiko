import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { browserDriverFactory } from "../src/browser-driver.ts";
const chrome=process.env.AIKO_NATIVE_SESSION_CHROME;
const domain=process.env.AIKO_NATIVE_LOGIN_TEST_DOMAIN;
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
