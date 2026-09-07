import { expect, test } from "bun:test";
import { ToolWorkflows, validateWorkflowDefinition, type WorkflowDefinition, type WorkflowRecord, type WorkflowReceipt, type WorkflowStore, type RegisteredWorkflowTool, type WorkflowJson, type ToolWorkflowsOptions } from "../src/tool-workflows.ts";

class Store implements WorkflowStore {
  definitions = new Map<string, WorkflowRecord>(); runs = new Map<string, WorkflowReceipt>();
  key(owner: string, id: string) { return `${owner}:${id}`; }
  async getDefinition(owner: string, id: string) { return structuredClone(this.definitions.get(this.key(owner,id))); }
  async putDefinition(owner: string, record: WorkflowRecord) {
    const key = this.key(owner,record.definition.id), old = this.definitions.get(key);
    if (record.owner !== owner || old && old.digest !== record.digest) throw new Error("Conflict");
    this.definitions.set(key,structuredClone(record));
  }
  async listDefinitions(owner: string) { return structuredClone([...this.definitions.values()].filter(r=>r.owner===owner)); }
  async getRun(owner: string, id: string) { return structuredClone(this.runs.get(this.key(owner,id))); }
  async claimRun(owner: string, r: WorkflowReceipt) {
    const key = this.key(owner,r.runId);
    if (this.runs.has(key)) return false;
    this.runs.set(key,structuredClone(r)); return true;
  }
  async finishRun(owner: string, r: WorkflowReceipt) {
    const key = this.key(owner,r.runId), old = this.runs.get(key);
    if (!old || old.owner !== owner || old.digest !== r.digest || old.status !== "running") throw new Error("Conflict");
    this.runs.set(key,structuredClone(r));
  }
}
const literal = (value: WorkflowJson) => ({kind:"literal" as const,value});
const result = (step: string, ...path: string[]) => ({kind:"result" as const,step,path});
const step = (id: string, toolId = "echo"): WorkflowDefinition["steps"][number] => ({id,toolId,dependsOn:[] as string[],arguments:{value:literal(id)}});
const definition = (steps: WorkflowDefinition["steps"] = [step("first")]): WorkflowDefinition => ({version:1,id:"workflow",parameters:[],steps});
const sleep = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
function harness(extra: Partial<ToolWorkflowsOptions> = {}) {
  const store = new Store(), registry = new Map<string,RegisteredWorkflowTool>();
  const calls: {tool:string;owner:string;input:Record<string,WorkflowJson>}[] = [];
  const consumed: unknown[] = []; let allowed = true;
  function register(id: string, effect: "read"|"write", execute: RegisteredWorkflowTool["execute"], validate: RegisteredWorkflowTool["validate"] = input => Object.keys(input).length===1 && Object.hasOwn(input,"value")) {
    registry.set(id, {id,owner:"alice",effect,inputSchema:{type:"object",properties:{value:{}},required:["value"],additionalProperties:false},validate,
      authorize: async call => call.owner === "alice" && allowed,
      execute: async call => {
        // Actual registered dispatch: recheck host authorization at the effect boundary.
        if (call.owner !== "alice" || !allowed) return {status:"authorization_required"};
        calls.push({tool:id,owner:call.owner,input:structuredClone(call.input)});
        return execute(call);
      },
    });
  }
  register("echo","read",async call=>({status:"succeeded",output:call.input.value!}));
  const engine = new ToolWorkflows({owner:"alice",store,dispatcher:{resolve:async({owner,toolId})=>owner==="alice"?registry.get(toolId):undefined},consume:async value=>{consumed.push(structuredClone(value));},...extra});
  return {engine,store,registry,calls,consumed,register,deny:()=>{allowed=false;}};
}

test("real registered tools execute parallel read DAG bindings; receipt/persistence never contains values",async()=>{
 const h=harness(); let active=0,peak=0,release!:()=>void;
 const both=new Promise<void>(resolve=>{release=resolve;});
 h.register("source","read",async call=>{active++;peak=Math.max(peak,active);if(active===2)release();await both;active--;return {status:"succeeded",output:{items:[{amount:call.input.value}]}};});
 h.register("sum","read",async call=>({status:"succeeded",output:Number(call.input.left)+Number(call.input.right)}),input=>Object.keys(input).sort().join() === "left,right" && typeof input.left==="number" && typeof input.right==="number");
 const d:WorkflowDefinition={version:1,id:"workflow",parameters:["first","second"],steps:[
  {id:"a",toolId:"source",dependsOn:[],arguments:{value:{kind:"input",name:"first"}}},
  {id:"b",toolId:"source",dependsOn:[],arguments:{value:{kind:"input",name:"second"}}},
  {id:"sum",toolId:"sum",dependsOn:["a","b"],arguments:{left:result("a","items","0","amount"),right:result("b","items","0","amount")}},
 ],limits:{maxConcurrency:2,timeoutMs:1000}};
 await h.engine.define(d);
 const receipt=await h.engine.run({workflowId:d.id,runId:"run",input:{first:18723,second:92874}});
 expect(receipt.status).toBe("succeeded");expect(receipt.calls).toBe(3);expect(peak).toBe(2);
 expect(h.calls[2]?.input).toEqual({left:18723,right:92874});
 expect(h.consumed.at(-1)).toMatchObject({stepId:"sum",output:111597});
 const stored=JSON.stringify([...h.store.runs.values(),...h.store.definitions.values()]);
 for(const privateValue of ["18723","92874","111597",'"output"']) expect(stored).not.toContain(privateValue);
 expect((await h.engine.describe(d.id))?.reusable).toBe(false);
 expect((await h.engine.crystallize({workflowId:d.id,runId:"run"})).provenance).toEqual({runId:"run"});
 expect((await h.engine.list())[0]?.reusable).toBe(true);
});

test("write steps are exclusive, bounded read batches reach configured concurrency",async()=>{
 const h=harness();let active=0,peak=0,writes=0;
 h.register("read","read",async()=>{active++;peak=Math.max(peak,active);await sleep(5);active--;return {status:"succeeded",output:null};});
 h.register("write","write",async()=>{expect(active).toBe(0);writes++;active++;await sleep(5);active--;return {status:"succeeded",output:null};});
 const d=definition([step("a","read"),step("b","read"),step("c","read"),step("w","write"),step("d","read")]);d.limits={maxConcurrency:2};
 await h.engine.define(d);expect((await h.engine.run({workflowId:d.id,runId:"run",input:{}})).status).toBe("succeeded");expect(peak).toBe(2);expect(writes).toBe(1);
});

test("authorization and registered schema failures block dispatch and crystallization",async()=>{
 const h=harness();await h.engine.define(definition());h.deny();
 const r=await h.engine.run({workflowId:"workflow",runId:"denied",input:{}});
 expect(r.status).toBe("failed");expect(r.steps[0]?.status).toBe("authorization_required");expect(h.calls).toHaveLength(0);
 await expect(h.engine.crystallize({workflowId:"workflow",runId:"denied"})).rejects.toThrow("evidence");
 const bad=harness();bad.registry.get("echo")!.validate=()=>false;await bad.engine.define(definition());
 expect((await bad.engine.run({workflowId:"workflow",runId:"schema",input:{}})).calls).toBe(0);
});

for(const outcome of ["unknown","throw","malformed","timeout"] as const) test(`uncertain ${outcome} is unknown, never retried, and cannot crystallize`,async()=>{
 const h=harness();let executionCount=0;
 h.register("uncertain","write",async()=>{executionCount++;if(outcome==="throw")throw new Error("private response never leaked");if(outcome==="timeout")await sleep(60);if(outcome==="malformed")return {} as never;return {status:"unknown"};});
 const d=definition([step("write","uncertain"),{...step("next"),dependsOn:["write"]}]);d.limits={timeoutMs:10};await h.engine.define(d);
 const r=await h.engine.run({workflowId:d.id,runId:"run",input:{}});
 expect(r.status).toBe("unknown");expect(r.steps[1]?.status).toBe("skipped");expect(executionCount).toBe(1);
 expect(await h.engine.run({workflowId:d.id,runId:"run",input:{}})).toEqual(r);expect(executionCount).toBe(1);
 await expect(h.engine.crystallize({workflowId:d.id,runId:"run"})).rejects.toThrow();
 await sleep(65);expect(h.consumed).toHaveLength(0);expect(JSON.stringify(r)).not.toContain("private response");
});

test("atomic run claim prevents duplicate concurrent calls and restart replay of running claim",async()=>{
 const h=harness();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
 h.register("echo","read",async()=>{await waiting;return {status:"succeeded",output:42};});await h.engine.define(definition());
 const first=h.engine.run({workflowId:"workflow",runId:"same",input:{}});await sleep(5);
 expect((await h.engine.run({workflowId:"workflow",runId:"same",input:{}})).status).toBe("unknown");expect(h.calls).toHaveLength(1);
 release();expect((await first).status).toBe("succeeded");
 const record=(await h.engine.describe("workflow"))!;
 await h.store.claimRun("alice",{version:1,owner:"alice",workflowId:"workflow",digest:record.digest,runId:"crashed",calls:0,steps:[],status:"running"});
 const restarted=harness({store:h.store});expect((await restarted.engine.run({workflowId:"workflow",runId:"crashed",input:{}})).status).toBe("unknown");expect(restarted.calls).toHaveLength(0);
});

test("owner scope is enforced for definitions, dispatcher, runs and evidence",async()=>{
 const h=harness();await h.engine.define(definition());
 const other=new ToolWorkflows({owner:"bob",store:h.store,dispatcher:{resolve:async()=>h.registry.get("echo")}});
 expect(await other.list()).toEqual([]);await expect(other.run({workflowId:"workflow",runId:"run",input:{}})).rejects.toThrow();
 await other.define(definition());expect((await other.run({workflowId:"workflow",runId:"run",input:{}})).calls).toBe(0);
 await expect(other.crystallize({workflowId:"workflow",runId:"run"})).rejects.toThrow();
 const poisonedStore=new Store();poisonedStore.getDefinition=async()=>h.engine.describe("workflow");
 const poisoned=harness({store:poisonedStore,owner:"bob"});
 await expect(poisoned.engine.describe("workflow")).rejects.toThrow("owner");expect(h.calls).toHaveLength(0);
});

test("call budget stops further tools; missing bindings fail before dispatch",async()=>{
 const h=harness();const d=definition([step("a"),step("b"),step("c")]);d.limits={maxCalls:2};await h.engine.define(d);
 const r=await h.engine.run({workflowId:d.id,runId:"budget",input:{}});expect(r.status).toBe("failed");expect(r.calls).toBe(2);expect(h.calls).toHaveLength(2);
 const h2=harness();const missing:WorkflowDefinition=definition([step("a"),{...step("b"),dependsOn:["a"],arguments:{value:result("a","missing")}}]);await h2.engine.define(missing);
 expect((await h2.engine.run({workflowId:missing.id,runId:"missing",input:{}})).calls).toBe(1);
});

test("invalid graphs, fields, code, limits, and credential material are rejected before persistence",async()=>{
 const h=harness();
 const bads:unknown[]=[
 {...definition(),steps:[]},definition([step("a"),step("a")]),
 definition([{...step("a"),dependsOn:["missing"]}]),
 definition([{...step("a"),dependsOn:["b"]},{...step("b"),dependsOn:["a"]}]),
 definition([{...step("a"),arguments:{value:result("b")}},step("b")]),
 {...definition(),code:"exec('unsafe')"}, {...definition(),limits:{maxConcurrency:9}}, {...definition(),limits:{timeoutMs:60001}},
 {...definition(),limits:{maxCalls:0}},definition([{...step("a"),arguments:{value:literal("password=private")}}]),
 definition([{...step("a"),arguments:{value:literal("https://site.test/oauth?code=private")}}]),
 {...definition(),steps:Array.from({length:33},(_,i)=>step(`s${i}`))},
 definition([{...step("a"),arguments:{value:{kind:"eval",code:"unsafe"} as never}}]),
 ];
 for(const bad of bads){expect(()=>validateWorkflowDefinition(bad)).toThrow();}
 expect(h.store.definitions.size).toBe(0);
 const d:WorkflowDefinition={...definition(),parameters:["value"],steps:[{...step("a"),arguments:{value:{kind:"input",name:"value"}}}]};await h.engine.define(d);
 await expect(h.engine.run({workflowId:d.id,runId:"secret",input:{value:"authorization=private"}})).rejects.toThrow();expect(h.store.runs.size).toBe(0);
});

test("current auth is rechecked for reusable workflows; definitions cannot be changed under evidence",async()=>{
 const h=harness();await h.engine.define(definition());await h.engine.run({workflowId:"workflow",runId:"success",input:{}});await h.engine.crystallize({workflowId:"workflow",runId:"success"});
 h.deny();expect((await h.engine.run({workflowId:"workflow",runId:"later",input:{}})).status).toBe("failed");expect(h.calls).toHaveLength(1);
 await expect(h.engine.define(definition([step("different")]))).rejects.toThrow("immutable");
});

test("result credential guards block downstream calls and consume; injected guard covers unlabelled host secrets",async()=>{
 const h=harness({guard:v=>{if(JSON.stringify(v).includes("host-private-value"))throw new Error("Secret");}});
 h.register("source","read",async()=>({status:"succeeded",output:"host-private-value"}));
 await h.engine.define(definition([step("a","source"),{...step("b"),dependsOn:["a"],arguments:{value:result("a")}}]));
 const r=await h.engine.run({workflowId:"workflow",runId:"run",input:{}});expect(r.status).toBe("unknown");expect(h.calls).toHaveLength(1);expect(h.consumed).toHaveLength(0);expect(JSON.stringify([...h.store.runs.values()])).not.toContain("host-private-value");
});

test("pre-cancelled runs have no claim; deadline bounds an uncooperative resolver",async()=>{
 const h=harness();await h.engine.define(definition());const c=new AbortController();c.abort();
 await expect(h.engine.run({workflowId:"workflow",runId:"cancel",input:{},signal:c.signal})).rejects.toThrow();expect(h.store.runs.size).toBe(0);
 const stuck=harness({dispatcher:{resolve:async()=>new Promise(()=>{})}});const d=definition();d.limits={timeoutMs:10};await stuck.engine.define(d);
 const start=Date.now();expect((await stuck.engine.run({workflowId:"workflow",runId:"bounded",input:{}})).status).toBe("failed");expect(Date.now()-start).toBeLessThan(500);
});

test("actual host workflowDispatcher executes connected Arcade engine using connection ID and exact schema",async()=>{
 const {ConnectorEngine,connectorStorePrefix}=await import("../src/connectors.ts");
 const {workflowDispatcher}=await import("../src/workflow-host.ts");
 const rows=new Map<string,unknown>();let outbound=0;
 const connector=new ConnectorEngine({owner:"123",env:{ARCADE_API_KEY:"fixture-only-workflow-key"},store:{
  get:async k=>structuredClone(rows.get(k)),set:async(k,v)=>{rows.set(k,structuredClone(v));},list:async prefix=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([,v])=>structuredClone(v)),
 },fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith("/tools"))return Response.json({items:[{qualified_name:"Example.Read",toolkit:{name:"Example"},metadata:{behavior:{read_only:true,destructive:false}},formatted_schema:{type:"object",properties:{count:{type:"integer",minimum:1,maximum:3}},required:["count"],additionalProperties:false}}],offset:0,total_count:1});
  if(path.endsWith("/execute")){outbound++;const body=JSON.parse(String(init?.body));expect(body.user_id).toBe("123");expect(body.tool_name).toBe("Example.Read");return Response.json({success:true,output:{value:{items:Array.from({length:body.input.count},(_,i)=>i)}}});}
  throw new Error("Unexpected fixture endpoint");
 }});
 const fixtureId=crypto.randomUUID();rows.set(`${connectorStorePrefix("123")}connection:${fixtureId}`,{id:fixtureId,owner:"123",connectorId:"arcade:Example.Read",provider:"arcade",status:"connected",createdAt:Date.now(),expiresAt:Date.now()+600000,toolName:"Example.Read"});
 const store=new Store();const outputs:unknown[]=[];
 const engine=new ToolWorkflows({owner:"123",store,dispatcher:workflowDispatcher({owner:"123",engine:connector,readEvents:async()=>[],redact:s=>s}),consume:async v=>{outputs.push(v.output);}});
 const d:WorkflowDefinition={version:1,id:"arcade_workflow",parameters:["count"],steps:[{id:"read",toolId:"arcade:Example.Read",dependsOn:[],arguments:{count:{kind:"input",name:"count"}}}]};
 await engine.define(d);
 expect((await engine.run({workflowId:d.id,runId:"schema_reject",input:{count:20}})).calls).toBe(0);
 expect(outbound).toBe(0);
 expect((await engine.run({workflowId:d.id,runId:"real_dispatch",input:{count:2}})).status).toBe("succeeded");
 expect(outbound).toBe(1);expect(outputs).toEqual([{items:[0,1]}]);
});

test("write policy denial, malformed outputs and sink failure never manufacture reusable success",async()=>{
 const denied=harness();denied.register("write","write",async()=>({status:"succeeded",output:null}));denied.deny();await denied.engine.define(definition([step("write","write")]));
 expect((await denied.engine.run({workflowId:"workflow",runId:"denied_write",input:{}})).calls).toBe(0);
 for(const output of [undefined,Number.NaN,"x".repeat(131073)]) {
  const h=harness();h.register("source","read",async()=>({status:"succeeded",output}));await h.engine.define(definition([step("source","source")]));
  const r=await h.engine.run({workflowId:"workflow",runId:"invalid_output",input:{}});expect(r.status).toBe("unknown");expect(h.consumed).toHaveLength(0);expect(r.calls).toBe(1);
 }
 const failingSink=harness({consume:async()=>{throw new Error("private sink content");}});await failingSink.engine.define(definition());
 const r=await failingSink.engine.run({workflowId:"workflow",runId:"sink_failure",input:{}});expect(r.status).toBe("unknown");expect(JSON.stringify(r)).not.toContain("private sink");
});

test("validator and policy cannot mutate the eventual tool arguments; failure stops dependencies without retry",async()=>{
 const h=harness();h.registry.get("echo")!.validate=input=>{input.value="validator mutation";return true;};h.registry.get("echo")!.authorize=async call=>{call.input.value="policy mutation";return true;};
 await h.engine.define(definition());expect((await h.engine.run({workflowId:"workflow",runId:"isolation",input:{}})).status).toBe("succeeded");expect(h.calls[0]?.input).toEqual({value:"first"});
 const failed=harness();failed.register("fail","write",async()=>({status:"failed"}));await failed.engine.define(definition([step("fail","fail"),{...step("next"),dependsOn:["fail"]}]));
 const receipt=await failed.engine.run({workflowId:"workflow",runId:"failed",input:{}});expect(receipt.status).toBe("failed");expect(receipt.calls).toBe(1);expect(receipt.steps[1]?.status).toBe("skipped");
});
