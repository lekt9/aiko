import { expect, test } from "bun:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { registryExternalEventAllowed } from "../src/registry-host.ts";
import { threadBinding } from "../src/account-binding.ts";

// Execute the exact production factory property in a controlled host context.
// This isolates its read-time authorization; it does not simulate a learner.
for (const worker of [false, true]) test(`${worker ? "Worker" : "Bun"} mounted learning source reader checks current owner and instance`, async () => {
  const path = new URL(`../src/${worker ? "cloudflare" : "server"}.ts`, import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path,"utf8"), ts.ScriptTarget.Latest, true);
  const properties: ts.PropertyAssignment[] = [];
  const visit = (node:ts.Node) => { if(ts.isPropertyAssignment(node)&&node.name.getText(file)==="readSourcePage")properties.push(node);ts.forEachChild(node,visit); };
  visit(file);expect(properties).toHaveLength(1);
  const code=ts.transpileModule(`return (${properties[0]!.initializer.getText(file)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let allowed = true, revokeDuringRead = false;
  let onRead: (() => void) | undefined;
  const calls: unknown[][] = [], row = {seq:1,event:{type:"FixtureSource",id:"source"}};
  const host={readPage:async(...args:unknown[])=>{calls.push(args);onRead?.();if(revokeDuringRead)allowed=false;return args[0]==="background-123-reflection"?[]:[row];}};
  const reader=new Function("config","owner","thread","validOwner","bindingOf","host","configOf",code).call(
    {env:{}},{instanceId:"configured-instance",mode:"demo"},"123","background-123-indexer",
    (...args:unknown[])=>allowed&&args.at(-1)==="123",threadBinding,host,()=>({}));
  const source={actor:"aiko",instance:"configured-instance",thread:"user-123"};
  expect(await reader(source,4,7)).toEqual([row]);
  expect(calls).toEqual([["user-123",0,1],["user-123",4,7]]);
  for(const invalid of [undefined,{...source,actor:"other"},{...source,instance:"demo"},{...source,thread:"user-456"},{...source,thread:"unknown"}])
    await expect(reader(invalid,0,1)).rejects.toThrow("Learning source scope denied");
  expect(calls).toHaveLength(2);
  await expect(reader({...source,thread:"background-123-reflection"},0,1)).rejects.toThrow("Learning source unavailable");
  allowed=false;await expect(reader(source,0,1)).rejects.toThrow("Learning source scope denied");
  expect(calls).toHaveLength(3);
  allowed=true;revokeDuringRead=true;await expect(reader(source,0,1)).rejects.toThrow("Learning source scope denied");
  expect(calls).toHaveLength(4);
  allowed=true;revokeDuringRead=false;
  let reads=0;onRead=()=>{if(++reads===2)allowed=false;};
  await expect(reader(source,4,7)).rejects.toThrow("Learning source scope denied");
  expect(reads).toBe(2);
  allowed=true;reads=0;
  const mutable={...source};
  onRead=()=>{if(++reads===1)Object.assign(mutable,{actor:"foreign",instance:"foreign",thread:"user-456"});};
  const before=calls.length;
  expect(await reader(mutable,4,7)).toEqual([row]);
  expect(calls.slice(before)).toEqual([["user-123",0,1],["user-123",4,7]]);

});
test("external registry admission reserves learning and knowledge receipts regardless of claimed provenance",()=>{
  for(const type of ["AikoLearningSourceScanned","AikoLearningIndexed","AikoLearningFutureReceipt","AikoKnowledgeChanged","AikoKnowledgeUnchanged"])
  for(const fields of [{},{owner:"123",provenance:"aiko.learning.host.v1"},{source:{actor:"aiko",instance:"configured-instance",thread:"user-123"}}])
    expect(registryExternalEventAllowed({type,...fields})).toBe(false);
  expect(registryExternalEventAllowed({type:"MessageReceived",text:"ordinary prompt"})).toBe(true);
  // This guard leaves hook inputs to their existing schema/authorization layer.
  expect(registryExternalEventAllowed({type:"AikoHookReceived"})).toBe(true);
});
