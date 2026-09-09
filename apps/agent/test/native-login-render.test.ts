import { afterEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { mkdtemp, rm } from "node:fs/promises";
import { createNativeLoginRenderer } from "../src/native-login-render.ts";
import { fallbackLoginSpec, LOGIN_UI_VERSION, type LoginSpec } from "../../../packages/protocol/src/login-ui.ts";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";

const view = { status: "pending" as const, domain: "fixture-private-domain.example", fields: ["username", "password"] as ("username" | "password")[],
  password: "fixture-password-canary", username: "fixture-user-canary", code: "fixture-code-canary", screenshot: "fixture-screenshot-canary" };
function composed(fields: string[] = view.fields): LoginSpec {
  const spec = fallbackLoginSpec(fields)!;
  spec.elements.title = { type: "LoginHeading", props: { text: fields.includes("code") ? "Verify your sign-in" : "Sign in" }, children: [] };
  spec.elements.group = { type: "LoginStack", props: { spacing: "compact" }, children: [...fields] };
  spec.elements.login!.children = ["title", "group", "submit"];
  return spec;
}
const inert = () => new AbortController().signal;
function model(output: unknown, calls: InferRequest[]) {
  return Layer.succeed(Infer, { react: request => Effect.sync(() => {
    calls.push(request);
    return { kind: "complete" as const, output: JSON.stringify(output) };
  }) });
}

test("generation receives only field kinds; compositions and owner caches are real", async () => {
  const calls: InferRequest[] = [], spec = composed();
  const renderer = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => model(spec, calls) });
  const [one, two] = await Promise.all([renderer(view, inert()), renderer({ ...view, fields: ["password", "username"] }, inert())]);
  expect(calls).toHaveLength(1);
  expect(one).toEqual({ version: LOGIN_UI_VERSION, source: "generated", spec });
  expect(two).toEqual(one);
  expect(one!.spec).not.toEqual(fallbackLoginSpec(view.fields));
  expect(calls[0]!.tools).toEqual([]);
  expect(calls[0]!.system).toContain("PasswordField");
  expect(calls[0]!.system).not.toContain("setState");
  expect(calls[0]!.system).not.toContain("pushState");
  expect(calls[0]!.trajectory).toHaveLength(1);
  expect(JSON.parse(String(calls[0]!.trajectory[0]!.text))).toEqual({ fields: ["username", "password"] });
  for (const secret of [view.domain, view.password, view.username, view.code, view.screenshot]) expect(JSON.stringify(calls)).not.toContain(secret);
  one!.spec.elements.title!.props = {};
  expect((await renderer(view, inert()))!.spec).toEqual(spec);
  const other = createNativeLoginRenderer({ owner: "456", instance: "test", layer: () => model(spec, calls) });
  await other(view, inert());
  expect(calls).toHaveLength(2);
  expect(calls.map(call => call.identity.thread)).toEqual(["login-ui-123", "login-ui-456"]);
});

test("unsupported/origin/error/completed views do not reach a model", async () => {
  const calls: InferRequest[] = [], render = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => model(composed(), calls) });
  for (const input of [
    { ...view, fields: [] }, { ...view, fields: ["unknown"] }, { ...view, fields: ["password", "password"] },
    { ...view, requiresOrigin: "https://identity.example" }, { ...view, pageError: "navigation_failed" }, { ...view, status: "connected" },
  ]) expect(await render(input as Parameters<typeof render>[0], inert())).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test("invalid output or unavailable inference returns cached, value-free fallback", async () => {
  const invalid = composed() as any;
  invalid.elements.password.props = { value: view.password };
  const calls: InferRequest[] = [], render = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => model(invalid, calls) });
  const result = await render(view, inert());
  expect(result?.source).toBe("fallback");
  expect(JSON.stringify(result)).not.toContain(view.password);
  await render(view, inert()); expect(calls).toHaveLength(1);
  const unavailable = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => undefined });
  expect((await unavailable(view, inert()))?.source).toBe("fallback");
  const failed = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => Layer.succeed(Infer, { react: () => Effect.die(Error(view.password)) }) });
  expect((await failed(view, inert()))?.source).toBe("fallback");
});

test("cancellation stops inference and never starts a fresh retry for that shape", async () => {
  let calls = 0;
  const render = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => Layer.succeed(Infer, { react: () => Effect.gen(function* () { calls++; yield* Effect.never; return { kind: "fail" as const, error: "unreachable" }; }) }) });
  const abort = new AbortController(); abort.abort();
  await expect(render(view, abort.signal)).rejects.toThrow(); expect(calls).toBe(0);
  const running = new AbortController(), pending = render(view, running.signal);
  running.abort();
  await expect(pending).rejects.toThrow();
  expect((await render(view, inert()))?.source).toBe("fallback");
  expect(calls).toBe(1);
});

test("slow layout inference cannot hold a ready sign-in form open", async () => {
  let calls = 0, cancelled = false;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const deferred: Promise<unknown>[] = [];
  const render = createNativeLoginRenderer({ owner: "123", instance: "test", defer: work => { deferred.push(work); }, layer: () => Layer.succeed(Infer, {
    react: (_request, _id, signal) => Effect.gen(function* () {
      calls++;
      signal!.addEventListener("abort", () => { cancelled = true; }, { once: true });
      yield* Effect.promise(() => ready);
      return {kind:"complete" as const,output:JSON.stringify(composed())};
    }),
  }) });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const layout = await Promise.race([
      render(view, inert()),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(Error("Layout held sign-in hostage")), 1000); }),
    ]);
    expect(layout).toEqual({version:LOGIN_UI_VERSION,source:"fallback",spec:fallbackLoginSpec(view.fields)!});
    expect(cancelled).toBe(false);
    release();
    await Promise.all(deferred);
    expect((await render(view, inert()))?.source).toBe("generated");
    expect(calls).toBe(1);
  } finally { clearTimeout(timeout); release(); }
});

test("native provider adapter receives the catalog and returns a validated generated spec", async () => {
  const spec = composed(), wire: any[] = [];
  const env = { AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-provider-key" };
  const routing = createModelRouting({ owner: "123", env, config: parseModelRouting(env), throttleRetryDelaysMs: [], fetch: async (_url, init) => {
    wire.push(JSON.parse(String(init?.body)));
    return new Response([
      { id: "layout", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(spec) }, finish_reason: null }] },
      { id: "layout", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const render = createNativeLoginRenderer({ owner: "123", instance: "test", layer: () => routing.layer("conversation") });
  expect((await render(view, inert()))?.source).toBe("generated");
  expect(wire).toHaveLength(1);
  expect(JSON.stringify(wire[0].messages)).toContain("LoginStack");
  expect(JSON.stringify(wire[0].messages)).toContain("PasswordField");
  for (const secret of [view.password, view.username, view.code, view.domain]) expect(JSON.stringify(wire[0].messages)).not.toContain(secret);
  expect(wire[0].tools ?? []).toHaveLength(0);
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
test("authenticated native API generates layouts while passwords stay in private browser control", async () => {
  const stateDir = await mkdtemp("/tmp/login-ui-host-"); cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const token = "fixture-account-credential-12345678901234567890", reader = "fixture-read-credential-12345678901234567890", foreign = "fixture-other-credential-12345678901234567890";
  const config: AikoConfig = { mode: "demo", port: 4242, stateDir, operatorToken: "fixture-operator-12345678901234567890", persona: PERSONA, voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]), planeCredentials: [{ account: "123", digest: credentialDigest(token), scopes: ["read", "write"] }, { account: "123", digest: credentialDigest(reader), scopes: ["read"] }, { account: "456", digest: credentialDigest(foreign), scopes: ["read", "write"] }] };
  const calls: InferRequest[] = [], privateInputs: unknown[] = [];
  const service = await createService(config, { model: model(composed(), calls), connectorBrowser: () => ({ native: true,
    begin: async () => ({ authorizationUrl: "https://signin.aiko.com/owner" }),
    control: async (_binding, input) => { privateInputs.push(input); return { status: "pending", domain: "service.net", fields: ["username", "password"], expiresAt: Date.now() + 60_000, revision: 1 }; },
  }) }); cleanup.push(() => service.close());
  const request = (body: unknown, credential = token, path = "native") => service.fetch(new Request(`http://127.0.0.1:4242/api/connectors/${path}`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const connection = await (await request({ domain: "service.net" }, token, "browser")).json() as any;
  expect((await request({ connectionId: connection.id, action: "form" }, reader)).status).toBe(403);
  expect((await request({ connectionId: connection.id, action: "form" }, foreign)).status).toBe(409);
  expect((await request({ connectionId: connection.id, action: "form" }, "not-authorized")).status).toBe(401);
  expect(calls).toHaveLength(0);
  const result = await request({ connectionId: connection.id, action: "login", username: view.username, password: view.password });
  expect(result.status).toBe(200);
  expect((await result.json() as any).layout.source).toBe("generated");
  expect(privateInputs).toHaveLength(1);
  expect(privateInputs[0]).toMatchObject({ username: view.username, password: view.password });
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain(view.password);
  expect(JSON.stringify(calls)).not.toContain(view.username);
});
