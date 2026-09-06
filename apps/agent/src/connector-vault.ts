import type { SecureBrowserAdapter } from "./connectors-browser.ts";
import { connectorDomain } from "./connectors.ts";
import { publicTarget } from "./browser-proxy.ts";
import { boundedText, safeUserId } from "./security.ts";

export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ConnectorVaultConfig = {
  origin: string;
  accounts: Record<string, { token: string; tenantId: string; profileId: string; runtimeId: string; connections: Record<string, string> }>;
};
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** Operator configuration only. Never accept account mappings from a model or request body. */
export function parseConnectorVault(value?: string): ConnectorVaultConfig | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 200000) throw new Error();
    const c = JSON.parse(value);
    if (!record(c) || Object.keys(c).some(k => !["origin", "accounts"].includes(k))) throw new Error();
    const u = publicTarget(c.origin);
    if (u.protocol !== "https:" || u.origin !== c.origin || !record(c.accounts) || Object.keys(c.accounts).length > 1000) throw new Error();
    for (const [owner, a] of Object.entries(c.accounts)) {
      if (!safeUserId(owner) || !record(a) || Object.keys(a).some(k => !["token", "tenantId", "profileId", "runtimeId", "connections"].includes(k))) throw new Error();
      if (typeof a.token !== "string" || a.token.length < 16 || a.token.length > 16000 || /\s/.test(a.token)) throw new Error();
      if ([a.tenantId,a.profileId,a.runtimeId].some(v => typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v)) || !record(a.connections)) throw new Error();
      for (const [domain, id] of Object.entries(a.connections)) if (connectorDomain(domain) !== domain || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error();
    }
    return c as ConnectorVaultConfig;
  } catch { throw new Error("Invalid connector vault configuration"); }
}
type Request = { owner: string; domain: string; connectionId: string };
/** Uses owner-approved Unlock runtime grants; never retrieves passwords or session cookies. */
export function connectorVault(config: ConnectorVaultConfig | undefined, owner: string, transport: VaultFetch = fetch): SecureBrowserAdapter | undefined {
  const account = config?.accounts[owner];
  if (!config || !account) return undefined;
  function binding(input: Request) {
    if (input.owner !== owner || connectorDomain(input.domain) !== input.domain || !input.connectionId) throw new Error("Foreign vault connection");
    const id = account!.connections[input.domain];
    if (!id) throw new Error("No owner-approved vault assignment for this domain");
    return id;
  }
  async function call(id: string, suffix: string, method = "GET", signal?: AbortSignal) {
    try {
      const response = await transport(`${config!.origin}/v1/runtime/connections/${encodeURIComponent(id)}/${suffix}`, {
        method, redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${account!.token}`, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      if (!response.ok) throw new Error();
      if (method === "DELETE" && response.status === 204) return { revoked: true };
      const value = JSON.parse(await boundedText(response, 16000));
      if (!record(value)) throw new Error();
      return value;
    } catch { throw new Error("Vault connection operation could not be verified"); }
  }
  async function state(input: Request, signal?: AbortSignal) {
    const id = binding(input), s = await call(id, "status", "GET", signal);
    if (s.tenantId !== account!.tenantId || s.profileId !== account!.profileId || s.runtimeId !== account!.runtimeId || s.connectionId !== id || !Array.isArray(s.allowedDomains) || !s.allowedDomains.includes(input.domain)) throw new Error("Vault connection identity mismatch");
    return s;
  }
  return {
    async begin(input: Request, signal?: AbortSignal) {
      const id = binding(input);
      await state(input, signal); // Validate the assigned connection before requesting password/session maintenance.
      await call(id, "renew", "POST", signal);
      return { authorizationUrl: config.origin + "/" };
    },
    async status(input: Request, signal?: AbortSignal) {
      const s = await state(input, signal);
      if (s.verified === true && Number.isSafeInteger(s.revision) && s.revision > 0 && Number.isSafeInteger(s.expiresAt) && s.expiresAt > Date.now()) return { ...input, status: "connected", verification: { verified: true, revision: s.revision, expiresAt: s.expiresAt } };
      return { ...input, status: "pending" };
    },
    async disconnect(input: Request, signal?: AbortSignal) { const s = await call(binding(input), "session", "DELETE", signal); if (s.revoked !== true) throw new Error("Vault revocation unverified"); return { ...input, status: "disconnected" }; },
  };
}
