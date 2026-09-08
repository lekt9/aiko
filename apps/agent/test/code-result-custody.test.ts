import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { codeResultCustody } from "../src/code-result-custody.ts";
import type { Event } from "tardie/core/event";
const spec={name:"private_read",inputSchema:{type:"object" as const}};
const scope={owner:"123",thread:"user-123",callId:"exec.0",tool:spec.name,definitionDigest:`sha256:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`};
function fixture(){
 let active=true,tools=[spec];
 const rows:Event[]=[{type:"CodeDispatched",execId:"exec",turn:"turn-1"},{type:"PackageCalled",name:"tools.call",callId:"exec.0",turn:"turn-1"},{type:"AikoToolDefinitionRecorded",owner:"123",tool:spec.name,digest:scope.definitionDigest}];
 const custody=codeResultCustody({owner:"123",thread:"user-123",blobs:{put:async()=>{throw Error("not needed")},putPrivate:async()=>{throw Error("not needed")},get:async()=>{throw Error("authorization must not hydrate")}},read:async()=>rows,current:()=>active,tools:()=>tools});
 return {custody,rows,revoke:()=>{active=false},remove:()=>{tools=[]}};
}
test("current owner, thread, exact call and registered definition gate retained result reads",async()=>{
 const f=fixture();expect(await f.custody.authorize(scope)).toBe(true);
 for(const patch of [{owner:"456"},{thread:"child-123"},{callId:"exec.1"},{tool:"other"},{definitionDigest:"sha256:"+"0".repeat(64)}])expect(await f.custody.authorize({...scope,...patch})).toBe(false);
 f.revoke();expect(await f.custody.authorize(scope)).toBe(false);
});
test("cancelled invocation and removed tools cannot hydrate after reconstruction",async()=>{
 const f=fixture();f.rows.push({type:"TurnCancelled",turn:"turn-1"});expect(await f.custody.authorize(scope)).toBe(false);
 const g=fixture();g.remove();expect(await g.custody.authorize(scope)).toBe(false);
 const h=fixture();h.rows.push({type:"AikoCodeToolStarted",callId:scope.callId});h.rows.splice(2,1);expect(await h.custody.authorize(scope)).toBe(false);
});
test("authorization is checked again after reading native invocation evidence",async()=>{
 const f=fixture(),custody=codeResultCustody({owner:"123",thread:"user-123",blobs:f.custody.blobs,tools:()=>[spec],current:()=>f.rows.length>0,read:async()=>{const rows=[...f.rows];f.rows.length=0;return rows;}});
 expect(await custody.authorize(scope)).toBe(false);
});

import {fixture as hostFixture,registryProgram} from "./registry-host.test.ts";
test("production host seals native results and missing custody after restart never repeats dispatch",async()=>{
 const f=await hostFixture(),contract=await f.seed();
 await f.run(registryProgram(contract,`return await channels.wait({port:{channel:outlet.channel,generation:outlet.generation},handler:{harness:c.harnessDigest,contract:"${contract}"},schema:"number.output",correlation:"missing-result-test",deadline:Date.now()+500,authorityRef:"receiving-fixture"});`),"custody_host_restart");
 const before=await f.events(),settled=before.filter(e=>e.type==="AikoCodeToolSettled");
 expect(settled.length).toBeGreaterThan(0);
 for(const event of settled)expect(event.result).toMatchObject({kind:"aiko-code-retained.v1",owner:"123",thread:"user-123"});
 const first=settled[0]!.result as any,privateRow=await f.binding().blobs.get("123",first.ref) as any;
 expect(privateRow.kind).toBe("aiko-code-retained.v1");
 expect(JSON.stringify(await f.trace())).not.toContain(JSON.stringify(privateRow));
 expect(await f.disk()).not.toContain(JSON.stringify(privateRow));
 const requests=f.requests(),calls=before.filter(e=>e.type==="AikoCodeToolStarted").length;
 f.erasePrivate(first.ref);await f.restart();await new Promise(resolve=>setTimeout(resolve,600));await f.drive();
 const after=await f.events();
 expect(f.requests()).toBe(requests);
 // The controlled model may handle the separate waiter notification as a new
 // turn. The interrupted execution itself must never repeat a native call.
 expect(after.filter(e=>e.type==="AikoCodeToolStarted"&&e.turn==="local:custody_host_restart")).toHaveLength(calls);
 const ids=after.filter(e=>e.type==="AikoCodeToolStarted").map(e=>e.callId);
 expect(new Set(ids).size).toBe(ids.length);
 expect(after.some(e=>e.type==="CodeSettled"&&e.execId==="host-program:local:custody_host_restart"&&String(e.error).includes("Private tool result unavailable"))).toBe(true);
});
