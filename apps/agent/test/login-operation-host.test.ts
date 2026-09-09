import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { nativeLogin, type NativeLoginState } from "../src/native-login.ts";
import { nativeLoginMetadataJournal } from "../src/native-login-journal.ts";
import type { SecureBrowserAdapter } from "../src/connectors.ts";
import { loginOperationState } from "../src/login-operation.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const token = "aiko_test_login_12345678901234567890123456789012",
  reader = "aiko_test_reader_123456789012345678901234567890",
  bob = "aiko_test_bob_1234567890123456789012345678901234";
async function fixture(ttl = 60000) {
  const dir = await mkdtemp("/tmp/login-host-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let db = new Database(join(dir, "private.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS fixture(key TEXT PRIMARY KEY,value TEXT)",
  );
  const get = (key: string) =>
    (
      db.query("SELECT value FROM fixture WHERE key=?").get(key) as {
        value: string;
      } | null
    )?.value;
  const put = (key: string, value: string) => {
    db.query("INSERT OR REPLACE INTO fixture VALUES (?,?)").run(key, value);
  };
  let metadata = nativeLoginMetadataJournal(db, "123"),
    connectionId = "",
    loseAck = false,
    failCleanup = false;
  const state = () => {
    const row = db
      .query("SELECT state FROM native_login WHERE id=?")
      .get(connectionId) as { state: string } | null;
    return row ? (JSON.parse(row.state) as NativeLoginState) : undefined;
  };
  const typed: string[] = [];
  const adapter: SecureBrowserAdapter = {
    native: true,
    begin: async () => ({
      authorizationUrl: "https://signin.aiko.com/fixture",
    }),
    status: async (binding) =>
      state()?.status === "connected" && get("custody") === "yes"
        ? {
            ...binding,
            status: "connected",
            verification: {
              verified: true,
              revision: state()!.revision,
              expiresAt: state()!.expiresAt,
            },
          }
        : { ...binding, status: "pending" },
    control: async (binding, input, signal) => {
      signal?.throwIfAborted();
      connectionId = binding.connectionId;
      return nativeLogin(
        {
          ...input,
          connectionId: binding.connectionId,
          domain: binding.domain,
        },
        {
          read: state,
          save: (value) => metadata.save(value),
          verified: async () => {
            put("custody", "yes");
            return true;
          },
          cdp: {
            close() {},
            async send(method, params: any) {
              if (method === "Target.getTargets")
                return {
                  targetInfos: state()?.targetId
                    ? [{ targetId: state()!.targetId, type: "page" }]
                    : [],
                };
              if (method === "Target.createTarget")
                return { targetId: "fixture-private" };
              if (method === "Target.attachToTarget")
                return { sessionId: "fixture-session" };
              if (method === "Target.closeTarget") {
                if (failCleanup) throw Error("private cleanup lost");
                return { success: true };
              }
              if (method === "Input.insertText") {
                typed.push(params.text);
                put("input", params.text);
                return {};
              }
              if (method === "Network.getCookies")
                return {
                  cookies:
                    get("authenticated") === "yes"
                      ? [
                          {
                            secure: true,
                            httpOnly: true,
                            value: "PRIVATE_COOKIE",
                          },
                        ]
                      : [],
                };
              if (method === "Storage.getCookies") return { cookies: [] };
              if (method === "Runtime.evaluate") {
                const e = params.expression;
                if (e.includes("const names=")) return { result: { value: { code: 1 } } };
                if (e === "location.hostname")
                  return { result: { value: "service.net" } };
                if (e === "location.origin")
                  return { result: { value: "https://service.net" } };
                if (e.includes("Object.keys(f)"))
                  return {
                    result: {
                      value: get("authenticated") === "yes" ? [] : ["code"],
                    },
                  };
                if (e.includes("Boolean(document"))
                  return { result: { value: get("authenticated") === "yes" } };
                if (e.includes("HTMLFormElement.prototype.requestSubmit.call")) {
                  put(
                    "authenticated",
                    get("input") === "654321" ? "yes" : "no",
                  );
                  if (loseAck) throw Error("lost private acknowledgement");
                }
                return { result: { value: true } };
              }
              return {};
            },
          },
        },
      );
    },
  };
  const config: AikoConfig = {
    mode: "demo",
    port: 4242,
    stateDir: dir,
    operatorToken: "private-fixture-operator-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(token),
        scopes: ["read", "write"],
      },
      { account: "123", digest: credentialDigest(reader), scopes: ["read"] },
      {
        account: "456",
        digest: credentialDigest(bob),
        scopes: ["read", "write"],
      },
    ],
  };
  const options = {
    connectorBrowser: () => adapter,
    connectorFetch: async () => {
      throw Error("No provider network in fixture");
    },
  };
  let service = await createService(config, options);
  cleanups.push(async () => {
    await service.close();
    db.close();
  });
  const request = (path: string, body?: unknown, auth = token) =>
    service.fetch(
      new Request("http://127.0.0.1:4242" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const drive = () => service.host.wake("user-123");
  const created = await request("/api/connectors/browser", {
    domain: "service.net",
  });
  expect(created.status).toBe(200);
  connectionId = (await created.json()).id;
  const accepted = await request("/api/messages", {
    id: "original_fixture_task",
    text: "Hello, continue my fixture task after the connection is verified.",
  });
  expect(accepted.status).toBe(202);
  await drive();
  const start = {
    operationId: "fixture-login",
    connectionId,
    continuationId: (await accepted.json()).id,
    expiresInMs: ttl,
  };
  const begin = await request("/api/login-operations/start", start);
  expect(begin.status).toBe(202);
  const operation = await begin.json();
  await drive();
  const events = () => service.host.read("user-123");
  return {
    request,
    drive,
    events,
    state: () => state()!,
    typed,
    start,
    operation,
    connectionId,
    custody: () => get("custody"),
    approveExternally: () => put("authenticated", "yes"),
    projected: async () =>
      loginOperationState(await events(), "123", "user-123").get(
        "fixture-login",
      )!,
    restart: async () => {
      await service.close();
      db.close();
      db = new Database(join(dir, "private.sqlite"));
      metadata = nativeLoginMetadataJournal(db, "123");
      service = await createService(config, options);
      await drive();
    },
    submit: (code: string, fields: Record<string, unknown> = {}) =>
      request("/api/connectors/native", {
        connectionId,
        action: "credentials",
        code,
        attemptId: operation.attemptId,
        challengeId: state()!.challenge!.id,
        expectedRevision: state()!.challenge!.revision,
        submissionId: crypto.randomUUID(),
        ...fields,
      }),
    loseObservationDelivery: () => {
      const commit = service.host.commitRoot.bind(service.host);
      Object.defineProperty(service.host, "commitRoot", {
        value: async (
          address: string,
          event: import("tardie/core/event").Event,
        ) => {
          if (event.type === "AikoPrivateLoginObserved")
            throw Error("fixture observation unavailable");
          return commit(address, event);
        },
      });
    },
    failCleanup: (value: boolean) => {
      failCleanup = value;
    },
    loseAck: (value: boolean) => {
      loseAck = value;
    },
  };
}

test("actual account host resumes original native task once after private OTP, custody and reopen", async () => {
  const f = await fixture();
  expect((await f.projected()).status).toBe("awaiting_user");
  const first = f.state().challenge!;
  await f.restart();
  const wrong = await f.submit("WRONG_PRIVATE_OTP");
  expect(wrong.status).toBe(200);
  await f.drive();
  expect(f.state().challenge!.id).not.toBe(first.id);
  expect(
    (
      await f.submit("654321", {
        challengeId: first.id,
        expectedRevision: first.revision,
      })
    ).status,
  ).toBe(409);
  expect((await f.submit("654321")).status).toBe(200);
  await f.drive();
  expect(f.custody()).toBe("yes");
  expect(await f.projected()).toMatchObject({
    status: "connected",
    continued: true,
    continuationOutcome: "resumed",
  });
  await f.restart();
  await f.drive();
  const events = await f.events();
  expect(
    events.filter(
      (e) =>
        e.type === "MessageReceived" && e.id === "login-resume:fixture-login",
    ),
  ).toHaveLength(1);
  expect(
    events.some(
      (e) =>
        e.type === "TurnCompleted" && e.turn === "login-resume:fixture-login",
    ),
  ).toBe(true);
  const listed = await (await f.request("/api/connectors/connections")).json();
  expect(listed.connections[0].status).toBe("connected");
  for (const secret of ["654321", "WRONG_PRIVATE_OTP", "PRIVATE_COOKIE"])
    expect(JSON.stringify(events)).not.toContain(secret);
  expect(f.typed).toEqual(["WRONG_PRIVATE_OTP", "654321"]);
});

test("actual host lost private acknowledgement is reconciled without repeat input", async () => {
  const f = await fixture();
  f.loseAck(true);
  const submissionId = crypto.randomUUID();
  expect((await f.submit("654321", { submissionId })).status).toBe(409);
  f.loseAck(false);
  await f.restart();
  await f.drive();
  expect(f.typed).toEqual(["654321"]);
  expect((await f.projected()).continued).toBe(true);
  expect((await f.submit("654321", { submissionId })).status).toBe(409);
  expect(f.typed).toHaveLength(1);
});

test("scoped API rejects secrets, foreign owner and stale cancelled challenge", async () => {
  const f = await fixture();
  expect(
    (await f.request("/api/login-operations/start", f.start, reader)).status,
  ).toBe(403);
  expect(
    (await f.request("/api/login-operations/start", f.start, bob)).status,
  ).toBe(409);
  expect(
    (
      await f.request("/api/login-operations/start", {
        ...f.start,
        code: "PRIVATE_REJECTED",
      })
    ).status,
  ).toBe(400);
  expect((await f.request("/api/login-operations/start", f.start)).status).toBe(
    202,
  );
  expect(
    (
      await f.request("/api/login-operations/cancel", {
        operationId: "fixture-login",
      })
    ).status,
  ).toBe(202);
  await f.drive();
  await f.restart();
  expect(await f.projected()).toMatchObject({
    status: "cancelled",
    cleaned: true,
  });
  expect((await f.submit("654321")).status).toBe(409);
  expect(f.typed).toHaveLength(0);
  expect(JSON.stringify(await f.events())).not.toContain("PRIVATE_REJECTED");
});

test("actual native alarm observes app approval across reopen and resumes the original task once", async () => {
  const f = await fixture();
  expect((await f.projected()).status).toBe("awaiting_user");
  f.approveExternally();
  await f.restart();
  const due = (await f.projected()).nextProbeAt!;
  expect(due).toBeLessThan((await f.projected()).expiresAt);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, due - Date.now()) + 100),
  );
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "connected",
    continued: true,
  });
  expect(f.custody()).toBe("yes");
  expect(f.typed).toEqual([]);
  expect((await f.events()).some((e) => e.type === "AlarmFired")).toBe(true);
  await f.restart();
  await f.drive();
  expect(
    (await f.events()).filter(
      (e) =>
        e.type === "MessageReceived" && e.id === "login-resume:fixture-login",
    ),
  ).toHaveLength(1);
}, 15000);

test("actual native method alarm expires a waiting login across reopen", async () => {
  const f = await fixture(500);
  await f.restart();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "expired",
    cleaned: true,
  });
  expect((await f.events()).some((e) => e.type === "AlarmFired")).toBe(true);
  expect((await f.submit("654321")).status).toBe(409);
  expect(f.typed).toHaveLength(0);
});

test("cleanup uncertainty stays explicit and cannot authorize continuation", async () => {
  const f = await fixture();
  f.failCleanup(true);
  await f.request("/api/login-operations/cancel", {
    operationId: "fixture-login",
  });
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "cancelled",
    cleaned: false,
    cleanupOutcome: "unknown",
  });
  await f.restart();
  expect(
    (await f.events()).some(
      (e) =>
        e.type === "MessageReceived" && e.id === "login-resume:fixture-login",
    ),
  ).toBe(false);
  expect(
    (
      await f.request("/api/login-operations/start", {
        ...f.start,
        operationId: "replacement",
      })
    ).status,
  ).toBe(409);
  f.failCleanup(false);
  await f.request("/api/login-operations/cancel", {
    operationId: "fixture-login",
  });
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "cancelled",
    cleaned: true,
    cleanupOutcome: "cleaned",
    cleanupAttempts: 1,
  });
  expect(f.typed).toHaveLength(0);
});

test("verified custody waits for private cleanup, then native alarm resumes without retyping", async () => {
  const f = await fixture();
  f.failCleanup(true);
  expect((await f.submit("654321")).status).toBe(200);
  await f.drive();
  expect(f.custody()).toBe("yes");
  expect((await f.projected()).status).not.toBe("connected");
  await f.restart();
  f.failCleanup(false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "connected",
    continued: true,
  });
  expect(f.typed).toEqual(["654321"]);
});

test("runtime admission accepts sanitized observations but rejects forged private completion and handoffs", async () => {
  const { loginRuntimeEvent } = await import("../src/login-operation-host.ts");
  const { loginOperationExternalEventAllowed } =
    await import("../src/login-operation.ts");
  const event = {
    type: "AikoPrivateLoginObserved",
    owner: "123",
    connectionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    sequence: 1,
    revision: 1,
    kind: "opening",
    at: Date.now(),
    expiresAt: Date.now() + 1000,
    code: "PRIVATE_CODE",
    password: "PRIVATE_PASSWORD",
  };
  const accepted = loginRuntimeEvent("123", event);
  expect(accepted).not.toHaveProperty("code");
  expect(accepted).not.toHaveProperty("password");
  expect(() => loginRuntimeEvent("456", event)).toThrow("owner");
  for (const forged of [
    { type: "AikoLoginOperationVerified" },
    { type: "AikoLoginOperationRequested" },
    { type: "MessageReceived", source: "login" },
    { type: "Arbitrary", call: { invocation: { method: "loginWait" } } },
  ]) {
    expect(loginOperationExternalEventAllowed(forged)).toBe(false);
    expect(() => loginRuntimeEvent("123", forged)).toThrow("Reserved");
  }
  expect(loginOperationExternalEventAllowed(event)).toBe(false);
});

test("actual host restart flushes a stranded connector observation outbox without repeating OTP", async () => {
  const f = await fixture();
  f.loseObservationDelivery();
  expect((await f.submit("654321")).status).toBe(200);
  await f.drive();
  expect((await f.projected()).status).toBe("awaiting_user");
  await f.restart();
  await f.drive();
  expect(await f.projected()).toMatchObject({
    status: "connected",
    continued: true,
  });
  expect(f.typed).toEqual(["654321"]);
  expect(
    (await f.events()).filter(
      (e) =>
        e.type === "MessageReceived" && e.id === "login-resume:fixture-login",
    ),
  ).toHaveLength(1);
});
