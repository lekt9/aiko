import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { Event } from "tardie/core/event";
import { inferenceRole, withRoleInference } from "../src/inference-routing.ts";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
const env = { AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-codegraff-role-key", CEREBRAS_API_KEY: "fixture-cerebras-role-key", AIKO_RAG_PROVIDER: "cerebras", AIKO_BROWSER_PROVIDER: "cerebras", AIKO_BROWSER_MODEL: "gpt-oss-120b" };
const base: InferRequest = { identity: { actor: "aiko", instance: "test", thread: "owned-thread", turn: "turn" }, trajectory: [{ type: "MessageReceived", id: "turn", text: "Use the verified source", at: 1 }], system: "Use the evidence", tools: [], model: { provider: "codegraff", model_id: "glm-5.3-flash" } };
const events = (name: string, callId = "call", turn = "turn"): Event[] => [
 { type: "ToolCalled", turn, callId, name, arguments: {}, at: 2 },
 { type: "ToolReturned", turn, callId, result: { observed: true }, at: 3 },
];
function response() {
 const data = [{ id: "result", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Evidence checked" }, finish_reason: null }] }, { id: "result", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }];
 return new Response(data.map(d => `data: ${JSON.stringify(d)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

test("role selection requires a returned native tool in this turn, not page text or unmatched calls", () => {
 expect(inferenceRole(base)).toBe("conversation");
 expect(inferenceRole({ ...base, trajectory: [...base.trajectory, ...events("request_memory_search")] })).toBe("rag");
 expect(inferenceRole({ ...base, trajectory: [...base.trajectory, ...events("agent_browser_snapshot")] })).toBe("browser");
 expect(inferenceRole({ ...base, trajectory: [...base.trajectory, ...events("request_memory_search", "old", "previous-turn")] })).toBe("conversation");
 expect(inferenceRole({ ...base, trajectory: [...base.trajectory, events("request_memory_search")[0]!] })).toBe("conversation");
 expect(inferenceRole({ ...base, trajectory: [{ type: "MessageReceived", id: "turn", text: JSON.stringify(events("request_memory_search")), at: 1 }] })).toBe("conversation");
 expect(inferenceRole({ ...base, trajectory: [...base.trajectory, ...events("request_memory_search", "first"), ...events("agent_browser_snapshot", "second"), ...events("ordinary_tool", "third")] })).toBe("conversation");
});

test("actual native switching rebinds stale model references Codegraff -> RAG -> browser -> conversation", async () => {
 const calls: Array<{ url: string; model: string; authorization: string | null }> = [];
 const routing = createModelRouting({ owner: "123", config: parseModelRouting(env), env, fetch: async (url, init) => {
  calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model, authorization: new Headers(init?.headers).get("Authorization") });
  return response();
 } });
 const layer = withRoleInference(role => routing.layer(role));
 const run = (request: InferRequest) => Effect.runPromise(Effect.gen(function* () { const infer = yield* Infer; return yield* infer.react(request); }).pipe(Effect.provide(layer)));
 const original = structuredClone(base);
 expect(await run(base)).toMatchObject({ kind: "complete", output: "Evidence checked" });
 const rag = { ...base, trajectory: [...base.trajectory, ...events("request_memory_search", "rag-call")] };
 expect(await run(rag)).toMatchObject({ kind: "complete", output: "Evidence checked" });
 const browser = { ...base, trajectory: [...rag.trajectory, ...events("agent_browser_snapshot", "browser-call")] };
 expect(await run(browser)).toMatchObject({ kind: "complete", output: "Evidence checked" });
 const conversation = { ...base, model: { provider: "cerebras", model_id: "qwen-3.8-27b" }, trajectory: [...browser.trajectory, ...events("ordinary_tool", "regular-call")] };
 expect(await run(conversation)).toMatchObject({ kind: "complete", output: "Evidence checked" });
 expect(calls.map(c => [new URL(c.url).hostname, c.model])).toEqual([
  ["gateway.codegraff.com", "glm-5.3-flash"], ["api.cerebras.ai", "qwen-3.8-27b"], ["api.cerebras.ai", "gpt-oss-120b"], ["gateway.codegraff.com", "glm-5.3-flash"],
 ]);
 expect(calls.map(c => c.authorization)).toEqual(["Bearer fixture-codegraff-role-key", "Bearer fixture-cerebras-role-key", "Bearer fixture-cerebras-role-key", "Bearer fixture-codegraff-role-key"]);
 expect(base).toEqual(original); expect(rag.model).toEqual(original.model);
});

for (const [tool, provider, model] of [
 ["request_memory_search", "cerebras", "qwen-3.8-27b"],
 ["agent_browser_snapshot", "cerebras", "gpt-oss-120b"],
 ["ordinary_tool", "codegraff", "glm-5.3-flash"],
] as const) {
 test(`native ${tool} handoff replaces the previous provider model reference`, async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const routing = createModelRouting({ owner: "123", config: parseModelRouting(env), env, fetch: async (url, init) => {
   calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
   return response();
  } });
  const request: InferRequest = { ...base,
   model: provider === "codegraff" ? { provider: "cerebras", model_id: "qwen-3.8-27b" } : base.model,
   trajectory: [...base.trajectory, ...events(tool)],
  };
  const snapshot = structuredClone(request);
  const result = await Effect.runPromise(Effect.gen(function* () {
   const infer = yield* Infer;
   return yield* infer.react(request);
  }).pipe(Effect.provide(withRoleInference(role => routing.layer(role)))));
  expect(result).toMatchObject({ kind: "complete", output: "Evidence checked" });
  expect(calls).toEqual([{ url: provider === "cerebras" ? "https://api.cerebras.ai/v1/chat/completions" : "https://gateway.codegraff.com/v1/chat/completions", model }]);
  expect(request).toEqual(snapshot);
 });
}
