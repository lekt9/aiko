import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createBunHost } from "tardie/bun/host";
import { createToolRouterActor, routerEventKey, type RouterMethod, type ToolRouterBinding } from "../src/tool-router.ts";
import { codeSchemaDigest, codeWorkflowDigest, ToolWorkflows, type CodeWorkflowRecord, type WorkflowRecord, type WorkflowReceipt, type WorkflowStore } from "../src/tool-workflows.ts";
import type { ConnectorDescription, Connection } from "../src/connectors.ts";
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f()});
async function fixture(){
 const definitions=new Map<string,WorkflowRecord>(),runs=new Map<string,WorkflowReceipt>();
 const store:WorkflowStore={getDefinition:async(owner,id)=>definitions.get(`${owner}:${id}`),putDefinition:async(owner,r)=>{definitions.set(`${owner}:${r.definition.id}`,structuredClone(r))},listDefinitions:async owner=>[...definitions.values()].filter(r=>r.owner===owner),getRun:async(owner,id)=>runs.get(`${owner}:${id}`),claimRun:async(owner,r)=>{const k=`${owner}:${r.runId}`;if(runs.has(k))return false;runs.set(k,r);return true},finishRun:async(owner,r)=>{runs.set(`${owner}:${r.runId}`,r)}};
 const catalog:ConnectorDescription[]=[{id:"arcade:GitHub.FindIssues",name:"FindIssues",toolName:"GitHub.FindIssues",description:"Find repository issues",provider:"arcade",domains:["github.com"],toolkit:{name:"GitHub",version:"1"},inputSchema:{type:"object",properties:{repository:{type:"string"}},required:["repository"],additionalProperties:false},input:{},domainEvidence:[],requirements:{},metadata:{}}];
 const connections:Connection[]=[{id:"owned-connection",connectorId:catalog[0]!.id,provider:"arcade",status:"connected",createdAt:1}];
 const engine=new ToolWorkflows({owner:"123",store,dispatcher:{resolve:async()=>({owner:"123",id:catalog[0]!.id,effect:"read",inputSchema:catalog[0]!.inputSchema,validate:input=>typeof input.repository==="string",authorize:async()=>true,execute:async()=>({status:"succeeded",output:{issues:[]}})})}});
 await engine.define({version:1,id:"FindRepositoryIssueDigest",parameters:["repository"],steps:[{id:"find",toolId:catalog[0]!.id,dependsOn:[],arguments:{repository:{kind:"input",name:"repository"}}}]});
 const run=await engine.run({workflowId:"FindRepositoryIssueDigest",runId:"verified-run",input:{repository:"owned/repo"}});
 expect(run.status).toBe("succeeded");
 const saved=await engine.crystallize({workflowId:"FindRepositoryIssueDigest",runId:"verified-run"});
 const records=[saved]; const codes:CodeWorkflowRecord[]=[]; const specs:{name:string;description:string;inputSchema:Record<string,unknown>}[]=[];let unavailable=false,authorityUnavailable=false;
 const binding:ToolRouterBinding={owner:"123",listWorkflows:async()=>records,listCodeWorkflows:async()=>codes,codeToolSpecs:()=>specs,engine:{listCatalog:async()=>{if(unavailable)throw new Error("unavailable");return catalog},describe:async id=>catalog.find(c=>c.id===id)!,connections:async()=>connections,search:async()=>({status:authorityUnavailable?"unavailable":"available",fallbackAllowed:false,connectors:authorityUnavailable?[]:catalog,message:"catalog"})}};
 const dir=await mkdtemp("/tmp/router-workflows-");const options={database:join(dir,"router.sqlite"),actorName:"aiko",actorInstance:"test",actorFor:()=>createToolRouterActor(binding),keyOf:routerEventKey};
 let host=await createBunHost(options);cleanup.push(async()=>{await host.close();await rm(dir,{recursive:true,force:true})});let n=0;
 const call=async(method:RouterMethod,input:unknown,id=`call-${++n}`):Promise<any>=>{const actor=createToolRouterActor(binding),invocation={method,id,epoch:0};await host.commitRoot(host.self("router-123"),actor.methods[method].eventOf({input,invocation,at:Date.now()}));await host.wake("router-123");const result=actor.methods[method].state(await host.read("router-123"),invocation);expect(result?.status).toBe("completed");return result?.status==="completed"?result.output:undefined};
 return {call,records,codes,specs,catalog,connections,setUnavailable:()=>{unavailable=true},setAuthorityUnavailable:()=>{authorityUnavailable=true},restart:async()=>{await host.close();host=await createBunHost(options);await host.recover()}};
}
const task={tasks:[{id:"digest",query:"Find repository issue digest",domain:"github.com",arguments:{repository:"owned/repo"}}]};
test("native router selects successfully crystallized workflow and describes exact workflow_run mapping",async()=>{
 const f=await fixture();const decision=await f.call("route",task,"stable");
 expect(decision.state).toBe("ready");expect(decision.tasks[0].tools[0].id).toBe("workflow:FindRepositoryIssueDigest");
 const described=await f.call("describe",{toolIds:["workflow:FindRepositoryIssueDigest"]});
 expect(described.tools[0]).toMatchObject({provider:"workflow",inputSchema:{type:"object",properties:{repository:{}},required:["repository"],additionalProperties:false},requirements:{executeWith:"workflow_run",reauthorizeEveryRun:true,provenance:{runId:"verified-run"},execution:{tool:"workflow_run",arguments:{workflowId:"FindRepositoryIssueDigest"},inputParameter:"input",inputEncoding:"json"}}});
 await f.restart();expect(await f.call("route",task,"stable")).toEqual(decision);
});
test("foreign, uncrystallized and tampered workflows are excluded from describe and discovery",async()=>{
 const f=await fixture();const original=f.records[0]!;
 f.records.splice(0,1,{...original,owner:"456"},{...original,reusable:false},{...original,provenance:undefined},{...original,digest:"tampered"});
 expect((await f.call("describe",{toolIds:["workflow:FindRepositoryIssueDigest"]})).state).toBe("needs_discovery");
 expect((await f.call("discover",task)).tasks[0].tools.every((t:any)=>t.provider!=="workflow")).toBe(true);
});
test("owned connection, catalog version and crystallization changes invalidate saved native decisions",async()=>{
 const f=await fixture();const first=await f.call("route",task);
 expect(await f.call("status",{decisionId:first.id})).toMatchObject({current:true});
 f.connections[0]!.status="disconnected";
 expect(await f.call("status",{decisionId:first.id})).toMatchObject({current:false});
 const second=await f.call("route",task);expect(second.state).toBe("needs_connection");expect(second.id).not.toBe(first.id);
 f.catalog[0]!.toolkit.version="2";expect(await f.call("status",{decisionId:second.id})).toMatchObject({current:false});
 const third=await f.call("route",task);f.records[0]!.reusable=false;expect(await f.call("status",{decisionId:third.id})).toMatchObject({current:false});
});
test("saved workflows cannot bypass unavailable Arcade authority or catalog",async()=>{
 const f=await fixture();const decision=await f.call("route",task);f.setAuthorityUnavailable();
 expect(await f.call("status",{decisionId:decision.id})).toMatchObject({current:false});
 expect((await f.call("route",task)).tasks[0]).toMatchObject({state:"needs_discovery",fallbackAllowed:false,tools:[]});
 f.setUnavailable();expect(await f.call("route",task)).toMatchObject({state:"catalog_unavailable"});
});

test("read intent cannot hide a mutation behind a saved workflow name",async()=>{
 const f=await fixture();f.catalog[0]!.toolName="GitHub.DeleteIssues";
 const result=await f.call("route",task);
 expect(result.tasks[0].tools).toEqual([]);
 expect(result.tasks[0].state).toBe("needs_discovery");
});

test("verified code artifacts route after restart and invalidate on dependency drift",async()=>{
 const f=await fixture();
 const spec={name:"fixture_read",description:"Read weather forecast",inputSchema:{type:"object",properties:{city:{type:"string"}},required:["city"]}};
 f.specs.push(spec);
 const record:CodeWorkflowRecord={version:1,owner:"123",id:"weather-report",description:"Read weather forecast",code:"return await tools.call({name:'fixture_read',arguments:input});",inputSchema:spec.inputSchema,outputSchema:{type:"object"},dependencies:[{name:spec.name,schemaDigest:codeSchemaDigest(spec.inputSchema)}],digest:"",reusable:true,provenance:{thread:"user-123",execId:"workflow:verified",harness:"aiko-code/1"}};
 record.digest=codeWorkflowDigest(record);f.codes.push(record);
 const route=await f.call("route",{tasks:[{id:"weather",query:"Read weather forecast",arguments:{city:"Singapore"}}]});
 expect(route.tasks[0].tools[0]).toMatchObject({id:"code-workflow:weather-report",requirements:{execution:{tool:"code_workflow_run",arguments:{id:"weather-report"},inputParameter:"input"}}});
 await f.restart();
 expect((await f.call("describe",{toolIds:["code-workflow:weather-report"]})).state).toBe("ready");
 spec.inputSchema.required.push("date");
 expect(await f.call("status",{decisionId:route.id})).toMatchObject({current:false});
 expect((await f.call("describe",{toolIds:["code-workflow:weather-report"]})).tools).toEqual([]);
 spec.inputSchema.required.pop();record.code="return 'tampered';";
 expect((await f.call("describe",{toolIds:["code-workflow:weather-report"]})).tools).toEqual([]);
});
