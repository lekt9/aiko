import { createHash, randomUUID } from "node:crypto";
import { boundedText, redactor, safeUserId, type HttpFetch } from "./security.ts";
import { publicTarget } from "./browser-proxy.ts";
import { readPublicPage } from "./public-web.ts";
import { CatalogCache, type ConnectorDescription, type ConnectorAuthProvider } from "./connectors-catalog.ts";
import { browserOperation, validateBrowserStatus, type SecureBrowserAdapter, type SecureBrowserBinding, type SecureBrowserVerification } from "./connectors-browser.ts";
export type { SecureBrowserAdapter, SecureBrowserBinding, SecureBrowserStatus, SecureBrowserVerification } from "./connectors-browser.ts";
export type { ConnectorDescription, ConnectorAuthProvider } from "./connectors-catalog.ts";

export interface ConnectorStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<unknown[]>;
}
export type Connector = { id: string; name: string; description: string; provider: "arcade"; toolName: string; domains: string[] };
export type ConnectorExecution = {
  status: "succeeded" | "failed" | "authorization_required" | "unknown";
  value?: unknown;
  message?: string;
};
export type Connection = { id: string; connectorId: string; provider: "arcade" | "browser"; status: "pending" | "connected" | "disconnected" | "failed"; authorizationUrl?: string; createdAt: number; relayDisconnectStatus?: "pending" | "confirmed" | "unavailable" | "unknown" };
type StoredConnection = Connection & { owner: string; authId?: string; expiresAt: number; toolName?: string; browserVerification?: SecureBrowserVerification };
export type GeneratedCapability = { id: string; domain: string; method: string; path: string; source: { kind: "owned-log" | "public"; reference: string }; status: "review_required"; version: 1; createdAt: number };
export type ConnectorSearch = { status: "available" | "absent" | "unavailable"; connectors: Connector[]; fallbackAllowed: boolean; message: string; totalMatches?: number; catalogSize?: number; authProviders?: ConnectorAuthProvider[]; authProvidersStatus?: "available" | "unavailable" };
export type ConnectorOptions = {
  owner: string; store: ConnectorStore; fetch?: HttpFetch; env?: { ARCADE_API_KEY?: string };
  readOwnedLogs?: (owner: string, domain: string) => Promise<Array<{ owner: string; id: string; text: string }>>;
  readPublicEvidence?: (url: string) => Promise<{ url: string; text: string; truncated: boolean }>;
  secureBrowser?: SecureBrowserAdapter;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid connector response");
  return v as Record<string, any>;
};
export function connectorDomain(value: string): string {
  const url = publicTarget(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("Public HTTPS domain required");
  return url.hostname;
}
const clean = (v: unknown, secrets: string[] = []): unknown => {
  const redact = redactor(secrets);
  if (typeof v === "string") return redact(v).slice(0, 16000);
  if (Array.isArray(v)) return v.slice(0, 1000).map(value => clean(value, secrets));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !/password|secret|token|cookie|authorization|api.?key|headers|logs|context/i.test(k)).map(([k, value]) => [k, clean(value, secrets)]));
  return v;
};
function authUrl(value: unknown, arcade: boolean): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Authorization unavailable");
  const url = publicTarget(value);
  if (url.protocol !== "https:" || (arcade && url.hostname !== "arcade.dev" && !url.hostname.endsWith(".arcade.dev"))) throw new Error("Authorization unavailable");
  return url.href;
}

const catalogScopes = new WeakMap<HttpFetch, Map<string, CatalogCache>>();
const ownerQueues = new Map<string, Promise<unknown>>();

/** Bind once to the authenticated account. Do not construct from model-supplied owner IDs. */
export class ConnectorEngine {
  private prefix: string;
  constructor(private options: ConnectorOptions) {
    if (!safeUserId(options.owner)) throw new Error("Invalid connector owner");
    this.prefix = `connectors:${hash(options.owner)}:`;
  }
  private clean(value: unknown) { return clean(value, [this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY ?? ""]); }
  private async api(path: string, body?: unknown, maxBytes = 2_000_000, catalogKey?: string): Promise<Record<string, any>> {
    const key = catalogKey ?? this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY;
    if (!key) throw new Error("Arcade is not configured");
    try {
      const response = await (this.options.fetch ?? fetch)(`https://api.arcade.dev/v1/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // workerd supports manual redirects; never follow a Location with the Arcade credential.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Arcade redirect rejected");
      }
      if (!response.ok) throw new Error("Arcade unavailable");
      return object(JSON.parse(await boundedText(response, maxBytes)));
    } catch (error) { console.warn("connector_transport_unavailable"); throw new Error("Arcade request unavailable; browser fallback is not permitted"); }
  }
  private cache(): CatalogCache {
    const transport = this.options.fetch ?? fetch;
    const key = this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY;
    if (!key) throw new Error("Arcade is not configured");
    const scope = hash(key);
    const bucket = catalogScopes.get(transport) ?? new Map<string, CatalogCache>();
    catalogScopes.set(transport, bucket);
    let cache = bucket.get(scope);
    if (!cache) {
      if (bucket.size >= 16) bucket.delete(bucket.keys().next().value!);
      cache = new CatalogCache(); bucket.set(scope, cache);
    }
    return cache;
  }
  private catalogAccess() {
    // Pin one environment key for the entire snapshot, including concurrent pages and redaction.
    const key = this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY;
    const cache = this.cache();
    return { cache, api: (path: string, body?: unknown, maxBytes?: number) => this.api(path, body, maxBytes, key), text: (value: string) => String(clean(value, [key ?? ""])) };
  }
  private snapshot() {
    const { cache, api, text } = this.catalogAccess();
    return cache.catalog(api, text);
  }
  /** Public tool definitions only. No user grants or auth URLs; returned copies cannot poison the shared cache. */
  async listCatalog(): Promise<ConnectorDescription[]> { return structuredClone((await this.snapshot()).tools); }
  async describe(id: string): Promise<ConnectorDescription> {
    if (typeof id !== "string" || id.length > 220) throw new Error("Invalid connector ID");
    const tool = (await this.snapshot()).byId.get(id);
    if (!tool) throw new Error("Arcade connector unavailable");
    return structuredClone(tool);
  }
  async listAuthProviders(): Promise<ConnectorAuthProvider[]> {
    const { cache, api, text } = this.catalogAccess();
    return structuredClone(await cache.authProviders(api, text));
  }
  async search(query: string): Promise<ConnectorSearch> {
    if (typeof query !== "string" || query.length > 200) throw new Error("Invalid connector query");
    try {
      const catalog = await this.snapshot();
      const q = query.trim().toLowerCase();
      let domain: string | undefined;
      // Qualified tool names such as Gmail.ListEmails are identities, not domains.
      if (q.includes(".") && !catalog.tools.some(t => t.name.toLowerCase() === q)) domain = connectorDomain(q);
      const matched = catalog.index.search(q, domain);
      let authProviders: ConnectorAuthProvider[] = [];
      let authProvidersStatus: "available" | "unavailable" = "available";
      try {
        authProviders = (await this.listAuthProviders()).filter(p => domain
          ? p.domains.some(d => domain === d || domain!.endsWith(`.${d}`))
          : !q || p.providerId.toLowerCase() === q || p.id.toLowerCase() === q || p.domains.some(d => d.split(".")[0] === q));
      } catch { authProvidersStatus = "unavailable"; }
      // Keep search results compact; the router retrieves complete schemas by describe(id).
      const connectors: Connector[] = matched.slice(0, 50).map(({ id, name, description, provider, toolName, domains }) => ({ id, name, description: description.slice(0, 1200), provider, toolName, domains: [...domains] }));
      const details = { totalMatches: matched.length, catalogSize: catalog.tools.length, authProviders, authProvidersStatus };
      if (connectors.length || authProviders.length) return { status: "available", connectors, fallbackAllowed: false, message: connectors.length ? "Arcade catalog tools available; inspect tool requirements and authorize before execution." : "Arcade auth provider available; custom tool implementation is required. No executable tool match confirmed.", ...details };
      if (!q || !catalog.tools.length || authProvidersStatus !== "available" || (domain && !catalog.completeDomainMetadata)) throw new Error("Catalog coverage cannot establish absence");
      return { status: "absent", connectors: [], fallbackAllowed: true, message: "No match in the complete configured Arcade catalog.", ...details };
    } catch (error) { console.warn("connector_catalog_unavailable"); return { status: "unavailable", connectors: [], fallbackAllowed: false, message: "Arcade catalog availability or coverage could not be confirmed. Browser fallback is disabled." }; }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const prior = ownerQueues.get(this.prefix) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(run);
    ownerQueues.set(this.prefix, next);
    void next.finally(() => { if (ownerQueues.get(this.prefix) === next) ownerQueues.delete(this.prefix); }).catch(() => undefined);
    return next;
  }
  connectBrowser(domain: string) { return this.serial(() => this.connectBrowserUnlocked(domain)); }
  completeAuth(id: string) { return this.serial(() => this.completeAuthUnlocked(id)); }
  disconnect(id: string) { return this.serial(() => this.disconnectUnlocked(id)); }
  execute(id: string, input: Record<string, unknown>) { return this.serial(() => this.executeUnlocked(id, input)); }
  private async save(row: StoredConnection) { await this.options.store.set(`${this.prefix}connection:${row.id}`, row); }
  private view(row: StoredConnection): Connection {
    const { id, connectorId, provider, authorizationUrl, createdAt, relayDisconnectStatus } = row;
    let status = row.status;
    if (provider === "browser" && ((status === "pending" && row.expiresAt <= Date.now()) || (status === "connected" && (!row.browserVerification || row.browserVerification.expiresAt <= Date.now())))) status = "failed";
    return { id, connectorId, provider, status, createdAt, ...(authorizationUrl && status === "pending" && row.expiresAt > Date.now() ? { authorizationUrl } : {}), ...(relayDisconnectStatus ? { relayDisconnectStatus } : {}) };
  }
  private async load(id: string): Promise<StoredConnection> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Connection unavailable");
    const row = object(await this.options.store.get(`${this.prefix}connection:${id}`)) as StoredConnection;
    if (row.owner !== this.options.owner || row.id !== id) throw new Error("Connection unavailable");
    return row;
  }
  async connect(connectorId: string): Promise<Connection> {
    const tool = await this.describe(connectorId);
    const auth = await this.api("tools/authorize", { tool_name: tool.toolName, user_id: this.options.owner });
    const row: StoredConnection = { id: randomUUID(), owner: this.options.owner, connectorId, provider: "arcade", status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000, toolName: tool.toolName };
    this.applyAuth(row, auth);
    await this.save(row);
    return this.view(row);
  }
  private applyAuth(row: StoredConnection, auth: Record<string, any>) {
    if ((auth.user_id !== undefined && auth.user_id !== row.owner) || (row.authId && auth.id !== row.authId) || !["completed", "pending", "not_started", "failed"].includes(auth.status)) throw new Error("Authorization binding invalid");
    if (auth.status === "completed") { row.status = "connected"; delete row.authorizationUrl; }
    else if (auth.status === "failed") { row.status = "failed"; delete row.authorizationUrl; }
    else {
      if (typeof auth.id !== "string" || !auth.id || auth.id.length > 256) throw new Error("Authorization binding invalid");
      row.authId = auth.id;
      row.authorizationUrl = authUrl(auth.url, true);
    }
  }
  private async completeAuthUnlocked(id: string): Promise<Connection> {
    const row = await this.load(id);
    if (row.provider === "browser") return this.completeBrowser(row);
    if (row.status !== "pending") return this.view(row);
    if (row.expiresAt <= Date.now()) { row.status = "failed"; delete row.authorizationUrl; await this.save(row); return this.view(row); }
    if (row.provider !== "arcade" || !row.authId) throw new Error("Secure browser completion is not configured");
    const auth = await this.api(`auth/status?id=${encodeURIComponent(row.authId)}`);
    // Re-read after network wait so a concurrent disconnect cannot be undone.
    const current = await this.load(id);
    if (current.status !== "pending") return this.view(current);
    this.applyAuth(current, auth);
    await this.save(current);
    return this.view(current);
  }
  async connections(): Promise<Connection[]> {
    return (await this.options.store.list(`${this.prefix}connection:`)).map(v => object(v) as StoredConnection).filter(r => r.owner === this.options.owner).map(r => this.view(r));
  }
  private browserBinding(row: StoredConnection): SecureBrowserBinding {
    if (row.provider !== "browser" || !row.connectorId.startsWith("browser:")) throw new Error("Secure browser binding invalid");
    return { owner: row.owner, domain: connectorDomain(row.connectorId.slice(8)), connectionId: row.id };
  }
  private async completeBrowser(row: StoredConnection): Promise<Connection> {
    if (row.status !== "pending" && row.status !== "connected") return this.view(row);
    if (this.view(row).status === "failed") {
      row.status = "failed"; delete row.authorizationUrl; delete row.browserVerification;
      await this.save(row); return this.view(row);
    }
    const adapter = this.options.secureBrowser;
    if (!adapter?.status) throw new Error("Secure browser completion is not configured");
    const binding = this.browserBinding(row);
    const result = validateBrowserStatus(binding, await browserOperation(signal => adapter.status!({ ...binding }, signal)));
    if (result.status === "unknown") throw new Error("Secure browser status could not be confirmed");
    // A provider check can consume the last seconds of a pending flow. Never complete after its deadline.
    if (row.status === "pending" && row.expiresAt <= Date.now()) {
      row.status = "failed"; delete row.authorizationUrl; delete row.browserVerification;
    } else if (result.status === "connected") {
      if (row.browserVerification && result.verification.revision < row.browserVerification.revision) throw new Error("Secure browser verification revision regressed");
      row.status = "connected"; row.browserVerification = result.verification; delete row.authorizationUrl;
    } else {
      row.status = result.status;
      delete row.browserVerification;
      if (row.status !== "pending") delete row.authorizationUrl;
    }
    await this.save(row); return this.view(row);
  }
  private async disconnectUnlocked(id: string): Promise<Connection> {
    const row = await this.load(id);
    const alreadySettled = row.status === "disconnected" && row.relayDisconnectStatus === "confirmed";
    row.status = "disconnected"; delete row.authorizationUrl; delete row.authId; delete row.browserVerification;
    const adapter = this.options.secureBrowser;
    if (row.provider === "browser" && !alreadySettled) row.relayDisconnectStatus = adapter?.disconnect ? "pending" : "unavailable";
    // Local access is disabled durably before invoking the host, even if remote revocation fails.
    await this.save(row);
    if (row.provider === "browser" && adapter?.disconnect && !alreadySettled) {
      const binding = this.browserBinding(row);
      try {
        const result = validateBrowserStatus(binding, await browserOperation(signal => adapter.disconnect!({ ...binding }, signal)));
        row.relayDisconnectStatus = result.status === "disconnected" ? "confirmed" : "unknown";
      } catch { row.relayDisconnectStatus = "unknown"; }
      await this.save(row);
    }
    return this.view(row);
  }
  private async executeUnlocked(id: string, input: Record<string, unknown>): Promise<ConnectorExecution> {
    const row = await this.load(id);
    if (row.status !== "connected" || row.provider !== "arcade" || !row.toolName) throw new Error("Connection is not executable");
    object(input);
    if (JSON.stringify(input).length > 64000 || Object.keys(input).some(k => /^(user_id|tool_name|tool_version|authorization|api_key|password|token|cookie)$/i.test(k))) throw new Error("Invalid connector input");
    const unknown = (): ConnectorExecution => ({ status: "unknown", message: "Arcade execution outcome is unknown; the action may have executed. Do not retry automatically. No browser fallback was attempted." });
    let result: Record<string, any>;
    try {
      result = await this.api("tools/execute", { tool_name: row.toolName, user_id: row.owner, input });
    } catch {
      // A timeout, lost response, HTTP error or parsing failure is not proof that a mutation failed.
      return unknown();
    }
    const output = result.output;
    if (output !== undefined && (!output || typeof output !== "object" || Array.isArray(output))) return unknown();
    if (output?.authorization != null) {
      // Never import a new auth flow from execution output. Reconnect binds a fresh owner/tool flow.
      row.status = "failed";
      delete row.authorizationUrl;
      delete row.authId;
      try { await this.save(row); }
      catch { throw new Error("Connection authorization invalidation could not be persisted"); }
      return { status: "authorization_required", message: "Reconnect this Arcade tool to authorize it." };
    }
    if (result.success === false) return { status: "failed", message: "Arcade did not confirm execution success." };
    // Contradictory status/error or an absent result value cannot confirm completion.
    if (result.success !== true || !output || output.error != null || !Object.hasOwn(output, "value")) return unknown();
    try { return { status: "succeeded", value: this.clean(output.value) }; }
    catch { return unknown(); }
  }
  private async connectBrowserUnlocked(value: string): Promise<Connection> {
    const domain = connectorDomain(value);
    const search = await this.search(domain);
    if (search.status !== "absent" || !search.fallbackAllowed) throw new Error("Confirmed Arcade absence required");
    if (!this.options.secureBrowser) throw new Error("Secure browser/password connection is not configured");
    const row: StoredConnection = { id: randomUUID(), owner: this.options.owner, connectorId: `browser:${domain}`, provider: "browser", status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600000 };
    // Recoverable local binding exists even when begin times out after creating a remote relay.
    await this.save(row);
    try {
      const result = await browserOperation(signal => this.options.secureBrowser!.begin({ owner: row.owner, domain, connectionId: row.id }, signal));
      row.authorizationUrl = authUrl(result.authorizationUrl, false);
    } catch { row.status = "failed"; await this.save(row); throw new Error("Secure browser connection could not be started"); }
    await this.save(row); return this.view(row);
  }
  async discover(value: string, evidenceUrls: string[] = []) {
    const domain = connectorDomain(value);
    const search = await this.search(domain);
    const capabilities: GeneratedCapability[] = [];
    if (search.status !== "absent") return { status: search.status === "available" ? "arcade" : "unavailable", search, capabilities };
    const evidence: Array<{ text: string; source: GeneratedCapability["source"] }> = [];
    let logs: Array<{ owner: string; id: string; text: string }> = [];
    try { logs = await this.options.readOwnedLogs?.(this.options.owner, domain) ?? []; }
    catch { /* Host read failures are not evidence; never surface raw errors. */ }
    for (const row of logs.slice(0, 100)) {
      if (row.owner !== this.options.owner) continue;
      evidence.push({ text: row.text.slice(0, 64000), source: { kind: "owned-log", reference: `log:${hash(row.id)}` } });
    }
    if (evidenceUrls.length > 8) throw new Error("Evidence budget exceeded");
    for (const raw of evidenceUrls) {
      const url = publicTarget(raw);
      if (url.href.length > 2048 || this.clean(url.href) !== url.href || url.protocol !== "https:" || !["github.com", "raw.githubusercontent.com", "deepwiki.com"].includes(url.hostname) || url.search || url.hash) throw new Error("Public GitHub or DeepWiki evidence URL required");
      try {
        const page = await (this.options.readPublicEvidence ?? ((u: string) => readPublicPage(u, AbortSignal.timeout(15000))))(url.href);
        if (page.url !== url.href || page.truncated) continue;
        evidence.push({ text: page.text.slice(0, 64000), source: { kind: "public", reference: url.href } });
      } catch { /* Missing evidence is never a successful capability. */ }
    }
    let candidateCount = 0;
    for (const item of evidence) {
      // Extract explicit method + absolute HTTPS endpoint only. Never infer credentials or execute source code.
      for (const match of item.text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(https:\/\/[^\s<>"'`]+)/g)) {
        if (++candidateCount > 256) break;
        try {
          const url = publicTarget(match[2]!);
          if (url.hostname !== domain || url.search || url.hash || !/^\/[A-Za-z0-9_./{}:-]*$/.test(url.pathname) || redactor()(url.pathname) !== url.pathname || /token|secret|password|key/i.test(url.pathname)) continue;
          const id = hash(`${domain}\n${match[1]}\n${url.pathname}\n${item.source.reference}`);
          const capability: GeneratedCapability = { id, domain, method: match[1]!, path: url.pathname, source: item.source, status: "review_required", version: 1, createdAt: Date.now() };
          await this.options.store.set(`${this.prefix}capability:${id}`, { ...capability, owner: this.options.owner });
        } catch { /* Reject unsafe candidate. */ }
      }
    }
    for (const raw of await this.options.store.list(`${this.prefix}capability:`)) {
      const row = object(raw);
      if (row.owner === this.options.owner && row.domain === domain) { const { owner: _, ...capability } = row; capabilities.push(capability as GeneratedCapability); }
    }
    return { status: capabilities.length ? "discovered" : "needs_evidence", search, capabilities };
  }
}
