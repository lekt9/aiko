import type { Composio } from "@composio/core";
import { createHash } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { connectorStorePrefix, type ConnectorStore } from "./connectors.ts";
import { DynamicToolDenied, type DynamicToolSession } from "./dynamic-tools.ts";
import { safeUserId, redactor } from "./security.ts";

export const integrationIdentity = (instance: string, owner: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instance) || !safeUserId(owner)) throw Error("Invalid integration owner");
  return `unlock_${createHash("sha256").update(JSON.stringify([instance, owner])).digest("hex")}`;
};
export const integrationStoreKey = (owner: string, identity: string, provider: string, revision: string) =>
  `${connectorStorePrefix(owner)}integration:${createHash("sha256").update(JSON.stringify([identity, provider, revision])).digest("hex")}`;
export const composioMetaTools = {
  COMPOSIO_SEARCH_TOOLS: "read",
  COMPOSIO_GET_TOOL_SCHEMAS: "read",
  COMPOSIO_MULTI_EXECUTE_TOOL: "read",
  // Authorization links are intercepted by the host, never returned to the model.
  COMPOSIO_MANAGE_CONNECTIONS: "write",
  COMPOSIO_WAIT_FOR_CONNECTIONS: "read",
} as const;

export async function composioClient(apiKey: string) {
  const { Composio } = await import("@composio/core");
  const sdk = new Composio({ apiKey, baseURL: "https://backend.composio.dev", allowTracking: false, disableVersionCheck: true,
    dangerouslyAllowAutoUploadDownloadFiles: false });
  const transport = sdk.getClient();
  transport.maxRetries = 0; // Native receipts, not SDK retries, own uncertain dispatch.
  transport.timeout = 60_000;
  transport.logLevel = "off";
  transport.fetchOptions = { redirect: "error" };
  return sdk;
}
type Session = Awaited<ReturnType<Composio["create"]>>;
export interface ComposioSessionOptions {
  owner: string;
  instance: string;
  apiKey: string;
  store: ConnectorStore;
  current(): boolean | Promise<boolean>;
  /** Must authenticate the CURRENT request before returning true. */
  canConnect(turn: string | undefined): Promise<boolean>;
  deliverLinks(links: string[], signal: AbortSignal): Promise<"delivered" | "unknown" | "rejected">;
  sdk?: Pick<Composio, "create" | "sessions" | "tools">;
}

/** SDK session identity and policy are host-owned. No caller can select a user,
 * session, connected account, auth config, remote sandbox or proxy credential. */
export async function composioSession(options: ComposioSessionOptions, signal: AbortSignal): Promise<DynamicToolSession> {
  const userId = integrationIdentity(options.instance, options.owner);
  const policy = { tags: ["readOnlyHint"], sandbox: { enable: false }, manageConnections: { enable: true } } as const;
  const revision = createHash("sha256").update(JSON.stringify([options.apiKey, policy])).digest("hex");
  const key = integrationStoreKey(options.owner, userId, "composio", revision);
  const current = async () => { signal.throwIfAborted(); if (!await options.current()) throw Error("Integration access revoked"); };
  await current();
  const sdk = options.sdk ?? await composioClient(options.apiKey);
  const stored = await options.store.get(key) as { owner?: string; userId?: string; sessionId?: string } | undefined;
  if (stored && (stored.owner !== options.owner || stored.userId !== userId || typeof stored.sessionId !== "string")) throw Error("Foreign Composio session record");
  // A deleted/invalid retained session is an error, not permission to create a
  // replacement and silently lose the old operation/connection lineage.
  let session: Session;
  try {
    session = stored
      ? await sdk.sessions.use(stored.sessionId!, undefined, { signal })
      : await sdk.create(userId, { ...policy, tags: [...policy.tags] }, { signal });
  } catch (error) { throw providerError(error); }
  await current();
  if (!stored) await options.store.set(key, { owner: options.owner, userId, sessionId: session.sessionId });
  return sessionAdapter(session, options, sdk);
}

function sessionAdapter(session: Session, options: ComposioSessionOptions, sdk: Pick<Composio, "tools">): DynamicToolSession {
  const redact = redactor([options.apiKey]);
  const check = async (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!await options.current()) throw Error("Integration access revoked"); };
  return {
    close: async () => {}, // Keep the durable provider session for the next turn/restart.
    listTools: async (_, request) => {
      await check(request?.signal);
      let tools: Awaited<ReturnType<Session["tools"]>>;
      try { tools = await session.tools(); } catch (error) { throw providerError(error); }
      await check(request?.signal);
      return { tools: tools.flatMap(t => {
        if (t.type !== "function" || !Object.hasOwn(composioMetaTools, t.function.name)) return [];
        if (!t.function.parameters) throw Error("Composio tool schema unavailable");
        const inputSchema = structuredClone(t.function.parameters);
        // Composio's workflow-correlation IDs are not model-selectable identity.
        const properties = { ...(inputSchema.properties as Record<string, unknown> ?? {}) };
        delete properties.session_id; delete properties.session;
        return [{ name: t.function.name, description: redact(t.function.description ?? "") + " Session identity/correlation is supplied privately by the host.",
          inputSchema: { ...inputSchema, properties, additionalProperties: false } }];
      }) };
    },
    callTool: async (input, _, request) => {
      const signal = request?.signal ?? AbortSignal.timeout(60_000);
      await check(signal);
      if (!Object.hasOwn(composioMetaTools, input.name)) throw new DynamicToolDenied("Composio meta tool is outside the grant");
      rejectIdentityOverrides(input.arguments);
      if (input.arguments && (Object.hasOwn(input.arguments, "session") || Object.hasOwn(input.arguments, "session_id"))) throw new DynamicToolDenied("Session context is host-bound");
      if (input.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
        const tools = input.arguments?.tools;
        if (!Array.isArray(tools) || !tools.length || tools.length > 8 || tools.some(t => typeof t?.tool_slug !== "string" || Object.hasOwn(composioMetaTools, t.tool_slug) || /^COMPOSIO_REMOTE_/.test(t.tool_slug))) throw new DynamicToolDenied("Use up to eight app calls, never nested meta tools");
        // A read grant is explicit host policy, not merely a planner suggestion.
        // Validate every inner tool, not just the multi-execute envelope. The
        // provider session independently applies its read-only scope/version.
        for (const call of tools) {
          const definition = await sdk.tools.getRawComposioToolBySlug(call.tool_slug).catch(error => { throw new DynamicToolDenied(providerError(error).message); });
          if (definition.slug !== call.tool_slug || !definition.toolkit || !definition.tags?.includes("readOnlyHint") || definition.tags.includes("destructiveHint") ||
            !definition.inputParameters || !new Validator(definition.inputParameters as any).validate(call.arguments).valid) throw new DynamicToolDenied("App tool is not a valid read-only call; rediscover its schema");
        }
        await check(signal);
      }
      if (input.name === "COMPOSIO_MANAGE_CONNECTIONS" && input.arguments?.reinitiate_all === true) throw new DynamicToolDenied("Reconnection can replace existing grants; disconnect explicitly first");
      if (input.name === "COMPOSIO_MANAGE_CONNECTIONS" && !await options.canConnect(typeof input._meta?.["aiko/native-turn"] === "string" ? input._meta["aiko/native-turn"] : undefined)) throw new DynamicToolDenied("Connect an app from your current private Telegram conversation");
      let result: Awaited<ReturnType<Session["execute"]>>;
      try { result = await session.execute(input.name, input.name === "COMPOSIO_SEARCH_TOOLS" ? { ...input.arguments, session: { generate_id: true } } : input.arguments); }
      catch (error) { throw providerError(error); }
      if (!result.logId || !/^[A-Za-z0-9_-]{1,128}$/.test(result.logId)) throw Error("Composio execution receipt unavailable; outcome unconfirmed");
      await check(signal);
      if (input.name === "COMPOSIO_MANAGE_CONNECTIONS") {
        const links = connectionLinks(result.data);
        const turn = typeof input._meta?.["aiko/native-turn"] === "string" ? input._meta["aiko/native-turn"] : undefined;
        if (links.length && !await options.canConnect(turn)) throw Error("Connection request changed; no link delivered");
        const delivery = links.length && !result.error ? await options.deliverLinks(links, signal) : undefined;
        return { isError: !!result.error, logId: result.logId,
          status: result.error ? "failed" : delivery ? "authorization_required" : "check_connection",
          ...(delivery ? { delivery } : {}),
          message: "Check connection state with COMPOSIO_SEARCH_TOOLS or COMPOSIO_WAIT_FOR_CONNECTIONS. A delivered sign-in link is not authorization." };
      }
      const data = result.data as Record<string, unknown> | undefined;
      const failed = !!result.error || data?.success === false || (typeof data?.error_count === "number" && data.error_count > 0);
      return { isError: failed, logId: result.logId, data: integrationResult(result.data, redact),
        ...(failed ? { error: "Composio tool failed; inspect its log ID and per-tool results" } : {}) };
    },
  };
}

function rejectIdentityOverrides(value: unknown, depth = 0): void {
  if (depth > 16) throw new DynamicToolDenied("Integration input nesting limit");
  if (Array.isArray(value)) { for (const item of value) rejectIdentityOverrides(item, depth + 1); return; }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if ((depth === 0 && /^(?:user_?id|entity_?id|session_?id|connected_?account_?id|auth_?config_?id|account|callback_?url|redirect_?url)$/i.test(key)) || /password|cookie|authorization|api_?key|credential|headers/i.test(key))
      throw new DynamicToolDenied("Identity and credentials are host-bound, not tool arguments");
    rejectIdentityOverrides(item, depth + 1);
  }
}
function providerError(error: unknown): Error {
  const e = error as { status?: unknown; headers?: Headers };
  const id = e?.headers?.get?.("x-request-id");
  return Error(`Composio request unavailable${typeof e?.status === "number" ? ` (HTTP ${e.status})` : ""}${id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `; request ${id}` : ""}. No automatic retry.`);
}
function connectionLinks(value: unknown): string[] {
  const links = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const text of v.match(/https:\/\/[^\s<>"']+/g) ?? []) {
      try { const url = new URL(text); if (url.hostname === "connect.composio.dev" && !url.username && !url.password && !url.port) links.add(url.href); } catch { /* Not an authorization URL. */ }
    }
    else if (v && typeof v === "object") for (const item of Object.values(v)) walk(item);
  };
  walk(value);
  if (links.size > 8) throw Error("Too many connection links");
  return [...links];
}
/** Model-visible API data is not a private OTP channel. Sign-in messages and
 * credential-bearing fields/URLs are withheld, including inside JSON strings. */
export function integrationResult(value: unknown, redact: (s: string) => string, depth = 0): unknown {
  if (depth > 16) return "[omitted: nesting limit]";
  if (typeof value === "string") {
    try { const json = JSON.parse(value); if (json && typeof json === "object") return integrationResult(json, redact, depth + 1); } catch { /* Ordinary text. */ }
    if (/\b(?:verification|one[ -]?time|security|sign[ -]?in|log[ -]?in)\s+(?:code|link)|\bOTP\b/i.test(value)) return "[Private sign-in content withheld]";
    return redact(value).slice(0, 64000).replace(/https?:\/\/[^\s<>"']+/g, text => {
      try { const url = new URL(text); return url.hostname === "connect.composio.dev" || url.username || url.password || [...url.searchParams.keys()].some(k => /token|code|state|key|session|signature/i.test(k)) ? "[private URL withheld]" : text; } catch { return "[invalid URL]"; }
    });
  }
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => integrationResult(item, redact, depth + 1));
  if (value && typeof value === "object" && Object.entries(value).some(([key, item]) =>
    /^(?:subject|body|text|html|preview|content)$/i.test(key) && typeof item === "string" && /\b(?:verification|one[ -]?time|security|sign[ -]?in|log[ -]?in)\s+(?:code|link)|\bOTP\b/i.test(item.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "))))
    return { status: "private_sign_in", message: "Private sign-in message withheld; use the private sign-in flow." };
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|secret|token|cookie|authorization|api.?key|headers|^session$|session.?id/i.test(key))
    .map(([key, item]) => [key, integrationResult(item, redact, depth + 1)]));
  return value;
}
