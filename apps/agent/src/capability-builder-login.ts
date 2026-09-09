import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { NativeTool } from "tardie/component/tool";
import type { Event } from "tardie/core/event";
import {
  fallbackLoginSpec,
  loginFields,
  LOGIN_UI_VERSION,
  type LoginLayout,
} from "../../../packages/protocol/src/login-ui.ts";
import {
  loginAssistanceMessage,
  loginAssistanceMethods,
  type LoginAssistanceMethod,
} from "../../../packages/protocol/src/login-assistance.ts";
import type { ActorConnectorBinding } from "./capability-builder-connectors.ts";
import {
  cancelLoginOperation,
  loginOperationState,
  requestLoginOperation,
  type LoginOperation,
  type LoginOperationBinding,
} from "./login-operation.ts";
import {
  loginObservationEvent,
  loginUuid,
  type NativeLoginObservation,
} from "./native-login-observation.ts";
import type { NativeLoginView } from "./native-login.ts";

/** Explicit projection: private browser output must never be spread into a tool result. */
export function agentLoginFields(view: NativeLoginView) {
  const fields =
    view.status === "pending" ? loginFields(view.fields) : undefined;
  const pageError = ["navigation_failed", "navigation_uncertain"].includes(
    view.pageError ?? "",
  )
    ? view.pageError
    : undefined;
  const approvalRequired =
    !!view.requiresOrigin || view.assistance?.status === "approval_required";
  const assistance = view.assistance;
  const spec =
    !pageError && !approvalRequired && fields?.length
      ? fallbackLoginSpec(fields)
      : undefined;
  return {
    ...(fields && !pageError && !approvalRequired ? { fields } : {}),
    ...(spec
      ? { layout: { version: LOGIN_UI_VERSION, source: "fallback", spec } }
      : {}),
    ...(pageError ? { pageError } : {}),
    ...(Array.isArray(view.providers) && view.providers.includes("google")
      ? { providers: ["google"] }
      : {}),
    approvalRequired,
    ...(assistance &&
    loginAssistanceMethods.includes(assistance.method) &&
    Object.hasOwn(loginAssistanceMessage, assistance.status)
      ? { assistance: { method: assistance.method, status: assistance.status } }
      : {}),
    credentialEntry: "private_ui",
  };
}

/** Adopt only trusted native receipts, never model arguments or page metadata.
 * Ambiguous, expired and unsettled attempts require private reconciliation.
 * The engine also checks the current private attempt at begin dispatch. */
function existingPrivateAttempt(
  events: readonly Event[],
  owner: string,
  connectionId: string,
) {
  const attempts = new Map<string, NativeLoginObservation>();
  const receipts = new Map<string, Event>();
  for (const event of events) {
    if (
      event.type !== "AikoPrivateLoginObserved" ||
      event.owner !== owner ||
      event.connectionId !== connectionId
    )
      continue;
    const receipt = loginObservationEvent(
      owner,
      event as unknown as NativeLoginObservation,
    ) as unknown as NativeLoginObservation;
    const id = `${receipt.attemptId}:${receipt.sequence}`;
    if (
      receipts.has(id) &&
      JSON.stringify(receipts.get(id)) !== JSON.stringify(receipt)
    )
      throw Error("Conflicting private login receipts");
    receipts.set(id, receipt as unknown as Event);
    const previous = attempts.get(receipt.attemptId);
    if (!previous || receipt.sequence > previous.sequence)
      attempts.set(receipt.attemptId, receipt);
  }
  const pending = [...attempts.values()].filter(
    (receipt) => receipt.kind !== "disconnected",
  );
  if (
    pending.length > 1 ||
    pending.some(
      (receipt) =>
        receipt.kind === "verified" || receipt.expiresAt <= Date.now(),
    )
  )
    throw Error("Reconcile the existing private sign-in first");
  const latest = pending[0];
  if (!latest) return;
  const history = [...receipts.values()]
    .filter((receipt) => receipt.attemptId === latest.attemptId)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  if (history.some((receipt, index) => receipt.sequence !== index + 1))
    throw Error("Incomplete private login receipts");
  return { latest, history };
}

const finished = (operation: LoginOperation) =>
  ["connected", "cancelled", "expired"].includes(operation.status);
function summary(operation: LoginOperation) {
  return {
    operationId: operation.operationId,
    connectionId: operation.connectionId,
    attemptId: operation.attemptId,
    status:
      !finished(operation) &&
      Math.min(operation.expiresAt, operation.challengeExpiresAt ?? Infinity) <=
        Date.now()
        ? "expired"
        : operation.status,
    expiresAt: operation.expiresAt,
    ...(["cancelled", "expired"].includes(operation.status)
      ? { cleanup: operation.cleanupOutcome ?? "pending" }
      : {}),
    credentialEntry: "private_ui",
  };
}

/** Generative layout for a tool response: the host renderer when mounted, the
 * validated catalog fallback otherwise. Presentation only; never blocks control. */
async function loginLayout(
  binding: ActorConnectorBinding,
  view: Pick<NativeLoginView, "status" | "fields" | "requiresOrigin" | "pageError">,
  signal: AbortSignal,
): Promise<{ layout: LoginLayout } | {}> {
  const fields = view.status === "pending" ? loginFields(view.fields) : undefined;
  if (!fields?.length) return {};
  try {
    const generated = binding.renderLogin
      ? await binding.renderLogin(
          { status: view.status, fields: view.fields, requiresOrigin: view.requiresOrigin, pageError: view.pageError },
          signal,
        )
      : undefined;
    if (generated) return { layout: generated };
  } catch {
    // Renderer failure is presentation loss only; control and fallback continue.
  }
  return { layout: { version: LOGIN_UI_VERSION, source: "fallback", spec: fallbackLoginSpec(fields)! } };
}

/** Owner-supplied values for the 1:1 injection wrapper. Strings only, bounded
 * like the private HTTP path; anything else is an invalid argument. */
function injectedLoginFields(value: unknown): Partial<Record<"username" | "password" | "code", string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed: Partial<Record<"username" | "password" | "code", string>> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined) continue;
    if (!(name === "username" || name === "password" || name === "code")) return undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return undefined;
    parsed[name as "username" | "password" | "code"] = raw;
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

/** These tools mount only beside the existing native login component. Owner-supplied
 * values travel once through the advance injection wrapper into the private page;
 * they are never returned, journaled or repeated after an uncertain outcome. Google
 * consent and new-origin approvals stay host-owned in the Sign in panel. */
export function createActorLoginTools(
  binding: ActorConnectorBinding,
  login: LoginOperationBinding,
): NativeTool<Self | EventLog>[] {
  const definitions = [
    [
      "start",
      "Start private sign-in for an existing pending connection from connector_recommend. Reuses an active login and queues its Sign in button. The owner enters credentials in that panel or supplies values for connector_login_advance to inject. Requested is not connected.",
    ],
    [
      "status",
      "Read passive connection and native login status without opening or renewing a browser. Use advance to inspect the current private form. Only connected means verified; cancelled may still await cleanup.",
    ],
    [
      "advance",
      "Inspect or complete the next sign-in step through the existing private controller. Returns observed field kinds and an inert JSON-render layout. With fields, injects the owner's own values 1:1 into the private page: pass exactly what the owner provided in their request (username, password, or the verification code for the displayed challenge); never invent, transform or guess values, and never repeat an uncertain submission. Google or email assistance and approvals stay in the Sign in panel. Native verification continues separately.",
    ],
    [
      "assist",
      "Start an assisted private sign-in for this attempt through the owner's connected Gmail when the owner explicitly asked for Google or email sign-in: pass the method (google, email_code, email_link) and the connected Gmail connectionId as sourceConnectionId. Google consent and new-origin approval stay in the Sign in panel; an agent cannot approve them.",
    ],
    [
      "cancel",
      "Cancel this pending native login attempt. Cancellation is recorded first; private cleanup may still be pending or unknown. Does not disconnect a completed connection.",
    ],
  ] as const;
  return definitions.map(([action, description]) => ({
    spec: {
      name: `connector_login_${action}`,
      description,
      inputSchema: {
        type: "object",
        properties: {
          connectionId: { type: "string" },
          ...(action === "advance" || action === "cancel" || action === "assist"
            ? {
                attemptId: {
                  type: "string",
                  description:
                    "Exact attemptId from login status/start; prevents controlling a replacement attempt.",
                },
              }
            : {}),
          ...(action === "advance"
            ? {
                fields: {
                  type: "object",
                  description:
                    "Owner-supplied values to inject 1:1 into the current private step. Pass only values the owner explicitly provided in their request, verbatim; never invent, transform or guess. Values are never returned or stored.",
                  properties: {
                    username: { type: "string", maxLength: 2048 },
                    password: { type: "string", maxLength: 2048 },
                    code: { type: "string", maxLength: 2048 },
                  },
                  additionalProperties: false,
                },
              }
            : {}),
          ...(action === "assist"
            ? {
                assistMethod: {
                  type: "string",
                  enum: [...loginAssistanceMethods],
                  description: "Assistance method the owner explicitly chose in their request.",
                },
                sourceConnectionId: {
                  type: "string",
                  description: "connectionId of the owner's connected Gmail.",
                },
              }
            : {}),
        },
        required: [
          "connectionId",
          ...(action === "advance" || action === "cancel" || action === "assist"
            ? ["attemptId"]
            : []),
          ...(action === "assist" ? ["assistMethod", "sourceConnectionId"] : []),
        ],
        additionalProperties: false,
      },
    },
    run: (input, context) =>
      Effect.gen(function* () {
        const self = yield* Self,
          log = yield* EventLog;
        if (
          self.actor !== "aiko" ||
          self.thread !== binding.thread ||
          login.owner !== binding.owner ||
          login.thread !== binding.thread ||
          binding.thread !== `user-${binding.owner}`
        )
          return { status: "rejected", reason: "owner_binding_mismatch" };
        const allowed =
          action === "advance"
            ? ["connectionId", "attemptId", "fields"]
            : action === "assist"
              ? ["connectionId", "attemptId", "assistMethod", "sourceConnectionId"]
              : action === "cancel"
                ? ["connectionId", "attemptId"]
                : ["connectionId"];
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => !allowed.includes(key))
        )
          return { status: "rejected", reason: "invalid_arguments" };
        const args = input as Record<string, unknown>;
        if (
          !loginUuid(args.connectionId) ||
          (allowed.includes("attemptId") && !loginUuid(args.attemptId)) ||
          (action === "assist" &&
            (!loginAssistanceMethods.includes(args.assistMethod as LoginAssistanceMethod) ||
              !loginUuid(args.sourceConnectionId)))
        )
          return { status: "rejected", reason: "invalid_arguments" };
        // Top-level credential keys stay rejected: values ride only in the
        // advance `fields` wrapper, never as bare arguments on any action.
        const injected = action === "advance" ? injectedLoginFields(args.fields) : undefined;
        if (action === "advance" && args.fields !== undefined && !injected)
          return { status: "rejected", reason: "invalid_arguments" };
        const connectionId = args.connectionId;
        const events = yield* log.read;
        const current = [...events]
          .reverse()
          .find((e) => e.type === "MessageReceived");
        if (
          action !== "status" &&
          (!current ||
            current.id !== context.turn ||
            current.source !== "telegram" ||
            String(current.chat) !== binding.owner ||
            String(current.sender) !== binding.owner ||
            typeof current.text !== "string" ||
            events.some(
              (e) =>
                e.type === "CancellationRequested" &&
                (e.invocation as { id?: string } | undefined)?.id ===
                  context.turn,
            ))
        )
          return {
            status: "rejected",
            reason: "current_owner_request_required",
          };
        if (
          !binding.engine.connectionSnapshot ||
          !binding.engine.loginOperationContext ||
          ((action === "assist" || (action === "advance" && injected)) &&
            !binding.engine.nativeControl)
        )
          return {
            status: "unavailable",
            message: "Use the Sign in panel to continue.",
          };
        const connection = yield* Effect.tryPromise(async () =>
          (await binding.engine.connectionSnapshot!()).find(
            (c) => c.id === connectionId && c.provider === "browser",
          ),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!connection)
          return { status: "rejected", reason: "connection_unavailable" };
        const records = [
          ...loginOperationState(
            events,
            binding.owner,
            binding.thread,
          ).values(),
        ].filter((r) => r.connectionId === connectionId);
        const operation = records.at(-1);
        if (action === "status") {
          const standalone =
            !operation && connection.status === "pending"
              ? existingPrivateAttempt(events, binding.owner, connectionId)
              : undefined;
          return {
            connectionId,
            connectionStatus: connection.status,
            ...(operation ? { operation: summary(operation) } : {}),
            ...(standalone
              ? {
                  privateAttempt: {
                    attemptId: standalone.latest.attemptId,
                    expiresAt: standalone.latest.expiresAt,
                  },
                  message:
                    "This sign-in was opened in the private panel. Start adopts it for ongoing chat control; cancel accepts this exact attemptId.",
                }
              : {}),
            credentialEntry: "private_ui",
          };
        }
        const key = `${context.turn}:${context.callId}`;
        if (
          action !== "cancel" &&
          events.some(
            (e) =>
              e.type === "AikoConnectorToolStarted" &&
              e.owner === binding.owner &&
              e.key === key,
          )
        )
          return {
            status: "unknown",
            message:
              "This step may have completed. Check login status or the private panel before continuing.",
          };
        if (action === "start") {
          if (
            operation &&
            (!finished(operation) ||
              (["cancelled", "expired"].includes(operation.status) &&
                !operation.cleaned))
          )
            return {
              ...summary(operation),
              message:
                "Continue this attempt in the Sign in panel; inspect uncertain cleanup before starting again.",
            };
          if (connection.status !== "pending")
            return { status: "rejected", reason: "connection_not_pending" };
          const owned = yield* Effect.tryPromise(() =>
            binding.engine.loginOperationContext!(connectionId),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (!owned || owned.status !== "pending")
            return { status: "rejected", reason: "connection_not_pending" };
          // A panel opened before chat control already owns its attempt and OTP
          // challenge. Reuse it; begin with a different ID would replace it.
          const existing = existingPrivateAttempt(
            yield* log.read,
            binding.owner,
            connectionId,
          );
          const event = requestLoginOperation({
            owner: binding.owner,
            thread: binding.thread,
            operationId: crypto.randomUUID(),
            connectionId,
            domain: owned.domain,
            attemptId: existing?.latest.attemptId ?? crypto.randomUUID(),
            expectedRevision: owned.revision,
            expiresAt: Math.min(
              Date.now() + 600_000,
              existing?.latest.expiresAt ?? Infinity,
            ),
            continuationId: context.turn!,
            contractRef: "native-login-session-v1",
          });
          // Replay existing metadata after admission so the same native projection
          // already knows the UI challenge; adoption does not reopen the page.
          yield* log.append([
            {
              type: "AikoConnectorToolStarted",
              owner: binding.owner,
              key,
              operation: "connector_login_start",
              at: Date.now(),
            },
            event,
            ...(existing?.history ?? []),
            {
              type: "AikoLoginRequested",
              owner: binding.owner,
              connectionId,
              at: Date.now(),
            },
          ]);
          return {
            status: "requested",
            connectionId,
            operationId: event.operationId,
            attemptId: event.attemptId,
            delivery: "queued",
            credentialEntry: "private_ui",
          };
        }
        if (!operation && action === "cancel") {
          const standalone = existingPrivateAttempt(
            events,
            binding.owner,
            connectionId,
          );
          if (
            !standalone ||
            standalone.latest.attemptId !== args.attemptId ||
            connection.status !== "pending"
          )
            return { status: "rejected", reason: "stale_login_attempt" };
          if (
            events.some(
              (e) =>
                e.type === "AikoConnectorToolStarted" &&
                e.owner === binding.owner &&
                e.key === key,
            )
          )
            return { status: "unknown", cleanup: "unknown" };
          const owned = yield* Effect.tryPromise(() =>
            binding.engine.loginOperationContext!(connectionId),
          );
          yield* log.append([
            {
              type: "AikoConnectorToolStarted",
              owner: binding.owner,
              key,
              operation: "connector_login_cancel",
              at: Date.now(),
            },
          ]);
          const view = yield* Effect.tryPromise(() =>
            login.control(
              {
                connectionId,
                domain: owned.domain,
                attemptId: standalone.latest.attemptId,
                action: "disconnect",
              },
              context.signal,
            ),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          return view?.attemptId === standalone.latest.attemptId &&
            view.status === "disconnected"
            ? {
                status: "cancelled",
                connectionId,
                attemptId: standalone.latest.attemptId,
                cleanup: "cleaned",
              }
            : {
                status: "unknown",
                cleanup: "unknown",
                message:
                  "Cancellation could not be confirmed. Inspect the private panel before continuing.",
              };
        }
        if (!operation || operation.attemptId !== args.attemptId)
          return { status: "rejected", reason: "stale_login_attempt" };
        if (action === "cancel") {
          if (finished(operation)) return summary(operation);
          yield* log.append([cancelLoginOperation(operation)]);
          return {
            ...summary(operation),
            status: "cancelled",
            cleanup: "pending",
          };
        }
        if (
          finished(operation) ||
          summary(operation).status === "expired" ||
          connection.status !== "pending"
        )
          return {
            ...summary(operation),
            message:
              "This attempt cannot advance. Check connection status or open the Sign in panel.",
          };
        // A form observation may continue an approved private assistance action.
        // Fence before dispatch and retain uncertainty even across replay/restart.
        const authorized = yield* Effect.tryPromise(() =>
          login.authorize(operation, context.signal),
        ).pipe(Effect.catch(() => Effect.succeed(false)));
        if (!authorized)
          return { status: "rejected", reason: "login_authority_unavailable" };
        yield* log.append([
          {
            type: "AikoConnectorToolStarted",
            owner: binding.owner,
            key,
            operation: `connector_login_${action}`,
            at: Date.now(),
          },
        ]);
        const view = yield* Effect.tryPromise(() =>
          action === "assist"
            ? binding.engine.nativeControl!(
                connectionId,
                {
                  action: "assist",
                  attemptId: operation.attemptId,
                  assistanceId: crypto.randomUUID(),
                  assistMethod: args.assistMethod as LoginAssistanceMethod,
                  sourceConnectionId: args.sourceConnectionId as string,
                },
                context.signal,
              )
            : login.control(
                {
                  connectionId,
                  domain: operation.domain,
                  attemptId: operation.attemptId,
                  action: "form",
                },
                context.signal,
              ),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!view || view.attemptId !== operation.attemptId)
          return {
            status: "unknown",
            message:
              "The private step could not be confirmed. Inspect login status or the Sign in panel; do not repeat input.",
          };
        const fresh = [
          ...loginOperationState(
            yield* log.read,
            binding.owner,
            binding.thread,
          ).values(),
        ]
          .filter((r) => r.connectionId === connectionId)
          .at(-1);
        if (
          !fresh ||
          fresh.attemptId !== operation.attemptId ||
          finished(fresh)
        )
          return { ...(fresh ? summary(fresh) : { status: "unknown" }) };
        if (action === "assist") {
          const assistance = view.assistance;
          return {
            ...summary(fresh),
            ...agentLoginFields(view),
            ...(yield* Effect.promise(() => loginLayout(binding, view, context.signal))),
            observedAt: Date.now(),
            ...(assistance && assistance.status in loginAssistanceMessage
              ? { assistanceMessage: loginAssistanceMessage[assistance.status] }
              : {}),
            message:
              "Assisted sign-in state was updated privately. Google consent and origin approvals stay in the Sign in panel.",
          };
        }
        const observed =
          view.status === "pending" ? loginFields(view.fields) : undefined;
        if (!injected)
          return {
            ...summary(fresh),
            ...agentLoginFields(view),
            ...(yield* Effect.promise(() => loginLayout(binding, view, context.signal))),
            observedAt: Date.now(),
            message:
              observed?.length
                ? `The private step asks for ${observed.join(" and ")}. Pass owner-supplied values as fields to inject them 1:1, or open the Sign in panel. Never guess or repeat an uncertain submission.`
                : "Use the Sign in panel for approvals. Never repeat an uncertain submission.",
          };
        // 1:1 injection wrapper. Only observed field kinds, the pinned attempt
        // and a server-generated submission identity are used; values are never
        // returned, journaled or re-dispatched after an uncertain outcome.
        if (
          !observed?.length ||
          view.pageError ||
          view.requiresOrigin ||
          agentLoginFields(view).approvalRequired
        )
          return {
            ...summary(fresh),
            ...agentLoginFields(view),
            message:
              "This step cannot accept injected values. Use the Sign in panel.",
          };
        const provided = (["username", "password", "code"] as const).filter(
          (name) => injected[name] !== undefined && observed.includes(name),
        );
        const ignored = (["username", "password", "code"] as const).filter(
          (name) => injected[name] !== undefined && !observed.includes(name),
        );
        if (!provided.length)
          return {
            ...summary(fresh),
            ...agentLoginFields(view),
            ...(yield* Effect.promise(() => loginLayout(binding, view, context.signal))),
            observedAt: Date.now(),
            message: `The current step asks for ${observed.join(" and ")}; ${ignored.join(", ")} is not part of it. Send the value this step asks for, or use the Sign in panel.`,
          };
        const automatic =
          !provided.includes("code") &&
          provided.includes("username") &&
          provided.includes("password");
        const stepValues: Partial<Record<"username" | "password" | "code", string>> = {};
        if (!automatic)
          for (const name of provided) stepValues[name] = injected[name]!;
        if (
          provided.includes("code") &&
          (!view.challenge || view.challenge.expiresAt <= Date.now())
        )
          return {
            ...summary(fresh),
            ...agentLoginFields(view),
            message:
              "Inspect the current step without fields first, then send the code shown for the displayed challenge.",
          };
        const submitted = yield* Effect.tryPromise(() =>
          binding.engine.nativeControl!(
            connectionId,
            {
              action: automatic ? "login" : "credentials",
              attemptId: operation.attemptId,
              ...(automatic
                ? { username: injected.username!, password: injected.password! }
                : stepValues),
              ...(provided.includes("code")
                ? {
                    challengeId: view.challenge!.id,
                    expectedRevision: view.challenge!.revision,
                    submissionId: crypto.randomUUID(),
                  }
                : {}),
            },
            context.signal,
          ),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!submitted || submitted.attemptId !== operation.attemptId)
          return {
            status: "unknown",
            message:
              "The injected values may or may not have been submitted. Check login status; never resend them.",
          };
        const settled = [
          ...loginOperationState(
            yield* log.read,
            binding.owner,
            binding.thread,
          ).values(),
        ]
          .filter((r) => r.connectionId === connectionId)
          .at(-1);
        return {
          ...(settled && settled.attemptId === operation.attemptId
            ? summary(settled)
            : summary(fresh)),
          ...agentLoginFields(submitted),
          ...(yield* Effect.promise(() => loginLayout(binding, view, context.signal))),
          injected: provided,
          observedAt: Date.now(),
          message:
            submitted.status === "connected"
              ? "The owner's values were submitted privately. Verification continues automatically."
              : "Values were injected 1:1 into the private step. Check status before any repeat; the Sign in panel stays available for verification and approvals.",
        };
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            status: "unknown",
            message:
              "Login control could not be confirmed. Check status in the Sign in panel.",
          }),
        ),
      ),
  }));
}
