import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Infer, type InferRequest } from "tardie";
import { CONTRIBUTION_OUTPUT } from "../src/background.ts";
import { Database } from "bun:sqlite";
import { ModelBudget } from "../src/model-budget.ts";
import { ModelBudgetDenied, type ModelBudgetDenial } from "../src/model-budget-denial.ts";
import { createModelRouting, parseModelRouting, orderedToolMessages, MODEL_PROVIDERS, type ModelRole } from "../src/model-routing.ts";
import type { HttpFetch } from "../src/security.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const env = { AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-codegraff-private", CEREBRAS_API_KEY: "fixture-cerebras-private", AIKO_RAG_PROVIDER: "cerebras", AIKO_BROWSER_PROVIDER: "cerebras" };
async function fixture(upstream: HttpFetch, overrides = {}, limits = { globalPerDay: 10, accountPerDay: 5, maxConcurrent: 2 }) {
 const directory = await mkdtemp(join(tmpdir(), "model-routing-test-"));
 const budget = new ModelBudget(directory, limits);
 cleanup.push(async () => { budget.close(); await rm(directory, { recursive: true, force: true }); });
 const vars = { ...env, ...overrides };
 return { router: createModelRouting({ owner: "123", config: parseModelRouting(vars), env: vars, budget, fetch: upstream, throttleRetryDelaysMs: [] }), budget, directory, vars };
}
const bodyFor = (role: ModelRole, extra = {}) => JSON.stringify({ model: role === "conversation" ? "glm-5.3-flash" : "qwen-3.8-27b", messages: [{ role: "user", content: "Use verified evidence" }], max_tokens: 1024, stream: true, ...extra });
const requestFor = (role: ModelRole, extra = {}) => ({ method: "POST", body: bodyFor(role, extra) });
const endpointFor = (role: ModelRole) => `${MODEL_PROVIDERS[role === "conversation" ? "codegraff" : "cerebras"].baseUrl}/chat/completions`;
const streamReply = () => new Response([
 { id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Verified answer" }, finish_reason: null }] },
 { id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const nativeRequest: InferRequest = { trajectory: [{ type: "MessageReceived", id: "turn", text: "Find the answer", at: 1 }], identity: { actor: "aiko", instance: "test", thread: "owner-thread", turn: "turn" }, system: "Answer with evidence", tools: [] };

// Uses the installed native model.ts and streaming adapter, not a mocked inference binding.
const react = (router: ReturnType<typeof createModelRouting>, role: ModelRole, request = nativeRequest) => Effect.runPromise(Effect.gen(function* () { const infer = yield* Infer; return yield* infer.react(request); }).pipe(Effect.provide(router.layer(role))));

for (const allowance of [1024, 4096]) test(`native v2 reflection caps output at the stricter allowance (${allowance}) and never retries a provider failure`, async () => {
 let physical = 0, wire: any;
 const vars = { ...env };
 const router = createModelRouting({ owner: "123", env: vars,
   config: { ...parseModelRouting(vars, { maxOutputTokens: allowance }), fallbacks: { rag: [{ provider: "codegraff", model: "glm-5.3-flash", secretEnv: "CODEGRAFF_API_KEY" }] } },
   throttleRetryDelaysMs: [0, 0],
   fetch: async (_, init) => { physical++; wire = JSON.parse(String(init?.body)); return Response.json({ error: "unavailable" }, { status: 503 }); },
 });
 const request: InferRequest = { ...nativeRequest, identity: { ...nativeRequest.identity, thread: "background-123-reflection" },
   trajectory: [{ ...nativeRequest.trajectory[0]!, source: "background", output: { name: CONTRIBUTION_OUTPUT.name, schema: CONTRIBUTION_OUTPUT.schema } }],
   output: { fallback: { kind: "local", name: "validate-once" } },
 };
 const result = await react(router, "rag", request);
 expect(result.kind).toBe("fail"); expect(physical).toBe(1);
 expect(wire.max_tokens).toBe(Math.min(allowance, 1500));
 expect(request.trajectory[0]?.output).toEqual({ name: CONTRIBUTION_OUTPUT.name, schema: CONTRIBUTION_OUTPUT.schema });
});

test("queued user messages cannot split tool calls from their recorded replies", async () => {
 const request = { ...nativeRequest, trajectory: [
  { type: "MessageReceived", id: "old", text: "Read a page", at: 1 },
  { type: "ToolCalled", turn: "old", callId: "browser-old", name: "agent_browser_navigate", arguments: {}, at: 2 },
  { type: "MessageReceived", id: "turn", text: "hi", at: 3 },
  { type: "ToolReturned", turn: "old", callId: "browser-old", result: { status: "unknown", text: "Interrupted; do not replay" }, at: 4 },
  { type: "TurnCompleted", turn: "old", output: "Unconfirmed", at: 5 },
 ] };
 const original = structuredClone(request);
 let wire: any;
 const { router } = await fixture(async (_, init) => { wire = JSON.parse(String(init?.body)); return streamReply(); });
 expect(await react(router, "rag", request)).toMatchObject({ kind: "complete" });
 const call = wire.messages.findIndex((m: any) => m.tool_calls?.[0]?.id === "browser-old");
 expect(wire.messages[call + 1]).toMatchObject({ role: "tool", tool_call_id: "browser-old" });
 expect(wire.messages[call + 1].content).toContain("Interrupted; do not replay");
 expect(wire.messages[call + 2]).toMatchObject({ role: "user", content: "hi" });
 expect(request).toEqual(original);
});

test("native Infer retains a real daily denial before normalizing its transport error", async () => {
 let physical = 0;
 const f = await fixture(async () => { physical++; return streamReply(); }, {}, { globalPerDay: 5, accountPerDay: 1, maxConcurrent: 2 });
 const denials: Readonly<ModelBudgetDenial>[] = [];
 const router = createModelRouting({ owner: "123", env: f.vars, config: parseModelRouting(f.vars), budget: f.budget,
   fetch: async () => { physical++; return streamReply(); }, throttleRetryDelaysMs: [],
   onBudgetDenied: async denial => { denials.push(denial); } });
 const results = await Promise.all([react(router, "conversation"), react(router, "rag")]);
 expect(results.map(r => r.kind).sort()).toEqual(["complete", "fail"]);
 expect(physical).toBe(1);
 expect(denials).toEqual([{ version: 1, owner: "123", day: new Date().toISOString().slice(0,10), scope: "account", limit: 1 }]);
 expect(f.budget.status("123").accountCalls).toBe(1);
});

test("global ledger denial is scoped to the caller without exposing another account's usage", async () => {
 let physical = 0;
 const f = await fixture(async () => { physical++; return streamReply(); }, {}, { globalPerDay: 1, accountPerDay: 5, maxConcurrent: 2 });
 await (await f.budget.transport("456", async () => { physical++; return streamReply(); })(endpointFor("conversation"), requestFor("conversation"))).text();
 const denials: Readonly<ModelBudgetDenial>[] = [];
 const router = createModelRouting({ owner: "123", env: f.vars, config: parseModelRouting(f.vars), budget: f.budget,
   fetch: async () => { physical++; return streamReply(); }, throttleRetryDelaysMs: [], onBudgetDenied: async denial => { denials.push(denial); } });
 expect((await react(router, "conversation")).kind).toBe("fail");
 expect(denials).toEqual([{ version: 1, owner: "123", day: new Date().toISOString().slice(0,10), scope: "global", limit: 1 }]);
 expect(JSON.stringify(denials)).not.toContain("456");
 expect(f.budget.status("123").accountCalls).toBe(0);
 expect(physical).toBe(1);
});

test("provider errors, corrupt ledger data and cancellation cannot become a daily denial receipt", async () => {
 for (const kind of ["same-message", "same-type", "http", "corrupt", "cancel"] as const) {
  let physical = 0, denied = 0;
  const f = await fixture(async () => streamReply());
  if (kind === "corrupt") {
   const db = new Database(join(f.directory, "model-budget.sqlite"));
   db.query("INSERT INTO model_usage(day,owner,calls) VALUES(?,?,?)").run(new Date().toISOString().slice(0,10), "456", "invalid");
   db.close();
  }
  const router = createModelRouting({ owner: "123", env: f.vars, config: parseModelRouting(f.vars), budget: f.budget,
   throttleRetryDelaysMs: [], onBudgetDenied: async () => { denied++; }, fetch: async () => {
    physical++;
    if (kind === "same-type") throw new ModelBudgetDenied({ version: 1, owner: "123", day: new Date().toISOString().slice(0,10), scope: "account", limit: 1 });
    if (kind === "same-message") throw Error("Daily inference allowance exhausted");
    return new Response("Daily inference allowance exhausted", { status: 503 });
   } });
  if (kind === "cancel") await expect(router.transport("conversation")(endpointFor("conversation"), {
   ...requestFor("conversation"), signal: AbortSignal.abort(),
  })).rejects.toThrow();
  else expect((await react(router, "conversation")).kind).toBe("fail");
  expect(denied).toBe(0);
  expect(physical).toBe(["cancel", "corrupt"].includes(kind) ? 0 : 1);
 }
});

test("parallel tool blocks retain every real receipt and reject unmatched history", () => {
 const call = { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] };
 const user = { role: "user", content: "next" };
 const a = { role: "tool", tool_call_id: "a", content: "unknown" };
 const b = { role: "tool", tool_call_id: "b", content: "done" };
 expect(orderedToolMessages([call, user, b, a])).toEqual([call, a, b, user]);
 expect(() => orderedToolMessages([call, a])).toThrow("Unpaired tool call");
 expect(() => orderedToolMessages([a])).toThrow("Unpaired tool response");
});

test("native provider retries recover transient HTTP errors and retain permanent diagnostics", async () => {
 for (const status of [400, 401, 429, 503]) {
  let calls = 0;
  const router = createModelRouting({ owner: "123", env, config: parseModelRouting(env), throttleRetryDelaysMs: [1],
   fetch: async () => ++calls === 1 ? new Response("private provider diagnostic", { status }) : streamReply() });
  const result = await react(router, "rag");
  expect(calls).toBe(status >= 429 ? 2 : 1);
  expect(result.kind).toBe(status >= 429 ? "complete" : "fail");
  if (result.kind === "fail") expect(result.error).toContain(String(status));
  expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
 }
});

test("native retries recover a redacted fetch failure", async () => {
 let calls = 0;
 const router = createModelRouting({ owner: "123", env, config: parseModelRouting(env), throttleRetryDelaysMs: [1],
  fetch: async () => { if (++calls === 1) throw new TypeError("fetch failed: fixture-private-token"); return streamReply(); } });
 const result = await react(router, "rag");
 expect(result).toMatchObject({ kind: "complete", output: "Verified answer" });
 expect(calls).toBe(2);
 expect(JSON.stringify(result)).not.toContain("fixture-private-token");
});

test("configured Codegraff fallbacks serve exhausted Cerebras roles with their own endpoint stamp", async () => {
 const fallbackEnv = { ...env, AIKO_RAG_FALLBACKS: JSON.stringify([{provider:"codegraff",model:"muse-spark-1.3-contributor"}]) };
 const calls: {url:string;model:string;key:string|null}[] = [];
 const router = createModelRouting({ owner:"123",env:fallbackEnv,config:parseModelRouting(fallbackEnv),throttleRetryDelaysMs:[],fetch:async(url,init)=>{
  const model=JSON.parse(String(init?.body)).model;
  calls.push({url:String(url),model,key:new Headers(init?.headers).get("Authorization")});
  return model==="qwen-3.8-27b" ? new Response("unavailable",{status:503}) : streamReply();
 } });
 const result = await react(router,"rag");
 expect(result).toMatchObject({kind:"complete",endpoint:{provider:"codegraff",model:"muse-spark-1.3-contributor"}});
 expect(result.usage).toMatchObject({promptTokens:12,completionTokens:3});
 expect(result.usage?.costUsd).toBeUndefined();
 expect(calls).toEqual([
  {url:endpointFor("rag"),model:"qwen-3.8-27b",key:"Bearer fixture-cerebras-private"},
  {url:endpointFor("conversation"),model:"muse-spark-1.3-contributor",key:"Bearer fixture-codegraff-private"},
 ]);
});

test("permanent failures and completed tool calls never trigger configured fallbacks", async () => {
 const fallbackEnv = {...env, AIKO_RAG_FALLBACKS:'[{"provider":"codegraff","model":"muse-spark-1.3-contributor"}]'};
 let calls=0;
 const router=createModelRouting({owner:"123",env:fallbackEnv,config:parseModelRouting(fallbackEnv),throttleRetryDelaysMs:[],fetch:async()=>{calls++;return new Response("invalid history",{status:400});}});
 expect(await react(router,"rag")).toMatchObject({kind:"fail"});expect(calls).toBe(1);
 expect(()=>parseModelRouting({...fallbackEnv,AIKO_RAG_FALLBACKS:'[{"provider":"unknown","model":"bad"}]'})).toThrow();
 expect(()=>parseModelRouting({...fallbackEnv,AIKO_RAG_FALLBACKS:'[{"provider":"cerebras","model":"qwen-3.8-27b"}]'})).toThrow();
});

test("default roles preserve Codegraff and public config contains env references only", () => {
 const config = parseModelRouting({ CODEGRAFF_API_KEY: "fixture-secret", CEREBRAS_API_KEY: "fixture-other-secret" });
 for (const role of ["conversation", "rag", "browser"] as const) expect(config.roles[role]).toEqual({ provider: "codegraff", model: "glm-5.3-flash", secretEnv: "CODEGRAFF_API_KEY" });
 expect(JSON.stringify(config)).not.toContain("fixture-secret"); expect(JSON.stringify(config)).not.toContain("fixture-other-secret");
 expect(config.maxOutputTokens).toBe(1024); expect(config.contextWindowTokens).toBe(32768);
 expect(parseModelRouting({}, { model: "custom-reviewed-model", maxOutputTokens: 4096, contextWindowTokens: 1_000_000 })).toMatchObject({ maxOutputTokens: 4096, contextWindowTokens: 1_000_000, roles: { conversation: { model: "custom-reviewed-model" } } });
});

test("independent roles use selected pinned endpoints and credentials, sharing the existing real budget", async () => {
 const sent: Array<{ url: string; authorization: string | null; body: any }> = [];
 const { router, budget } = await fixture(async (url, init) => {
  expect(init?.redirect).toBe("manual"); sent.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) }); return streamReply();
 });
 for (const role of ["conversation", "rag", "browser"] as const) await (await router.transport(role)(endpointFor(role), requestFor(role))).text();
 expect(sent.map(s => s.url)).toEqual([endpointFor("conversation"), endpointFor("rag"), endpointFor("browser")]);
 expect(sent.map(s => s.authorization)).toEqual(["Bearer fixture-codegraff-private", "Bearer fixture-cerebras-private", "Bearer fixture-cerebras-private"]);
 expect(budget.status("123")).toMatchObject({ accountCalls: 3, globalCalls: 3, active: 0 });
 expect(sent[0]!.body).not.toHaveProperty("reasoning_effort"); expect(sent[1]!.body.reasoning_effort).toBe("none");
});

test("native inference completes for Codegraff and Cerebras without role fallback", async () => {
 const urls: string[] = []; const { router, budget } = await fixture(async (url) => { urls.push(String(url)); return streamReply(); });
 expect(await react(router, "conversation")).toMatchObject({ kind: "complete", output: "Verified answer" });
 expect(await react(router, "rag")).toMatchObject({ kind: "complete", output: "Verified answer" });
 expect(urls).toEqual([endpointFor("conversation"), endpointFor("rag")]); expect(budget.status("123").accountCalls).toBe(2);
});

test("missing Cerebras secret is unavailable without fallback; a ledger is optional", async () => {
 let calls = 0; const f = await fixture(async () => { calls++; return streamReply(); }, { CEREBRAS_API_KEY: undefined });
 expect(f.router.status("rag")).toMatchObject({ status: "unavailable", reason: "missing_key", provider: "cerebras" });
 expect(() => f.router.layer("rag")).toThrow("missing_key"); expect(() => f.router.transport("browser")).toThrow("missing_key");
 expect(f.router.status("conversation").status).toBe("configured"); expect(calls).toBe(0);
 const noBudget = createModelRouting({ owner: "123", config: parseModelRouting(env), env }); expect(noBudget.status("rag").status).toBe("configured");
 expect(() => noBudget.layer("rag")).not.toThrow();
});

test("paid opt-in and valid provider/model/secret references are required", () => {
 expect(() => parseModelRouting({ AIKO_RAG_PROVIDER: "unknown" })).toThrow();
 expect(() => parseModelRouting({ AIKO_RAG_MODEL: "https://untrusted.net/model?key=x" })).toThrow();
 expect(() => parseModelRouting({ AIKO_RAG_MODEL: "credentialvalue", CEREBRAS_API_KEY: "credentialvalue" })).toThrow();
 expect(() => parseModelRouting({}, { contextWindowTokens: 1024, maxOutputTokens: 1024 })).toThrow();
 const disabled = createModelRouting({ owner: "123", config: parseModelRouting(env), env: { ...env, AIKO_ALLOW_PAID_INFERENCE: "false" } });
 expect(disabled.status("browser").reason).toBe("paid_inference_disabled");
 const modified = structuredClone(parseModelRouting(env)); (modified.roles.rag as any).baseUrl = "https://untrusted.net/v1";
 expect(() => createModelRouting({ owner: "123", config: modified, env })).toThrow("configuration");
});

test("Cerebras wire adaptation preserves local schemas and property names, keeps output ceiling", async () => {
 let sent: any;
 const { router } = await fixture(async (_, init) => { sent = JSON.parse(String(init?.body)); return streamReply(); });
 const parameters = { type: "object", properties: { pattern: { type: "string", minLength: 3, pattern: "^[a-z]+$" }, nested: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 8 } } }, required: ["pattern"], additionalProperties: false };
 const original = structuredClone(parameters);
 await (await router.transport("browser")(endpointFor("browser"), requestFor("browser", { tools: [{ type: "function", function: { name: "read_page", parameters } }] }))).text();
 expect(parameters).toEqual(original);
 expect(sent.tools[0].function.parameters.properties.pattern).toEqual({ type: "string" });
 expect(sent.tools[0].function.parameters.properties.nested.items).toEqual({ type: "string" });
 expect(sent.tools[0].function.parameters.properties.nested).not.toHaveProperty("minItems");
 expect(sent.tools[0].function.parameters.properties.nested).not.toHaveProperty("maxItems");
 expect(sent.tools[0].function.strict).toBe(true); expect(sent.reasoning_effort).toBe("high"); expect(sent.max_tokens).toBe(1024);
});

test("Cerebras uses uniform non-strict tools for open connector inputs without closing their original schemas", async () => {
 let sent: any;
 const {router} = await fixture(async (_,init)=>{sent=JSON.parse(String(init?.body));return streamReply();});
 const open = {type:"object",properties:{arguments:{type:"object"}},required:["arguments"],additionalProperties:false};
 const closed = {type:"object",properties:{text:{type:"string",maxLength:12000}},required:["text"],additionalProperties:false};
 const tools = [open,closed].map((parameters,index)=>({type:"function",function:{name:index===0?"connector_execute":"respond",parameters}}));
 const original = structuredClone(tools);
 await (await router.transport("browser")(endpointFor("browser"),requestFor("browser",{tools}))).text();
 expect(sent.tools.map((tool:any)=>tool.function.strict)).toEqual([false,false]);
 expect(sent.tools[0].function.parameters).toEqual(open);
 expect(sent.tools[1].function.parameters).toEqual(closed);
 expect(tools).toEqual(original);
});

test("redirects/provider failures are charged once, not retried and never sent to another provider", async () => {
 for (const status of [302, 429, 500]) {
  const urls: string[] = []; const { router, budget } = await fixture(async url => { urls.push(String(url)); return new Response("private provider error", { status, headers: { Location: "https://untrusted.net/key-sink" } }); });
  const action = await react(router, "rag");
  expect(action.kind).toBe("fail"); expect(JSON.stringify(action)).not.toContain("private provider error");
  expect(urls).toEqual([endpointFor("rag")]); expect(budget.status("123")).toMatchObject({ accountCalls: 1, active: 0 });
 }
});

test("budget exhaustion is shared across roles and no extra outbound call occurs", async () => {
 let calls = 0; const { router, budget } = await fixture(async () => { calls++; return streamReply(); }, {}, { globalPerDay: 2, accountPerDay: 1, maxConcurrent: 1 });
 await (await router.transport("conversation")(endpointFor("conversation"), requestFor("conversation"))).text();
 await expect(router.transport("rag")(endpointFor("rag"), requestFor("rag"))).rejects.toThrow("daily_budget_exhausted");
 expect(calls).toBe(1); expect(budget.status("123").accountCalls).toBe(1);
});

test("endpoint/model/output injection and pre-cancelled calls cannot consume allowance", async () => {
 let calls = 0; const { router, budget } = await fixture(async () => { calls++; return streamReply(); });
 const send = router.transport("rag");
 await expect(send("https://untrusted.net/v1/chat/completions", requestFor("rag"))).rejects.toThrow("request_rejected");
 await expect(send(endpointFor("rag"), requestFor("rag", { model: "other" }))).rejects.toThrow("request_rejected");
 await expect(send(endpointFor("rag"), requestFor("rag", { max_tokens: 4096 }))).rejects.toThrow("request_rejected");
 await expect(send(endpointFor("rag"), { ...requestFor("rag"), signal: AbortSignal.abort() })).rejects.toThrow();
 expect(calls).toBe(0); expect(budget.status("123").accountCalls).toBe(0);
 expect(await react(router, "rag", { ...nativeRequest, model: { provider: "codegraff", model_id: "other" } })).toMatchObject({ kind: "fail" });
 expect(calls).toBe(0);
});

test("concurrency cancellation and stream cancellation release existing accounting slots", async () => {
 let calls = 0; const { router, budget } = await fixture(async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); } })); }, {}, { globalPerDay: 5, accountPerDay: 5, maxConcurrent: 1 });
 const first = await router.transport("rag")(endpointFor("rag"), requestFor("rag")); expect(budget.status("123").active).toBe(1);
 const abort = new AbortController(); const queued = router.transport("browser")(endpointFor("browser"), { ...requestFor("browser"), signal: abort.signal });
 abort.abort(); await expect(queued).rejects.toThrow();
 await first.body!.cancel(); expect(budget.status("123")).toMatchObject({ active: 0, accountCalls: 1 }); expect(calls).toBe(1);
});

test("configured wider native output cannot bypass the existing budget's independent ceiling", async () => {
 let calls = 0; const f = await fixture(async () => { calls++; return streamReply(); });
 const router = createModelRouting({ owner: "123", env, config: parseModelRouting(env, { maxOutputTokens: 4096 }), budget: f.budget, fetch: async () => { calls++; return streamReply(); } });
 await expect(router.transport("rag")(endpointFor("rag"), requestFor("rag", { max_tokens: 4096 }))).rejects.toThrow("transport_or_budget_unavailable");
 expect(calls).toBe(0); expect(f.budget.status("123").accountCalls).toBe(0);
});

test("credential rotation is resolved privately at egress; malformed or removed key blocks existing layers", async () => {
 const headers: string[] = [];
 const f = await fixture(async (_, init) => { headers.push(new Headers(init?.headers).get("Authorization")!); return streamReply(); });
 const layer = f.router.layer("rag");
 f.vars.CEREBRAS_API_KEY = "fixture-rotated-private";
 await (await f.router.transport("rag")(endpointFor("rag"), requestFor("rag"))).text();
 expect(headers).toEqual(["Bearer fixture-rotated-private"]);
 f.vars.CEREBRAS_API_KEY = "invalid\nheader";
 expect(f.router.status("rag").reason).toBe("invalid_key");
 const action = await Effect.runPromise(Effect.gen(function* () { const binding = yield* Infer; return yield* binding.react(nativeRequest); }).pipe(Effect.provide(layer)));
 expect(action).toMatchObject({ kind: "fail" }); expect(JSON.stringify(action)).not.toContain("invalid\nheader");
 expect(headers).toHaveLength(1);
});

test("Cloudflare-style native routing works without a ledger through direct pinned egress", async () => {
 const seen: string[] = [];
 const router = createModelRouting({ owner: "123", config: parseModelRouting(env), env, fetch: async (url, init) => {
  seen.push(String(url)); expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(init?.headers).get("Authorization")).toBe(String(url).includes("cerebras") ? "Bearer fixture-cerebras-private" : "Bearer fixture-codegraff-private");
  return streamReply();
 } });
 for (const role of ["conversation", "rag", "browser"] as const) expect(await react(router, role)).toMatchObject({ kind: "complete", output: "Verified answer" });
 expect(seen).toEqual([endpointFor("conversation"), endpointFor("rag"), endpointFor("browser")]);
});

test("direct mode rejects redirects, exhausted providers and invalid destinations without retry", async () => {
 for (const status of [302, 429, 503]) {
  const seen: string[] = [];
  const router = createModelRouting({ owner: "123", config: parseModelRouting(env), env, throttleRetryDelaysMs: [], fetch: async url => { seen.push(String(url)); return new Response("private upstream", { status, headers: { Location: "https://untrusted.net/steal" } }); } });
  expect(await react(router, "rag")).toMatchObject({ kind: "fail" }); expect(seen).toEqual([endpointFor("rag")]);
  await expect(router.transport("rag")("https://untrusted.net/v1/chat/completions", requestFor("rag"))).rejects.toThrow("request_rejected");
  expect(seen).toHaveLength(1);
 }
});
