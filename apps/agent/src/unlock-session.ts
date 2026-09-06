/** Host-only Unlock session material. Never journal cookies or expose them as tool results. */
import { createVaultAgent, type VaultCookie } from "../../../packages/sdk/src/agent.ts";
import { vaultTransport } from "../../../packages/sdk/src/vault-transport.ts";
import { z } from "@unlock/protocol";
import { parseConnectorVault, type ConnectorVaultConfig } from "./connector-vault.ts";
import { connectorDomain, type ConnectorEngine } from "./connectors.ts";
import { publicTarget } from "./browser-proxy.ts";

export type { VaultCookie };
export interface UnlockSessionGrant {
  connectionId: string;
  revision: string;
  domains: readonly string[];
  cookies: readonly VaultCookie[];
  /** True when this grant was (re)published by a maintenance renewal — the vault side used the stored password. */
  renewed?: boolean;
}
const statusSchema = z.object({
  tenantId: z.string().min(1),
  profileId: z.string().min(1),
  runtimeId: z.string().min(1),
  connectionId: z.string().min(1),
  allowedDomains: z.array(z.string()).min(1).max(100),
  verified: z.boolean(),
  revision: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  renewable: z.boolean(),
}).strict();

/** Value-free lifecycle events for the thread log; never carry cookie or header values. */
export type UnlockSessionEvent =
  | { type: "AikoUnlockSessionRenewed"; owner: string; connectionId: string; revision: string; domain: string; at: number }
  | { type: "AikoUnlockSessionResolved"; owner: string; connectionId: string; revision: string; domain: string; cookies: number; renewed: boolean; at: number };

function cookieMatches(url: URL, cookie: VaultCookie) {
  const host = url.hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  const domainOk = cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  const pathOk = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`) || cookie.path === "/";
  return domainOk && pathOk && (!cookie.secure || url.protocol === "https:");
}

/** Build a Cookie header from vault material. Values never leave this function's return string. */
export function cookieHeader(url: URL, cookies: readonly VaultCookie[]): string {
  return cookies.filter(c => cookieMatches(url, c)).map(c => `${c.name}=${c.value}`).join("; ");
}

const RENEW_POLL_INTERVAL_MS = 1500;
const RENEW_MAX_POLLS = 12;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}

/**
 * Resolve the owner's current session material for `origin` through the Unlock
 * runtime API. When `renew` is set and the stored session is missing or
 * expired but renewable, request maintenance renewal first — the vault's
 * maintainer re-verifies with the stored session cookies and, when they no
 * longer verify, re-authenticates using the connection's stored password
 * (or 1Password reference) via the connection's approved recipe — then polls
 * until the fresh session is published. Passwords never cross this boundary:
 * only the resulting cookie jar returns, scoped to the granted domains.
 */
export async function ensureUnlockSession(input: {
  owner: string;
  origin: string;
  config?: ConnectorVaultConfig | (() => ConnectorVaultConfig | undefined);
  search: ConnectorEngine["search"];
  signal: AbortSignal;
  transport?: typeof fetch;
  renew?: boolean;
  emit?: (event: UnlockSessionEvent) => Promise<void> | void;
}): Promise<UnlockSessionGrant | undefined> {
  const url = publicTarget(input.origin.endsWith("/") ? input.origin : `${input.origin}/`);
  if (url.protocol !== "https:") return undefined;
  const domain = connectorDomain(url.origin);
  const raw = typeof input.config === "function" ? input.config() : input.config;
  const config = raw ? parseConnectorVault(JSON.stringify(raw)) : undefined;
  const account = config?.accounts[input.owner];
  const connectionId = account?.connections[domain];
  if (!config || !account || !connectionId) return undefined;
  const search = await input.search(domain);
  if (search.status !== "absent" || search.fallbackAllowed !== true) return undefined;
  const prefix = `${config.origin}/v1/runtime/connections`;
  const allowed = new Map<string, string[]>([
    [prefix, ["GET"]],
    [`${prefix}/${connectionId}/status`, ["GET"]],
    [`${prefix}/${connectionId}/session`, ["GET"]],
    [`${prefix}/${connectionId}/renew`, ["POST"]],
  ]);
  const transport = async (target: RequestInfo | URL, init?: RequestInit) => {
    const targetUrl = String(target);
    if (!allowed.get(targetUrl)?.includes(init?.method ?? "GET")) throw new Error("Private Unlock redirect rejected");
    const response = await (input.transport ?? fetch)(targetUrl, { ...init, redirect: "manual", credentials: "omit", signal: input.signal });
    if ((response.status >= 300 && response.status < 400) || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Private Unlock redirect rejected");
    }
    return response;
  };
  const sdk = { baseUrl: `${config.origin}/v1`, token: account.token, transport: transport as typeof fetch, timeoutMs: 15000, credentials: "omit" as const };
  const agent = createVaultAgent(sdk);
  const transportOfVault = vaultTransport(sdk);
  const statusOf = async () => transportOfVault(statusSchema, `runtime/connections/${connectionId}/status`, "GET", undefined, { signal: input.signal });
  const valid = (status: z.infer<typeof statusSchema>) =>
    status.verified && status.connectionId === connectionId &&
    status.expiresAt > Date.now() && status.allowedDomains.includes(domain);
  let status = await statusOf();
  let renewed = false;
  if (!valid(status)) {
    // Fail closed: only an ordinary expired/missing ready jar is renewable.
    // Revoked, stale-generation or failed rows need explicit owner recovery.
    if (input.renew !== true || !status.renewable) return undefined;
    await agent.requestRenewal(connectionId, { signal: input.signal });
    for (let poll = 0; poll < RENEW_MAX_POLLS; poll++) {
      await delay(RENEW_POLL_INTERVAL_MS, input.signal);
      status = await statusOf();
      if (valid(status)) { renewed = true; break; }
      if (!status.renewable) return undefined;
    }
    if (!renewed) return undefined;
  }
  const material = await agent.retrieve(connectionId, { signal: input.signal });
  if (material.connectionId !== connectionId || material.revision !== status.revision || material.expiresAt <= Date.now() || !material.cookies.length)
    return undefined;
  const grant: UnlockSessionGrant = {
    connectionId,
    revision: String(material.revision),
    domains: material.allowedDomains,
    cookies: material.cookies,
    ...(renewed ? { renewed: true } : {}),
  };
  if (renewed) await input.emit?.({ type: "AikoUnlockSessionRenewed", owner: input.owner, connectionId, revision: grant.revision, domain, at: Date.now() });
  await input.emit?.({ type: "AikoUnlockSessionResolved", owner: input.owner, connectionId, revision: grant.revision, domain, cookies: material.cookies.length, renewed, at: Date.now() });
  return grant;
}

/** Back-compatible retrieval without renewal. */
export function retrieveUnlockSession(input: Parameters<typeof ensureUnlockSession>[0]): Promise<UnlockSessionGrant | undefined> {
  return ensureUnlockSession({ ...input, renew: false });
}
