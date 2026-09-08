import { request as httpsRequest } from "node:https";
import { request as httpRequest, validateHeaderName, validateHeaderValue } from "node:http";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
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
import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { isAllowedHarnessHeaderName } from "@unbrowse/browser-harness/harness-artifact";
import { cookieHeader } from "./unlock-session.ts";

export interface ObservedNetworkBinding extends CapabilityBuilderBinding {
  /** Trusted parent consent journal for a scoped native worker; never supplied in tool arguments. */
  approvalJournal?: {thread:string;read():Promise<readonly Event[]>;append(events:readonly Event[]):Promise<void>};
  /** Test/host override. Production uses pinned public DNS. */
  send?: HarnessTransport["send"];
  /** Host-only vault session. Cookies never appear in tool arguments or receipts. Accepts a static grant (host-pinned material) or a resolver that fetches fresh vault cookies. */
  session?: UnlockSessionGrant | ((origin: string, signal: AbortSignal) => Promise<UnlockSessionGrant | undefined>);
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Host transport dependencies. Overrides do not bypass URL or public DNS admission. */
export interface ObservedHttpOptions {
  lookup?: (hostname: string) => Promise<string[]>;
  request?: typeof httpRequest;
  /** Trusted runner callback after all asynchronous preparation, before a socket
   * is opened. These exact prepared bytes cannot be changed by the callback. */
  beforeDispatch?: (request: ObservedHttpDispatch) => void | Promise<void>;
  onDispatch?: () => void;
}
export interface ObservedHttpDispatch {
  url: string;
  method: string;
  address: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

function dispatchHeaders(input: Readonly<Record<string, string>>, authenticated: boolean) {
  const result: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const credential = name === "cookie" || name === "authorization";
    if (Object.hasOwn(result, name) || typeof value !== "string" ||
      !(credential ? authenticated : isAllowedHarnessHeaderName(name)))
      throw new Error("Unsafe observed dispatch headers");
    try { validateHeaderName(name); validateHeaderValue(name, value); }
    catch { throw new Error("Unsafe observed dispatch headers"); }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 16384) throw new Error("Observed dispatch headers exceed byte budget");
    result[name] = value;
  }
  return result;
}
/** Value-free anti-bot refusal signatures. A challenge means the origin's edge never
 * reached the application; host replay must not be retried and the browser session
 * actor (real fingerprint) is the designed route for such origins. */
const CHALLENGE_STATUS = new Set([403, 429, 503]);
const CHALLENGE_HEADER = /^(?:cf-mitigated|x-datadome(?:-status|-captcha)?|x-px-[a-z0-9-]+|x-akamai-[a-z0-9-]+|x-kpsdk-[a-z0-9-]+|x-kasada|x-f5-[a-z0-9-]+|x-bm-telemetry|x-perimeterx-[a-z0-9-]+)$/i;
const challengedResponse = (response: HarnessTransportResponse): { status: number; headerNames: readonly string[] } | undefined => {
  if (!CHALLENGE_STATUS.has(response.status)) return undefined;
  const names = Object.keys(response.headers);
  const flagged = names.some(name => CHALLENGE_HEADER.test(name) ||
    (name === "server" && /cloudflare|akamaighost|datadome/i.test(String(response.headers[name]))));
  return flagged ? { status: response.status, headerNames: names.sort() } : undefined;
};
export function observedActionEventKey(event: Event) {
  if (["AikoNetworkRequestStarted", "AikoNetworkRequestSettled"].includes(event.type) && typeof event.id === "string")
    return `aiko-observed-action:${event.type}:${event.id}`;
  if (event.type === "AikoObservedActionStarted" && typeof event.owner === "string" && typeof event.key === "string")
    return `aiko-observed-action:${event.owner}:${event.key}`;
  return actionApprovalEventKey(event);
}

export async function sendObservedHttp(
  request: HarnessTransportRequest,
  signal: AbortSignal,
  options: ObservedHttpOptions = {},
): Promise<HarnessTransportResponse> {
  request = structuredClone(request);
  const url = publicTarget(request.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Public HTTP(S) host required");
  if (WRITE.has(request.method) && url.protocol !== "https:") throw new Error("Writes require HTTPS");
  if (request.redirect !== "manual") throw new Error("Observed redirects must be manual");
  // Artifact validation already rejects captured credentials. At this boundary,
  // headers include trusted, freshly resolved session and response-derived values.
  const incoming = dispatchHeaders(request.headers, url.protocol === "https:");
  signal.throwIfAborted();
  const address = await publicAddress(url.hostname, options.lookup);
  signal.throwIfAborted();
  const bodyText = request.body === undefined || request.method === "GET" || request.method === "HEAD"
    ? undefined
    : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  const headers: Record<string, string> = {
    ...incoming,
    "user-agent": "Aiko/1.0 (observed-network)",
    accept: incoming.accept ?? "application/json,text/plain,text/html",
    "accept-encoding": "identity",
    ...(incoming["content-type"] ? { "content-type": incoming["content-type"] } : bodyText ? { "content-type": "application/json" } : {}),
  };
  await options.beforeDispatch?.(Object.freeze({ url: url.href, method: request.method, address,
    headers: Object.freeze({ ...headers }), ...(bodyText === undefined ? {} : { body: bodyText }) }));
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    options.onDispatch?.();
    const req = (options.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest))(
      url.toString(),
      {
        method: request.method,
        family: 4,
        // The permit binds this DNS-selected address. A pooled connection could
        // otherwise reuse a different earlier resolution for the same hostname.
        agent: false,
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
  if (Object.keys(request.headers).some(name => /^(?:cookie|authorization)$/i.test(name)))
    throw new Error("Public replay cannot carry credentials");
  return sendObservedHttp(request, signal);
}

const cookieKey = (cookie: { name: string; domain: string; path?: string }) =>
  JSON.stringify([cookie.name, cookie.domain.replace(/^\./, "").toLowerCase(), cookie.path ?? "/"]);
const coversHost = (domains: readonly string[], hostname: string) =>
  domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookieValue = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Admit runtime jar updates and mask replaced/deleted base cookies. Values are
 * passed directly back to the native jar; only scope keys remain in this set. */
function sessionResponse(response: HarnessTransportResponse, url: URL, grant: UnlockSessionGrant, replaced: Set<string>): HarnessTransportResponse {
  const lines = response.setCookies ?? (response.headers["set-cookie"] ? [response.headers["set-cookie"]] : []);
  const setCookies: string[] = [];
  for (const line of lines.slice(0, 32)) {
    if (line.length > 4096 || /[\u0000\r\n]/.test(line)) continue;
    const parts = line.split(";");
    const pair = parts.shift()!.trim();
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (separator <= 0 || !cookieName.test(name) || !cookieValue.test(value)) continue;
    let domain = url.hostname, path = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/", valid = true;
    for (const attribute of parts) {
      const [rawName, rawValue = ""] = attribute.split("=");
      if (rawName!.trim().toLowerCase() === "domain") {
        domain = rawValue.trim().replace(/^\./, "").toLowerCase();
        if (!domain || !coversHost([domain], url.hostname) || !coversHost(grant.domains, domain)) valid = false;
      } else if (rawName!.trim().toLowerCase() === "path" && rawValue.trim().startsWith("/")) path = rawValue.trim();
    }
    if (!valid) continue;
    replaced.add(cookieKey({ name, domain, path }));
    setCookies.push(line);
  }
  const headers = { ...response.headers };
  delete headers["set-cookie"];
  return { ...response, headers, setCookies };
}

function sessionRequest(request: HarnessTransportRequest, grant: UnlockSessionGrant, origins: readonly string[], replaced: Set<string>): HarnessTransportRequest {
  const url = publicTarget(request.url);
  if (url.protocol !== "https:" || !origins.includes(url.origin) || !coversHost(grant.domains, url.hostname))
    throw new Error("Unlock session does not cover this request");
  const available = grant.cookies.filter(cookie => !replaced.has(cookieKey(cookie)) &&
    (cookie.expires === -1 || cookie.expires * 1000 > Date.now()));
  if (available.some(cookie => !cookieName.test(cookie.name) || !cookieValue.test(cookie.value)))
    throw new Error("Invalid session cookie");
  const base = cookieHeader(url, available);
  const merged = new Map<string, string>();
  // Native runtime cookies are already scoped by its run jar; they override base
  // material only after the actual request URL has selected the vault cookies.
  for (const pair of [base, request.headers.cookie ?? ""].flatMap(header => header.split(";"))) {
    if (!pair.trim()) continue;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1).trim();
    if (separator <= 0 || !cookieName.test(name) || !cookieValue.test(value)) throw new Error("Invalid session cookie");
    merged.set(name, value);
  }
  const headers = { ...request.headers };
  delete headers.cookie;
  if (merged.size) headers.cookie = [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
  return { ...request, headers };
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

export interface ObservedReadContract {
  digest: string;
  generation: string;
  stepIds: string[];
  inputs: { name: string; type: string; required: boolean }[];
  /** Selected response processing runs in host memory; this method returns no bodies. */
  execute(inputs: Record<string, HarnessJsonValue>, consume: (stepId: string, body: HarnessJsonValue | undefined) => void, signal: AbortSignal, budget: { maxCalls: number; maxBytes: number }): Promise<{ calls: number; bytes: number }>;
}

/** Owner-held structural catalog. Listing never fetches a source or renews a session. */
export async function listObservedReads(binding: ObservedNetworkBinding) {
  const events = await binding.readEvents?.() ?? [];
  const reads = executableObservedReads(events).map(row => ({ sourceId: row.toolDigest, contractDigest: row.toolDigest, stepIds: row.definition.steps.map(step => step.id), inputs: row.definition.inputs.map(input => ({ name: input.name, type: input.type, required: input.required })), sessionRequired: false }));
  const actions = ownedObservedActions(events).filter(row => row.effect === "read").flatMap(row => {
    const target = row.artifact.actions.find(action => action.id === row.actionId);
    return target ? [{ sourceId: row.artifactDigest, contractDigest: row.artifactDigest, stepIds: target.steps.map(step => step.id), inputs: target.inputs.map(input => ({ name: input.name, type: input.type, required: input.required })), sessionRequired: row.sessionRequired }] : [];
  });
  const items = [...reads, ...actions];
  return { items: items.slice(0, 64), coverage: items.length > 64 ? "partial" : "complete", requiresAuthorization: true };
}

/** The database uses the same learned contracts, URL checks and session transport
 * as observed_network_run. Resolving a contract never executes a source request. */
export interface ObservedReadRevision {
  graph: import("@unbrowse/browser-harness/harness-artifact").SiteHarnessArtifact;
  actionId: string;
  /** Trusted host authority for these exact authored bytes and fresh inputs. */
  authorize(input: Record<string, HarnessJsonValue>, signal: AbortSignal): Promise<boolean>;
  /** Test/private transport override must await the fence at physical dispatch. */
  send?(request: HarnessTransportRequest, signal: AbortSignal, beforeDispatch: () => Promise<void>): Promise<HarnessTransportResponse>;
}
export async function resolveObservedRead(binding: ObservedNetworkBinding, digest: string, signal: AbortSignal, revision?: ObservedReadRevision): Promise<ObservedReadContract> {
  if (revision) revision = { ...revision, graph: structuredClone(revision.graph) };
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !binding.readEvents) throw Error("Owned read contract unavailable");
  signal.throwIfAborted();
  const events = await binding.readEvents();
  const read = executableObservedReads(events).find(row => row.toolDigest === digest);
  const action = ownedObservedActions(events).find(row => row.artifactDigest === digest && row.effect === "read");
  if (!read && !action) throw Error("Owned read contract unavailable");
  const source = read ? artifact(read.definition) : action!.artifact;
  const sourceTarget = source.actions.find(row => row.id === (read?.actionId ?? action!.actionId));
  if (!sourceTarget) throw Error("Owned read action unavailable");
  const definition = revision ? (await import("@unbrowse/browser-harness/harness-artifact")).validateSiteHarnessArtifact(structuredClone(revision.graph)) : source;
  const target = definition.actions.find(row => row.id === (revision?.actionId ?? sourceTarget.id));
  if (revision && (definition.actions.length !== 1 || definition.sourceCaptureDigest !== source.sourceCaptureDigest ||
    definition.allowedOrigins.some(origin => !source.allowedOrigins.includes(origin)))) throw Error("Authored request cannot widen source or credential scope");
  if (!target || target.steps.some(step => !["GET", "HEAD"].includes(step.method))) throw Error("Read contract required");
  const origins = [...new Set(target.steps.map(step => step.origin))];
  if (revision && origins.some(origin => !sourceTarget.steps.some(step => step.origin === origin))) throw Error("Authored request origin outside source");
  if (revision && binding.send && !revision.send) throw Error("Revised read requires guarded transport");
  for (const origin of origins) if (!await binding.checkArcade?.(new URL(origin).hostname)) throw Error("Source authority unavailable");
  const grant = action?.sessionRequired ? typeof binding.session === "function" ? await binding.session(origins[0]!, signal) : binding.session : undefined;
  if (action?.sessionRequired && (!grant?.cookies.length || !origins.every(origin => coversHost(grant.domains, new URL(origin).hostname)))) throw Error("Source session unavailable");
  const generation = grant ? `${grant.connectionId}:${grant.revision}` : "public";
  return {
    digest, generation, stepIds: target.steps.map(step => step.id),
    inputs: target.inputs.map(input => ({ name: input.name, type: input.type, required: input.required })),
    execute: async (inputs, consume, requestSignal, budget) => {
      validateRouterInput(inputs); validateNoSecrets(inputs);
      if (binding.redact(JSON.stringify(inputs)) !== JSON.stringify(inputs)) throw Error("Secret in source inputs");
      // A resolver may obtain current vault material, but never implicitly renews
      // or logs it. Re-resolve before dispatch and compare the exact generation.
      const current = await resolveObservedRead(binding, digest, requestSignal, revision);
      if (current.generation !== generation) throw Error("Source generation changed");
      const beforeDispatch = async () => {
        requestSignal.throwIfAborted();
        if ((await resolveObservedRead(binding, digest, requestSignal, revision)).generation !== generation) throw Error("Source generation changed");
        if (revision && !await revision.authorize(structuredClone(inputs), requestSignal)) throw Error("Authored request authority unavailable");
        if (revision && (await resolveObservedRead(binding, digest, requestSignal, revision)).generation !== generation) throw Error("Source generation changed during authority check");
        requestSignal.throwIfAborted();
      };
      await beforeDispatch();
      let calls = 0, bytes = 0;
      const replaced = new Set<string>();
      const result = await executeHarnessAction({ artifact: definition, actionId: target.id, input: inputs, adapters: {
        clock: { now: () => new Date() }, uuid: { next: () => crypto.randomUUID() },
        ...(grant ? { session: { resolve: (origin: string) => ({ origin, cookies: [], revision: grant.revision }) } } : {}),
        transport: { send: async request => {
          requestSignal.throwIfAborted(); publicTarget(request.url);
          if ((await resolveObservedRead(binding, digest, requestSignal, revision)).generation !== generation) throw Error("Source generation changed");
          if (!origins.includes(new URL(request.url).origin) || !["GET", "HEAD"].includes(request.method) || ++calls > budget.maxCalls) throw Error("Source call budget exceeded");
          const dispatched = grant ? sessionRequest(request, grant, origins, replaced) : request;
          const received = revision?.send ? await revision.send(dispatched, requestSignal, beforeDispatch)
            : binding.send ? await binding.send(dispatched) : await sendObservedHttp(dispatched, requestSignal, { beforeDispatch });
          requestSignal.throwIfAborted();
          const response = grant ? sessionResponse(received, new URL(request.url), grant, replaced) : received;
          bytes += new TextEncoder().encode(JSON.stringify(response.body ?? null)).length;
          if (bytes > budget.maxBytes || challengedResponse(response)) throw Error("Source response unavailable or over budget");
          consume(request.stepId, response.body);
          return response;
        } },
      } });
      requestSignal.throwIfAborted();
      if (result.status !== "completed") throw Error(`Source read did not complete: ${result.code ?? "unknown"}`);
      if ((await resolveObservedRead(binding, digest, requestSignal, revision)).generation !== generation) throw Error("Source generation changed");
      return { calls, bytes };
    },
  };
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
  if(binding.approvalJournal&&binding.approvalJournal.thread!==`user-${binding.owner}`)throw Error("Foreign worker approval journal");
  const approvals = createActionApprovals({ owner: binding.owner, thread: binding.approvalJournal?.thread??binding.thread });
  const consent=<A,E>(io:Effect.Effect<A,E,EventLog>)=>binding.approvalJournal?io.pipe(Effect.provideService(EventLog,withWatermark({read:Effect.promise(binding.approvalJournal.read),append:events=>Effect.promise(()=>binding.approvalJournal!.append(events))}))):io;
  return [{
    authorizeRetained:async (input:unknown)=>{
      if(!binding.readEvents)return false;
      const args=input&&typeof input==="object"&&!Array.isArray(input)?input as Record<string,unknown>:undefined;
      if(!args||(typeof args.toolDigest==="string")===(typeof args.artifactDigest==="string"))return false;
      const events=await binding.readEvents();
      const read=executableObservedReads(events).find(row=>row.toolDigest===args.toolDigest);
      const action=ownedObservedActions(events).find(row=>row.artifactDigest===args.artifactDigest);
      if(!read&&!action)return false;
      const origins=read?.definition.steps.map(step=>step.origin)??action!.artifact.actions.flatMap(action=>action.steps.map(step=>step.origin));
      for(const origin of origins)if(!await binding.checkArcade?.(new URL(origin).hostname))return false;
      if(action?.sessionRequired){
        const grant=typeof binding.session==="function"?await binding.session(origins[0]!,AbortSignal.timeout(10000)):binding.session;
        if(!grant?.cookies.length||!origins.every(origin=>coversHost(grant.domains,new URL(origin).hostname)))return false;
      }
      return true;
    },
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
    run: (input, context) => Effect.suspend(() => {
      let dispatchMayHaveStarted = false;
      return Effect.gen(function* () {
      const self = yield* Self;
      const log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread)
        return { status: "rejected", reason: "owner_binding_mismatch" };
      const events = yield* log.read;
      const args = !input || typeof input !== "object" || Array.isArray(input) ? undefined : input as Record<string, unknown>;
      try {
        if (!args || Object.keys(args).some(k => !["toolDigest", "artifactDigest", "inputs", "approvalId", "hash"].includes(k)))
          throw new Error("Invalid arguments");
        if((typeof args.toolDigest==="string")===(typeof args.artifactDigest==="string"))throw new Error("Exactly one learned definition is required");
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
        const priorAttempt = write && events.find(e => e.type === "AikoObservedActionStarted" && e.owner === binding.owner && e.key === identity);
        if (priorAttempt) {
          const prior = typeof priorAttempt.approvalId === "string" ? yield* consent(approvals.get(priorAttempt.approvalId)) : undefined;
          if (prior) {
            const stored = prior.prepared.payload as { inputs?: Record<string, HarnessJsonValue> };
            if (canonicalStringify(stored.inputs ?? {}) !== canonicalStringify(typedInputs) ||
              typeof args.approvalId === "string" && (args.approvalId !== prior.prepared.id || args.hash !== prior.prepared.hash))
              throw Error("Invocation already bound to another approved payload");
            if (prior.state === "settled") return { kind: "observed-network-receipt", status: prior.outcome === "succeeded" ? "completed" : "failed",
              approvalId: prior.prepared.id, hash: prior.prepared.hash, effect: "write", browser: false,
              text: "Original durable receipt; no new request was sent. Receipt is not proof the remote business action succeeded." };
          }
          return { status: "unknown", reason: "Prior write attempt may have completed; inspect the app before retrying" };
        }
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
          // The native base-material merge is not URL scoped. Select vault cookies
          // at host dispatch instead; retain the native response-cookie jar.
          resolve: origin => ({ origin, cookies: [], revision: grant.revision }),
        } : undefined;
        const replacedCookies = new Set<string>();
        let challenge: { status: number; headerNames: readonly string[] } | undefined;
        const definitionDigest = read?.toolDigest ?? action!.artifactDigest;
        const send: HarnessTransport["send"] = async request => {
          if (grant) request = sessionRequest(request, grant, origins, replacedCookies);
          const id = crypto.randomUUID();
          const requestDigest = sha256(canonicalStringify({owner:binding.owner,definitionDigest,step:request.stepId,method:request.method,url:request.url,body:request.body ?? null,revision:grant?.revision ?? null}));
          const metadata = {id,owner:binding.owner,definitionDigest,requestDigest,method:request.method};
          await Effect.runPromise(log.append([{type:"AikoNetworkRequestStarted",...metadata,at:Date.now()}]));
          const received = binding.send ? await binding.send(request) : await sendObservedHttp(request, context.signal);
          const response = grant ? sessionResponse(received, new URL(request.url), grant, replacedCookies) : received;
          challenge ??= challengedResponse(response);
          const responseDigest = sha256(canonicalStringify({owner:binding.owner,status:response.status,body:response.body ?? null}));
          const previous = events.findLast(e=>e.type==="AikoNetworkRequestSettled"&&e.owner===binding.owner&&e.requestDigest===requestDigest);
          await Effect.runPromise(log.append([{type:"AikoNetworkRequestSettled",...metadata,status:response.status,responseDigest,
            changed:previous ? previous.responseDigest!==responseDigest : null,at:Date.now()}]));
          return response;
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
          // A preparation belongs to a native invocation, not to an action forever.
          // Replay keeps that consent; a later explicit request needs fresh consent.
          const approvalId = `observed-${sha256(canonicalStringify([binding.owner, binding.thread, context.turn, context.callId])).slice(7)}`;
          if (typeof args.approvalId !== "string" || typeof args.hash !== "string") {
            const previous = yield* consent(approvals.get(approvalId));
            const preparation = {
              id: approvalId,
              operation: "observed_network_run",
              connectionId: grant?.connectionId ?? "unlock-session",
              connectionRevision: grant?.revision ?? "none",
              expiresAt: previous?.prepared.expiresAt ?? Date.now() + 10 * 60_000,
              payload: { artifactDigest: action!.artifactDigest, merkle: action!.importDigest, inputs: typedInputs as never },
            };
            const matches = (row: NonNullable<typeof previous>) => row.prepared.operation === preparation.operation &&
              row.prepared.connectionId === preparation.connectionId && row.prepared.connectionRevision === preparation.connectionRevision &&
              canonicalStringify(row.prepared.payload) === canonicalStringify(preparation.payload);
            if (previous && !matches(previous)) throw Error("Invocation already bound to another action");
            // Expired and consumed preparations still replay their original identity.
            // Concurrent prepares select the journal's winner, never a new expiry.
            const prepared = previous ?? (yield* consent(approvals.prepare(preparation)).pipe(Effect.catch(error =>
              consent(approvals.get(approvalId)).pipe(Effect.flatMap(row => row && matches(row) ? Effect.succeed(row) : Effect.fail(error))))));
            if (!["pending", "approved"].includes(prepared.state)) return {
              status: ["unknown", "dispatched"].includes(prepared.state) ? "unknown" : prepared.state === "settled" ? (prepared.outcome === "succeeded" ? "completed" : "failed") : "rejected",
              approvalId: prepared.prepared.id, hash: prepared.prepared.hash, approvalState: prepared.state, effect: "write", browser: false,
              text: "This is the original consent record, not a new execution. It cannot be reused. Inspect existing receipts before preparing a new owner intent.",
            };
            return {
              status: "authorization_required",
              approvalId: prepared.prepared.id,
              hash: prepared.prepared.hash,
              effect: "write",
              browser: false,
              text: "Owner approval is required before replaying this learned write. POST /v1/observed-actions/approval with id, hash and decision, then retry observed_network_run with approvalId and hash. This is not an execution.",
            };
          }
          const current = yield* consent(approvals.get(args.approvalId));
          if (!current || current.prepared.hash !== args.hash || current.prepared.operation !== "observed_network_run")
            throw new Error("Approval not found");
          const stored = current.prepared.payload as { artifactDigest?:string;merkle?:string;inputs?: Record<string, HarnessJsonValue> };
          if(stored.artifactDigest!==action!.artifactDigest||stored.merkle!==action!.importDigest||canonicalStringify(stored.inputs??{})!==canonicalStringify(typedInputs)||current.prepared.connectionId!==(grant?.connectionId??"unlock-session")||current.prepared.connectionRevision!==(grant?.revision??"none"))throw Error("Approval does not match this exact action, inputs and current connection");
          let writeTrace: readonly HarnessTraceEvent[] = [];
          const settled = yield* consent(approvals.dispatch({
            id: current.prepared.id,
            hash: current.prepared.hash,
            payload: current.prepared.payload,
            connectionId: current.prepared.connectionId,
            connectionRevision: current.prepared.connectionRevision,
          }, () => Effect.tryPromise(async () => {
            dispatchMayHaveStarted = true;
            const token = crypto.randomUUID();
            await Effect.runPromise(log.append([{ type: "AikoObservedActionStarted", owner: binding.owner, key: identity, token, approvalId: current.prepared.id, hash: current.prepared.hash, artifactDigest: action!.artifactDigest, at: Date.now() }]));
            const winner = (await Effect.runPromise(log.read)).find(e => e.type === "AikoObservedActionStarted" && e.owner === binding.owner && e.key === identity);
            if (winner?.token !== token) return "unknown" as const;
            context.signal.throwIfAborted();
            const executed = await executeArtifact(action!.artifact, (action!.artifact.actions.find(a => a.id === action!.actionId) ?? action!.artifact.actions[0])!.id, stored.inputs ?? {}, send, context.signal, sessionAdapter);
            writeTrace = executed.result.trace;
            // The harness converts transport exceptions into failed results. A
            // dispatched write without a response still has unknown effects.
            const ambiguous = writeTrace.some(sent => sent.type === "request_sent" &&
              !["GET", "HEAD", "OPTIONS"].includes(sent.method) &&
              (executed.result.status !== "completed" ||
                !writeTrace.some(received => received.type === "response_received" && received.requestIndex === sent.requestIndex)));
            // An error response (including 5xx) or a later failed DAG step cannot
            // prove that an earlier write had no effect. Keep that attempt consumed.
            return ambiguous ? "unknown" as const : executed.result.status === "completed" ? "succeeded" as const : "failed" as const;
          })));
          const writeCounts = recomputeCounts(writeTrace);
          if (writeCounts.sessions || writeCounts.cookieEvents)
            yield* log.append([{ type: "AikoObservedHeadersRecomputed", owner: binding.owner, artifactDigest: action!.artifactDigest, ...writeCounts, at: Date.now() }]);
          if (challenge)
            yield* log.append([{ type: "AikoObservedOriginChallenged", owner: binding.owner, origin: new URL(origins[0]!).hostname, status: challenge.status, headerNames: challenge.headerNames, at: Date.now() }]);
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
            ...(challenge ? { challenged: true } : {}),
            text: settled.outcome === "succeeded"
              ? challenge
                ? "Learned write replayed but the origin edge answered with an anti-bot challenge; the application likely never saw it. Inspect the app; never retry automatically."
                : "Learned write replayed over host HTTPS using the current Unlock session. Receipt is not proof the remote business action succeeded."
              : "Learned write did not complete. Do not retry automatically.",
          };
        }
        const executed = yield* Effect.promise(() => run());
        const counts = recomputeCounts(executed.result.trace);
        if (counts.sessions || counts.cookieEvents)
          yield* log.append([{ type: "AikoObservedHeadersRecomputed", owner: binding.owner, ...(read ? { toolDigest: read.toolDigest } : { artifactDigest: action!.artifactDigest }), ...counts, at: Date.now() }]);
        if (challenge)
          yield* log.append([{ type: "AikoObservedOriginChallenged", owner: binding.owner, origin: new URL(origins[0]!).hostname, status: challenge.status, headerNames: challenge.headerNames, at: Date.now() }]);
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
          ...(challenge ? { challenged: true } : {}),
          text: challenge
            ? "Origin answered with an anti-bot challenge; the application never saw this request. Host replay is not retried — route this action through the browser session actor."
            : executed.result.status === "completed"
            ? `Learned DAG replayed over host HTTP${sessionNeeded ? " with the current Unlock session" : ""}, not the browser.\n${text}`
            : "Learned DAG did not complete. Do not treat this as a successful action.",
        };
      } catch {
        return dispatchMayHaveStarted
          ? { status: "unknown", reason: "Write outcome is uncertain; inspect the app and do not retry automatically" }
          : { status: "rejected", reason: "Learned Merkle DAG could not be authorized or executed; passwords were not used and the browser was not started" };
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(dispatchMayHaveStarted
      ? { status: "unknown" as const, reason: "Write outcome is uncertain; inspect the app and do not retry automatically" }
      : { status: "rejected" as const, reason: "Approval flow failed before write dispatch" })));
    }),
  }];
}
