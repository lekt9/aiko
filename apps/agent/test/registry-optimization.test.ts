import { demoInference } from "../src/actor.ts";
import { expect, test } from "bun:test";
import type { Event } from "tardie/core/event";
import { registryOptimizationEvidence } from "../src/registry-optimization.ts";
import { builtinHarnessDefinitions } from "../src/harness-builtins.ts";
import { harnessDigest } from "../src/harness-library.ts";
const definition = builtinHarnessDefinitions()[0]!;
const owner = "123", contextDigest = harnessDigest("context"), artifact = harnessDigest(definition.artifact);
const head: Event = { type: "AikoHarnessPromoted", id: "head", owner, generation: 1, previousGeneration: 0, routeKey: "route", harnessDigest: artifact, contractDigest: harnessDigest(definition.contract), contextDigest, at: 10 };
function run(id: string, extra: object = {}): Event[] {
  return [{ type: "AikoHarnessRunStarted", owner, id, harnessDigest: artifact, contextDigest, at: 11, ...extra },
    { type: "AikoHarnessChecked", owner, id, witness: { operationId: id, harnessDigest: artifact, contextDigest, status: "satisfied" } }];
}
test("standing trigger needs three distinct checked ordinary runs in the stable regime", () => {
  const rows = [head, ...run("a"), ...run("b")];
  expect(registryOptimizationEvidence(rows, owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("b")], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("fixture", { caseId: "nested" })], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("old", { at: 9 })], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("foreign", { owner: "456" })], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("stale", { contextDigest: harnessDigest("old") })], owner)).toBeUndefined();
  const selected = registryOptimizationEvidence([...rows, ...run("c")], owner)!;
  expect(selected.evidence).toEqual(["a", "b", "c"]);
  expect(registryOptimizationEvidence([...rows, ...run("c"), { type: "AikoHarnessOptimizationTriggered", owner, id: selected.id }], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("c"), { type: "AikoHarnessExperimentRegistered", owner, experimentId: selected.id }], owner)).toBeUndefined();
  expect(registryOptimizationEvidence([...rows, ...run("c"), { ...head, type: "AikoHarnessRetired", generation: 2, previousGeneration: 1 }], owner)).toBeUndefined();
});

import { fixture } from "./registry-host.test.ts";
import { parseModelRouting } from "../src/model-routing.ts";
test("default production host triggers native reflection and checked child trials without replay duplication", async () => {
  const requests: unknown[] = [], jobs: string[] = [];
  const env = { CODEGRAFF_API_KEY: "controlled-optimizer-key", AIKO_ALLOW_PAID_INFERENCE: "true" };
  const f = await fixture(true, { defaults: true,
    config: { mode: "live", modelKey: env.CODEGRAFF_API_KEY, modelRouting: parseModelRouting(env, { maxOutputTokens: 1024 }) },
    beforeJob: async job => { jobs.push(job.operationId); },
    overrides: { backgroundModel: demoInference, modelFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const output = { hypothesis: "The fixed implementation already expresses the required operation; retain the baseline.", files: null };
      return new Response([
        { id: "reflection", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(output) }, finish_reason: null }] },
        { id: "reflection", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.001 } },
      ].map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    } },
  });
  expect(f.readiness.experiments).toBe(true);
  await f.run(`const a=await tools.call({name:"harness_acquire",arguments:{name:"json.project",operationId:"optimizer-acquire"}});if(a.status!=="ready")throw Error("acquisition failed");const list=await tools.call({name:"harness_list",arguments:{}});const digest=list.candidates.find(c=>c.name==="json.project").harnessDigest;for(let i=0;i<3;i++){const r=await tools.call({name:"harness_run",arguments:{digest,input:{value:{a:1,b:2},keys:["a"]},operationId:"ordinary-"+i}});if(r.status!=="satisfied")throw Error("run failed");}return "Completed three private local operations";`);
  for (let i = 0; i < 12; i++) await f.drive();
  const rows = await f.events();

  expect(rows.filter(e => e.type === "AikoHarnessOptimizationTriggered")).toHaveLength(1);
  expect(rows.filter(e => e.type === "AikoHarnessExperimentRegistered")).toHaveLength(1);
  expect(rows.filter(e => e.type === "AikoHarnessTrialJoined").length).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain("array-and-unicode");
  expect(rows.find(e => e.type === "AikoHarnessExperimentSettled")?.status).toBe("retained-baseline");
  const count = jobs.length;
  await f.restart(); await f.drive();
  expect(requests).toHaveLength(1);
  expect(jobs).toHaveLength(count);
});

for (const mode of ["cancel", "lost-ack", "revoked"] as const) test(`default host trial ${mode} is retained without another job or model on restart`, async () => {
  let f: Awaited<ReturnType<typeof fixture>>, interrupted = false, jobs = 0, requests = 0;
  const allowedUsers = new Set(["123"]);
  const env = { CODEGRAFF_API_KEY: "controlled-optimizer-key", AIKO_ALLOW_PAID_INFERENCE: "true" };
  f = await fixture(true, { defaults: true, config: { mode: "live", allowedUsers, modelKey: env.CODEGRAFF_API_KEY, modelRouting: parseModelRouting(env,{maxOutputTokens:1024}) },
    overrides: { backgroundModel: demoInference, modelFetch: async () => { requests++; throw Error("No model allowed before checked development trials"); } },
    beforeJob: async () => {
      jobs++;
      const registered = (await f.events()).find(e => e.type === "AikoHarnessExperimentRegistered");
      if (!registered || interrupted) return;
      interrupted = true;
      if (mode === "revoked") f.setOwnerAuthorized(false);
      if (mode === "cancel") await f.append([{ type: "AikoHarnessExperimentCancelled", owner: "123", id: String(registered.experimentId), experimentId: registered.experimentId, at: Date.now() }]);
      throw Error("controlled unconfirmed job acknowledgement");
    },
  });
  await f.run(`const a=await tools.call({name:"harness_acquire",arguments:{name:"json.project",operationId:"acquire-interruption"}});if(a.status!=="ready")throw Error("acquisition failed");const l=await tools.call({name:"harness_list",arguments:{}});const digest=l.candidates.find(c=>c.name==="json.project").harnessDigest;for(let i=0;i<3;i++)await tools.call({name:"harness_run",arguments:{digest,input:{value:{a:1},keys:["a"]},operationId:"interrupt-run-"+i}});return "done";`);
  for (let i=0;i<5;i++)await f.drive();
  expect(interrupted).toBe(true);
  expect(requests).toBe(0);
  if(mode === "revoked"){
    expect((await f.request("/api/harness/readiness")).status).toBe(401);
    f.setOwnerAuthorized(true); await f.restart(); for(let n=0;n<5;n++) await f.drive();
  }
  const terminal=(await f.events()).find(e=>e.type==="AikoHarnessExperimentSettled");
  expect(terminal?.status).toBe(mode==="cancel"?"cancelled":"unknown");
  const before=jobs;
  await f.restart();await f.drive();
  expect(jobs).toBe(before);expect(requests).toBe(0);
});
