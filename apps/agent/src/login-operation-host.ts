import type { Event } from "tardie/core/event";
import type { ConnectorEngine } from "./connectors.ts";
import {
  loginObservationEvent,
  loginUuid,
  type NativeLoginObservation,
} from "./native-login-observation.ts";
import type { NativeLoginInput } from "./native-login.ts";
import { boundedText } from "./security.ts";
import {
  cancelLoginOperation,
  loginOperationExternalEventAllowed,
  loginOperationState,
  requestLoginOperation,
  type LoginOperationBinding,
} from "./login-operation.ts";

export interface LoginOperationHost {
  self(thread: string): string;
  read(thread: string): Promise<readonly Event[]>;
  commitRoot(address: string, event: Event): Promise<void>;
}
const originalAllowed = (events: readonly Event[], id: string) =>
  events.some(
    (e) =>
      e.type === "MessageReceived" && e.id === id && typeof e.text === "string",
  ) &&
  !events.some(
    (e) =>
      e.type === "CancellationRequested" && (e.invocation as any)?.id === id,
  );
/** Authority is resolved from the current owned connector and durable original task,
 * never from a candidate origin, caller-supplied owner, revision, or contract. */
export function hostedLoginOperation(
  owner: string,
  host: () => LoginOperationHost,
  engine: () => ConnectorEngine,
): LoginOperationBinding {
  const thread = `user-${owner}`;
  return {
    owner,
    thread,
    nativeHandoff: true,
    control: (input, signal) => engine().loginOperationControl(input, signal),
    authorize: async (operation, signal) => {
      if (
        operation.owner !== owner ||
        operation.thread !== thread ||
        operation.contractRef !== "native-login-session-v1"
      )
        return false;
      const events = await host().read(thread);
      if (!originalAllowed(events, operation.continuationId)) return false;
      const context = await engine().loginOperationContext(
        operation.connectionId,
      );
      if (
        context.domain !== operation.domain ||
        context.status === "disconnected"
      )
        return false;
      if (operation.status === "connected") {
        if (
          context.status !== "connected" ||
          context.revision !== operation.verifiedRevision
        )
          return false;
        const current = await engine().loginOperationControl(
          {
            action: "status",
            connectionId: operation.connectionId,
            domain: operation.domain,
            attemptId: operation.attemptId,
          },
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
        return (
          current.status === "connected" &&
          current.revision === operation.verifiedRevision &&
          current.expiresAt > Date.now()
        );
      }
      return true;
    },
  };
}
/** Runs inside the connector's existing owner mutation queue immediately before
 * private work. Standalone private panel logins retain their prior behavior. */
export async function guardLoginOperationInput(
  owner: string,
  host: LoginOperationHost,
  id: string,
  input: Partial<NativeLoginInput>,
) {
  const operations = [
    ...loginOperationState(
      await host.read(`user-${owner}`),
      owner,
      `user-${owner}`,
    ).values(),
  ].filter((r) => r.connectionId === id);
  const operation = input.attemptId
    ? operations.find((r) => r.attemptId === input.attemptId)
    : operations.at(-1);
  if (!operation) return;
  if (
    ["status", "disconnect"].includes(String(input.action)) ||
    (operation.status === "connected" &&
      ["form", "view", "finish"].includes(String(input.action)))
  )
    return;
  if (
    ["connected", "cancelled", "expired"].includes(operation.status) ||
    operation.expiresAt <= Date.now() ||
    (operation.challengeExpiresAt !== undefined &&
      operation.challengeExpiresAt <= Date.now())
  )
    throw Error("Stale login operation");
  if (
    input.code !== undefined &&
    (input.attemptId !== operation.attemptId ||
      input.challengeId !== operation.challengeId ||
      input.expectedRevision !== operation.challengeRevision)
  )
    throw Error("Stale login challenge");
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
/** Only metadata is admitted. Private credentials remain at /api/connectors/native.
 * start: {operationId,connectionId,continuationId,expiresInMs?}; cancel: {operationId}.
 * Repeating cancel explicitly reconciles uncertain private cleanup.
 * continuationId must already name a task in this owner's native account journal.
 */
export async function loginOperationApi(
  request: Request,
  owner: string,
  host: LoginOperationHost,
  engine: ConnectorEngine,
  principal: { owner: string; scopes: readonly string[] },
  wake: () => void,
): Promise<Response> {
  if (
    principal.owner !== owner ||
    !principal.scopes.includes(request.method === "GET" ? "read" : "write")
  )
    return json({ error: "forbidden" }, 403);
  const url = new URL(request.url),
    path = url.pathname.replace(/^\/(?:api|v1)\/login-operations\/?/, ""),
    thread = `user-${owner}`;
  if (url.search) return json({ error: "invalid_query" }, 400);
  if (request.method === "GET" && path === "")
    return json({
      operations: [
        ...loginOperationState(await host.read(thread), owner, thread).values(),
      ],
    });
  if (request.method !== "POST" || !["start", "cancel"].includes(path))
    return json({ error: "not_found" }, 404);
  try {
    const body = JSON.parse(
      await boundedText(new Response(request.body), 2048),
    );
    const keys =
      path === "start"
        ? ["operationId", "connectionId", "continuationId", "expiresInMs"]
        : ["operationId"];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !keys.includes(k)) ||
      typeof body.operationId !== "string"
    )
      return json({ error: "invalid_login_operation" }, 400);
    const events = await host.read(thread),
      records = loginOperationState(events, owner, thread),
      prior = records.get(body.operationId);
    if (path === "cancel") {
      if (!prior) return json({ error: "not_found" }, 404);
      if (prior.cleanupOutcome === "unknown") {
        const generation = (prior.cleanupAttempts ?? 0) + 1;
        await host.commitRoot(host.self(thread), {
          type: "AikoLoginOperationCleanupRequested",
          id: `${prior.operationId}:${generation}`,
          owner,
          connectionId: prior.connectionId,
          attemptId: prior.attemptId,
          generation,
          at: Date.now(),
        });
      } else
        await host.commitRoot(host.self(thread), cancelLoginOperation(prior));
      wake();
      return json({ status: "recorded", operationId: prior.operationId }, 202);
    }
    if (prior) {
      if (
        prior.connectionId !== body.connectionId ||
        prior.continuationId !== body.continuationId
      )
        return json({ error: "login_operation_conflict" }, 409);
      wake();
      return json(
        {
          status: prior.status,
          operationId: prior.operationId,
          attemptId: prior.attemptId,
        },
        202,
      );
    }
    if (!originalAllowed(events, body.continuationId))
      return json({ error: "original_task_unavailable" }, 409);
    if (
      [...records.values()].some(
        (r) =>
          r.connectionId === body.connectionId &&
          (!["connected", "expired", "cancelled"].includes(r.status) ||
            r.cleanupOutcome === "unknown"),
      )
    )
      return json({ error: "login_operation_conflict" }, 409);
    const ttl = body.expiresInMs ?? 600000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 1800000)
      return json({ error: "invalid_deadline" }, 400);
    const context = await engine.loginOperationContext(body.connectionId);
    if (context.status !== "pending")
      return json({ error: "connection_not_pending" }, 409);
    const operation = {
      owner,
      thread,
      operationId: body.operationId,
      connectionId: body.connectionId,
      domain: context.domain,
      attemptId: crypto.randomUUID(),
      expectedRevision: context.revision,
      expiresAt: Date.now() + ttl,
      continuationId: body.continuationId,
      contractRef: "native-login-session-v1",
    };
    await host.commitRoot(host.self(thread), requestLoginOperation(operation));
    wake();
    return json(
      {
        status: "recorded",
        operationId: operation.operationId,
        attemptId: operation.attemptId,
      },
      202,
    );
  } catch {
    return json({ error: "login_operation_unavailable" }, 409);
  }
}

/** VM/browser adapters may report observations, but cannot mint host verification,
 * continuation, cancellation or deadline receipts. Keep the status compatibility
 * callback narrowly allowlisted too. */
export function loginRuntimeEvent(owner: string, event: Event): Event {
  if (event.type === "AikoPrivateLoginObserved") {
    if (event.owner !== owner) throw Error("Private login owner mismatch");
    return loginObservationEvent(
      owner,
      event as unknown as NativeLoginObservation,
    );
  }
  if (event.type === "AikoNativeLoginStatus") {
    if (
      event.owner !== owner ||
      !loginUuid(event.connectionId) ||
      typeof event.id !== "string" ||
      !Number.isSafeInteger(event.at)
    )
      throw Error("Invalid login status");
    return {
      type: event.type,
      id: event.id,
      owner,
      connectionId: event.connectionId,
      at: event.at,
    };
  }
  if (!loginOperationExternalEventAllowed(event))
    throw Error("Reserved login event");
  return event;
}
