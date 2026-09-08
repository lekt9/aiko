import {test,expect} from "bun:test";
import {nativeLogin,prepareNativeLogin,validateNativeInput,type NativeLoginState} from "../src/native-login.ts";
const id="12345678-1234-1234-1234-123456789abc";
test("form reads reopen a missing private target after restart without replaying credentials",async()=>{
 for(const action of ["form","view","credentials"] as const) {
  let state:NativeLoginState={connectionId:id,domain:"linkedin.com",targetId:"old",status:"pending",expiresAt:Date.now()+60000,revision:3,preserveTargetIds:["other-page"],approvedOrigins:["https://old-sso.example"]};
  const calls:any[]=[];
  let popup=true;
  const deps={read:()=>state,save:(next:NativeLoginState)=>{state=next;},cdp:{close(){},async send(method:string,params:any){
   calls.push({method,params});
   if(method==="Target.attachToTarget"){if(params.targetId==="old")throw Error("Missing target");return {sessionId:"new-session"};}
   if(method==="Target.getTargets")return {targetInfos:[{targetId:"other-page",type:"page"},...(popup?[{targetId:"abandoned-popup",type:"page"}]:[])]};
   if(method==="Target.closeTarget"&&params.targetId==="abandoned-popup"){popup=false;return {success:true};}
   if(method==="Target.createTarget")return {targetId:"fresh"};
   if(method==="Runtime.evaluate")return {result:{value:""}};
   return {};
  }}};
  const result=nativeLogin({connectionId:id,domain:"linkedin.com",action,...(action==="credentials"?{password:"test-value"}:{})},deps);
  if(action==="credentials") {
   await expect(result).rejects.toThrow("Missing target");
   expect(calls.some(c=>c.method==="Target.createTarget")).toBe(false);
  } else {
   expect(await result).toMatchObject({status:"pending",revision:4,fields:[]});
   expect(state.targetId).toBe("fresh");
   expect(popup).toBe(false);
   expect(state.preserveTargetIds).toEqual(["other-page"]);
   expect(state.approvedOrigins).toBeUndefined();
   expect(calls.find(c=>c.method==="Page.navigate")?.params.url).toBe("https://linkedin.com/login");
  }
  expect(calls.some(c=>c.method.startsWith("Input."))).toBe(false);
 }
});
test("an attach failure does not replace a private page that still exists",async()=>{
 const state:NativeLoginState={connectionId:id,domain:"linkedin.com",targetId:"existing",status:"pending",expiresAt:Date.now()+60000,revision:1};
 let created=false;
 const deps={read:()=>state,save:()=>{},cdp:{close(){},async send(method:string){
  if(method==="Target.attachToTarget")throw Error("Connection failed");
  if(method==="Target.getTargets")return {targetInfos:[{targetId:"existing"}]};
  if(method==="Target.createTarget")created=true;
  return {};
 }}};
 await expect(nativeLogin({connectionId:id,domain:"linkedin.com",action:"form"},deps)).rejects.toThrow("Connection failed");
 expect(created).toBe(false);
});
test("expired private locks are cleaned before a new login; live locks still isolate credentials", async () => {
 const old: NativeLoginState={connectionId:"22222222-2222-2222-2222-222222222222",domain:"linkedin.com",status:"pending",expiresAt:100,revision:1};
 const input={connectionId:id,domain:"linkedin.com",action:"form" as const};
 const cleaned:unknown[]=[];
 await prepareNativeLogin(input,[old],async value=>{cleaned.push(value)},101);
 expect(cleaned).toEqual([{connectionId:old.connectionId,domain:old.domain,action:"disconnect"}]);
 await expect(prepareNativeLogin(input,[old],async()=>{},99)).rejects.toThrow("Finish the existing");
 await expect(prepareNativeLogin(input,[old],async()=>{throw Error("cleanup failed")},101)).rejects.toThrow("cleanup failed");
 await prepareNativeLogin({...input,action:"disconnect"},[old],async()=>{},99);
});
test("expiry cleanup records its reason, while valid verified sessions finish cleanup", async () => {
 const state:NativeLoginState={connectionId:id,domain:"linkedin.com",status:"pending",expiresAt:100,revision:2};
 const calls:unknown[]=[];
 await prepareNativeLogin({connectionId:id,domain:state.domain,action:"status"},[state],async (input,reason)=>{calls.push({action:input.action,reason})},101);
 expect(calls).toEqual([{action:"disconnect",reason:"expired"}]);
 calls.length=0;
 await prepareNativeLogin({connectionId:id,domain:state.domain,action:"form"},[{...state,verifiedSession:{expiresAt:200,revision:3}}],async (input,reason)=>{calls.push({action:input.action,reason})},101);
 expect(calls).toEqual([{action:"finish",reason:undefined}]);
 await expect(prepareNativeLogin({connectionId:id,domain:state.domain,action:"form"},[state],async()=>{throw Error("cleanup failed")},101)).rejects.toThrow("cleanup failed");
});
test("form reads recover persisted expiration but respect explicit disconnect",async()=>{
 for(const expired of [true,false]) {
  let state:NativeLoginState={connectionId:id,domain:"linkedin.com",status:"disconnected",expiresAt:1,revision:3,...(expired?{expired:true}:{})};
  let created=0;
  const deps={read:()=>state,save:(next:NativeLoginState)=>{state=next},cdp:{close(){},async send(method:string){
   if(method==="Target.getTargets")return {targetInfos:[]};
   if(method==="Target.createTarget"){created++;return {targetId:"fresh"};}
   if(method==="Target.attachToTarget")return {sessionId:"session"};
   if(method==="Runtime.evaluate")return {result:{value:""}};
   return {};
  }}};
  expect((await nativeLogin({connectionId:id,domain:state.domain,action:"status"},deps)).status).toBe(expired?"pending":"disconnected");
  expect((await nativeLogin({connectionId:id,domain:state.domain,action:"form"},deps)).status).toBe(expired?"pending":"disconnected");
  expect(created).toBe(expired?1:0);expect(state.expired).not.toBe(true);
 }
});
test("an uncommitted navigation returns loading metadata without typing or screenshots", async () => {
 let state:NativeLoginState|undefined;
 const calls:string[]=[];
 const deps={read:()=>state,save:(value:NativeLoginState)=>{state=value},cdp:{close(){},async send(method:string){calls.push(method);if(method==="Target.createTarget")return {targetId:"page"};if(method==="Target.attachToTarget")return {sessionId:"session"};if(method==="Runtime.evaluate")return {result:{value:""}};return {};}}};
 const result=await nativeLogin({connectionId:id,domain:"linkedin.com",action:"form"},deps);
 expect(result.status).toBe("pending");expect(result.fields).toEqual([]);
 expect(calls).not.toContain("Page.captureScreenshot");expect(calls).not.toContain("Input.insertText");
});
test("private login checks domain before typing and requires independent signed-in evidence",async()=>{
 let state:NativeLoginState|undefined;let hostname="linkedin.com",authenticated=false;const calls:any[]=[];
 const deps={read:()=>state,save:(s:NativeLoginState)=>{state={...s}},cdp:{close(){},async send(method:string,params:any){calls.push({method,params});if(method === "Target.createTarget")return {targetId:"private"};if(method === "Target.attachToTarget")return {sessionId:"session"};if(method === "Runtime.evaluate")return {result:{value:params.expression === "location.hostname"?hostname:params.expression.includes("Boolean(document")?authenticated:true}};if(method === "Network.getCookies")return {cookies:[{httpOnly:true,secure:true,value:"secret-cookie"}]};if(method === "Storage.getCookies")return {cookies:[]};if(method === "Page.captureScreenshot")return {data:"image"};return {};}}};
 await nativeLogin({connectionId:id,domain:"linkedin.com",action:"begin"},deps);expect(state?.status).toBe("pending");
 hostname="phishing.example";await expect(nativeLogin({connectionId:id,domain:"linkedin.com",action:"type",text:"private-password"},deps)).rejects.toThrow();expect(calls.some(c=>c.method === "Input.insertText")).toBe(false);
 hostname="linkedin.com";await expect(nativeLogin({connectionId:id,domain:"linkedin.com",action:"finish"},deps)).rejects.toThrow();expect(state?.status).toBe("pending");
 authenticated=true;const result=await nativeLogin({connectionId:id,domain:"linkedin.com",action:"finish"},deps);expect(result.status).toBe("connected");expect(JSON.stringify(state)).not.toContain("secret-cookie");expect(calls.some(c=>c.method === "Target.closeTarget")).toBe(true);
 await nativeLogin({connectionId:id,domain:"linkedin.com",action:"disconnect"},deps);expect(state?.status).toBe("disconnected");expect(calls.some(c=>c.method === "Storage.clearDataForOrigin")).toBe(true);
});
test("private disconnect accepts an already-gone target only after checking its absence",async()=>{
 for(const remains of [false,true]) {
  let state:NativeLoginState={connectionId:id,domain:"linkedin.com",targetId:"gone",preserveTargetIds:["main"],status:"pending",expiresAt:Date.now()+60000,revision:1};
  const deps={read:()=>state,save:(s:NativeLoginState)=>{state={...s}},cdp:{close(){},async send(method:string,params:any){
   if(method==="Target.createTarget")return {targetId:"cleanup"};
   if(method==="Target.attachToTarget")return {sessionId:"cleanup-session"};
   if(method==="Target.closeTarget"&&params.targetId==="gone")throw Error("already gone or failed");
   if(method==="Target.getTargets")return {targetInfos:[{type:"page",targetId:"main"},...(remains?[{type:"page",targetId:"gone"}]:[])]};
   if(method==="Storage.getCookies")return {cookies:[]};
   return {};
  }}};
  const result=nativeLogin({connectionId:id,domain:"linkedin.com",action:"disconnect"},deps);
  if(remains){await expect(result).rejects.toThrow();expect(state.status).toBe("pending");}
  else expect((await result).status).toBe("disconnected");
 }
});
test("private controls reject arbitrary commands and coordinates",()=>{
 expect(()=>validateNativeInput({connectionId:id,domain:"linkedin.com",action:"key",key:"F12"})).toThrow();
 expect(()=>validateNativeInput({connectionId:id,domain:"linkedin.com",action:"click",x:NaN,y:20})).toThrow();
});
test("native form returns field names only and submits credentials privately without screenshots", async () => {
 let state:NativeLoginState={connectionId:id,domain:"linkedin.com",targetId:"private",status:"pending",expiresAt:Date.now()+60000,revision:1};
 const calls:any[]=[];let safe=true;
 const deps={read:()=>state,save:(s:NativeLoginState)=>{state=s},cdp:{close(){},async send(method:string,params:any){
  calls.push({method,params});
  if(method === "Target.attachToTarget")return {sessionId:"session"};
  if(method === "Runtime.evaluate")return {result:{value:params.expression === "location.hostname" ? "linkedin.com" : params.expression.includes("Object.keys(f)") ? ["username","password"] : safe}};
  return {};
 }}};
 const view=await nativeLogin({connectionId:id,domain:"linkedin.com",action:"form"},deps);
 expect(view.fields).toEqual(["username","password"]);expect(view.screenshot).toBeUndefined();
 const result=await nativeLogin({connectionId:id,domain:"linkedin.com",action:"credentials",username:"test-user",password:"private-password"},deps);
 expect(result.status).toBe("pending");expect(result.fields).toEqual([]);
 expect(calls.filter(c=>c.method === "Input.insertText").map(c=>c.params.text)).toEqual(["test-user","private-password"]);
 expect(JSON.stringify({state,result,view})).not.toContain("private-password");
 expect(calls.some(c=>c.method === "Page.captureScreenshot")).toBe(false);
 expect(calls.filter(c=>c.method === "Runtime.evaluate").some(c=>c.params.expression.includes("private-password"))).toBe(false);
 safe=false;calls.length=0;
 await expect(nativeLogin({connectionId:id,domain:"linkedin.com",action:"credentials",password:"private-password"},deps)).rejects.toThrow();
 expect(calls.some(c=>c.method === "Input.insertText")).toBe(false);
 expect(()=>validateNativeInput({connectionId:id,domain:"linkedin.com",action:"credentials",password:"x".repeat(2049)})).toThrow();
});

test("redirected sign-in providers require consent and cannot verify the original app",async()=>{
 let state:NativeLoginState={connectionId:id,domain:"example.com",targetId:"page",status:"pending",expiresAt:Date.now()+60000,revision:1};
 let origin="https://accounts.example.net";const calls:string[]=[];
 const deps={read:()=>state,save:(s:NativeLoginState)=>{state=s;},cdp:{close(){},async send(method:string,p:any){calls.push(method);
 if(method==="Target.attachToTarget")return {sessionId:"s"};
 if(method==="Runtime.evaluate")return {result:{value:p.expression==="location.hostname"?new URL(origin).hostname:p.expression==="location.origin"?origin:true}};
 if(method==="Page.captureScreenshot")return {data:"fixture"};return {};
 }}};
 expect(await nativeLogin({connectionId:id,domain:state.domain,action:"form"},deps)).toMatchObject({fields:[],requiresOrigin:origin});
 await expect(nativeLogin({connectionId:id,domain:state.domain,action:"type",text:"secret"},deps)).rejects.toThrow();
 expect(calls).not.toContain("Input.insertText");
 await expect(nativeLogin({connectionId:id,domain:state.domain,action:"allow_origin",url:"https://different.example.net"},deps)).rejects.toThrow();
 await nativeLogin({connectionId:id,domain:state.domain,action:"allow_origin",url:origin},deps);
 await nativeLogin({connectionId:id,domain:state.domain,action:"type",text:"secret"},deps);
 expect(calls).toContain("Input.insertText");
 await expect(nativeLogin({connectionId:id,domain:state.domain,action:"finish"},deps)).rejects.toThrow("Return to the selected app");
 for(const url of ["http://example.com/login","https://127.0.0.1/","https://user:password@example.com/"])
   expect(()=>validateNativeInput({connectionId:id,domain:state.domain,action:"navigate",url})).toThrow();
});

test("expired verified deadline is cleaned before another connection; cancellation bypasses preparation",async()=>{
 const state:NativeLoginState={connectionId:id,domain:"linkedin.com",status:"pending",expiresAt:200,revision:1,verifiedSession:{expiresAt:100,revision:2}};
 const calls:unknown[]=[];
 await prepareNativeLogin({connectionId:"22222222-2222-2222-2222-222222222222",domain:"example.com",action:"form"},[state],async(input,reason)=>{calls.push({action:input.action,reason})},101);
 expect(calls).toEqual([{action:"disconnect",reason:"expired"}]);
 await prepareNativeLogin({connectionId:id,domain:state.domain,action:"disconnect"},[state],async()=>{throw Error("Must not block cancellation")},101);
});
test("verified cleanup returns the recovered result without redispatching begin or renewal",async()=>{
 const state:NativeLoginState={connectionId:id,domain:"linkedin.com",status:"pending",expiresAt:100,revision:1,verifiedSession:{expiresAt:200,revision:2}};
 for(const action of ["begin","renew","form","login"] as const) {
  const actions:string[]=[];
  const connected={status:"connected" as const,domain:state.domain,expiresAt:200,revision:2};
  const result=await prepareNativeLogin({connectionId:id,domain:state.domain,action},[state],async input=>{actions.push(input.action);return connected},101);
  expect(result).toEqual(connected);expect(actions).toEqual(["finish"]);
 }
});

test("bound attempt missing-page recovery preserves receipt order and invalidates the old OTP",async()=>{
 const attemptId=crypto.randomUUID(),challengeId=crypto.randomUUID();
 let state:NativeLoginState={connectionId:id,domain:"service.net",attemptId,targetId:"gone",status:"pending",revision:2,expiresAt:Date.now()+60000,loginSequence:2,loginReceipts:[],challenge:{id:challengeId,revision:1,expiresAt:Date.now()+60000}};
 let inputs=0;
 const deps={read:()=>state,save:(next:NativeLoginState)=>{state=structuredClone(next);},cdp:{close(){},async send(method:string,params:any):Promise<any>{
  if(method==="Target.attachToTarget"){if(params.targetId==="gone")throw Error("gone");return {sessionId:"session"};}
  if(method==="Target.getTargets")return {targetInfos:[]};
  if(method==="Target.createTarget")return {targetId:"new"};
  if(method==="Input.insertText")inputs++;
  if(method==="Runtime.evaluate")return {result:{value:params.expression==="location.hostname"?"service.net":params.expression==="location.origin"?"https://service.net":params.expression.includes("Object.keys(f)")?["code"]:true}};
  return {};
 }}};
 const view=await nativeLogin({connectionId:id,domain:"service.net",attemptId,action:"form"},deps);
 expect(view.attemptId).toBe(attemptId);expect(view.challenge!.id).not.toBe(challengeId);expect(view.loginReceipts!.map(e=>e.sequence)).toEqual([3,4]);
 await expect(nativeLogin({connectionId:id,domain:"service.net",attemptId,action:"credentials",challengeId,expectedRevision:1,submissionId:crypto.randomUUID(),code:"PRIVATE_OLD_CODE"},deps)).rejects.toThrow("Stale");expect(inputs).toBe(0);
});
