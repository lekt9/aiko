import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { codegraffSandboxService } from "../src/code-sandbox.ts";
import type { CodeSegment } from "../src/code-sandbox-protocol.ts";

const base: CodeSegment = { version: 1, code: "return 42", packages: {}, values: {}, ambient: { at: 1234, seed: "fixed" }, history: [] };
test("pure code is isolated from browser, filesystem, network and process authority", async () => {
  const result = await runCodeSegment({ ...base, code: "return [typeof process,typeof Bun,typeof fetch,typeof require,typeof __aikoCall,typeof WebSocket,Date.now(),new Date().getTime()]" });
  expect(result.error).toBeUndefined();
  expect(result.result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", 1234, 1234]);
});
test("sequential and parallel calls preserve ordinals and fresh results", async () => {
  const seen: unknown[] = [];
  const sandbox = codegraffSandboxService(runCodeSegment);
  const result = await Effect.runPromise(sandbox.run("const rows = await Promise.all([tools.read({id:1}),tools.read({id:2})]); return await tools.sum({values:rows});", {
    tools: { read: async (args: any, ordinal: number) => { seen.push([args,ordinal]); return { _tag: "Returned", result: args.id * 2 }; },
      sum: async (args: any, ordinal: number) => { seen.push([args,ordinal]); return { _tag: "Returned", result: args.values.reduce((a: number,b: number)=>a+b,0) }; } },
  }, base.ambient));
  expect(result.result).toBe(6);
  expect(result.error).toBeUndefined();
  expect(seen).toEqual([[{id:1},0],[{id:2},1],[{values:[2,4]},2]]);
});
test("replay refuses changed arguments even if the guest catches errors", async () => {
  const result = await runCodeSegment({ ...base, code: "try { return await tools.read({id:2}) } catch { return 'hidden' }", packages: {tools:["read"]}, history:[{call:{ordinal:0,packageName:"tools",method:"read",args:{id:1}},result:"prior"}] });
  expect(result.error).toContain("Nondeterministic");
  expect(result.calls).toEqual([]);
});
test("unawaited effects never leave a settled segment", async () => {
  const result = await runCodeSegment({...base, packages:{tools:["write"]}, code:"tools.write({}); return 'done'"});
  expect(result.error).toContain("Await every");
  expect(result.calls).toEqual([]);
});
test("clock and random replay identically; infinite computation is interrupted", async () => {
  const input = {...base,code:"return [Math.random(), Math.random(), Date.now()]"};
  expect((await runCodeSegment(input)).result).toEqual((await runCodeSegment(input)).result);
  expect((await runCodeSegment({...base,code:"while(true) {}"})).error).toBeDefined();
});
test("held-out: outputs remain plain JSON across chained transforms and guest exceptions", async () => {
  const sandbox = codegraffSandboxService(runCodeSegment);
  const result = await Effect.runPromise(sandbox.run("const rows=await data.rows({}); console.log(rows.length); return rows.filter(r=>r.ok).map(r=>r.id).sort();", {data:{rows:async()=>({_tag:"Returned",result:[{id:"b",ok:true},{id:"x",ok:false},{id:"a",ok:true}]})}}, base.ambient));
  expect(result).toEqual({result:["a","b"],error:undefined,logs:["3"]});
  expect((await runCodeSegment({...base,code:"throw new Error('bad input')"})).error).toBe("bad input");
});
