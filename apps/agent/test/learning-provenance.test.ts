import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { learningEventDigest, validLearningOrigin } from "../src/learning-origin.ts";

// Reuse the independent production fixture, never an application test module.
// Retain all disk artifacts on failure so a wiring defect remains inspectable.
test("actual promoted acquisition carries source origin and DB ingestion through Merkle and decision", async () => {
  const dir=await mkdtemp("/tmp/learning-provenance-");
  console.log(`learning provenance evidence: ${dir}`);
  const entry=resolve(import.meta.dir,"../../../scripts/fixtures/self-composing-proactive.ts");
  const child=Bun.spawn([process.execPath,entry,dir,crypto.randomUUID()],{env:{...process.env,TMPDIR:"/tmp"},stdout:"pipe",stderr:"pipe"});
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  await Bun.write(join(dir,"process.log"),stdout+stderr);
  expect(exit,stderr).toBe(0);
  const snapshots=JSON.parse(await readFile(join(dir,"native-traces.json"),"utf8"));
  const rows=snapshots.find((s:any)=>s.stage==="verified").rows;
  const source=rows["user-123"];
  const promotion=source.find((e:any)=>e.type==="AikoHarnessPromoted");
  expect(promotion).toBeDefined();
  const indexer=rows["background-123-indexer"];
  const hook=indexer.find((e:any)=>e.type==="AikoHookReceived"&&e.cause===promotion.id);
  expect(hook).toBeDefined(); expect(validLearningOrigin(hook.origin,"123")).toBe(true);
  expect(hook.origin.eventDigest).toBe(learningEventDigest(promotion));
  expect(hook.origin.eventIdentity).toBe(promotion.id);
  const indexed=indexer.find((e:any)=>e.type==="AikoLearningIndexed"&&e.id===hook.id);
  expect(indexed.ingestion).toBeDefined();
  const change=indexer.find((e:any)=>e.type==="AikoKnowledgeChanged"&&e.id===hook.id);
  expect(change).toBeDefined(); expect(change.origin).toEqual(hook.origin); expect(change.ingestion).toEqual(indexed.ingestion);
  const decision=rows["background-123-reflection"].find((e:any)=>e.type==="AikoDecisionRecorded"&&e.id===hook.id);
  expect(decision).toBeDefined(); expect(decision.origin).toEqual(hook.origin); expect(decision.ingestion).toEqual(indexed.ingestion);
},60_000);

test("DB commit receipt remains original after unrelated ingestion and reopening", async () => {
  const {indexLearning,memorySnapshot}=await import("../src/learning.ts");
  const {openMemory}=await import("../src/memory.ts");
  const dir=await mkdtemp("/tmp/learning-provenance-db-");
  console.log(`learning DB evidence: ${dir}`);
  const binding={stateDir:dir,owner:"123"};
  const input={id:"independent-origin-001",subject:"independent/origin",title:"Original evidence",kind:"fact" as const,type:"fixture",payload:{value:"original"}};
  // indexLearning closes its actual SQLite connection; no background ack is written.
  const first=await indexLearning(binding,input,s=>s);
  await indexLearning(binding,{...input,id:"independent-other-002",subject:"independent/other",payload:{value:"unrelated"}},s=>s);
  const replay=await indexLearning(binding,input,s=>s);
  expect(replay).toEqual(first);
  expect(replay.ingestion.commit.scopeVersion).toBeLessThan(memorySnapshot(binding).scopeVersion);
  const memory=openMemory(binding);
  try{expect(memory.history(first.subject)).toHaveLength(1);}finally{memory.close();}
});
