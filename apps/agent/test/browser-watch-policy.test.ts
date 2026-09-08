import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event } from "tardie/core/event";
import { nativeBrowserWatchPolicy, type NativeBrowserWatchPolicyOptions } from "../src/browser-watch-policy.ts";
import { ConnectorEngine, connectorStorePrefix, type ConnectorStore } from "../src/connectors.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { channelSeal, channelHydrate } from "../src/channel-custody.ts";
import type { BrowserWatchConfig, BrowserWatchDiscovery } from "../src/browser-watches.ts";
import type { BrowserWatchRunnerStatus } from "../src/browser-watch-runner.ts";
const closes:(()=>void)[]=[];
afterEach(()=>{for(const close of closes.splice(0))close();});
const signal=()=>AbortSignal.timeout(5000);
const owner="123",connectionId="11111111-1111-4111-8111-111111111111";
async function fixture(){
  const rows=new Map<string,unknown>(),events:Event[]=[],db=new Database(":memory:");closes.push(()=>db.close());
  let enabled=true,profile="owned-profile",privateCalls=0,contextHook=()=>{},sourceHook=()=>{},actionHook=()=>{};
  const denied=async():Promise<never>=>{privateCalls++;throw Error("Private pages, providers and evaluators must not run");};
  const store:ConnectorStore={get:async key=>structuredClone(rows.get(key)),set:async(key,value)=>{rows.set(key,structuredClone(value));},
    list:async prefix=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([,row])=>structuredClone(row))};
  const connection={id:connectionId,owner,connectorId:"browser:site.example.com",provider:"browser",status:"connected",createdAt:Date.now(),expiresAt:Date.now()+3600000,
    browserVerification:{verified:true,revision:7,expiresAt:Date.now()+3600000},credentialReference:"PRIVATE_CREDENTIAL_REFERENCE"};
  rows.set(`${connectorStorePrefix(owner)}connection:${connectionId}`,connection);
  const connections=new ConnectorEngine({owner,store,secureBrowser:{native:true,begin:denied,status:denied,control:denied,disconnect:denied},onEvent:denied,fetch:denied});
  const journal={read:async()=>events,append:async(batch:Event[])=>{events.push(...batch);}};
  const verifier={digest:harnessDigest("policy-check"),evaluatorDigest:harnessDigest("policy-cases"),cases:[],verify:denied};
  const library=new HarnessLibrary({owner,thread:`user-${owner}`,blobs:harnessBlobStore(sqliteWorkflowKV(db)),verifiers:new Map([[verifier.digest,verifier]]),
    context:denied,authorize:denied,execute:denied,guard:()=>{}},journal);
  const contractDigest=await library.registerContract({version:1,outcome:"Read the configured value",inputSchema:{type:"object"},outputSchema:{type:"object"},effect:"read",
    verifierDigest:verifier.digest,evaluatorDigest:verifier.evaluatorDigest,applicability:{},timeoutMs:1000});
  const digest=await library.record({version:1,name:"policy-read",description:"A configured read action",runtime:"javascript",entrypoint:"main.js",files:{"main.js":"return input;"},dependencies:[],
    sources:[{uri:"fixture:policy",revision:"1",digest:harnessDigest("policy-source"),license:"test-fixture"}],contractDigest});
  const action:BrowserWatchConfig["action"]={kind:"harness",digest,contractDigest,input:{selection:"configured"},eventInputs:{event:["payload","id"]}};
  let sites:BrowserWatchDiscovery["sites"]=[{connectionId,label:"Connected site",origin:"https://site.example.com",connectionRevision:"7",sourceGeneration:1,
    events:[{id:"new-item",label:"New item",kind:"network",outcome:"completed",method:"GET",route:"/api/items"}]}];
  let actions:BrowserWatchDiscovery["actions"]=[{id:"read",label:"Read saved value",action}];
  const calls:{operation:string;args:unknown[]}[]=[],statuses:BrowserWatchRunnerStatus[]=[];
  const runner:NativeBrowserWatchPolicyOptions["runner"]={
    watchContext:async s=>{calls.push({operation:"context",args:[s]});contextHook();s?.throwIfAborted();return {owner,profile};},
    watchConfigure:async(lease,s)=>{calls.push({operation:"configure",args:[lease,s]});return {producer:lease.grant.producer,generation:lease.grant.generation,lifecycleRevision:lease.lifecycleRevision??0,state:"watching",reason:"ready",expiresAt:lease.grant.expiresAt};},
    watchPause:async(...args)=>{calls.push({operation:"pause",args});return {producer:args[0],generation:1,lifecycleRevision:args[2]??0,pausedThrough:3,state:"paused",reason:"paused",expiresAt:Date.now()+1000};},
    watchStatus:async(...args)=>{calls.push({operation:"status",args});return statuses;},
    watchAcknowledgeGap:async(...args)=>{calls.push({operation:"gap",args});return statuses[0]!;},
  };
  const options:NativeBrowserWatchPolicyOptions={owner,ingressOrigin:"https://ingress.example.com",connections,runner,library,receivingAuthority:"watch-receiver",current:()=>enabled,
    discoverSources:async(authorities,s)=>{s.throwIfAborted();expect(JSON.stringify(authorities)).not.toContain("PRIVATE");sourceHook();return sites;},
    discoverActions:async s=>{s.throwIfAborted();actionHook();return actions;},defaults:{expiresInMs:60000,backlog:8,maxOccurrences:100}};
  const context={owner,thread:`user-${owner}`,journal:undefined as never,wiring:undefined as never,sources:undefined as never};
  const policy=nativeBrowserWatchPolicy(options)(context);
  const config:BrowserWatchConfig={id:"new-items",label:"Watch items",connectionId,connectionRevision:"7",sourceGeneration:1,origin:"https://site.example.com",kind:"network",outcome:"completed",method:"GET",route:"/api/items",
    action,expiresAt:Date.now()+60000,backlog:8,maxOccurrences:100};
  return {policy,options,context,config,connection,library,events,calls,statuses,db,privateCalls:()=>privateCalls,
    revoke:()=>{enabled=false;},profile:(value:string)=>{profile=value;},contextHook:(hook:typeof contextHook)=>{contextHook=hook;},
    sourceHook:(hook:typeof sourceHook)=>{sourceHook=hook;},actionHook:(hook:typeof actionHook)=>{actionHook=hook;},
    sites:(value:typeof sites)=>{sites=value;},actions:(value:typeof actions)=>{actions=value;}};
}
const identity=()=>({producer:"watch-new-items",epoch:"epoch-private",registeredAt:Date.now()});

test("policy discovers only configured capabilities using committed metadata without private work or evaluation",async()=>{
  const f=await fixture();
  const found=await f.policy.discovery!(signal());
  expect(found.sites[0]!.events).toMatchObject([{kind:"network",route:"/api/items"}]);
  expect(found.actions).toHaveLength(1);expect(f.calls).toHaveLength(0);expect(f.privateCalls()).toBe(0);
  expect(await f.policy.authorize(f.config,"configure",signal())).toBe(true);
  expect(await f.policy.authorize({...f.config,kind:"push",outcome:"received",method:undefined,route:undefined},"configure",signal())).toBe(false);
  expect(await f.policy.authorize({...f.config,route:"/api/delete-all"},"dispatch",signal())).toBe(false);
  expect(await f.policy.authorize({...f.config,action:{...f.config.action,input:{selection:"unapproved"}} as typeof f.config.action},"dispatch",signal())).toBe(false);
  f.actions([{id:"actor",label:"Unavailable agent",action:{kind:"actor",instruction:"Do things"}}]);
  expect((await f.policy.discovery!(signal())).actions).toEqual([]);
  expect(await f.policy.authorize(f.config,"dispatch",signal())).toBe(false);
  f.sites([]);expect((await f.policy.discovery!(signal())).sites).toEqual([]);
  expect(f.privateCalls()).toBe(0);expect(f.calls).toHaveLength(0);
});

test("lease preparation binds exact private profile and fixed ingress while native custody seals a random producer key",async()=>{
  const f=await fixture();const first=await f.policy.prepareLease(f.config,identity(),signal()),second=await f.policy.prepareLease(f.config,identity(),signal());
  expect(first.grant).toMatchObject({owner,profile:"owned-profile",connectionRevision:"7",generation:1,origins:["https://site.example.com"],kinds:["network"]});
  expect(first.networkRoutes).toEqual([{method:"GET",route:"/api/items"}]);
  expect(first.ingestUrl).toBe(`https://ingress.example.com/v1/browser-events/${owner}`);
  expect(first.grant.secret).toHaveLength(43);expect(first.grant.secret).not.toBe(second.grant.secret);
  const ref=await channelSeal(f.library.binding.blobs,owner,{config:f.config,lease:first});
  expect(await channelHydrate(f.library.binding.blobs,owner,ref)).toEqual({config:f.config,lease:first});
  expect(JSON.stringify(f.db.query("SELECT * FROM workflow_records").all())).not.toContain(first.grant.secret);
  const resumed={...first,lifecycleRevision:2,resumeFrom:{lifecycleRevision:1,pausedThrough:3}};
  await f.policy.configureLease(resumed,signal());
  expect(f.calls.at(-1)!.operation).toBe("configure");expect(f.calls.at(-1)!.args[0]).toEqual(resumed);
  expect(f.calls.at(-1)!.args[1]).toBeInstanceOf(AbortSignal);
  const before=f.calls.filter(c=>c.operation==="configure").length;
  await expect(f.policy.configureLease({...first,ingestUrl:"https://attacker.example.com/events"},signal())).rejects.toThrow("binding_mismatch");
  f.profile("replacement-profile");
  await expect(f.policy.configureLease(first,signal())).rejects.toThrow("authority_unavailable");
  expect(f.calls.filter(c=>c.operation==="configure")).toHaveLength(before);expect(f.privateCalls()).toBe(0);
});

test("actor and webhook discovery require mounted capabilities and preserve exact destination authority",async()=>{
  const f=await fixture();
  expect(()=>nativeBrowserWatchPolicy({...f.options,nativeActions:{actor:{} as never}})).toThrow("watch_actor_commit_authority_required");
  f.actions([{id:"actor",label:"Ask Aiko",supportsInstruction:true,action:{kind:"actor",instruction:"Summarize this event"}},
    {id:"hook",label:"Configured receiver",action:{kind:"webhook",destination:"requests"}}]);
  expect((await f.policy.discovery!(signal())).actions).toEqual([]);
  const policy=nativeBrowserWatchPolicy({...f.options,nativeActions:{actor:{timeoutMs:60000,commitCurrent:()=>true},webhook:{resolve:async()=>undefined}}})(f.context);
  expect((await policy.discovery!(signal())).actions).toHaveLength(2);
  expect(await policy.authorize({...f.config,action:{kind:"actor",instruction:"Summarize the new request"}},"configure",signal())).toBe(true);
  expect(await policy.authorize({...f.config,action:{kind:"webhook",destination:"requests"}},"configure",signal())).toBe(true);
  expect(await policy.authorize({...f.config,action:{kind:"webhook",destination:"attacker"}},"configure",signal())).toBe(false);
  f.actions([{id:"actor",label:"Fixed action",action:{kind:"actor",instruction:"Summarize this event"}}]);
  expect(await policy.authorize({...f.config,action:{kind:"actor",instruction:"Changed instruction"}},"configure",signal())).toBe(false);
  f.revoke();expect(await policy.authorize({...f.config,action:{kind:"actor",instruction:"Summarize this event"}},"dispatch",signal())).toBe(false);
  expect(f.calls).toHaveLength(0);expect(f.privateCalls()).toBe(0);
});

test("connection revision, expiry and owner changes across awaits fail before private configuration or dispatch",async()=>{
  const f=await fixture(),lease=await f.policy.prepareLease(f.config,identity(),signal());
  f.connection.browserVerification.revision=8;
  expect(await f.policy.authorize(f.config,"dispatch",signal())).toBe(false);
  await expect(f.policy.configureLease(lease,signal())).rejects.toThrow("source_unavailable");
  expect((await f.policy.discovery!(signal())).sites).toEqual([]);
  f.connection.browserVerification.revision=7;
  f.actionHook(()=>{f.connection.browserVerification.revision=8;});
  expect(await f.policy.authorize(f.config,"configure",signal())).toBe(false);
  expect((await f.policy.discovery!(signal())).sites).toEqual([]);
  f.actionHook(()=>{});f.connection.browserVerification.revision=7;
  f.contextHook(()=>{f.connection.status="disconnected";});
  await expect(f.policy.prepareLease(f.config,identity(),signal())).rejects.toThrow("authority_unavailable");
  expect(f.calls.some(c=>c.operation==="configure")).toBe(false);
  f.connection.status="connected";f.connection.browserVerification.expiresAt=Date.now()-1;
  expect(await f.policy.authorize(f.config,"dispatch",signal())).toBe(false);
  f.revoke();await expect(f.policy.discovery!(signal())).rejects.toThrow("authority_unavailable");
});

test("signals and exact lifecycle flow through borrowed controls and cancellation stops preparation",async()=>{
  const f=await fixture(),s=signal();
  f.statuses.push({producer:"other",generation:1,state:"watching",reason:"ready",expiresAt:Date.now()+1000},
    {producer:"watch-new-items",generation:1,lifecycleRevision:2,pausedThrough:3,state:"paused",reason:"paused",expiresAt:Date.now()+1000});
  await f.policy.pauseLease("watch-new-items",s,2);
  expect(f.calls.at(-1)).toEqual({operation:"pause",args:["watch-new-items",s,2]});
  expect(await f.policy.leaseStatus!("watch-new-items",s)).toEqual(f.statuses[1]);
  expect(f.calls.at(-1)).toEqual({operation:"status",args:[s]});
  await f.policy.acknowledgeGap!("watch-new-items",1,4,s);
  expect(f.calls.at(-1)).toEqual({operation:"gap",args:["watch-new-items",1,4,s]});
  const controller=new AbortController();f.contextHook(()=>controller.abort());
  await expect(f.policy.prepareLease(f.config,identity(),controller.signal)).rejects.toThrow();
  expect((f.calls.at(-1)!.args[0] as AbortSignal).aborted).toBe(true);
  expect(f.calls.some(c=>c.operation==="configure")).toBe(false);
});

test("policy rejects noncanonical/private ingress, foreign assembly, stale source metadata and invalid pins",async()=>{
  const f=await fixture();
  for(const ingressOrigin of ["http://ingress.example.com","https://ingress.example.com/","https://ingress.example.com/path","https://u:p@ingress.example.com","https://127.0.0.1"])
    expect(()=>nativeBrowserWatchPolicy({...f.options,ingressOrigin})).toThrow();
  expect(()=>nativeBrowserWatchPolicy(f.options)({...f.context,owner:"456"})).toThrow("owner_invalid");
  const found=await f.policy.discovery!(signal());
  f.sites([{...found.sites[0]!,origin:"https://child.site.example.com"}]);
  expect((await f.policy.discovery!(signal())).sites).toEqual([]);
  f.sites(found.sites);f.actions([{id:"wrong",label:"Wrong pin",action:{...f.config.action,contractDigest:harnessDigest("wrong")} as typeof f.config.action}]);
  await expect(f.policy.discovery!(signal())).rejects.toThrow("contract_pin_mismatch");
  expect(f.privateCalls()).toBe(0);expect(f.calls).toHaveLength(0);
});

test("configure snapshots its private lease, respects cancellation, and receipts keep current authority after collection expiry",async()=>{
  const f=await fixture(),lease=await f.policy.prepareLease(f.config,identity(),signal());
  const original=structuredClone(lease);
  f.sourceHook(()=>{lease.ingestUrl="https://attacker.example.com/events";lease.grant.origins=["https://attacker.example.com"];});
  await f.policy.configureLease(lease,signal());
  expect(f.calls.at(-1)!.args[0]).toEqual(original);
  f.sourceHook(()=>{});
  const before=f.calls.filter(c=>c.operation==="configure").length,controller=new AbortController();
  f.contextHook(()=>controller.abort());
  await expect(f.policy.configureLease(original,controller.signal)).rejects.toThrow();
  expect(f.calls.filter(c=>c.operation==="configure")).toHaveLength(before);
  const expired={...f.config,expiresAt:Date.now()-1};
  expect(await f.policy.authorize(expired,"dispatch",signal())).toBe(false);
  expect(await f.policy.authorize(expired,"reconcile",signal())).toBe(true);
  f.connection.browserVerification.revision++;
  expect(await f.policy.authorize(expired,"reconcile",signal())).toBe(false);
});

test("discovery supplies the actual session deadline and bounded defaults without extending a short connection",async()=>{
  const f=await fixture(),start=Date.now();let now=start;
  const clock=spyOn(Date,"now").mockImplementation(()=>now);
  try {
    f.connection.browserVerification.expiresAt=start+30000;
    const choices=await f.policy.discovery!(signal());
    expect(choices.defaults.expiresInMs).toBe(30000);
    expect(choices.sites[0]!.expiresAt).toBe(start+30000);
    // A delayed UI selection can clamp against the fixed deadline, not renew it.
    now+=10000;
    const config={...f.config,expiresAt:Math.min(now+choices.defaults.expiresInMs,choices.sites[0]!.expiresAt!)};
    expect(await f.policy.authorize(config,"configure",signal())).toBe(true);
    expect(await f.policy.authorize({...config,expiresAt:now+choices.defaults.expiresInMs},"configure",signal())).toBe(false);
    now=start+29500;
    expect((await f.policy.discovery!(signal())).sites).toEqual([]);
    expect(f.calls).toHaveLength(0);
  }finally{clock.mockRestore();}
});
