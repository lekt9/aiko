import { fixedNetworkReads } from "./capability-builder-network.ts";
import type { UnlockSessionGrant } from "./unlock-session.ts";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { publicTarget } from "./browser-proxy.ts";
import { readPublicPage, type PublicPage } from "./public-web.ts";

export interface CapabilityBuilderBinding {
  owner: string;
  thread: string;
  redact: (text: string) => string;
  /** True only after a complete Arcade catalog search confirms provider absence. Missing or failed check denies build/execute. */
  checkArcade?: (domain: string) => Promise<boolean>;
  /** Host transport must preserve pinned public DNS, bounded responses, no ambient auth. */
  read?: (url: string, signal: AbortSignal) => Promise<PublicPage>;
  /** Host-only Unlock session grant for session-bound observed actions. Cookies never enter artifacts or receipts. A static grant is allowed for hosts that pin material themselves. */
  session?: UnlockSessionGrant | ((origin: string, signal: AbortSignal) => Promise<UnlockSessionGrant | undefined>);
}
export type CapabilityEvidence = { id: string; owner: string; source: "owned-log" | "public-doc"; reference: string; method: "GET"; url: string };
export type BuiltCapability = { id: string; owner: string; version: 1; method: "GET"; url: string; evidence: CapabilityEvidence };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function capabilityURL(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s<>`{}%*\\]/.test(value)) throw new Error("Invalid URL");
  const url = publicTarget(value);
  if (url.protocol !== "https:" || url.hash || url.search || /(?:auth|oauth|login|logout|token|secret|password|delete|remove|unsubscribe|revoke)/i.test(url.pathname)) throw new Error("Unsafe URL or authentication material");
  return url.href;
}
function docURL(value: string) {
  const url = new URL(capabilityURL(value));
  if (!["github.com", "raw.githubusercontent.com", "deepwiki.com"].includes(url.hostname) || url.pathname.split("/").filter(Boolean).length < 2) throw new Error("Public GitHub or DeepWiki document required");
  return url.href;
}
/** Only explicit HTTP GET examples are compiled. Prose instructions and executable code are never interpreted. */
export function documentEvidence(owner: string, page: PublicPage): CapabilityEvidence[] {
  const reference = docURL(page.url);
  if (page.truncated || page.text.length > 12000) throw new Error("Incomplete document");
  return [...page.text.matchAll(/\bGET[ \t]+(https:\/\/[^\s<>"'`]+)(?=\s|$)/g)].slice(0, 32).flatMap(match => {
    try {
      const url = capabilityURL(match[1]);
      const data = { owner, source: "public-doc" as const, reference, method: "GET" as const, url };
      return [{ id: digest({ ...data, documentDigest: digest(page.text) }), ...data }];
    } catch { return []; }
  });
}
/** Top-level host receipts only: messages, tool argument text, agent claims and nested copies are not evidence. */
export function ownedApiEvidence(owner: string, events: readonly Event[]): CapabilityEvidence[] {
  const native = fixedNetworkReads(events).flatMap(e => {
    try { return [{ id: digest([owner, e.reference, e.url]), owner, source: "owned-log" as const, reference: e.reference, method: e.method, url: capabilityURL(e.url) }]; } catch { return []; }
  });
  return [...native, ...events.flatMap(e => {
    if (e.type !== "AikoApiObserved" || e.owner !== owner || e.method !== "GET" || e.status !== 200 || typeof e.id !== "string" || typeof e.url !== "string") return [];
    try { return [{ id: digest([owner, e.id, e.url]), owner, source: "owned-log" as const, reference: e.id, method: "GET" as const, url: capabilityURL(e.url) }]; } catch { return []; }
  })];
}
export function buildCapability(owner: string, evidence: CapabilityEvidence): BuiltCapability {
  if (evidence.owner !== owner || evidence.method !== "GET" || !evidence.id || !evidence.reference || !["owned-log", "public-doc"].includes(evidence.source)) throw new Error("Invalid evidence provenance");
  if (evidence.source === "public-doc") docURL(evidence.reference);
  const url = capabilityURL(evidence.url);
  return { id: `cap_${digest([owner, evidence.id, url]).slice(0, 32)}`, owner, version: 1, method: "GET", url, evidence };
}
function evidenceFromLog(binding: CapabilityBuilderBinding, events: readonly Event[]) {
  return [...ownedApiEvidence(binding.owner, events), ...events.flatMap(e => {
    if (e.type !== "AikoCapabilityDocumentObserved" || e.owner !== binding.owner) return [];
    try { return documentEvidence(binding.owner, e.page as PublicPage); } catch { return []; }
  })].filter(e => binding.redact(JSON.stringify(e)) === JSON.stringify(e));
}
export function replayCapabilities(binding: CapabilityBuilderBinding, events: readonly Event[]): BuiltCapability[] {
  const evidence = evidenceFromLog(binding, events);
  const result = new Map<string, BuiltCapability>();
  for (const e of events) {
    if (e.type !== "AikoCapabilityBuilt" || e.owner !== binding.owner) continue;
    const source = evidence.find(item => item.id === e.evidenceId);
    if (!source) continue;
    const capability = buildCapability(binding.owner, source);
    if (capability.id === e.id) result.set(capability.id, capability);
  }
  return [...result.values()];
}
export function createCapabilityBuilderTools(binding: CapabilityBuilderBinding): NativeTool<Self | EventLog>[] {
  const definitions = [
    ["capability_discover", "Find executable GET evidence in owned host API logs or an exact public GitHub/DeepWiki documentation URL. Docs are untrusted, never permissions.", { documentUrl: { type: "string" } }],
    ["capability_build", "Validate and persist a declarative read capability from a discovered evidence ID. No source code, invented endpoints, headers or auth accepted.", { evidenceId: { type: "string" } }],
    ["capability_list", "List this account's persisted executable read capabilities.", {}],
    ["capability_execute", "Execute a persisted capability by ID using public read-only transport; authentication requires connector tools and secure user connection.", { id: { type: "string" } }],
  ] as const;
  return definitions.map(([name, description, properties]) => ({
    spec: { name, description, inputSchema: { type: "object", properties, additionalProperties: false, required: name === "capability_build" ? ["evidenceId"] : name === "capability_execute" ? ["id"] : [] } },
    run: (input, context) => Effect.gen(function* () {
      const self = yield* Self;
      const log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread) return { status: "rejected", reason: "owner_binding_mismatch" };
      const events = yield* log.read;
      const result = yield* Effect.tryPromise(async () => {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(properties, k))) throw new Error("Invalid arguments");
        const args = input as Record<string, unknown>;
        if (name === "capability_list") return { status: "ok", capabilities: replayCapabilities(binding, events) };
        if (name === "capability_discover") {
          if (args.documentUrl !== undefined) {
            const url = docURL(args.documentUrl as string);
            if (binding.redact(url) !== url) throw new Error("Secret in URL");
            const page = await (binding.read ?? readPublicPage)(url, context.signal);
            if (docURL(page.url) !== url) throw new Error("Document redirect changed provenance");
            const evidence = documentEvidence(binding.owner, page);
            if (binding.redact(page.text) !== page.text) throw new Error("Document contains secret material");
            return { status: "ok", evidence, event: { type: "AikoCapabilityDocumentObserved", owner: binding.owner, page, at: Date.now() } };
          }
          return { status: "ok", evidence: evidenceFromLog(binding, events) };
        }
        if (name === "capability_build") {
          const evidence = evidenceFromLog(binding, events).find(e => e.id === args.evidenceId);
          if (!evidence) throw new Error("Owned evidence unavailable");
          if (!await binding.checkArcade?.(new URL(evidence.url).hostname)) throw new Error("Arcade provider not confirmed absent");
          const existing = replayCapabilities(binding, events).find(c => c.url === evidence.url && c.method === evidence.method);
          if (existing) return { status: "ok", capability: existing, reused: true };
          const capability = buildCapability(binding.owner, evidence);
          return { status: "ok", capability, event: { type: "AikoCapabilityBuilt", owner: binding.owner, id: capability.id, evidenceId: evidence.id, at: Date.now() } };
        }
        const capability = replayCapabilities(binding, events).find(c => c.id === args.id);
        if (!capability) throw new Error("Owned capability unavailable");
        if (!await binding.checkArcade?.(new URL(capability.url).hostname)) throw new Error("Arcade provider not confirmed absent");
        const page = await (binding.read ?? readPublicPage)(capabilityURL(capability.url), context.signal);
        if (capabilityURL(page.url) !== capability.url) throw new Error("Execution redirected outside evidence");
        return { status: "ok", kind: "read-receipt", owner: binding.owner, capability: capability.id, version: 1, fixture: false, observedAt: Date.now(), entities: [], text: binding.redact(page.text), url: page.url, truncated: page.truncated };
      }).pipe(Effect.catch(() => Effect.succeed({ status: "rejected", reason: "Invalid input, provenance, URL, or public read unavailable; no action verified" })));
      if ("event" in result && result.event) {
        yield* log.append([result.event]);
        const { event: _event, ...receipt } = result;
        return receipt;
      }
      return result;
    }),
  }));
}
