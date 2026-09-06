import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
import { executeHarnessAction, type HarnessJsonValue, type HarnessSessionAdapter, type HarnessTraceEvent, type HarnessTransport, type HarnessTransportRequest, type HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
import { networkToolDigest } from "@unbrowse/browser-harness/network-tool-catalog";
import { validateNoSecrets } from "entity-learn/cloudflare";
import { publicAddress, publicTarget } from "./browser-proxy.ts";
import { executableObservedReads, ownedObservedActions } from "./capability-builder-network.ts";
import { artifact } from "./request-memory.ts";
import { validateRouterInput } from "./connector-router-host.ts";
import type { CapabilityBuilderBinding } from "./capability-builder.ts";
import { actionApprovalEventKey, createActionApprovals } from "./action-approval.ts";
import type { UnlockSessionGrant } from "./unlock-session.ts";
import { sha256 } from "@unbrowse/browser-harness/har";

export interface ObservedNetworkBinding extends CapabilityBuilderBinding {
  /** Test/host override. Production uses pinned public DNS. */
  send?: HarnessTransport["send"];
  /** Host-only vault session. Cookies never appear in tool arguments or receipts. Accepts a static grant (host-pinned material) or a resolver that fetches fresh vault cookies. */
  session?: UnlockSessionGrant | ((origin: string, signal: AbortSignal) => Promise<UnlockSessionGrant | undefined>);
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export function observedActionEventKey(event: Event) {
  if (event.type === "AikoObservedActionStarted" && typeof event.owner === "string" && typeof event.key === "string")
    return `aiko-observed-action:${event.owner}:${event.key}`;
  return actionApprovalEventKey(event);
}

export async function sendObservedHttp(
  request: HarnessTransportRequest,
  signal: AbortSignal,
): Promise<HarnessTransportResponse> {
  const url = publicTarget(request.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Public HTTP(S) host required");
  if (WRITE.has(request.method) && url.protocol !== "https:") throw new Error("Writes require HTTPS");
  const incoming = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (incoming.cookie || incoming.authorization) throw new Error("Artifacts cannot carry credentials");
  signal.throwIfAborted();
  const address = await publicAddress(url.hostname);
  const bodyText = request.body === undefined || request.method === "GET" || request.method === "HEAD"
    ? undefined
    : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  const headers: Record<string, string> = {
    "user-agent": "Aiko/1.0 (observed-network)",
    accept: incoming.accept ?? "application/json,text/plain,text/html",
    "accept-encoding": "identity",
    ...(incoming["content-type"] ? { "content-type": incoming["content-type"] } : bodyText ? { "content-type": "application/json" } : {}),
  };
  return await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url.toString(),
      {
        method: request.method,
        family: 4,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const headersOut: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string" && key.toLowerCase() !== "set-cookie") headersOut[key.toLowerCase()] = value;
        }
        // Raw Set-Cookie lines for the runtime's recompute jar; values never enter receipts.
        const setCookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"].slice(0, 32) : [];
        if (request.method === "HEAD" || (status >= 300 && status < 400)) {
          response.resume();
          resolve({ status, headers: headersOut, ...(setCookies.length ? { setCookies } : {}), classification: "application" });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) {
            response.destroy();
            reject(new Error("Observed response exceeds byte budget"));
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const type = headersOut["content-type"] ?? "";
          let body: HarnessJsonValue | undefined;
          if (text) {
            if (/application\/json/i.test(type)) {
              try { body = JSON.parse(text) as HarnessJsonValue; }
              catch { reject(new Error("Invalid JSON response")); return; }
            } else body = text.slice(0, 12000);
          }
          resolve({ status, headers: headersOut, ...(setCookies.length ? { setCookies } : {}), ...(body === undefined ? {} : { body }), classification: "application" });
        });
        response.on("error", () => reject(new Error("Observed request interrupted")));
      },
    );
    req.on("error", () => reject(new Error("Observed request failed")));
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

/** Manual-redirect GET/HEAD. No cookies, ambient auth, or automatic hop following. */
export async function sendPublicHarnessRequest(
  request: HarnessTransportRequest,
  signal: AbortSignal,
): Promise<HarnessTransportResponse> {
  if (!["GET", "HEAD"].includes(request.method)) throw new Error("Read-only replay");
  if (request.body !== undefined) throw new Error("Observed host replay cannot carry bodies");
  return sendObservedHttp(request, signal);
}

async function executeArtifact(
  artifactValue: Parameters<typeof executeHarnessAction>[0]["artifact"],
  actionId: string,
  inputs: Record<string, HarnessJsonValue>,
  send: HarnessTransport["send"],
  signal: AbortSignal,
  session?: HarnessSessionAdapter,
) {
  let terminal: HarnessJsonValue | undefined;
  const result = await executeHarnessAction({
    artifact: artifactValue,
    actionId,
    input: inputs,
    adapters: {
      clock: { now: () => new Date() },
      uuid: { next: () => crypto.randomUUID() },
      ...(session ? { session } : {}),
      transport: {
        send: async (request) => {
          signal.throwIfAborted();
          publicTarget(request.url);
          const response = await send(request);
          signal.throwIfAborted();
          terminal = response.body;
          return response;
        },
      },
    },
  });
  return { result, terminal };
}

/** Value-free recompute counts from an execution trace; names only, never values. */
function recomputeCounts(trace: readonly HarnessTraceEvent[]) {
  let sessions = 0, cookieEvents = 0;
  const cookieNames = new Set<string>(), headerNames = new Set<string>();
  for (const event of trace) {
    if (event.type === "session_resolved") {
      sessions++;
      for (const name of event.cookieNames) cookieNames.add(name);
      for (const name of event.injectedHeaderNames) if (name !== "cookie") headerNames.add(name);
    } else if (event.type === "cookie_recomputed") {
      cookieEvents++;
      for (const name of event.cookieNames) cookieNames.add(name);
    }
  }
  return { sessions, cookieEvents, cookieNames: [...cookieNames].sort(), headerNames: [...headerNames].sort() };
}

export function createObservedNetworkTools(binding: ObservedNetworkBinding): NativeTool<Self | EventLog>[] {
  const approvals = createActionApprovals({ owner: binding.owner, thread: binding.thread });
  return [{
    spec: {
      name: "observed_network_run",
      description: "Execute a Merkle-backed learned request DAG over host HTTP without starting a browser. Public GET/HEAD run immediately. Session-bound calls use the owner's current Unlock vault cookies, never stored passwords. POST/PUT/PATCH/DELETE require a prior owner approval (approvalId+hash) and are never retried if the outcome is unknown.",
      inputSchema: {
        type: "object",
        properties: {
          toolDigest: { type: "string" },
          artifactDigest: { type: "string" },
          inputs: { type: "object" },
          approvalId: { type: "string" },
          hash: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    run: (input, context) => Effect.gen(function* () {
      const self = yield* Self;
      const log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread)
        return { status: "rejected", reason: "owner_binding_mismatch" };
      const events = yield* log.read;
      const args = !input || typeof input !== "object" || Array.isArray(input) ? undefined : input as Record<string, unknown>;
      try {
        if (!args || Object.keys(args).some(k => !["toolDigest", "artifactDigest", "inputs", "approvalId", "hash"].includes(k)))
          throw new Error("Invalid arguments");
        validateRouterInput(args);
        const inputs = args.inputs === undefined ? {} : args.inputs;
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Invalid inputs");
        validateNoSecrets(inputs);
        if (binding.redact(JSON.stringify(inputs)) !== JSON.stringify(inputs)) throw new Error("Secret in inputs");
        const typedInputs = inputs as Record<string, HarnessJsonValue>;
        const read = typeof args.toolDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(args.toolDigest)
          ? executableObservedReads(events).find(e => e.toolDigest === args.toolDigest)
          : undefined;
        const action = typeof args.artifactDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(args.artifactDigest)
          ? ownedObservedActions(events).find(e => e.artifactDigest === args.artifactDigest)
          : undefined;
        if (!read && !action) throw new Error("Owned Merkle DAG is not an executable learned skill");
        const origins = [...new Set((read ? read.definition.steps.map(s => s.origin) : action!.artifact.actions.flatMap(a => a.steps.map(s => s.origin))))];
        for (const origin of origins) {
          if (!(yield* Effect.promise(() => Promise.resolve(binding.checkArcade?.(new URL(origin).hostname) ?? true)))) throw new Error("Arcade provider not confirmed absent");
        }
        const write = action?.effect === "write";
        const sessionNeeded = action?.sessionRequired === true;
        const identity = write ? `observed:${action!.artifactDigest}:${context.turn}:${context.callId}` : undefined;
        if (write && events.some(e => e.type === "AikoObservedActionStarted" && e.owner === binding.owner && e.key === identity))
          return { status: "unknown", reason: "Prior write attempt may have completed; inspect the app before retrying" };
        let grant: UnlockSessionGrant | undefined;
        if (sessionNeeded) {
          const source = binding.session;
          if (!source) throw new Error("Unlock session is unavailable");
          grant = typeof source === "function"
            ? yield* Effect.promise(() => source(origins[0]!, context.signal))
            : source;
          if (!grant?.cookies.length) throw new Error("Unlock session is unavailable");
          for (const origin of origins) {
            const host = new URL(origin).hostname;
            if (!grant.domains.some(d => host === d || host.endsWith(`.${d}`))) throw new Error("Unlock session does not cover this origin");
          }
          // Value-free lifecycle events: the session that backed this run, and whether the
          // vault had to re-mint it from the stored password server-side.
          yield* log.append([
            ...(grant.renewed ? [{ type: "AikoUnlockSessionRenewed", owner: binding.owner, connectionId: grant.connectionId, revision: grant.revision, domain: new URL(origins[0]!).hostname, at: Date.now() }] : []),
            { type: "AikoObservedSessionResolved", owner: binding.owner, connectionId: grant.connectionId, revision: grant.revision, domain: new URL(origins[0]!).hostname, cookies: grant.cookies.length, renewed: grant.renewed === true, at: Date.now() },
          ]);
        }
        const sessionAdapter: HarnessSessionAdapter | undefined = grant ? {
          resolve: origin => ({ origin, cookies: grant.cookies, revision: grant.revision }),
        } : undefined;
        const send: HarnessTransport["send"] = async request => {
          if (binding.send) return binding.send(request);
          return sendObservedHttp(request, context.signal);
        };
        const run = async () => {
          if (read) {
            if (networkToolDigest(read.definition) !== read.toolDigest) throw new Error("Digest mismatch");
            return executeArtifact(artifact(read.definition), read.actionId, typedInputs, send, context.signal, sessionAdapter);
          }
          const target = action!.artifact.actions.find(a => a.id === action!.actionId) ?? action!.artifact.actions[0];
          if (!target) throw new Error("Action missing");
          return executeArtifact(action!.artifact, target.id, typedInputs, send, context.signal, sessionAdapter);
        };
        if (write) {
          const approvalId = `observed-${action!.artifactDigest.slice(7, 23)}-${sha256(JSON.stringify(typedInputs)).slice(7, 23)}`;
          if (typeof args.approvalId !== "string" || typeof args.hash !== "string") {
            const prepared = yield* approvals.prepare({
              id: approvalId,
              operation: "observed_network_run",
              connectionId: grant?.connectionId ?? "unlock-session",
              connectionRevision: grant?.revision ?? "none",
              expiresAt: Date.now() + 10 * 60_000,
              payload: { artifactDigest: action!.artifactDigest, merkle: action!.importDigest, inputs: typedInputs as never },
            });
            return {
              status: "authorization_required",
              approvalId: prepared.prepared.id,
              hash: prepared.prepared.hash,
              effect: "write",
              browser: false,
              text: "Owner approval is required before replaying this learned write. POST /v1/observed-actions/approval with id, hash and decision, then retry observed_network_run with approvalId and hash. This is not an execution.",
            };
          }
          const current = yield* approvals.get(args.approvalId);
          if (!current || current.prepared.hash !== args.hash || current.prepared.operation !== "observed_network_run")
            throw new Error("Approval not found");
          const stored = current.prepared.payload as { inputs?: Record<string, HarnessJsonValue> };
          yield* log.append([{ type: "AikoObservedActionStarted", owner: binding.owner, key: identity, artifactDigest: action!.artifactDigest, at: Date.now() }]);
          let writeTrace: readonly HarnessTraceEvent[] = [];
          const settled = yield* approvals.dispatch({
            id: current.prepared.id,
            hash: current.prepared.hash,
            payload: current.prepared.payload,
            connectionId: current.prepared.connectionId,
            connectionRevision: current.prepared.connectionRevision,
          }, () => Effect.tryPromise(async () => {
            const executed = await executeArtifact(action!.artifact, (action!.artifact.actions.find(a => a.id === action!.actionId) ?? action!.artifact.actions[0])!.id, stored.inputs ?? {}, send, context.signal, sessionAdapter);
            writeTrace = executed.result.trace;
            return executed.result.status === "completed" ? "succeeded" as const : "failed" as const;
          }));
          const writeCounts = recomputeCounts(writeTrace);
          if (writeCounts.sessions || writeCounts.cookieEvents)
            yield* log.append([{ type: "AikoObservedHeadersRecomputed", owner: binding.owner, artifactDigest: action!.artifactDigest, ...writeCounts, at: Date.now() }]);
          if (settled.state === "unknown")
            return { status: "unknown", reason: "Write outcome is uncertain; inspect the app and do not retry automatically", browser: false };
          if (settled.state !== "settled")
            return { status: "rejected", reason: `Write was not dispatched (${settled.state})`, browser: false };
          return {
            kind: "observed-network-receipt",
            owner: binding.owner,
            artifactDigest: action!.artifactDigest,
            merkle: action!.importDigest,
            status: settled.outcome === "succeeded" ? "completed" : "failed",
            effect: "write",
            browser: false,
            session: sessionNeeded,
            text: settled.outcome === "succeeded"
              ? "Learned write replayed over host HTTPS using the current Unlock session. Receipt is not proof the remote business action succeeded."
              : "Learned write did not complete. Do not retry automatically.",
          };
        }
        const executed = yield* Effect.promise(() => run());
        const counts = recomputeCounts(executed.result.trace);
        if (counts.sessions || counts.cookieEvents)
          yield* log.append([{ type: "AikoObservedHeadersRecomputed", owner: binding.owner, ...(read ? { toolDigest: read.toolDigest } : { artifactDigest: action!.artifactDigest }), ...counts, at: Date.now() }]);
        const text = executed.terminal === undefined ? "" : binding.redact(JSON.stringify(executed.terminal)).slice(0, 12000);
        if (text && binding.redact(text) !== text) throw new Error("Secret in observed response");
        return {
          kind: "observed-network-receipt",
          owner: binding.owner,
          ...(read ? { toolDigest: read.toolDigest, toolId: read.toolId, merkle: read.sourceTraceDigest } : { artifactDigest: action!.artifactDigest, merkle: action!.importDigest }),
          status: executed.result.status,
          code: executed.result.code,
          counts: executed.result.counts,
          effect: "read",
          browser: false,
          session: sessionNeeded,
          text: executed.result.status === "completed"
            ? `Learned DAG replayed over host HTTP${sessionNeeded ? " with the current Unlock session" : ""}, not the browser.\n${text}`
            : "Learned DAG did not complete. Do not treat this as a successful action.",
        };
      } catch {
        return { status: "rejected", reason: "Learned Merkle DAG could not be authorized or executed; passwords were not used and the browser was not started" };
      }
    }).pipe(Effect.catchCause(() => Effect.succeed({ status: "rejected" as const, reason: "Approval flow failed; nothing was dispatched" }))),
  }];
}
