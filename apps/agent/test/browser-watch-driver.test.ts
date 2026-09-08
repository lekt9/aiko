import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentBrowserClient } from "@unbrowse/browser-harness/client";
import { browserDriverFactory, type BrowserDriver } from "../src/browser-driver.ts";
import type { BrowserWatchLease } from "../src/browser-watch-runner.ts";
import { browserBatchSignature } from "../src/browser-events.ts";

test("private driver forwards matching network observations without a browser tool and retains profile across restart", async () => {
  const directory=mkdtempSync(join(tmpdir(),"aiko-watch-driver-")), exchanges: {url:string;body:any;signature:string|null}[]=[];
  let socket: any;
  const observerTargets=new Set<string>(), connectionId=crypto.randomUUID();
  const server=Bun.serve({port:0,hostname:"127.0.0.1",
    fetch(request,server){if(server.upgrade(request))return;return new Response(null,{status:400});},
    websocket:{message(ws,raw){
      socket=ws;
      const call=JSON.parse(String(raw));
      if(call.method==="Target.setAutoAttach")ws.send(JSON.stringify({method:"Target.attachedToTarget",params:{sessionId:"network",targetInfo:{type:"page"}}}));
      let result:object={};
      if(call.method==="Network.getResponseBody")result={body:"{}",base64Encoded:false};
      if(call.method==="Target.createTarget"){observerTargets.add("owned-observer");result={targetId:"owned-observer"};}
      if(call.method==="Target.getTargets")result={targetInfos:[{type:"page",targetId:"site",url:"https://example.com",browserContextId:"context"},
        ...[...observerTargets].map(targetId=>({type:"page",targetId,url:"about:blank",browserContextId:"context"}))]};
      if(call.method==="Target.getTargetInfo")result={targetInfo:{type:"page",targetId:"site",browserContextId:"context"}};
      if(call.method==="Target.attachToTarget"){
        result={sessionId:call.params.targetId};
        if(observerTargets.has(call.params.targetId))ws.send(JSON.stringify({method:"Target.attachedToTarget",params:{sessionId:call.params.targetId,targetInfo:{type:"page",targetId:call.params.targetId,browserContextId:"context"}}}));
      }
      if(call.method==="Target.closeTarget"){observerTargets.delete(call.params.targetId);result={success:true};}
      if(call.method==="BackgroundService.setRecording")ws.send(JSON.stringify({method:"BackgroundService.recordingStateChanged",sessionId:call.sessionId,params:{service:call.params.service,isRecording:call.params.shouldRecord}}));
      if(call.method==="Storage.getCookies")result={cookies:[]};
      if(call.method==="Target.getBrowserContexts")result={browserContextIds:["context"]};
      ws.send(JSON.stringify({id:call.id,...(call.sessionId?{sessionId:call.sessionId}:{}),result}));
    }},
  });
  const client=AgentBrowserClient.prototype;
  let startupGate:(()=>Promise<void>)|undefined, releaseStartup:(()=>void)|undefined;
  const preparation=spyOn(client,"prepareViewport").mockImplementation(async()=>{
    const gate=startupGate;startupGate=undefined;
    await gate?.();
  });
  const mocks=[
    preparation,
    spyOn(client,"streamStatus").mockResolvedValue({enabled:true,port:1} as any),
    spyOn(client,"connectTelemetry").mockResolvedValue(undefined),
    spyOn(client,"networkObservationEndpoint").mockResolvedValue(`ws://127.0.0.1:${server.port}/devtools/browser/fixture`),
    spyOn(client,"closeAll").mockResolvedValue(undefined),
    spyOn(client,"disconnectTelemetry").mockReturnValue(undefined),
    spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      const body=JSON.parse(String(init?.body));
      exchanges.push({url:String(input),body,signature:new Headers(init?.headers).get("x-browser-signature")});
      return Response.json({status:"accepted",through:body.items.at(-1).sequence},{status:202});
    },{preconnect:globalThis.fetch.preconnect})),
  ];
  let driver:BrowserDriver|undefined, db:Database|undefined, lease:BrowserWatchLease;
  const create=()=>browserDriverFactory("/fixture/not-launched",{persistentDirectory:directory})({owner:"alice",domains:["*"],emit:async()=>{}});
  try {
    driver=await create();const context=await driver.watchContext!();
    expect(context.owner).toBe("alice");
    db=new Database(join(directory,"request-evidence.sqlite"));
    const now=Date.now();
    db.query("INSERT INTO native_login VALUES(?,?)").run(connectionId,JSON.stringify({connectionId,domain:"example.com",revision:7,status:"connected",expiresAt:now+60000}));
    lease={grant:{owner:"alice",profile:context.profile,producer:"producer",epoch:"epoch",generation:1,connectionId,connectionRevision:"7",
      origins:["https://example.com"],kinds:["network"],active:true,expiresAt:now+60000,registeredAt:now-1000,secret:"fixture-secret-000000000000000000000000"},
      ingestUrl:"https://host.example/v1/browser-events/alice",networkRoutes:[{method:"GET",route:"/requests/{id}"}]};
    expect((await driver.watchConfigure!(lease)).state).toBe("watching");
    expect(await driver.hasActiveWatchLease!()).toBe(true);
    const emit=(method:string,params:object)=>socket.send(JSON.stringify({method,sessionId:"network",params}));
    emit("Network.requestWillBeSent",{requestId:"one",wallTime:Date.now()/1000,timestamp:1,request:{method:"GET",url:"https://example.com/requests/private-id?token=secret-query",headers:{}}});
    emit("Network.responseReceived",{requestId:"one",timestamp:2,hasExtraInfo:false,response:{status:200,mimeType:"application/json",headers:{}}});
    emit("Network.loadingFinished",{requestId:"one",timestamp:3,encodedDataLength:2});
    const deadline=Date.now()+7000;while(!exchanges.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.url).toBe(lease.ingestUrl);
    expect(exchanges[0]!.signature).toBe(browserBatchSignature(exchanges[0]!.body,lease.grant.secret));
    expect(exchanges[0]!.body.items[0].fields).toEqual({origin:"https://example.com",method:"GET",route:"/requests/{id}",status:200,outcome:"completed"});
    expect((await driver.watchStatus!())[0]?.acknowledged).toBe(1);
    expect(JSON.stringify(exchanges)).not.toContain("private-id");expect(JSON.stringify(exchanges)).not.toContain("secret-query");
    expect(JSON.stringify(db.query("SELECT * FROM browser_watch_leases").all())).not.toContain(lease.grant.secret);
    const paused = await driver.watchPause!("producer",undefined,0);expect(await driver.hasActiveWatchLease!()).toBe(false);
    expect(paused).toMatchObject({lifecycleRevision:0,pausedThrough:1});
    await driver.close();driver=await create();
    expect(await driver.watchContext!()).toEqual(context);
    expect((await driver.watchStatus!())[0]?.state).toBe("paused");
    expect(exchanges).toHaveLength(1);
    // Hold the watch's startup, then submit a tool through the driver's queue.
    // Both calls must use that startup without launching a page command.
    let release!:()=>void;
    const startup=new Promise<void>(resolve=>{release=resolve;});
    releaseStartup=release;
    let entered!:()=>void;
    const startupEntered=new Promise<void>(resolve=>{entered=resolve;});
    startupGate=()=>{entered();return startup;};
    const preparationsBefore=preparation.mock.calls.length;
    const configured=driver.watchConfigure!({...lease,lifecycleRevision:2,resumeFrom:{lifecycleRevision:0,pausedThrough:paused.pausedThrough!}});
    let entryTimer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([startupEntered,new Promise<never>((_,reject)=>{
        entryTimer=setTimeout(()=>reject(new Error("Watch did not enter browser startup")),2000);
      })]);
    } finally {clearTimeout(entryTimer);}
    const ordinary=driver.execute({action:"url"}).then(()=>"unexpected-success",error=>String(error.message));
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(preparation.mock.calls).toHaveLength(preparationsBefore+1);
    release();
    expect((await configured).state).toBe("watching");
    expect(await ordinary).toBe("Navigate before using page tools");
    expect(preparation.mock.calls).toHaveLength(preparationsBefore+1);
    await driver.watchPause!("producer",undefined,2);
    const push:BrowserWatchLease={grant:{...lease.grant,producer:"background",kinds:["push"]},ingestUrl:lease.ingestUrl};
    expect((await driver.watchConfigure!(push)).state).toBe("watching");
    expect(observerTargets.size).toBe(1);
    const session=await driver.sessionContext!();
    const installed=await driver.installSession!({...session,domain:"example.com",tenantId:"tenant",profileId:crypto.randomUUID(),runtimeId:crypto.randomUUID(),connectionId,
      allowedDomains:["example.com"],connectionGeneration:1,revision:7,expiresAt:Date.now()+30000,
      cookies:[{name:"sid",value:"fixture-session",domain:"example.com",path:"/",secure:true,httpOnly:true,sameSite:"Lax",hostOnly:true,expires:Math.floor(Date.now()/1000)+30}]});
    expect(installed.connectionId).toBe(connectionId);
    // Only the proven collector target was excluded; it is still alive and owned.
    expect(observerTargets.size).toBe(1);
    await driver.watchPause!("background");
    expect(observerTargets.size).toBe(0);
  } finally {releaseStartup?.();await driver?.close();db?.close();for(const mock of mocks)mock.mockRestore();await server.stop(true);rmSync(directory,{recursive:true,force:true});}
},15000);
