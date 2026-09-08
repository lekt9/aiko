import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {nativeLoginMetadataJournal} from "../src/native-login-journal.ts";
import {Layer} from "effect";
import {actor} from "tardie";
import {createBunHost} from "tardie/bun/host";
import type {Event} from "tardie/core/event";
import {nativeLogin,type NativeLoginState,type NativeLoginInput} from "../src/native-login.ts";
import {requestLoginOperation,loginOperationComponent,loginOperationState,loginObservationEvent,loginOperationWakeEvent,loginOperationNextWake,cancelLoginOperation,type LoginOperationBinding} from "../src/login-operation.ts";
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const connectionId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
async function fixture(){
  const directory=await mkdtemp("/tmp/login-operation-");cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const privateDb=new Database(join(directory,"private.sqlite"));
  cleanup.push(async()=>{privateDb.close();});
  const metadata=nativeLoginMetadataJournal(privateDb,"123");
  let state:NativeLoginState|undefined;
  let authenticated=false,typed="",loseAck=false,failCleanup=false,allowed=true;
  let now=Date.now(),resumes=0;
  const inserted:string[]=[],actions:string[]=[];
  const operation={owner:"123",thread:"user-123",operationId:"login-task",connectionId,domain:"fixture.example",attemptId:crypto.randomUUID(),expectedRevision:0,expiresAt:now+60000,continuationId:"resume-original-read",contractRef:"login-session-v1"};
  // Controlled CDP fixture: incorrect OTP leaves a challenge; a correct OTP
  // supplies independent authenticated-UI and secure-cookie observations.
  const dependencies={read:()=>state,save:(value:NativeLoginState)=>{state=JSON.parse(JSON.stringify(value));metadata.save(state!);},verified:async()=>true,cdp:{close(){},async send(method:string,params:any){
    if(method==="Target.getTargets")return {targetInfos:state?.targetId?[{targetId:state.targetId,type:"page"}]:[]};
    if(method==="Target.createTarget")return {targetId:"private-page"};
    if(method==="Target.attachToTarget")return {sessionId:"private-session"};
    if(method==="Target.closeTarget"){if(failCleanup)throw Error("cleanup unavailable");return {success:true};}
    if(method==="Input.insertText"){typed=params.text;inserted.push(typed);return {};}
    if(method==="Network.getCookies")return {cookies:authenticated?[{httpOnly:true,secure:true,value:"PRIVATE_COOKIE"}]:[]};
    if(method==="Storage.getCookies")return {cookies:[]};
    if(method==="Runtime.evaluate"){
      const expression=params.expression;
      if(expression==="location.hostname")return {result:{value:"fixture.example"}};
      if(expression==="location.origin")return {result:{value:"https://fixture.example"}};
      if(expression.includes("Object.keys(f)"))return {result:{value:authenticated?[]:["code"]}};
      if(expression.includes("Boolean(document"))return {result:{value:authenticated}};
      if(expression.includes("f.requestSubmit")){authenticated=typed==="654321";if(loseAck)throw Error("lost submission reply");}
      return {result:{value:true}};
    }
    return {};
  }}};
  const binding:LoginOperationBinding={owner:"123",thread:"user-123",now:()=>now,authorize:async()=>allowed,control:async(input,signal)=>{signal.throwIfAborted();actions.push(input.action);return nativeLogin(input,dependencies);},resume:async()=>{resumes++;}};
  const definition=actor({name:"aiko",methods:{},components:[loginOperationComponent(binding)]});
  const open=()=>createBunHost({database:join(directory,"actor.sqlite"),actorName:"aiko",actorInstance:"login-fixture",actorFor:()=>definition,layersFor:()=>Layer.empty});
  let host=await open();cleanup.push(()=>host.close());
  const commit=async(event:Event)=>{await host.commitRoot(host.self("user-123"),event);};
  const relay=async()=>{for(const receipt of state?.loginReceipts??[])await commit(loginObservationEvent("123",receipt));};
  await commit(requestLoginOperation(operation,now));
  const events=()=>host.read("user-123");
  return {operation,actions,inserted,binding,state:()=>state!,resumes:()=>resumes,events,commit,relay,
    projected:async()=>loginOperationState(await events(),"123","user-123").get(operation.operationId)!,
    drive:()=>host.wake("user-123"),restart:async()=>{await host.close();state=JSON.parse((privateDb.query("SELECT state FROM native_login WHERE id=?").get(connectionId) as {state:string}).state);host=await open();await host.wake("user-123");},
    advance:async(ms:number)=>{now+=ms;await commit(loginOperationWakeEvent("123",now));},
    cleanupFailure:(value:boolean)=>{failCleanup=value;},lostAck:(value:boolean)=>{loseAck=value;},authorize:(value:boolean)=>{allowed=value;},
    submit:async(code:string,extra:Partial<NativeLoginInput>={})=>nativeLogin({connectionId,domain:operation.domain,action:"credentials",attemptId:operation.attemptId,challengeId:state!.challenge!.id,expectedRevision:state!.challenge!.revision,submissionId:crypto.randomUUID(),code,...extra},dependencies),
  };
}

test("native waiter survives restart, incorrect OTP rotates challenge, verified cleanup resumes once",async()=>{
  const f=await fixture();await f.drive();
  expect((await f.projected()).status).toBe("awaiting_user");
  const first=f.state().challenge!;
  await f.restart();expect(f.resumes()).toBe(0);
  await f.submit("WRONG_PRIVATE_OTP");await f.relay();await f.drive();
  expect((await f.projected()).status).toBe("awaiting_user");
  expect(f.state().challenge!.id).not.toBe(first.id);
  await expect(f.submit("654321",{challengeId:first.id,expectedRevision:first.revision})).rejects.toThrow("Stale");
  await f.submit("654321");await f.relay();await f.drive();
  expect((await f.projected()).status).toBe("connected");expect(f.resumes()).toBe(1);
  await f.restart();await f.relay();await f.drive();expect(f.resumes()).toBe(1);
  const log=JSON.stringify(await f.events());
  for(const secret of ["654321","WRONG_PRIVATE_OTP","PRIVATE_COOKIE"])expect(log).not.toContain(secret);
  expect(f.inserted).toEqual(["WRONG_PRIVATE_OTP","654321"]);
});

test("lost OTP acknowledgement is inspected after restart and same submission never types twice",async()=>{
  const f=await fixture();await f.drive();const submissionId=crypto.randomUUID();f.lostAck(true);
  await expect(f.submit("654321",{submissionId})).rejects.toThrow("lost");
  expect(f.state().submission!.status).toBe("dispatched");
  await f.submit("654321",{submissionId});expect(f.inserted).toHaveLength(1);
  f.lostAck(false);await f.relay();await f.restart();
  expect((await f.projected()).status).toBe("connected");expect(f.resumes()).toBe(1);
});

test("cleanup failure cannot satisfy login; a native wake retries cleanup without retyping",async()=>{
  const f=await fixture();await f.drive();f.cleanupFailure(true);
  await f.submit("654321");await f.relay();await f.drive();
  expect(f.state().verifiedSession).toBeDefined();expect(f.resumes()).toBe(0);
  expect((await f.projected()).status).not.toBe("connected");
  expect(loginOperationNextWake(await f.events(),"123","user-123")).toBeDefined();
  f.cleanupFailure(false);await f.advance(1001);await f.drive();
  expect((await f.projected()).status).toBe("connected");expect(f.resumes()).toBe(1);expect(f.inserted).toHaveLength(1);
});

test("cancellation and expiry fence late success and perform private cleanup",async()=>{
  for(const expire of [false,true]){
    const f=await fixture();await f.drive();
    if(expire)await f.advance(60001);else await f.commit(cancelLoginOperation(f.operation));
    await f.drive();
    expect((await f.projected()).status).toBe(expire?"expired":"cancelled");
    expect(f.actions).toContain("disconnect");expect(f.resumes()).toBe(0);
    await f.commit({type:"AikoLoginOperationVerified",id:"late",owner:"123",attemptId:f.operation.attemptId,connectionId,revision:99,sessionExpiresAt:Date.now()+100000,at:Date.now()});await f.drive();
    expect(f.resumes()).toBe(0);
  }
});

test("wrong owner/attempt and sequence gaps cannot resolve the waiter; revoked continuation stays closed",async()=>{
  const f=await fixture();await f.drive();
  const latest=f.state().loginReceipts!.at(-1)!;
  await f.commit(loginObservationEvent("other",{...latest,kind:"verified",sequence:3}));
  await f.commit(loginObservationEvent("123",{...latest,attemptId:crypto.randomUUID(),kind:"verified",sequence:3}));
  await f.commit(loginObservationEvent("123",{...latest,kind:"verified",sequence:99}));await f.drive();
  expect(f.resumes()).toBe(0);expect((await f.projected()).status).toBe("awaiting_user");
  f.authorize(false);await f.submit("654321");await f.relay();await f.drive();expect(f.resumes()).toBe(0);
});

test("a lost continuation acknowledgement never resumes the original operation twice",async()=>{
  const f=await fixture();await f.drive();let dispatches=0;
  f.binding.resume=async()=>{dispatches++;throw Error("lost continuation acknowledgement");};
  await f.submit("654321");await f.relay();await f.drive();
  expect(dispatches).toBe(1);
  expect((await f.events()).find(e=>e.type==="AikoLoginOperationContinued")?.outcome).toBe("unknown");
  expect(await f.projected()).toMatchObject({continued:false,continuationOutcome:"unknown"});
  await f.restart();expect(dispatches).toBe(1);
});

test("cancellation committed during successful verification wins before continuation",async()=>{
  const f=await fixture();await f.drive();const original=f.binding.control;
  f.binding.control=async(input,signal)=>{const view=await original(input,signal);if(input.action==="finish")await f.commit(cancelLoginOperation(f.operation));return view;};
  await f.submit("654321");await f.relay();await f.drive();
  expect((await f.projected()).status).toBe("cancelled");expect(f.resumes()).toBe(0);
});

test("private metadata outbox survives lost delivery acknowledgement and never includes secrets",async()=>{
  const directory=await mkdtemp("/tmp/login-outbox-");cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  let db=new Database(join(directory,"db.sqlite"));cleanup.push(async()=>{db.close();});
  const attemptId=crypto.randomUUID();
  const state:NativeLoginState={connectionId,domain:"fixture.example",attemptId,status:"pending",revision:1,expiresAt:Date.now()+60000,loginReceipts:[{type:"AikoPrivateLoginObserved",id:`${attemptId}:1`,connectionId,attemptId,sequence:1,revision:1,expiresAt:Date.now()+60000,at:Date.now(),kind:"opening"}]};
  let journal=nativeLoginMetadataJournal(db,"123");journal.save(state);
  const delivered=new Map<string,Event>();
  await expect(journal.flush(async e=>{delivered.set(String(e.id),e);throw Error("lost ack");})).rejects.toThrow("lost ack");
  db.close();db=new Database(join(directory,"db.sqlite"));journal=nativeLoginMetadataJournal(db,"123");
  await journal.flush(async e=>{delivered.set(String(e.id),e);});expect(delivered.size).toBe(1);
  journal.save(state);let redelivered=0;await journal.flush(async()=>{redelivered++;});expect(redelivered).toBe(0);
  const contaminated={...state.loginReceipts![0],code:"PRIVATE_OTP",password:"PRIVATE_PASSWORD"};
  expect(JSON.stringify(loginObservationEvent("123",contaminated))).not.toContain("PRIVATE_");
});

test("expired challenge rejects the secret before any input dispatch",async()=>{
  const f=await fixture();await f.drive();f.state().challenge!.expiresAt=Date.now()-1;
  await expect(f.submit("654321")).rejects.toThrow("Stale");
  expect(f.inserted).toHaveLength(0);
});
