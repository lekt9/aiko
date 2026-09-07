import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { browserMemoryGraph } from "../src/browser-memory-graph.ts";
import { nodeStorage } from "entity-learn";
import { Memory } from "entity-learn/cloudflare";
import { indexToolArtifact, toolLogProjection } from "../src/log-memory.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCodeChildActor, scopedAgentsPackage } from "../src/code-agents.ts";
import { createWorkflowStore } from "../src/workflow-host.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { BrowserController } from "../src/browser.ts";
import { cancellationRequested } from "tardie/core/method/cancellation";

const dbs: Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function storage(): AccountStorage {
  const db=new Database(":memory:"); dbs.push(db); let alarm:number|null=null;
  return {sql:{exec:(q,...args)=>{const rows=db.query(q).all(...args as any);return {toArray:()=>rows as never};}},transactionSync:fn=>db.transaction(fn)(),sync:async()=>{},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;},deleteAlarm:async()=>{alarm=null;}};
}
const redact=(s:string)=>s;
test("native code mode discovers, validates and executes owner tools without journaling private results",async()=>{
  const harness=new CodeHarness("123","user-123",runCodeSegment,redact);
  let calls=0, modelCalls=0;
  const native={spec:{name:"fixture_read",description:"Read a record",inputSchema:{type:"object",properties:{id:{type:"integer",minimum:1}},required:["id"],additionalProperties:false}},run:()=>Effect.sync(()=>{calls++;return {text:"private customer evidence",ok:true};})};
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package([native])]),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:request=>{
    modelCalls++;
    expect(request.tools.map(t=>t.name)).toEqual(["execute"]);
    const returned=request.trajectory.find(e=>e.type==="ToolReturned");
    if(!returned)return Effect.succeed({kind:"call" as const,name:"execute",callId:"read-code",arguments:{code:"const spec=await tools.describe({name:'fixture_read'}); const bad=await tools.call({name:'fixture_read',arguments:{id:0}}); const good=await tools.call({name:spec.name,arguments:{id:1}}); return {bad,good};"}});
    expect((returned.result as any).result.bad.error).toContain("Arguments");
    expect((returned.result as any).result.good.text).toBe("private customer evidence");
    return Effect.succeed({kind:"complete" as const,output:"Verified"});
  }});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"turn",text:"read",at:1});
  await host.drive();
  const events=await host.read("user-123");
  expect(events.find(e=>e.type==="TurnCompleted")?.output).toBe("Verified");
  expect(calls).toBe(1);expect(modelCalls).toBe(2);
  expect(JSON.stringify(events)).not.toContain("private customer evidence");
  await host.drive(); expect(calls).toBe(1);
});
test("native child runs in a registered owner thread and returns without message-sending capability",async()=>{
  const harnesses=new Map<string,CodeHarness>(),definitions=new Map<string,ReturnType<typeof createCodeChildActor>>();
  const harness=(thread:string)=>{let h=harnesses.get(thread);if(!h){h=new CodeHarness("123",thread,runCodeSegment,redact);harnesses.set(thread,h);}return h;};
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:request=>{
    if(request.identity.thread.startsWith("ag.")) return Effect.succeed({kind:"complete" as const,output:"Child evidence"});
    const returned=request.trajectory.find(e=>e.type==="ToolReturned");
    if(!returned)return Effect.succeed({kind:"call" as const,name:"execute",callId:"parent-code",arguments:{code:"return await agents.run({text:'Read evidence',budget:3});"}});
    expect(JSON.stringify(returned.result)).toContain("Child evidence");
    return Effect.succeed({kind:"complete" as const,output:"Parent verified child"});
  }});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",allowChild:(parent,child)=>parent==="user-123"&&child.startsWith("ag."),actorFor:thread=>{
    let definition=definitions.get(thread);if(!definition){
      definition=thread==="user-123"?actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness(thread).package([]),scopedAgentsPackage("123")]),outputValidateOnce])]}):createCodeChildActor(harness(thread),[]);
      definitions.set(thread,definition);
    }return definition;
  },layersFor:thread=>Layer.merge(harness(thread).inference(model),harness(thread).sandboxLayer())});
  expect(()=>host.self("ag.forged")).toThrow();
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"parent-turn",text:"delegate",at:1});
  await host.drive();
  const events=await host.read("user-123");
  expect(events.find(e=>e.type==="TurnCompleted")?.output).toBe("Parent verified child");
  const child=(await host.threads()).find(t=>t.startsWith("ag."))!;
  expect(child).toBeDefined();expect(host.rootThread(child)).toBe("user-123");
  expect((await host.read(child))[0]?.type).toBe("ThreadCreated");
});
test("code workflows promote verified source and reuse fresh inputs under current schemas",async()=>{
  const db=new Database(":memory:");dbs.push(db);
  const store=createWorkflowStore(sqliteWorkflowKV(db));
  const harness=new CodeHarness("123","user-123",runCodeSegment,redact,store);
  const observed:number[]=[];
  const native={spec:{name:"fixture_read",description:"Read a number",inputSchema:{type:"object",properties:{id:{type:"integer"}},required:["id"],additionalProperties:false}},run:(args:any)=>Effect.sync(()=>{observed.push(args.id);return {number:args.id*10};})};
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package([native])]),harness.workflowComponent(),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:request=>{
    const results=request.trajectory.filter(e=>e.type==="ToolReturned");
    if(results.length===0)return Effect.succeed({kind:"call" as const,name:"code_workflow_run",callId:"first",arguments:{id:"scale-read-v1",code:"const row=await tools.call({name:'fixture_read',arguments:{id:input.id}}); return row.number+input.add;",description:"Read and scale",input:{id:2,add:3},inputSchema:{type:"object",properties:{id:{type:"integer"},add:{type:"integer"}},required:["id","add"],additionalProperties:false},outputSchema:{type:"integer"},dependencies:["fixture_read"]}});
    if(results.length===1){expect(results[0]!.result).toMatchObject({status:"succeeded",result:23});return Effect.succeed({kind:"call" as const,name:"code_workflow_save",callId:"save",arguments:{execId:"workflow:first"}});}
    if(results.length===2){expect(results[1]!.result).toMatchObject({reusable:true});return Effect.succeed({kind:"call" as const,name:"code_workflow_run",callId:"again",arguments:{id:"scale-read-v1",input:{id:7,add:4}}});}
    expect(results[2]!.result).toMatchObject({status:"succeeded",result:74});
    return Effect.succeed({kind:"complete" as const,output:"Workflow reused"});
  }});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"workflow-turn",text:"compose",at:1});await host.drive();
  expect((await host.read("user-123")).find(e=>e.type==="TurnCompleted")?.output).toBe("Workflow reused");
  expect(observed).toEqual([2,7]);
  const record=await store.getCode!("123","scale-read-v1");
  expect(record?.reusable).toBe(true);expect(record?.provenance?.execId).toBe("workflow:first");
  const logs=await host.read("user-123");
  const saved=logs.find(e=>e.type==="AikoCodeWorkflowSaved")!;
  expect(saved.digest).toBe(`sha256:${record!.digest}`);
  expect(toolLogProjection(saved)).toMatchObject({workflowId:"scale-read-v1",harness:"aiko-code/1"});
  expect(toolLogProjection({type:"AikoCodeToolSettled",tool:"fixture_read",result:{private:"never import"}})).toEqual({tool:"fixture_read"});
  const graph=browserMemoryGraph(logs.map((event,i)=>({seq:i+1,event})));
  expect(graph.nodes.some(n=>n.kind==="code-workflow")).toBe(true);
  expect(graph.edges.some(e=>e.from===`artifact:${saved.digest}`&&e.relation==="depends_on")).toBe(true);
  const memory=new Memory({storage:nodeStorage(":memory:"),scope:"artifact-test"});
  try {
    for(const event of logs)indexToolArtifact(memory,event,"123",redact);
    const artifacts=memory.recall({type:"tool-artifact",search:"scale-read-v1",depth:2,limit:10,maxNodes:24});
    const source=artifacts.items.find(h=>(h.observation.payload as any).workflowId==="scale-read-v1")!.observation;
    expect(source.dependsOn).toHaveLength(1);
    expect(memory.get(source.dependsOn[0]!)!.observation.payload).toEqual({digest:(saved.dependencies as any[])[0].digest});
    const before=memory.exportArchive();for(const event of logs)indexToolArtifact(memory,event,"123",redact);
    expect(memory.exportArchive()).toEqual(before);
  } finally {memory.close();}


  expect(await store.getCode!("456","scale-read-v1")).toBeUndefined();
  expect(JSON.stringify(record)).not.toContain('"number":');
  await expect(store.putCode!("123",{...record!,digest:"changed"})).rejects.toThrow("conflict");
});
test("code can transform browser output privately through the original owner-bound browser gate",async()=>{
  const marker="PRIVATE_BROWSER_EVIDENCE_98317";
  const browser=new BrowserController({domains:["*"],redact,requireInteractionApproval:false,factory:async ({owner})=>{
    expect(owner).toBe("123");return {execute:async()=>({text:marker}),close:async()=>{}};
  }});
  const harness=new CodeHarness("123","user-123",runCodeSegment,redact);
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package(browser.codeTools("123","user-123"))]),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:request=>{
    const result=request.trajectory.find(e=>e.type==="ToolReturned");
    if(!result)return Effect.succeed({kind:"call" as const,name:"execute",callId:"browser-code",arguments:{code:"await tools.call({name:'agent_browser_navigate',arguments:{url:'https://example.com'}});const row=await tools.call({name:'agent_browser_get_text',arguments:{selector:'body'}});return JSON.parse(row.untrustedPageContent).text;"}});
    expect((result.result as any).result).toBe(marker);return Effect.succeed({kind:"complete" as const,output:"Read verified"});
  }});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  try{await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"browse-turn",text:"read",at:1});await host.drive();
    const events=await host.read("user-123");expect(events.find(e=>e.type==="TurnCompleted")?.output).toBe("Read verified");expect(JSON.stringify(events)).not.toContain(marker);
  }finally{await browser.close();}
});
test("unknown workflow effects cannot be promoted even when their output schema accepts the return",async()=>{
  const db=new Database(":memory:");dbs.push(db);const store=createWorkflowStore(sqliteWorkflowKV(db));
  const harness=new CodeHarness("123","user-123",runCodeSegment,redact,store);let attempts=0;
  const native={spec:{name:"fixture_write",description:"Uncertain fixture write",inputSchema:{type:"object",properties:{},additionalProperties:false}},run:()=>Effect.sync(()=>{attempts++;return {status:"unknown"};})};
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package([native])]),harness.workflowComponent(),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:request=>{
    const results=request.trajectory.filter(e=>e.type==="ToolReturned");
    if(!results.length)return Effect.succeed({kind:"call" as const,name:"code_workflow_run",callId:"uncertain",arguments:{id:"uncertain-v1",code:"await tools.call({name:'fixture_write',arguments:{}});return 42;",input:{},inputSchema:{type:"object"},outputSchema:{type:"integer"},dependencies:["fixture_write"]}});
    if(results.length===1){expect(results[0]!.result).toMatchObject({status:"failed"});return Effect.succeed({kind:"call" as const,name:"code_workflow_save",callId:"bad-save",arguments:{execId:"workflow:uncertain"}});}
    expect(results[1]!.result).toMatchObject({status:"failed"});return Effect.succeed({kind:"complete" as const,output:"Unknown outcome retained"});
  }});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"uncertain-turn",text:"verify",at:1});await host.drive();
  expect((await host.read("user-123")).find(e=>e.type==="TurnCompleted")?.output).toBe("Unknown outcome retained");expect(attempts).toBe(1);expect((await store.getCode!("123","uncertain-v1"))?.reusable).toBe(false);
});
test("owner cancellation interrupts a package effect and settles the native code invocation",async()=>{
  const harness=new CodeHarness("123","user-123",runCodeSegment,redact);let started=false,aborted=false,attempts=0;
  const native={spec:{name:"fixture_wait",description:"Cancellable fixture",inputSchema:{type:"object",properties:{},additionalProperties:false}},run:(_args:unknown,ctx:{signal:AbortSignal})=>Effect.promise(()=>new Promise(resolve=>{attempts++;started=true;ctx.signal.addEventListener("abort",()=>{aborted=true;resolve({status:"unknown"});},{once:true});}))};
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([codeMode([harness.package([native])]),outputValidateOnce])]});
  const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"fixture",model_id:"fixture"}}),react:()=>Effect.succeed({kind:"call" as const,name:"execute",callId:"waiting-code",arguments:{code:"return await tools.call({name:'fixture_wait',arguments:{}});"}})});
  const host=await createCloudflareAccountHost({storage:storage(),actorName:"aiko",actorInstance:"demo",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.merge(harness.inference(model),harness.sandboxLayer())});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"cancel-code",text:"wait",at:1});const driving=host.drive();
  for(let i=0;!started&&i<100;i++)await Bun.sleep(5);expect(started).toBe(true);
  await host.commitRoot(host.self("user-123"),cancellationRequested({invocation:{method:"message",id:"cancel-code",epoch:0},request:"cancel-code-request",cause:"requested",at:Date.now()}));
  await driving;
  expect(aborted).toBe(true);expect(attempts).toBe(1);
  const events=await host.read("user-123");expect(events.some(e=>e.type==="TurnCancelled")).toBe(true);expect(events.find(e=>e.type==="CodeSettled")?.error).toContain("cancelled");
});
