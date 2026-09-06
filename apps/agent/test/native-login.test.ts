import {test,expect} from "bun:test";
import {nativeLogin,prepareNativeLogin,validateNativeInput,type NativeLoginState} from "../src/native-login.ts";
const id="12345678-1234-1234-1234-123456789abc";
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
