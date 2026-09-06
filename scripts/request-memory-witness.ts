/** Run: bun scripts/request-memory-witness.ts
 * Real local MiniLM embeddings; controlled in-process GET transport, no external API requests.
 * Only model assets may download. Artifacts contain assertions/scores, never response values. */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { nodeStorage } from "../packages/entity-learn/lib/storage-node.ts";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../apps/agent/src/browser-learning.ts";
import { ownedNetworkDefinitions } from "../apps/agent/src/capability-builder-network.ts";
import { RequestMemory } from "../apps/agent/src/request-memory.ts";
import { createRequestEmbedding } from "../apps/agent/src/request-embedding.ts";
import type { HarnessTransportRequest, HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
const events:Event[]=[];let sequence=0;
const learning=new BrowserLearning({threadId:"witness",nextSequence:()=>++sequence,emit:async event=>{events.push(event)}});
const entry=(url:string,body:string,index:number)=>({startedDateTime:new Date(1000+index*100).toISOString(),time:20,_observationComplete:true,request:{method:"GET",url,headers:[],cookies:[]},response:{status:200,headers:[],cookies:[],content:{mimeType:"application/json",size:body.length,text:body}}});
const entries=[entry("https://api.vendor.com/items",'{"item":"captured-key"}',0),entry("https://api.vendor.com/details?item=captured-key",'{"description":"captured-description"}',1)];
for(let i=0;i<entries.length;i++)await learning.observe(entries[i]!,i,true);
await learning.compile(entries,[{callId:"witness",action:"navigate",startedAtMs:999,endedAtMs:1250,direct:true,resultObserved:true}],"https://api.vendor.com");
const observed=ownedNetworkDefinitions(events).find(e=>e.definition.steps.length===2);assert(observed,"native two-node DAG compiled");
const directory=await mkdtemp("/tmp/request-memory-witness-");const storage=nodeStorage(join(directory,"memory.sqlite"));
let generation=1;const urls:string[]=[];const hydrated:unknown[]=[];
const transport={send:async(request:HarnessTransportRequest):Promise<HarnessTransportResponse>=>{
 assert.equal(request.method,"GET");assert.equal(request.redirect,"manual");urls.push(request.url);
 const first=request.stepId===observed.definition.steps[0]!.id;
 if(!first)assert.equal(new URL(request.url).searchParams.get("item"),`fresh-key-${generation}`);
 return {status:200,headers:{},classification:"application",body:first?{item:`fresh-key-${generation}`}:{description:`fresh-dependent-result-${generation}`}};
}};
const embedding=createRequestEmbedding('/tmp/aiko-request-model-cache');
const binding={owner:"witness",storage,embedding,readOwnedEvents:async()=>events,transport,embedResponseValues:true,consume:async(v:unknown)=>{hydrated.push(v)}};
try{
 const memory=new RequestMemory(binding);const step=observed.definition.steps[1]!.id;
 const invoice="The supplier invoice remains unpaid. Accounts payable must settle the outstanding vendor bill before its due date.";
 const weather="Tomorrow brings heavy rainfall and thunderstorms with strong winds. The regional weather forecast predicts cooler temperatures.";
 const finance=await memory.index(observed.toolDigest,["response"],{[step]:{description:invoice}});
 const forecast=await memory.index(observed.toolDigest,["response"],{[step]:{description:weather}});
 const query="Which creditor payment is overdue and still needs to be settled?";
 const search=await memory.search(query,2);assert.equal(search.items[0]?.pointerId,finance.pointerId,"semantic paraphrase ranks invoice over weather");
 assert.equal(search.items.length,2);assert(search.items[0]!.score>search.items[1]!.score);
 const inputs=Object.fromEntries(observed.definition.inputs.map(i=>[i.name,i.name.includes("0001")?"caller-path-one-sentinel":"caller-path-two-sentinel"]));
 const first=await memory.hydrate(finance.pointerId,inputs);assert.equal(first.status,"completed");generation=2;
 const reopened=new RequestMemory(binding);const second=await reopened.hydrate(finance.pointerId,inputs);assert.equal(second.status,"completed");
 assert.equal(urls.length,4);assert.notDeepEqual(hydrated[0],hydrated[1]);assert(JSON.stringify(hydrated[1]).includes("fresh-dependent-result-2"));
 const forbidden=[invoice,weather,query,...Object.values(inputs),"captured-key","captured-description","fresh-key-1","fresh-key-2","fresh-dependent-result-1","fresh-dependent-result-2"];
 const archive=JSON.stringify(memory.memory.exportArchive());for(const value of forbidden)assert(!archive.includes(value),"raw value absent from archive");
 storage.close();
 const files=await readdir(directory);for(const file of files){const bytes=await readFile(join(directory,file));for(const value of forbidden)assert(!bytes.includes(Buffer.from(value)),"raw value absent from SQLite/WAL");}
 const result={at:new Date().toISOString(),embedding:{kind:"actual local learned model",model:embedding.model,dimensions:embedding.dimensions},transport:"controlled in-process GET transport; no external API side effects",dag:{nodes:2,replays:2,requests:4,exactFreshDependencyBinding:true},semantic:{paraphraseRankedCorrectly:true,relatedScore:search.items[0]!.score,unrelatedScore:search.items[1]!.score},persistence:{archiveAndDatabaseChecked:true,rawValuesAbsent:true,filesChecked:files.length},freshDependentResultChanged:true};
 await mkdir("artifacts/request-memory",{recursive:true});await writeFile("artifacts/request-memory/minilm-witness.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));
}catch(error){try{storage.close()}catch{}throw error}finally{await rm(directory,{recursive:true,force:true})}
