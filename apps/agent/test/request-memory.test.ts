import { afterEach, expect, test } from "bun:test";
import { browserMemoryGraph } from "../src/browser-memory-graph.ts";
import { nodeStorage } from "entity-learn";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { RequestMemory, createRequestMemoryTools, responseShape, type RequestMemoryBinding, type RequestEmbeddingProvider } from "../src/request-memory.ts";
import type { HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
import { validateNetworkToolDefinition } from "@unbrowse/browser-harness/network-tool-catalog";
const cleanup: (()=>void)[]=[];
afterEach(()=>{cleanup.splice(0).forEach(f=>f());});
// Explicit deterministic TEST adapter; production must inject a semantic model.
const embedding: RequestEmbeddingProvider={model:"test-embedding-v1",dimensions:3,embed:async texts=>texts.map(t=>t.includes("weather")?[1,0,0]:[0,1,0])};
async function fixture(owner="123", dag=false) {
  const events:Event[]=[];let sequence=0;
  const learning=new BrowserLearning({threadId:"trace",nextSequence:()=>++sequence,emit:async e=>{events.push(e)}});
  const entry=(url:string,body:string,index:number)=>({startedDateTime:new Date(1000+index*100).toISOString(),time:20,_observationComplete:true,request:{method:"GET",url,headers:[],cookies:[]},response:{status:200,headers:[],cookies:[],content:{mimeType:"application/json",size:body.length,text:body}}});
  const entries=[entry("https://api.vendor.com/items",'{"item":"observed-id"}',0),...(dag?[entry("https://api.vendor.com/details?item=observed-id",'{"name":"private observed value"}',1)]:[])];
  for(let i=0;i<entries.length;i++) await learning.observe(entries[i]!,i,true);
  await learning.compile(entries,[{callId:"call",action:"navigate",startedAtMs:999,endedAtMs:1250,direct:true,resultObserved:true}],"https://api.vendor.com");
  const definitions=ownedNetworkDefinitions(events);
  expect(definitions.length).toBeGreaterThan(0);
  const selected=definitions.sort((a,b)=>b.definition.steps.length-a.definition.steps.length)[0]!;
  const storage=nodeStorage(":memory:");cleanup.push(()=>storage.close());
  const requests:any[]=[]; const consumed:any[]=[];
  const binding:RequestMemoryBinding={owner,storage,embedding,readOwnedEvents:async()=>events,transport:{send:async(request:any):Promise<HarnessTransportResponse>=>{requests.push(request);return {status:200,headers:{},classification:"application" as const,body:requests.length%2?{item:"fresh-id"}:{name:"TRANSIENT_SECRET_VALUE"}}}},consume:async (v:any)=>{consumed.push(v)}};
  return {events,selected,storage,requests,consumed,binding,inputs:Object.fromEntries(selected.definition.inputs.map(i=>[i.name,i.name.includes("0001")?"items":"details"])),memory:new RequestMemory(binding)};
}
test("pointer index survives reopen, uses embeddings and never persists response values",async()=>{
 const f=await fixture(); const step=f.selected.definition.steps[0]!.id;
 const indexed=await f.memory.index(f.selected.toolDigest,["weather"],{[step]:{temperature:29,city:"PRIVATE_RESPONSE_VALUE",access_token:"credential",users:{"alice@example.com":"person"}}});
 const reopened=new RequestMemory(f.binding);
 expect((await reopened.search("weather")).items[0]!.pointerId).toBe(indexed.pointerId);
 expect(JSON.stringify(reopened.memory.exportArchive())).not.toMatch(/PRIVATE_RESPONSE_VALUE|credential|alice@example/);
 const hydrated=await reopened.hydrate(indexed.pointerId,f.inputs);
 expect(hydrated.status).toBe("completed");expect(f.consumed).toHaveLength(1);
 expect(JSON.stringify(hydrated)).not.toContain("fresh-id");
 expect(JSON.stringify(reopened.memory.exportArchive())).not.toContain("fresh-id");
 expect(responseShape({items:[{name:"secret",count:200}]})).toContainEqual({path:"$.items[].name",type:"string"});
});
test("request search scans beyond the old 100-pointer recall window, with model, suppression and output bounds",async()=>{
 const f=await fixture();let embeds=0;
 const m=new RequestMemory({...f.binding,embedding:{...embedding,embed:async texts=>{embeds++;return texts.map(()=>[1,0,0])}}});
 const saved=await m.index(f.selected.toolDigest,["weather"]);
 const pointer=m.memory.get(saved.pointerId)!.observation;
 // Synthetic older pointer: recency-only pointer enumeration used to drop this best match.
 const old=m.memory.remember({subject:"old-pointer",title:"Old weather",type:"request-pointer",payload:pointer.payload,observedAt:1},{key:"old",producer:{kind:"tool",reference:"fixture"}});
 m.memory.forget(pointer.subject,pointer.id,"forget-original");
 for(let i=0;i<140;i++)m.memory.remember({subject:"later-"+i,title:"Later",type:"request-pointer",observedAt:1000+i,payload:{...(pointer.payload as any),embedding:[0,1,0]}},{key:"later-"+i,producer:{kind:"tool",reference:"fixture"}});
 expect(m.memory.recall({type:"request-pointer",limit:100,maxNodes:100,maxBytes:262144}).items.some(h=>h.observation.id===old.id)).toBe(false);
 const before=embeds, found=await m.search("weather");
 expect(embeds).toBe(before+1);expect(found.items[0]!.pointerId).toBe(old.id);expect(found.scanned).toBe(141);expect(found.reasons).toContain("result_budget");
 expect(f.requests).toHaveLength(0);
 m.memory.forget(old.subject,old.id,"forget-old");expect((await m.search("weather")).items.some(h=>h.pointerId===old.id)).toBe(false);
});

test("browser graph joins real native dependency evidence to local pointer receipts without replay, response values or vectors",async()=>{
 const f=await fixture("123",true);const indexed=await f.memory.index(f.selected.toolDigest,["catalog"]);
 const events=[...f.events,{type:"AikoRequestMemoryIndexed",toolDigest:f.selected.toolDigest,pointerId:indexed.pointerId,model:indexed.model,at:123},
  {type:"AikoRequestMemoryIndexUnavailable",toolDigest:f.selected.toolDigest,at:124}];
 const rows=events.map((event,i)=>({seq:i+1,event}));
 const before=f.memory.memory.exportArchive(), graph=browserMemoryGraph(rows);
 expect(graph.nodes.filter(n=>n.kind==="request")).toHaveLength(2);
 expect(graph.nodes.some(n=>n.id==="browser-pointer:"+indexed.pointerId)).toBe(true);
 expect(graph.edges.some(e=>e.relation==="depends_on")).toBe(true);expect(graph.edges.some(e=>e.relation==="index_receipt_for")).toBe(true);
 expect(graph.nodes.some(n=>n.kind==="index-error")).toBe(true);expect(graph.pointerAvailability).toBe("not-checked");
 expect(f.requests).toHaveLength(0);expect(f.memory.memory.exportArchive()).toEqual(before);
 expect(JSON.stringify(graph)).not.toMatch(/observed-id|private observed value|"embedding"|"query"|"headers"/);
 const incomplete=browserMemoryGraph(rows.slice(-2));
 expect(incomplete.reasons).toContain("receipt_evidence_outside_window");expect(incomplete.nodes.some(n=>n.kind==="request")).toBe(false);
 expect(browserMemoryGraph([{seq:1,event:{type:"ToolReturned",result:events} as any}]).nodes).toEqual([]);
 expect(()=>browserMemoryGraph(Array.from({length:1025},(_,i)=>({seq:i,event:{type:"Noop"}})))).toThrow();
});

test("native exact dependency DAG rehydrates fresh upstream values before downstream request",async()=>{
 const f=await fixture("123",true);
 expect(f.selected.definition.steps.length).toBe(2);
 const indexed=await f.memory.index(f.selected.toolDigest,["catalog"]);
 const result=await f.memory.hydrate(indexed.pointerId,f.inputs);
 expect(result.status).toBe("completed");expect(f.requests).toHaveLength(2);
 expect(f.requests[1].url).toContain("fresh-id");expect(f.requests[1].url).not.toContain("observed-id");
 expect(f.consumed[0].body).toEqual({name:"TRANSIENT_SECRET_VALUE"});
 expect(JSON.stringify(f.memory.memory.exportArchive())).not.toContain("TRANSIENT_SECRET_VALUE");
});
test("foreign owners, missing evidence, poisoned input and mismatched embedding models fail closed",async()=>{
 const f=await fixture();const saved=await f.memory.index(f.selected.toolDigest,["weather"]);
 const foreign=new RequestMemory({...f.binding,owner:"456",readOwnedEvents:async()=>[]});
 expect((await foreign.search("weather")).items).toEqual([]);
 await expect(foreign.hydrate(saved.pointerId)).rejects.toThrow();
 await expect(f.memory.index(f.selected.toolDigest,["api_key=secret"])).rejects.toThrow();
 await expect(f.memory.hydrate(saved.pointerId,{password:"secret"})).rejects.toThrow();
 const changed=new RequestMemory({...f.binding,embedding:{...embedding,model:"other-model"}});
 expect((await changed.search("weather")).items).toEqual([]);
 f.events.splice(0);
 expect(await f.memory.search("weather")).toMatchObject({items:[],coverage:"partial",reasons:["evidence_unavailable"]});
 await expect(f.memory.hydrate(saved.pointerId)).rejects.toThrow();expect(f.requests).toHaveLength(0);
});
test("native DAG validator rejects cycles, missing prerequisites and mismatched exact bindings",async()=>{
 const f=await fixture("123",true);const d=f.selected.definition;
 for(const mutate of [(x:any)=>x.steps[0].dependsOn.push(x.steps[1].id),(x:any)=>x.steps[1].dependsOn.push("missing"),(x:any)=>Object.values(x.steps[1].query).forEach((p:any)=>{if(p.kind==="response_json")p.pointer="/other"}),(x:any)=>{x.steps[0].method="POST"}]){
   const bad=structuredClone(d);mutate(bad);expect(()=>validateNetworkToolDefinition(bad)).toThrow();
 }
});
test("missing fresh producer value prevents downstream request and transient consumption",async()=>{
 const f=await fixture("123",true);let calls=0;
 const m=new RequestMemory({...f.binding,transport:{send:async()=>{calls++;return {status:200,headers:{},classification:"application",body:{wrong:"field"}}}}});
 const saved=await m.index(f.selected.toolDigest,["catalog"]);const result=await m.hydrate(saved.pointerId,f.inputs);
 expect(result.status).not.toBe("completed");expect(calls).toBe(1);expect(f.consumed).toHaveLength(0);
});
test("actor tools reject foreign thread before embeddings or replay",async()=>{
 const f=await fixture();const tool=createRequestMemoryTools(f.memory).find(t=>t.spec.name==="request_memory_search")!;
 const result=await Effect.runPromise(tool.run({query:"weather"},{signal:new AbortController().signal} as any).pipe(Effect.provideService(Self,{actor:"aiko",instance:"test",thread:"user-456"})));
 expect(result).toMatchObject({status:"rejected",reason:"owner_binding_mismatch"});
});

test("explicit response embedding passes transient content to model but journals only vectors and structure",async()=>{
 const f=await fixture();const documents:string[]=[];
 const m=new RequestMemory({...f.binding,embedResponseValues:true,embedding:{...embedding,embed:async texts=>{documents.push(...texts);return texts.map(()=>[1,0,0])}}});
 await m.index(f.selected.toolDigest,["catalog"],{[f.selected.definition.steps[0]!.id]:{description:"SEMANTIC_RESPONSE_SENTINEL",password:"PASSWORD_SENTINEL",token:"TOKEN_SENTINEL"}});
 expect(documents.join()).toContain("SEMANTIC_RESPONSE_SENTINEL");
 expect(documents[0]!.indexOf("SEMANTIC_RESPONSE_SENTINEL")).toBeLessThan(documents[0]!.indexOf("\"shapes\""));
 expect(documents.join()).not.toMatch(/PASSWORD_SENTINEL|TOKEN_SENTINEL/);
 expect(JSON.stringify(m.memory.exportArchive())).not.toMatch(/SEMANTIC_RESPONSE_SENTINEL|PASSWORD_SENTINEL|TOKEN_SENTINEL/);
 const invalid=new RequestMemory({...f.binding,embedding:{...embedding,embed:async()=>[[NaN,1,0]]}});
 await expect(invalid.index(f.selected.toolDigest,["catalog"])).rejects.toThrow();
});

test("browser preparation hook receives transient semantics after durable evidence, never emits bodies",async()=>{
 const events:Event[]=[];let sequence=0;let callback=false;
 const learning=new BrowserLearning({threadId:"hook",nextSequence:()=>++sequence,emit:async e=>{events.push(e)},onPrepared:async(event,responses,semantics)=>{
   callback=true;expect(ownedNetworkDefinitions(events).some(e=>e.toolDigest===event.toolDigest)).toBe(true);
   expect(JSON.stringify(responses)).toContain("TRANSIENT_HOOK_SENTINEL");
   expect(JSON.stringify([...semantics.values()])).not.toContain("TRANSIENT_HOOK_SENTINEL");
 }});
 const entry={startedDateTime:new Date(1000).toISOString(),time:20,_observationComplete:true,request:{method:"GET",url:"https://api.vendor.com/items",headers:[],cookies:[]},response:{status:200,headers:[],cookies:[],content:{mimeType:"application/json",size:50,text:'{"title":"TRANSIENT_HOOK_SENTINEL"}'}}};
 await learning.observe(entry,0,true);await learning.compile([entry],[{callId:"c",action:"navigate",startedAtMs:999,endedAtMs:1100,direct:true,resultObserved:true}],"https://api.vendor.com");
 expect(callback).toBe(true);expect(JSON.stringify(events)).not.toContain("TRANSIENT_HOOK_SENTINEL");
});

test("invalid URL/auth definitions and failed prerequisite responses never hydrate",async()=>{
 const f=await fixture("123",true);
 for(const origin of ["javascript:alert(1)","https://user:password@api.vendor.com"]){
   const bad=structuredClone(f.selected.definition) as any;bad.steps[0].origin=origin;
   expect(()=>validateNetworkToolDefinition(bad)).toThrow();
 }
 let calls=0;const m=new RequestMemory({...f.binding,transport:{send:async()=>{calls++;return {status:401,headers:{},classification:"browser_session_required"}}}});
 const p=await m.index(f.selected.toolDigest,["catalog"]);const result=await m.hydrate(p.pointerId,f.inputs);
 expect(result.status).not.toBe("completed");expect(calls).toBe(1);expect(f.consumed).toHaveLength(0);
});

test("request cache recalls provenance and records durable update checks without retaining values",async()=>{
 const f=await fixture();const emitted:Event[]=[];
 let body={item:"private-one"};
 const memory=new RequestMemory({...f.binding,record:async e=>{emitted.push(e)},transport:{send:async()=>({status:200,headers:{},classification:"application",body})}});
 const saved=await memory.index(f.selected.toolDigest,["catalog"]);
 expect((await memory.search("catalog")).items[0]).toMatchObject({pointerId:saved.pointerId,toolDigest:f.selected.toolDigest,sourceTraceDigest:f.selected.sourceTraceDigest,freshness:"requires-check"});
 const first=await memory.hydrate(saved.pointerId,f.inputs);expect(first.changed).toBeNull();
 const reopened=new RequestMemory(memory.binding);
 const second=await reopened.hydrate(saved.pointerId,f.inputs);expect(second.changed).toBe(false);
 body={item:"private-two"};
 const third=await reopened.hydrate(saved.pointerId,f.inputs);expect(third.changed).toBe(true);
 const check=reopened.memory.get(third.observationId!)!.observation;
 expect(check.supports).toEqual([saved.pointerId]);expect(check.dependsOn).toEqual([saved.pointerId]);
 expect(reopened.memory.history(check.subject)).toHaveLength(3);
 expect(emitted).toHaveLength(3);expect(emitted[2]).toMatchObject({type:"AikoRequestMemoryChecked",observationId:third.observationId,changed:true});
 expect(JSON.stringify(reopened.memory.exportArchive())+JSON.stringify(emitted)).not.toMatch(/private-one|private-two/);
});

test("unchanged request contracts reuse their durable cache without re-embedding",async()=>{
 const f=await fixture();let embeds=0;
 const binding={...f.binding,embedding:{...embedding,embed:async(texts:readonly string[])=>{embeds++;return texts.map(()=>[1,0,0])}}};
 const first=await new RequestMemory(binding).index(f.selected.toolDigest,["weather"]);
 const second=await new RequestMemory(binding).index(f.selected.toolDigest,["weather"]);
 expect(first.cached).toBe(false);expect(second).toMatchObject({pointerId:first.pointerId,cached:true});expect(embeds).toBe(1);
 await new RequestMemory({...binding,embedding:{...binding.embedding,model:"version-two"}}).index(f.selected.toolDigest,["weather"]);
 expect(embeds).toBe(2);
});
