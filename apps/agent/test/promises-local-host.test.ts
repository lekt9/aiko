import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { createPromises, promiseState } from "../src/promises.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

test("local owner API and native deadlines survive restart without model calls or repeated tool effects", async () => {
  const stateDir = await mkdtemp("/tmp/promise-local-");
  const owner = "123", thread = "user-123", token = "promise-local-owner-synthetic-1234567890", readonly = "promise-local-read-synthetic-1234567890";
  let modelCalls = 0, segments = 0;
  const config: AikoConfig = { mode: "demo", codeMode: true, port: 4242, stateDir,
    operatorToken: "promise-local-operator-synthetic-1234567890", persona: PERSONA, voiceEnabled: false, allowedUsers: new Set([owner]),
    planeCredentials: [{ account: owner, digest: credentialDigest(token), scopes: ["read", "write"] }, { account: owner, digest: credentialDigest(readonly), scopes: ["read"] }],
  };
  const open = () => createService(config, {
    model: Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "promise-local" } }),
      react: () => { modelCalls++; throw Error("Frozen tasks must not invoke a model"); } }),
    registrySandbox: () => ({ placement: "local", codeTransport: async (...args: Parameters<typeof runCodeSegment>) => { segments++; return runCodeSegment(...args); },
      sandbox: { harnessEnvironment: async () => `sha256:${"1".repeat(64)}`, harnessJob: async () => { throw Error("No job execution"); } } }),
  });
  let service: Awaited<ReturnType<typeof open>> | undefined;
  try {
    service = await open(); await service.ready;
    const request = (path: string, body?: unknown, bearer = token) => service!.fetch(new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const prepare = (when: Parameters<ReturnType<typeof createPromises>["prepare"]>[0]["when"], expiresInMs?: number) => Effect.runPromise(createPromises({ owner, thread }).prepare({
      payload: { kind: "harness", segment: { version: 1, code: 'await tools.call({name:"promise_list",arguments:{}}); return "done";', packages: { tools: ["call"] }, values: {}, ambient: { at: Date.now(), seed: "fixture" }, history: [] } }, when, expiresInMs,
    }).pipe(Effect.provideService(EventLog, withWatermark({ read: Effect.promise(() => service!.host.read(thread)), append: events => Effect.promise(async () => { for (const e of events) await service!.host.commitRoot(service!.host.self(thread), e); }) }))));
    expect((await request("/api/promises", undefined, "invalid")).status).toBe(401);
    expect((await request("/api/promises", undefined, config.operatorToken)).status).toBe(403);
    const approved = await prepare({ kind: "approval" });
    expect((await request("/v1/promises", undefined, readonly)).status).toBe(200);
    const body = { id: approved.id, hash: approved.hash, decision: "approve" };
    expect((await request("/api/promises/decision", body, readonly)).status).toBe(403);
    expect((await request("/api/promises/decision", { ...body, hash: "changed" })).status).toBe(409);
    expect((await request("/api/promises/decision", body)).status).toBe(200);
    await service.host.drive();
    expect(promiseState(await service.host.read(thread)).records.get(approved.id)).toMatchObject({ state: "settled", outcome: "succeeded" });
    const timed = await prepare({ kind: "at", at: Date.now() + 1500 });
    const expiring = await prepare({ kind: "approval" }, 1400);
    await service.host.drive();
    expect((await service.host.read(thread)).filter(e => e.type === "AikoPromiseDeadline").length).toBeGreaterThanOrEqual(2);
    expect(promiseState(await service.host.read(thread)).records.get(timed.id)?.state).toBe("pending");
    await service.close(); service = undefined;
    await new Promise(resolve => setTimeout(resolve, 1600));
    service = await open(); await service.ready;
    // Native recovery/alarm machinery owns the wake. No promise tick or explicit drive.
    for (let i = 0; i < 200; i++) {
      if (promiseState(await service.host.read(thread)).records.get(timed.id)?.state === "settled") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const rows = await service.host.read(thread), records = promiseState(rows).records;
    expect(records.get(timed.id)).toMatchObject({ state: "settled", outcome: "succeeded" });
    expect(records.get(expiring.id)?.state).toBe("expired");
    expect(rows.filter(e => e.type === "AikoCodeToolSettled")).toHaveLength(2);
    expect(rows.filter(e => e.type === "ToolCalled" && e.name === "respond")).toHaveLength(2);
    expect(rows.filter(e => e.type === "AikoResponseRequested")).toHaveLength(2);
    const before = segments;
    expect((await request("/v1/promises/decision", body)).status).toBe(200);
    await service.host.drive(); expect(segments).toBe(before); expect(modelCalls).toBe(0);
  } finally { await service?.close(); await rm(stateDir, { recursive: true, force: true }); }
}, 15000);
