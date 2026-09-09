import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import {
  createActorLoginTools,
  agentLoginFields,
} from "../src/capability-builder-login.ts";
import type { ActorConnectorBinding } from "../src/capability-builder-connectors.ts";
import {
  loginOperationComponent,
  loginOperationState,
  requestLoginOperation,
  type LoginOperationBinding,
} from "../src/login-operation.ts";
import {
  nativeLogin,
  type NativeLoginView,
  type NativeLoginState,
  type PrivateCdp,
} from "../src/native-login.ts";
import { ConnectorEngine } from "../src/connectors.ts";
import {
  guardLoginOperationInput,
  hostedLoginOperation,
} from "../src/login-operation-host.ts";
import { loginObservationEvent } from "../src/native-login-observation.ts";
import {
  validateLoginSpec,
  LOGIN_UI_VERSION,
  fallbackLoginSpec,
  loginFields,
} from "../../../packages/protocol/src/login-ui.ts";

const connectionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export function fixture() {
  const events: Event[] = [
    {
      type: "MessageReceived",
      id: "turn",
      source: "telegram",
      chat: "123",
      sender: "123",
      text: "Connect service.net",
      at: Date.now(),
    },
  ];
  const calls: unknown[] = [];
  const engineCalls: unknown[] = [];
  let connectionStatus: "pending" | "connected" = "pending";
  let failure = false,
    authority = true,
    engineFailure = false;
  let view: NativeLoginView | undefined;
  const binding: ActorConnectorBinding = {
    owner: "123",
    thread: "user-123",
    engine: {
      search: async () => {
        throw Error("unused");
      },
      connectBrowser: async () => {
        throw Error("unused");
      },
      execute: async () => {
        throw Error("unused");
      },
      connections: async () => {
        throw Error("Status must never renew browser sessions");
      },
      connectionSnapshot: async () => [
        {
          id: connectionId,
          connectorId: "browser:service.net",
          provider: "browser",
          status: connectionStatus,
          createdAt: 0,
          authorizationUrl: "https://private.example/SECRET_URL",
        },
      ],
      loginOperationContext: async () => ({
        domain: "service.net",
        revision: 0,
        status: connectionStatus,
      }),
      nativeControl: async (_id: string, input: Record<string, unknown>) => {
        engineCalls.push(input);
        if (engineFailure) throw Error("SECRET_TRANSPORT_ERROR");
        return {
          status: "pending",
          domain: "service.net",
          attemptId: (input as { attemptId?: string }).attemptId,
          revision: 2,
          expiresAt: Date.now() + 60000,
          fields: [] as string[],
        };
      },
    },
    deliverConnection: async () => {
      throw Error("Tools must use durable notifications");
    },
  };
  const login: LoginOperationBinding = {
    owner: "123",
    thread: "user-123",
    authorize: async () => authority,
    control: async (input) => {
      calls.push(input);
      if (failure) throw Error("SECRET_TRANSPORT_ERROR");
      return (
        view ?? {
          status: "pending",
          domain: "service.net",
          attemptId: input.attemptId,
          revision: 1,
          expiresAt: Date.now() + 60000,
          fields: ["username", "password"],
        }
      );
    },
  };
  const run = (
    action: string,
    input: unknown = { connectionId },
    callId = action,
    thread = binding.thread,
  ): Promise<any> =>
    Effect.runPromise(
      createActorLoginTools(binding, login)
        .find((t) => t.spec.name === `connector_login_${action}`)!
        .run(input, {
          callId,
          turn: "turn",
          signal: new AbortController().signal,
        })
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            instance: "test",
            thread,
          }),
          Effect.provideService(EventLog, {
            read: Effect.sync(() => events),
            head: Effect.sync(() => events.length),
            readFrom: (n) => Effect.sync(() => events.slice(n)),
            append: (items) =>
              Effect.sync(() => {
                events.push(...items);
              }),
          }),
        ),
    );
  const operation = () =>
    [...loginOperationState(events, "123", "user-123").values()].at(-1)!;
  return {
    run,
    events,
    calls,
    engineCalls,
    binding,
    login,
    operation,
    fail: () => {
      failure = true;
    },
    failEngine: () => {
      engineFailure = true;
    },
    deny: () => {
      authority = false;
    },
    view: (next: NativeLoginView) => {
      view = next;
    },
    connected: () => {
      connectionStatus = "connected";
    },
  };
}

test("start records the existing native operation and queues a private Telegram handoff without browser work", async () => {
  const f = fixture(),
    result = await f.run("start");
  expect(result.status).toBe("requested");
  expect(result.delivery).toBe("queued");
  expect(f.operation()).toMatchObject({
    connectionId,
    continuationId: "turn",
    contractRef: "native-login-session-v1",
    attemptId: result.attemptId,
  });
  expect(f.events.filter((e) => e.type === "AikoLoginRequested")).toHaveLength(
    1,
  );
  expect(f.calls).toEqual([]);
  expect(JSON.stringify([result, f.events])).not.toContain("SECRET_URL");
  expect((await f.run("start")).status).toBe("unknown");
  expect(
    f.events.filter((e) => e.type === "AikoLoginOperationRequested"),
  ).toHaveLength(1);
  expect((await f.run("start", { connectionId }, "new-call")).attemptId).toBe(
    result.attemptId,
  );
  expect(
    f.events.filter((e) => e.type === "AikoLoginOperationRequested"),
  ).toHaveLength(1);
});

test("status is passive, reads UI-created operations and does not expose URLs or private state", async () => {
  const f = fixture();
  const attemptId = crypto.randomUUID();
  f.events.push(
    requestLoginOperation({
      owner: "123",
      thread: "user-123",
      operationId: "ui-operation",
      connectionId,
      domain: "service.net",
      attemptId,
      expectedRevision: 0,
      expiresAt: Date.now() + 60000,
      continuationId: "turn",
      contractRef: "native-login-session-v1",
    }),
  );
  const result = await f.run("status");
  expect(result.operation).toMatchObject({
    operationId: "ui-operation",
    attemptId,
    status: "requested",
  });
  expect(result.connectionStatus).toBe("pending");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(f.calls).toEqual([]);
});

test("advance wraps native private fields in a validated inert layout, never submits credentials", async () => {
  const f = fixture(),
    started = await f.run("start");
  const result = await f.run("advance", {
    connectionId,
    attemptId: started.attemptId,
  });
  expect(f.calls).toEqual([
    {
      connectionId,
      domain: "service.net",
      attemptId: started.attemptId,
      action: "form",
    },
  ]);
  expect(result.fields).toEqual(["username", "password"]);
  expect(validateLoginSpec(result.layout.spec, result.fields)).toEqual(
    result.layout.spec,
  );
  expect(result.credentialEntry).toBe("private_ui");
  expect(
    (await f.run("advance", { connectionId, attemptId: started.attemptId }))
      .status,
  ).toBe("unknown");
  expect(f.calls).toHaveLength(1);
});

test("advance injects owner-supplied username/password exactly once through the private engine", async () => {
  const f = fixture(),
    started = await f.run("start");
  const input = {
    connectionId,
    attemptId: started.attemptId,
    fields: { username: "owner-user", password: "SECRET_PASSWORD" },
  };
  const result = await f.run("advance", input, "advance-fields");
  expect(f.calls).toEqual([
    {
      connectionId,
      domain: "service.net",
      attemptId: started.attemptId,
      action: "form",
    },
  ]);
  expect(f.engineCalls).toEqual([
    {
      action: "login",
      attemptId: started.attemptId,
      username: "owner-user",
      password: "SECRET_PASSWORD",
    },
  ]);
  expect(result.injected).toEqual(["username", "password"]);
  expect(result.fields).toEqual([]);
  expect(result.credentialEntry).toBe("private_ui");
  expect(JSON.stringify([result, f.events])).not.toContain("SECRET_PASSWORD");
  // The same call replays as unknown through the dispatch fence; a fresh call
  // hits the private controller, which owns resubmission decisions.
  expect(
    (await f.run("advance", input, "advance-fields")).status,
  ).toBe("unknown");
  expect(f.engineCalls).toHaveLength(1);
});

test("advance binds an injected code to the displayed challenge with a server-generated submission identity", async () => {
  const f = fixture(),
    started = await f.run("start"),
    challenge = {
      id: crypto.randomUUID(),
      revision: 3,
      expiresAt: Date.now() + 60000,
    };
  f.view({
    status: "pending",
    domain: "service.net",
    attemptId: started.attemptId,
    revision: 2,
    expiresAt: Date.now() + 60000,
    fields: ["code"],
    challenge,
  });
  const result = await f.run(
    "advance",
    { connectionId, attemptId: started.attemptId, fields: { code: "654321" } },
    "code-step",
  );
  expect(f.calls).toEqual([
    {
      connectionId,
      domain: "service.net",
      attemptId: started.attemptId,
      action: "form",
    },
  ]);
  expect(f.engineCalls).toEqual([
    {
      action: "credentials",
      attemptId: started.attemptId,
      code: "654321",
      challengeId: challenge.id,
      expectedRevision: challenge.revision,
      submissionId: expect.any(String),
    },
  ]);
  expect(result.injected).toEqual(["code"]);
  expect(JSON.stringify([result, f.events])).not.toContain("654321");
});

test("injected values are refused without dispatch when the step cannot take them", async () => {
  // Code offered for a step without a displayed challenge.
  const noChallenge = fixture(),
    started = await noChallenge.run("start");
  noChallenge.view({
    status: "pending",
    domain: "service.net",
    attemptId: started.attemptId,
    revision: 2,
    expiresAt: Date.now() + 60000,
    fields: ["username", "password"],
  });
  const refused = await noChallenge.run(
    "advance",
    { connectionId, attemptId: started.attemptId, fields: { code: "654321" } },
    "no-challenge",
  );
  expect(noChallenge.engineCalls).toEqual([]);
  expect(JSON.stringify(refused)).not.toContain("654321");
  // Owner approval is still required for a redirected provider page.
  const approval = fixture(),
    approvedStart = await approval.run("start");
  approval.view({
    status: "pending",
    domain: "service.net",
    attemptId: approvedStart.attemptId,
    revision: 2,
    expiresAt: Date.now() + 60000,
    fields: ["username", "password"],
    requiresOrigin: "https://identity.example",
  });
  await approval.run(
    "advance",
    {
      connectionId,
      attemptId: approvedStart.attemptId,
      fields: { username: "owner-user", password: "SECRET_PASSWORD" },
    },
    "approval",
  );
  expect(approval.engineCalls).toEqual([]);
  // Malformed field payloads are invalid arguments, never a dispatch.
  const f = fixture(),
    attempt = await f.run("start");
  expect(
    (
      await f.run(
        "advance",
        { connectionId, attemptId: attempt.attemptId, fields: "SECRET" },
        "malformed",
      )
    ).reason,
  ).toBe("invalid_arguments");
  expect(
    (
      await f.run(
        "advance",
        {
          connectionId,
          attemptId: attempt.attemptId,
          fields: { securityQuestion: "SECRET" },
        },
        "unknown-kind",
      )
    ).reason,
  ).toBe("invalid_arguments");
  expect(f.engineCalls).toEqual([]);
});

test("a lost private submission acknowledgement stays unknown and never carries values", async () => {
  const f = fixture(),
    started = await f.run("start");
  f.failEngine();
  const result = await f.run(
    "advance",
    {
      connectionId,
      attemptId: started.attemptId,
      fields: { username: "owner-user", password: "SECRET_PASSWORD" },
    },
    "engine-fail",
  );
  expect(result.status).toBe("unknown");
  expect(JSON.stringify([result, f.events])).not.toContain("SECRET_PASSWORD");
});

test("assist starts a private Gmail handoff with fresh identities; consent never becomes a tool", async () => {
  const f = fixture(),
    started = await f.run("start");
  const result = await f.run(
    "assist",
    {
      connectionId,
      attemptId: started.attemptId,
      assistMethod: "google",
      sourceConnectionId: crypto.randomUUID(),
    },
    "assist-call",
  );
  expect(f.engineCalls).toEqual([
    {
      action: "assist",
      attemptId: started.attemptId,
      assistMethod: "google",
      sourceConnectionId: expect.any(String),
      assistanceId: expect.any(String),
    },
  ]);
  expect(result.credentialEntry).toBe("private_ui");
  expect(
    (await f.run("assist", {
      connectionId,
      attemptId: started.attemptId,
      assistMethod: "google",
      sourceConnectionId: crypto.randomUUID(),
    }, "assist-call")).status,
  ).toBe("unknown");
  expect(f.engineCalls).toHaveLength(1);
  // Unknown methods and missing source bindings are rejected before dispatch.
  expect(
    (
      await f.run("assist", {
        connectionId,
        attemptId: started.attemptId,
        assistMethod: "facebook",
        sourceConnectionId: crypto.randomUUID(),
      })
    ).reason,
  ).toBe("invalid_arguments");
  expect(
    (
      await f.run("assist", {
        connectionId,
        attemptId: started.attemptId,
        assistMethod: "google",
      })
    ).reason,
  ).toBe("invalid_arguments");
  expect(f.engineCalls).toHaveLength(1);
  // Google consent is a private-panel control, not a chat tool.
  expect(
    createActorLoginTools(f.binding, f.login).map((tool) => tool.spec.name),
  ).not.toContain("connector_login_assist_consent");
});

test("tool responses carry the host's generative layout and fall back when rendering fails", async () => {
  const f = fixture();
  f.binding.renderLogin = async (step) => ({
    version: LOGIN_UI_VERSION,
    source: "generated",
    spec: fallbackLoginSpec(loginFields(step.fields)!)!,
  });
  const started = await f.run("start");
  const generated = await f.run("advance", {
    connectionId,
    attemptId: started.attemptId,
  });
  expect(generated.layout.source).toBe("generated");
  expect(validateLoginSpec(generated.layout.spec, generated.fields)).toEqual(
    generated.layout.spec,
  );
  const broken = fixture();
  broken.binding.renderLogin = async () => {
    throw Error("SECRET_RENDERER_ERROR");
  };
  const brokenStart = await broken.run("start");
  const fallback = await broken.run("advance", {
    connectionId,
    attemptId: brokenStart.attemptId,
  });
  expect(fallback.layout.source).toBe("fallback");
  expect(JSON.stringify(fallback)).not.toContain("SECRET_RENDERER_ERROR");
});

test("OTP field metadata never carries code, raw labels, screenshot, challenge internals, URLs or injected layout", () => {
  const result = agentLoginFields({
    status: "pending",
    domain: "SECRET_DOMAIN",
    fields: ["code"],
    revision: 1,
    expiresAt: 1,
    screenshot: "SECRET_SCREEN",
    currentHost: "SECRET_HOST",
    code: "SECRET_CODE",
    layout: { state: { code: "SECRET_STATE" } },
    challenge: { id: "SECRET_CHALLENGE", revision: 1, expiresAt: 1 },
  } as NativeLoginView);
  expect(result.fields).toEqual(["code"]);
  expect(validateLoginSpec(result.layout!.spec, ["code"])).toBeDefined();
  expect(JSON.stringify(result)).not.toContain("SECRET");
  const malformed = agentLoginFields({
    fields: ["code", "SECRET_LABEL"],
    status: "pending",
    domain: "service.net",
    revision: 1,
    expiresAt: 1,
  });
  expect(malformed.fields).toBeUndefined();
  expect(malformed.layout).toBeUndefined();
});

test("Google assistance exposes only reviewed status and leaves consent/new origins in the private panel", () => {
  const result = agentLoginFields({
    status: "pending",
    domain: "service.net",
    revision: 1,
    expiresAt: 1,
    fields: ["password"],
    requiresOrigin: "https://private.example/SECRET",
    assistance: {
      id: "SECRET_ID",
      method: "google",
      status: "approval_required",
      expiresAt: 1,
    },
  });
  expect(result).toMatchObject({
    approvalRequired: true,
    assistance: { method: "google", status: "approval_required" },
    credentialEntry: "private_ui",
  });
  expect(result.layout).toBeUndefined();
  expect(result.fields).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("SECRET");
  const providers = agentLoginFields({
    status: "pending",
    domain: "service.net",
    revision: 1,
    expiresAt: 1,
    providers: ["google", "SECRET_PROVIDER"],
  } as NativeLoginView);
  expect(providers.providers).toEqual(["google"]);
  expect(JSON.stringify(providers)).not.toContain("SECRET_PROVIDER");
});

test("expired, incomplete, conflicting and ambiguous private receipts hold instead of minting a new attempt", async () => {
  for (const kind of [
    "expired",
    "incomplete",
    "conflicting",
    "ambiguous",
    "verified",
  ] as const) {
    const f = fixture(),
      attemptId = crypto.randomUUID(),
      at = Date.now();
    const receipt = {
      type: "AikoPrivateLoginObserved" as const,
      id: `${attemptId}:1`,
      connectionId,
      attemptId,
      sequence: kind === "incomplete" ? 2 : 1,
      revision: 1,
      kind: kind === "verified" ? ("verified" as const) : ("opening" as const),
      at,
      expiresAt: kind === "expired" ? at - 1 : at + 60000,
    };
    f.events.push(loginObservationEvent("123", receipt));
    if (kind === "conflicting")
      f.events.push(loginObservationEvent("123", { ...receipt, revision: 2 }));
    if (kind === "ambiguous")
      f.events.push(
        loginObservationEvent("123", {
          ...receipt,
          attemptId: crypto.randomUUID(),
        }),
      );
    expect((await f.run("start")).status).toBe("unknown");
    expect(
      f.events.filter((e) => e.type === "AikoLoginOperationRequested"),
    ).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  }
});

test("secrets and arbitrary private browser controls are rejected before dispatch or event writes", async () => {
  for (const action of ["start", "status", "advance", "cancel"]) {
    for (const key of [
      "code",
      "password",
      "username",
      "text",
      "url",
      "gmailGrant",
      "assist_consent",
    ]) {
      const f = fixture();
      expect(
        (await f.run(action, { connectionId, [key]: "SECRET" })).status,
      ).toBe("rejected");
      expect(f.calls).toEqual([]);
      expect(f.events).toHaveLength(1);
    }
  }
});

test("mutations require the current trusted owner Telegram request, including sender identity", async () => {
  for (const change of [
    { source: "api" },
    { sender: "456" },
    { chat: "456" },
    { id: "stale" },
    { source: "operator", text: "source=telegram" },
  ]) {
    const f = fixture();
    Object.assign(f.events[0]!, change);
    expect((await f.run("start")).status).toBe("rejected");
    expect(f.events).toHaveLength(1);
  }
  const f = fixture();
  expect(
    (await f.run("status", { connectionId }, "status", "user-456")).status,
  ).toBe("rejected");
  expect(
    (await f.run("status", { connectionId: crypto.randomUUID() })).status,
  ).toBe("rejected");
});

test("cancel pins the exact attempt and reports cleanup pending; later start cannot replay the old call", async () => {
  const f = fixture(),
    started = await f.run("start");
  expect(
    (await f.run("cancel", { connectionId, attemptId: crypto.randomUUID() }))
      .reason,
  ).toBe("stale_login_attempt");
  expect(f.operation().status).toBe("requested");
  expect(
    await f.run("cancel", { connectionId, attemptId: started.attemptId }),
  ).toMatchObject({ status: "cancelled", cleanup: "pending" });
  expect(f.operation().status).toBe("cancelled");
  expect((await f.run("start", { connectionId }, "after-cancel")).cleanup).toBe(
    "pending",
  );
  expect(
    f.events.filter((e) => e.type === "AikoLoginOperationRequested"),
  ).toHaveLength(1);
  expect(f.calls).toHaveLength(0);
  expect((await f.run("start")).status).toBe("unknown");
});

test("lost private acknowledgement stays unknown and cannot be replayed through the same call", async () => {
  const f = fixture(),
    started = await f.run("start");
  f.fail();
  const result = await f.run("advance", {
    connectionId,
    attemptId: started.attemptId,
  });
  expect(result.status).toBe("unknown");
  expect(JSON.stringify([result, f.events])).not.toContain(
    "SECRET_TRANSPORT_ERROR",
  );
  await f.run("advance", { connectionId, attemptId: started.attemptId });
  expect(f.calls).toHaveLength(1);
});

test("authority loss, stale attempts and expiry block advance", async () => {
  const f = fixture(),
    started = await f.run("start");
  expect(
    (await f.run("advance", { connectionId, attemptId: crypto.randomUUID() }))
      .status,
  ).toBe("rejected");
  f.deny();
  expect(
    (await f.run("advance", { connectionId, attemptId: started.attemptId }))
      .reason,
  ).toBe("login_authority_unavailable");
  const index = f.events.findIndex(
    (e) => e.type === "AikoLoginOperationRequested",
  );
  f.events[index] = {
    ...f.events[index]!,
    at: Date.now() - 60000,
    expiresAt: Date.now() - 1,
  };
  expect(
    (await f.run("advance", { connectionId, attemptId: started.attemptId }))
      .status,
  ).toBe("expired");
  expect(f.calls).toHaveLength(0);
});

test("private connected observations alone cannot claim a verified native terminal", async () => {
  const f = fixture(),
    started = await f.run("start");
  f.view({
    status: "connected",
    domain: "service.net",
    attemptId: started.attemptId,
    revision: 2,
    expiresAt: Date.now() + 60000,
  });
  expect(
    (await f.run("advance", { connectionId, attemptId: started.attemptId }))
      .status,
  ).toBe("requested");
});

test("completed connections are not disconnected by cancel and tools require the native component binding", async () => {
  const f = fixture();
  f.connected();
  expect((await f.run("start")).reason).toBe("connection_not_pending");
  f.login.owner = "456";
  expect((await f.run("status")).reason).toBe("owner_binding_mismatch");
  expect(f.calls).toHaveLength(0);
});

test("tool requests and UI/API state converge through the real native host across restart and cancellation cleanup", async () => {
  const directory = await mkdtemp("/tmp/login-tools-host-");
  const f = fixture(),
    actions: string[] = [];
  f.login.control = async (input) => {
    actions.push(input.action);
    return {
      status: input.action === "disconnect" ? "disconnected" : "pending",
      domain: input.domain,
      attemptId: input.attemptId,
      revision: 1,
      expiresAt: Date.now() + 60000,
      fields: ["code"],
    };
  };
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [loginOperationComponent(f.login)],
  });
  const open = () =>
    createBunHost({
      database: join(directory, "actor.sqlite"),
      actorName: "aiko",
      actorInstance: "login-tools-test",
      actorFor: () => definition,
      layersFor: () => Layer.empty,
    });
  let host = await open();
  try {
    await host.commitRoot(host.self("user-123"), f.events[0]!);
    const run = (name: string, input: unknown): Promise<any> =>
      Effect.runPromise(
        createActorLoginTools(f.binding, f.login)
          .find((t) => t.spec.name === name)!
          .run(input, {
            callId: name,
            turn: "turn",
            signal: new AbortController().signal,
          })
          .pipe(
            Effect.provideService(Self, {
              actor: "aiko",
              instance: "login-tools-test",
              thread: "user-123",
            }),
            Effect.provideService(EventLog, {
              read: Effect.promise(() => host.read("user-123")),
              head: Effect.promise(
                async () => (await host.read("user-123")).length,
              ),
              readFrom: (n) =>
                Effect.promise(async () =>
                  (await host.read("user-123")).slice(n),
                ),
              append: (items) =>
                Effect.promise(async () => {
                  for (const event of items)
                    await host.commitRoot(host.self("user-123"), event);
                }),
            }),
          ),
      );
    const started = await run("connector_login_start", { connectionId });
    expect(started.status).toBe("requested");
    await host.wake("user-123");
    const before = await run("connector_login_status", { connectionId });
    expect(before.operation.status).toBe("awaiting_user");
    expect(actions).toEqual(["begin"]);
    await host.close();
    host = await open();
    await host.wake("user-123");
    expect(
      (await run("connector_login_status", { connectionId })).operation
        .attemptId,
    ).toBe(started.attemptId);
    expect(actions).toEqual(["begin"]);
    expect(
      (
        await run("connector_login_advance", {
          connectionId,
          attemptId: started.attemptId,
        })
      ).fields,
    ).toEqual(["code"]);
    expect(
      (
        await run("connector_login_cancel", {
          connectionId,
          attemptId: started.attemptId,
        })
      ).cleanup,
    ).toBe("pending");
    await host.wake("user-123");
    expect(
      (await run("connector_login_status", { connectionId })).operation,
    ).toMatchObject({ status: "cancelled", cleanup: "cleaned" });
    expect(actions).toEqual(["begin", "form", "disconnect"]);
    await host.close();
    host = await open();
    await host.wake("user-123");
    expect(actions).toEqual(["begin", "form", "disconnect"]);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Actual connector/controller/host; only the private browser transport is a fixture. */
async function joinedPrivateLogin() {
  const directory = await mkdtemp("/tmp/login-tools-private-");
  const rows = new Map<string, unknown>(),
    actions: string[] = [],
    targets = new Set<string>();
  let state: NativeLoginState | undefined,
    statusUnavailable = false,
    authenticated = false;
  const typed: string[] = [];
  const cdp: PrivateCdp = {
    close() {},
    async send(method, raw) {
      const params = raw as Record<string, any>;
      if (method === "Target.getTargets")
        return {
          targetInfos: [...targets].map((targetId) => ({
            targetId,
            type: "page",
          })),
        };
      if (method === "Target.createTarget") {
        const targetId = crypto.randomUUID();
        targets.add(targetId);
        return { targetId };
      }
      if (method === "Target.attachToTarget") return { sessionId: "private" };
      if (method === "Target.closeTarget") {
        targets.delete(params.targetId);
        return { success: true };
      }
      if (method === "Storage.getCookies") return { cookies: [] };
      if (method === "Network.getCookies")
        return {
          cookies: authenticated
            ? [{ httpOnly: true, secure: true, value: "SECRET_COOKIE" }]
            : [],
        };
      if (method === "Input.insertText") {
        typed.push(params.text);
        return {};
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        if (expression === "location.hostname")
          return { result: { value: "service.net" } };
        if (expression === "location.origin")
          return { result: { value: "https://service.net" } };
        if (expression.includes("Object.keys(f)"))
          return { result: { value: authenticated ? [] : ["code"] } };
        if (expression.includes("Boolean(document"))
          return { result: { value: authenticated } };
        if (expression.includes("const names="))
          return { result: { value: { code: 1 } } };
        if (expression.includes("HTMLFormElement.prototype.requestSubmit.call"))
          authenticated = typed.at(-1) === "654321";
        return { result: { value: true } };
      }
      return {};
    },
  };
  const engine = new ConnectorEngine({
    owner: "123",
    store: {
      get: async (key) => structuredClone(rows.get(key)),
      set: async (key, value) => {
        rows.set(key, structuredClone(value));
      },
      list: async (prefix) =>
        [...rows]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => structuredClone(value)),
    },
    fetch: async () => {
      throw Error("No provider network");
    },
    onEvent: async (event) => {
      await host.commitRoot(host.self("user-123"), event);
    },
    loginOperationGuard: (id, input) =>
      guardLoginOperationInput("123", host, id, input),
    secureBrowser: {
      native: true,
      begin: async () => ({
        authorizationUrl: "https://signin.aiko.com/fixture",
      }),
      status: async (binding) =>
        state?.status === "connected"
          ? {
              ...binding,
              status: "connected",
              verification: {
                verified: true,
                revision: state.revision,
                expiresAt: state.expiresAt,
              },
            }
          : { ...binding, status: "pending" },
      control: async (binding, input, signal) => {
        signal?.throwIfAborted();
        actions.push(input.action);
        if (statusUnavailable && input.action === "status")
          throw Error("Private status unavailable");
        return nativeLogin(
          {
            ...input,
            connectionId: binding.connectionId,
            domain: binding.domain,
          },
          {
            cdp,
            read: () => state,
            save: (next) => {
              state = structuredClone(next);
            },
            verified: async () => true,
          },
        );
      },
    },
  });
  const login = hostedLoginOperation(
    "123",
    () => host,
    () => engine,
  );
  // Use the production authorization/control binding, with an isolated continuation receipt.
  let resumed = 0;
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [
      loginOperationComponent({
        ...login,
        nativeHandoff: false,
        resume: async () => {
          resumed++;
        },
      }),
    ],
  });
  const open = () =>
    createBunHost({
      database: join(directory, "actor.sqlite"),
      actorName: "aiko",
      actorInstance: "private-login-tools",
      actorFor: () => definition,
      layersFor: () => Layer.empty,
    });
  let host = await open();
  await host.commitRoot(host.self("user-123"), {
    type: "MessageReceived",
    id: "turn",
    source: "telegram",
    chat: "123",
    sender: "123",
    text: "Sign in to service.net",
    at: Date.now(),
  });
  const connection = await engine.connectBrowser("service.net");
  const binding: ActorConnectorBinding = {
    owner: "123",
    thread: "user-123",
    engine,
    deliverConnection: async () => ({ status: "delivered" }),
  };
  const run = (
    action: string,
    args: Record<string, unknown> = {},
    callId = action,
  ): Promise<any> =>
    Effect.runPromise(
      createActorLoginTools(binding, login)
        .find((t) => t.spec.name === `connector_login_${action}`)!
        .run(
          { connectionId: connection.id, ...args },
          { callId, turn: "turn", signal: new AbortController().signal },
        )
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            instance: "private-login-tools",
            thread: "user-123",
          }),
          Effect.provideService(EventLog, {
            read: Effect.promise(() => host.read("user-123")),
            head: Effect.promise(
              async () => (await host.read("user-123")).length,
            ),
            readFrom: (n) =>
              Effect.promise(async () =>
                (await host.read("user-123")).slice(n),
              ),
            append: (items) =>
              Effect.promise(async () => {
                for (const event of items)
                  await host.commitRoot(host.self("user-123"), event);
              }),
          }),
        ),
    );
  return {
    engine,
    run,
    connection,
    state: () => state!,
    actions,
    typed,
    targets,
    resumed: () => resumed,
    events: () => host.read("user-123"),
    unavailable: () => {
      statusUnavailable = true;
    },
    drive: () => host.wake("user-123"),
    restart: async () => {
      await host.close();
      host = await open();
      await host.wake("user-123");
    },
    close: async () => {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const order of ["ui-first", "chat-first"] as const)
  test(`${order}: actual controller preserves the attempt/challenge across chat, UI and host restart`, async () => {
    const f = await joinedPrivateLogin();
    try {
      const first =
        order === "ui-first"
          ? await f.engine.nativeControl(f.connection.id, { action: "form" })
          : undefined;
      const started = await f.run("start");
      expect(started.status).toBe("requested");
      if (first) expect(started.attemptId).toBe(first.attemptId);
      await f.drive();
      const challenge = structuredClone(f.state().challenge),
        targetId = f.state().targetId;
      expect(challenge).toBeDefined();
      if (first) expect(challenge).toEqual(first.challenge);
      const form = await f.engine.nativeControl(f.connection.id, {
        action: "form",
      });
      expect(form.attemptId).toBe(started.attemptId);
      expect(form.challenge).toEqual(challenge);
      expect(
        (await f.run("advance", { attemptId: started.attemptId })).fields,
      ).toEqual(["code"]);
      await f.restart();
      expect(f.state().attemptId).toBe(started.attemptId);
      expect(f.state().challenge).toEqual(challenge);
      expect(f.state().targetId).toBe(targetId);
      expect(f.targets.size).toBe(1);
      // Private UI submission still passes the actual host challenge guard after adoption.
      await f.engine.nativeControl(f.connection.id, {
        action: "credentials",
        attemptId: started.attemptId,
        challengeId: challenge!.id,
        expectedRevision: challenge!.revision,
        submissionId: crypto.randomUUID(),
        code: "654321",
      });
      await f.drive();
      expect((await f.run("status")).operation.status).toBe("connected");
      expect(f.resumed()).toBe(1);
      expect(f.typed).toEqual(["654321"]);
      await f.restart();
      expect(f.resumed()).toBe(1);
      expect(JSON.stringify(await f.events())).not.toContain("654321");
      expect(JSON.stringify(await f.events())).not.toContain("SECRET_COOKIE");
    } finally {
      await f.close();
    }
  });

test("a UI attempt opened after chat admission is held by the real begin guard without replacing its challenge", async () => {
  const f = await joinedPrivateLogin();
  try {
    const started = await f.run("start");
    const ui = await f.engine.nativeControl(f.connection.id, {
      action: "form",
    });
    expect(ui.attemptId).not.toBe(started.attemptId);
    await f.drive();
    expect(f.state().attemptId).toBe(ui.attemptId);
    expect(f.state().challenge).toEqual(ui.challenge);
    expect(f.actions).not.toContain("begin");
    expect((await f.run("status")).operation.status).not.toBe("connected");
    expect(f.resumed()).toBe(0);
  } finally {
    await f.close();
  }
});

test("unavailable private status prevents begin dispatch in the real connector guard", async () => {
  const f = await joinedPrivateLogin();
  try {
    await f.run("start");
    f.unavailable();
    await f.drive();
    expect(f.actions).toEqual(["status"]);
    expect(f.targets.size).toBe(0);
    expect(f.resumed()).toBe(0);
  } finally {
    await f.close();
  }
});

test("chat can inspect and cancel a standalone UI attempt without creating a login operation", async () => {
  const f = await joinedPrivateLogin();
  try {
    const form = await f.engine.nativeControl(f.connection.id, {
      action: "form",
    });
    expect((await f.run("status")).privateAttempt.attemptId).toBe(
      form.attemptId,
    );
    expect(
      (await f.run("cancel", { attemptId: crypto.randomUUID() })).reason,
    ).toBe("stale_login_attempt");
    expect(await f.run("cancel", { attemptId: form.attemptId })).toMatchObject({
      status: "cancelled",
      cleanup: "cleaned",
    });
    expect(f.state().status).toBe("disconnected");
    expect(f.targets.size).toBe(0);
    expect(
      (await f.events()).filter(
        (e) => e.type === "AikoLoginOperationRequested",
      ),
    ).toHaveLength(0);
    expect(f.resumed()).toBe(0);
  } finally {
    await f.close();
  }
});
