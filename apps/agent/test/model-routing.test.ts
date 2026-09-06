import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Infer, type InferRequest } from "tardie";
import { ModelBudget } from "../src/model-budget.ts";
import { createModelRouting, parseModelRouting, MODEL_PROVIDERS, type ModelRole } from "../src/model-routing.ts";
import type { HttpFetch } from "../src/security.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const env = { AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-codegraff-private", CEREBRAS_API_KEY: "fixture-cerebras-private", AIKO_RAG_PROVIDER: "cerebras", AIKO_BROWSER_PROVIDER: "cerebras" };
async function fixture(upstream: HttpFetch, overrides = {}, limits = { globalPerDay: 10, accountPerDay: 5, maxConcurrent: 2 }) {
 const directory = await mkdtemp(join(tmpdir(), "model-routing-test-"));
 const budget = new ModelBudget(directory, limits);
 cleanup.push(async () => { budget.close(); await rm(directory, { recursive: true, force: true }); });
 const vars = { ...env, ...overrides };
 return { router: createModelRouting({ owner: "123", config: parseModelRouting(vars), env: vars, budget, fetch: upstream }), budget, directory, vars };
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
 const parameters = { type: "object", properties: { pattern: { type: "string", minLength: 3, pattern: "^[a-z]+$" }, nested: { type: "array", items: { type: "string", maxLength: 8 } } }, required: ["pattern"], additionalProperties: false };
 const original = structuredClone(parameters);
 await (await router.transport("browser")(endpointFor("browser"), requestFor("browser", { tools: [{ type: "function", function: { name: "read_page", parameters } }] }))).text();
 expect(parameters).toEqual(original);
 expect(sent.tools[0].function.parameters.properties.pattern).toEqual({ type: "string" });
 expect(sent.tools[0].function.parameters.properties.nested.items).toEqual({ type: "string" });
 expect(sent.tools[0].function.strict).toBe(true); expect(sent.reasoning_effort).toBe("high"); expect(sent.max_tokens).toBe(1024);
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
 await expect(router.transport("rag")(endpointFor("rag"), requestFor("rag"))).rejects.toThrow("transport_or_budget_unavailable");
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
  const router = createModelRouting({ owner: "123", config: parseModelRouting(env), env, fetch: async url => { seen.push(String(url)); return new Response("private upstream", { status, headers: { Location: "https://untrusted.net/steal" } }); } });
  expect(await react(router, "rag")).toMatchObject({ kind: "fail" }); expect(seen).toEqual([endpointFor("rag")]);
  await expect(router.transport("rag")("https://untrusted.net/v1/chat/completions", requestFor("rag"))).rejects.toThrow("request_rejected");
  expect(seen).toHaveLength(1);
 }
});
