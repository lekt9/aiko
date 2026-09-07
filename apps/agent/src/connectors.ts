import { createHash, randomUUID } from "node:crypto";
import {
  boundedText,
  redactor,
  safeUserId,
  type HttpFetch,
} from "./security.ts";
import { publicTarget } from "./browser-proxy.ts";
import { connectionRoute, connectionRouteId, CONNECTION_LINK_LIMIT, type ConnectionRoute, type ConnectionIndexPage } from "./connection-index.ts";
import { readPublicPage } from "./public-web.ts";
import {
  CatalogCache,
  type ConnectorDescription,
  type ConnectorAuthProvider,
} from "./connectors-catalog.ts";
import {
  browserOperation,
  validateBrowserStatus,
  type SecureBrowserAdapter,
  type SecureBrowserBinding,
  type SecureBrowserVerification,
} from "./connectors-browser.ts";
import type { ManagerHost, ManagerView } from "./password-managers.ts";
export type {
  SecureBrowserAdapter,
  SecureBrowserBinding,
  SecureBrowserStatus,
  SecureBrowserVerification,
} from "./connectors-browser.ts";
export type {
  ConnectorDescription,
  ConnectorAuthProvider,
} from "./connectors-catalog.ts";

export interface ConnectorStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<unknown[]>;
}
export type Connector = {
  id: string;
  name: string;
  description: string;
  provider: "arcade";
  toolName: string;
  domains: string[];
};
export type ConnectorExecution = {
  status: "succeeded" | "failed" | "authorization_required" | "unknown";
  value?: unknown;
  message?: string;
};
export type Connection = {
  id: string;
  connectorId: string;
  provider: "arcade" | "browser";
  status: "pending" | "connected" | "disconnected" | "failed";
  authorizationUrl?: string;
  createdAt: number;
  appName?: string;
  toolIds?: string[];
  importedUsername?: string;
  relayDisconnectStatus?: "pending" | "confirmed" | "unavailable" | "unknown";
};
export type ConnectionEvent = {
  type:
    "AikoConnectionChanged" | "AikoLoginSubmitted" | "AikoLoginAttemptFailed";
  id: string;
  owner: string;
  connectionId: string;
  provider: "browser" | "arcade";
  status: Connection["status"];
  domain?: string;
  at: number;
};
type StoredConnection = Connection & {
  owner: string;
  authId?: string;
  expiresAt: number;
  toolName?: string;
  authorizationDomains?: string[];
  browserVerification?: SecureBrowserVerification;
  eventSequence?: number;
  pendingEvents?: ConnectionEvent[];
};
export type GeneratedCapability = {
  id: string;
  domain: string;
  method: string;
  path: string;
  source: { kind: "owned-log" | "public"; reference: string };
  status: "review_required";
  version: 1;
  createdAt: number;
};
export type ConnectorSearch = {
  status: "available" | "absent" | "unavailable";
  connectors: Connector[];
  fallbackAllowed: boolean;
  message: string;
  totalMatches?: number;
  catalogSize?: number;
  authProviders?: ConnectorAuthProvider[];
  authProvidersStatus?: "available" | "unavailable";
};
export type ConnectorOptions = {
  owner: string;
  store: ConnectorStore;
  fetch?: HttpFetch;
  env?: { ARCADE_API_KEY?: string };
  readOwnedLogs?: (
    owner: string,
    domain: string,
  ) => Promise<Array<{ owner: string; id: string; text: string }>>;
  readPublicEvidence?: (
    url: string,
  ) => Promise<{ url: string; text: string; truncated: boolean }>;
  secureBrowser?: SecureBrowserAdapter;
  /** Host-provided password manager bindings; absent on hosts without the sealing key. */
  managers?: ManagerHost;
  onEvent?: (event: ConnectionEvent) => Promise<void>;
  /** Hosts explicitly opt in only after production OAuth configuration is verified. */
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const MAX_IMPORT_ROWS_PER_REQUEST = 500;
export const MAX_STAGED_IMPORTS_PER_OWNER = 1000;
export type ImportLoginRow = {
  name?: string;
  website: string;
  username?: string;
};
export type ImportLoginResult = {
  imported: number;
  updated: number;
  skipped: { row: number; reason: string }[];
};
/** Durable per-owner key prefix for connection records; exported for store tooling and tests. */
export const connectorStorePrefix = (owner: string) =>
  `connectors:${hash(owner)}:`;
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid connector response");
  return v as Record<string, any>;
};
export function connectorDomain(value: string): string {
  const url = publicTarget(value.includes("://") ? value : `https://${value}`);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Public HTTPS domain required");
  return url.hostname;
}
const clean = (v: unknown, secrets: string[] = []): unknown => {
  const redact = redactor(secrets);
  if (typeof v === "string") return redact(v).slice(0, 16000);
  if (Array.isArray(v))
    return v.slice(0, 1000).map((value) => clean(value, secrets));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            !/password|secret|token|cookie|authorization|api.?key|headers|logs|context/i.test(
              k,
            ),
        )
        .map(([k, value]) => [k, clean(value, secrets)]),
    );
  return v;
};
function authUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Authorization unavailable");
  const url = publicTarget(value);
  if (url.protocol !== "https:") throw new Error("Authorization unavailable");
  return url.href;
}

const catalogScopes = new WeakMap<HttpFetch, Map<string, CatalogCache>>();
const ownerQueues = new Map<string, Promise<unknown>>();

/** Bind once to the authenticated account. Do not construct from model-supplied owner IDs. */
export class ConnectorEngine {
  private prefix: string;
  constructor(private options: ConnectorOptions) {
    if (!safeUserId(options.owner)) throw new Error("Invalid connector owner");
    this.prefix = connectorStorePrefix(options.owner);
  }
  private clean(value: unknown) {
    return clean(value, [
      this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY ?? "",
    ]);
  }
  private async api(
    path: string,
    body?: unknown,
    maxBytes = 2_000_000,
    catalogKey?: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, any>> {
    const key =
      catalogKey ??
      this.options.env?.ARCADE_API_KEY ??
      process.env.ARCADE_API_KEY;
    if (!key) throw new Error("Arcade is not configured");
    try {
      const response = await (this.options.fetch ?? fetch)(
        `https://api.arcade.dev/v1/${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      // workerd supports manual redirects; never follow a Location with the Arcade credential.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Arcade redirect rejected");
      }
      if (!response.ok) throw new Error("Arcade unavailable");
      return object(JSON.parse(await boundedText(response, maxBytes)));
    } catch (error) {
      console.warn("connector_transport_unavailable");
      throw new Error(
        "Arcade request unavailable; browser fallback is not permitted",
      );
    }
  }
  private cache(): CatalogCache {
    const transport = this.options.fetch ?? fetch;
    const key = this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY;
    if (!key) throw new Error("Arcade is not configured");
    const scope = hash(key);
    const bucket =
      catalogScopes.get(transport) ?? new Map<string, CatalogCache>();
    catalogScopes.set(transport, bucket);
    let cache = bucket.get(scope);
    if (!cache) {
      if (bucket.size >= 16) bucket.delete(bucket.keys().next().value!);
      cache = new CatalogCache();
      bucket.set(scope, cache);
    }
    return cache;
  }
  private catalogAccess() {
    // Pin one environment key for the entire snapshot, including concurrent pages and redaction.
    const key = this.options.env?.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY;
    const cache = this.cache();
    return {
      cache,
      api: (path: string, body?: unknown, maxBytes?: number) =>
        this.api(path, body, maxBytes, key),
      text: (value: string) => String(clean(value, [key ?? ""])),
    };
  }
  private snapshot() {
    const { cache, api, text } = this.catalogAccess();
    return cache.catalog(api, text);
  }
  /** Public tool definitions only. No user grants or auth URLs; returned copies cannot poison the shared cache. */
  async listCatalog(): Promise<ConnectorDescription[]> {
    return structuredClone((await this.snapshot()).tools);
  }
  async describe(id: string): Promise<ConnectorDescription> {
    if (typeof id !== "string" || id.length > 220)
      throw new Error("Invalid connector ID");
    const tool = (await this.snapshot()).byId.get(id);
    if (!tool) throw new Error("Arcade connector unavailable");
    return structuredClone(tool);
  }
  async listAuthProviders(): Promise<ConnectorAuthProvider[]> {
    const { cache, api, text } = this.catalogAccess();
    return structuredClone(await cache.authProviders(api, text));
  }
  /** Arcade OAuth login flows were removed: connections are password sign-ins on
   * the owner's private browser session. The response shape stays for the
   * connector capability layer, which then proposes the native sign-in screen. */
  async apps(_query = "") {
    return {
      apps: [],
      oauthEnabled: false,
      nativeAvailable: !!this.options.secureBrowser,
      nativeInline: this.options.secureBrowser?.native === true,
    };
  }
  async search(query: string): Promise<ConnectorSearch> {
    if (typeof query !== "string" || query.length > 200)
      throw new Error("Invalid connector query");
    try {
      const catalog = await this.snapshot();
      const q = query.trim().toLowerCase();
      let domain: string | undefined;
      // Qualified tool names such as Gmail.ListEmails are identities, not domains.
      if (
        q.includes(".") &&
        !catalog.tools.some((t) => t.name.toLowerCase() === q)
      )
        domain = connectorDomain(q);
      const matched = catalog.index.search(q, domain);
      let authProviders: ConnectorAuthProvider[] = [];
      let authProvidersStatus: "available" | "unavailable" = "available";
      try {
        authProviders = (await this.listAuthProviders()).filter((p) =>
          domain
            ? p.domains.some((d) => domain === d || domain!.endsWith(`.${d}`))
            : !q ||
              p.providerId.toLowerCase() === q ||
              p.id.toLowerCase() === q ||
              p.domains.some((d) => d.split(".")[0] === q),
        );
      } catch {
        authProvidersStatus = "unavailable";
      }
      // Keep search results compact; the router retrieves complete schemas by describe(id).
      const connectors: Connector[] = matched
        .slice(0, 50)
        .map(({ id, name, description, provider, toolName, domains }) => ({
          id,
          name,
          description: description.slice(0, 1200),
          provider,
          toolName,
          domains: [...domains],
        }));
      const details = {
        totalMatches: matched.length,
        catalogSize: catalog.tools.length,
        authProviders,
        authProvidersStatus,
      };
      if (connectors.length || authProviders.length)
        return {
          status: "available",
          connectors,
          fallbackAllowed: false,
          message: connectors.length
            ? "Arcade catalog tools available; inspect tool requirements and authorize before execution."
            : "Arcade auth provider available; custom tool implementation is required. No executable tool match confirmed.",
          ...details,
        };
      if (
        !q ||
        !catalog.tools.length ||
        authProvidersStatus !== "available" ||
        (domain && !catalog.completeDomainMetadata)
      )
        throw new Error("Catalog coverage cannot establish absence");
      return {
        status: "absent",
        connectors: [],
        fallbackAllowed: true,
        message: "No match in the complete configured Arcade catalog.",
        ...details,
      };
    } catch (error) {
      console.warn("connector_catalog_unavailable");
      return {
        status: "unavailable",
        connectors: [],
        fallbackAllowed: false,
        message:
          "Arcade catalog availability or coverage could not be confirmed. Browser fallback is disabled.",
      };
    }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const prior = ownerQueues.get(this.prefix) ?? Promise.resolve();
    const queuedAt = Date.now();
    const next = prior
      .catch(() => undefined)
      .then(() => {
        const waited = Date.now() - queuedAt;
        if (waited > 10_000)
          console.warn("connector_serial_starved", {
            owner: this.options.owner,
            waitedMs: waited,
          });
        return run();
      });
    ownerQueues.set(this.prefix, next);
    void next
      .finally(() => {
        if (ownerQueues.get(this.prefix) === next)
          ownerQueues.delete(this.prefix);
      })
      .catch(() => undefined);
    return next;
  }
  nativeControl(
    id: string,
    input: Omit<
      import("./native-login.ts").NativeLoginInput,
      "connectionId" | "domain"
    >,
  ) {
    return this.serial(async () => {
      const row = await this.load(id);
      if (
        row.provider !== "browser" ||
        row.status !== "pending" ||
        !this.options.secureBrowser?.control ||
        ![
          "form",
          "credentials",
          "view",
          "click",
          "type",
          "key",
          "scroll",
          "finish",
          "navigate",
          "allow_origin",
        ].includes(input.action)
      )
        throw Error("Private sign-in unavailable");
      if (input.action === "credentials")
        await this.recordEvent(row, "AikoLoginSubmitted");
      let result;
      try {
        result = await this.options.secureBrowser.control(
          this.browserBinding(row),
          input,
        );
      } catch (error) {
        if (input.action === "credentials")
          await this.recordEvent(row, "AikoLoginAttemptFailed");
        throw error;
      }
      if (result.status === "connected") await this.completeBrowser(row);
      return result;
    });
  }
  connectBrowser(domain: string) {
    return this.serial(() => this.connectBrowserUnlocked(domain));
  }
  addManager(input: unknown) {
    return this.serial(async () => {
      if (!this.options.managers)
        throw new Error("Password managers are not available on this host");
      return this.options.managers.add(input);
    });
  }
  managers() {
    return this.serial(async (): Promise<ManagerView[]> => {
      if (!this.options.managers)
        throw new Error("Password managers are not available on this host");
      return this.options.managers.list();
    });
  }
  removeManager(id: string) {
    return this.serial(async () => {
      if (!this.options.managers)
        throw new Error("Password managers are not available on this host");
      await this.options.managers.remove(id);
      return { ok: true as const };
    });
  }
  /** Resolves the saved reference server-side and submits it into the owner's
   * private sign-in page. The password never reaches the mini app or the model. */
  fillFromManager(input: {
    connectionId: string;
    managerId: string;
    reference: string;
    username?: string;
  }) {
    return this.serial(async () => {
      if (!this.options.managers)
        throw new Error("Password managers are not available on this host");
      const row = await this.load(input.connectionId);
      if (
        row.provider !== "browser" ||
        row.status !== "pending" ||
        !this.options.secureBrowser?.control
      )
        throw new Error("Private sign-in unavailable");
      const reference =
        typeof input.reference === "string" ? input.reference : "";
      if (!reference || reference.length > 500 || /\p{C}/u.test(reference))
        throw new Error("Pick a saved login to fill");
      const binding = this.browserBinding(row);
      const username =
        (typeof input.username === "string" ? input.username.trim() : "") ||
        row.importedUsername ||
        "";
      if (!username || username.length > 2048 || /\p{C}/u.test(username))
        throw new Error("Add the username for this sign-in once");
      let password: string;
      try {
        password = await this.options.managers.resolvePassword(
          input.managerId,
          reference,
        );
      } catch (error) {
        throw error instanceof Error && error.message
          ? error
          : new Error("Could not use the saved password manager");
      }
      if (!password || password.length > 2048)
        throw new Error("The saved login did not resolve to a usable password");
      await this.recordEvent(row, "AikoLoginSubmitted");
      let result;
      try {
        result = await this.options.secureBrowser.control(binding, {
          action: "credentials",
          username,
          password,
        });
      } catch {
        await this.recordEvent(row, "AikoLoginAttemptFailed");
        throw new Error(
          "The saved login could not be submitted. Finish by typing your credentials instead.",
        );
      }
      if (result.status === "connected") await this.completeBrowser(row);
      return result;
    });
  }
  /** Stages login metadata from a password manager CSV export. Password columns
   * never reach this engine: the mini app drops them during local parsing. */
  importLogins(rows: unknown) {
    return this.serial(async (): Promise<ImportLoginResult> => {
      if (
        !Array.isArray(rows) ||
        rows.length < 1 ||
        rows.length > MAX_IMPORT_ROWS_PER_REQUEST
      )
        throw new Error("Import between 1 and 500 logins at a time");
      const existing = await this.options.store.list(
        `${this.prefix}connection:`,
      );
      const staged = existing
        .map((v) => object(v) as StoredConnection)
        .filter(
          (r) => r.owner === this.options.owner && r.provider === "browser",
        );
      if (staged.length >= MAX_STAGED_IMPORTS_PER_OWNER)
        throw new Error(
          "This account already has the maximum number of staged logins",
        );
      const result: ImportLoginResult = {
        imported: 0,
        updated: 0,
        skipped: [],
      };
      const seen = new Set<string>();
      for (const [index, raw] of rows.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          result.skipped.push({ row: index + 1, reason: "Not a login row." });
          continue;
        }
        const row = raw as Record<string, unknown>;
        const username =
          typeof row.username === "string" ? row.username.trim() : "";
        for (const value of [row.name, row.website, row.username])
          if (
            value !== undefined &&
            (typeof value !== "string" || /\p{C}/u.test(value))
          ) {
            result.skipped.push({
              row: index + 1,
              reason: "Unsupported characters.",
            });
            break;
          }
        if (result.skipped.some((s) => s.row === index + 1)) continue;
        let domain: string;
        try {
          domain = connectorDomain(String(row.website ?? ""));
        } catch {
          result.skipped.push({
            row: index + 1,
            reason: "A public HTTPS website is required.",
          });
          continue;
        }
        const name =
          typeof row.name === "string" &&
          row.name.trim() &&
          row.name.trim().length <= 60
            ? row.name.trim()
            : domain;
        if (username.length > 120) {
          result.skipped.push({
            row: index + 1,
            reason: "Username is too long.",
          });
          continue;
        }
        const key = `${domain}\n${username.toLowerCase()}`;
        if (seen.has(key)) {
          result.skipped.push({
            row: index + 1,
            reason: "Repeated in this import.",
          });
          continue;
        }
        seen.add(key);
        const match = staged.find(
          (r) =>
            r.connectorId === `browser:${domain}` &&
            ["pending", "connected"].includes(r.status),
        );
        if (match) {
          if (!match.importedUsername && username) {
            match.importedUsername = username;
            if (!match.appName) match.appName = name;
            await this.options.store.set(
              `${this.prefix}connection:${match.id}`,
              match,
            );
            result.updated++;
          } else
            result.skipped.push({
              row: index + 1,
              reason: "This app is already connected or staged.",
            });
          continue;
        }
        if (staged.length >= MAX_STAGED_IMPORTS_PER_OWNER) {
          result.skipped.push({
            row: index + 1,
            reason: "Staged login limit reached.",
          });
          continue;
        }
        const id = randomUUID();
        const record: StoredConnection = {
          id,
          owner: this.options.owner,
          connectorId: `browser:${domain}`,
          provider: "browser",
          status: "pending",
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 86400_000,
          appName: name,
          ...(username ? { importedUsername: username } : {}),
        };
        await this.options.store.set(`${this.prefix}connection:${id}`, record);
        staged.push(record);
        result.imported++;
      }
      return result;
    });
  }
  completeAuth(id: string) {
    return this.serial(() => this.completeAuthUnlocked(id));
  }
  disconnect(id: string) {
    return this.serial(() => this.disconnectUnlocked(id));
  }
  execute(id: string, input: Record<string, unknown>, toolId?: string) {
    return this.serial(() => this.executeUnlocked(id, input, toolId));
  }
  private eventFor(
    row: StoredConnection,
    type: ConnectionEvent["type"],
  ): ConnectionEvent {
    row.eventSequence = (row.eventSequence ?? 0) + 1;
    return {
      type,
      id: `connection:${row.id}:${row.eventSequence}`,
      owner: row.owner,
      connectionId: row.id,
      provider: row.provider,
      status: row.status,
      ...(row.provider === "browser"
        ? { domain: this.browserBinding(row).domain }
        : {}),
      at: Date.now(),
    };
  }
  private async publishEvents(row: StoredConnection) {
    if (!this.options.onEvent) return;
    for (const event of [...(row.pendingEvents ?? [])]) {
      try {
        await this.options.onEvent(event);
      } catch {
        console.warn("connection_event_delivery_pending");
        return;
      }
      row.pendingEvents = row.pendingEvents!.filter(
        (pending) => pending.id !== event.id,
      );
      await this.options.store.set(`${this.prefix}connection:${row.id}`, row);
    }
  }
  private async recordEvent(
    row: StoredConnection,
    type: ConnectionEvent["type"],
  ) {
    if (!this.options.onEvent) return;
    row.pendingEvents = [
      ...(row.pendingEvents ?? []),
      this.eventFor(row, type),
    ];
    await this.options.store.set(`${this.prefix}connection:${row.id}`, row);
    await this.publishEvents(row);
  }
  private async save(row: StoredConnection) {
    const prior = (await this.options.store.get(
      `${this.prefix}connection:${row.id}`,
    )) as StoredConnection | undefined;
    if (this.options.onEvent && prior?.status !== row.status)
      row.pendingEvents = [
        ...(row.pendingEvents ?? []),
        this.eventFor(row, "AikoConnectionChanged"),
      ];
    // The status change and metadata-only outbox share the same durable write.
    await this.options.store.set(`${this.prefix}connection:${row.id}`, row);
    await this.publishEvents(row);
  }
  flushEvents() {
    return this.serial(async () => {
      for (const value of await this.options.store.list(
        `${this.prefix}connection:`,
      )) {
        const row = object(value) as StoredConnection;
        if (row.owner === this.options.owner && row.pendingEvents?.length)
          await this.publishEvents(row);
      }
    });
  }
  async initialContext(
    id: string,
    signal?: AbortSignal,
  ): Promise<import("./learning.ts").LearningInput> {
    return (await this.connectionPage(id, signal)).input;
  }
  async connectionPage(
    id: string,
    signal?: AbortSignal,
    route?: ConnectionRoute,
  ): Promise<ConnectionIndexPage> {
    const row = await this.load(id);
    if (
      this.view(row).status !== "connected" ||
      row.provider !== "browser" ||
      !row.browserVerification ||
      !this.options.secureBrowser?.readContext
    )
      throw Error("Verified connection context unavailable");
    const binding = this.browserBinding(row);
    const target = route && connectionRoute(route.url, binding.domain);
    if (route && (!target || route.revision !== row.browserVerification.revision))
      throw Error("Connection route or session changed before indexing");
    const context = await this.options.secureBrowser.readContext(
      binding,
      signal,
      target || undefined,
    );
    signal?.throwIfAborted();
    const current = await this.load(id);
    if (this.view(current).status !== "connected")
      throw Error("Connection revoked during indexing");
    if (
      current.browserVerification?.revision !== row.browserVerification.revision
    )
      throw Error("Connection session changed during indexing");
    const url = publicTarget(context.url);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== binding.domain &&
        !url.hostname.endsWith(`.${binding.domain}`)) ||
      typeof context.text !== "string" ||
      context.text.length > 16000
    )
      throw Error("Invalid connection context");
    if (context.links !== undefined && (!Array.isArray(context.links) || context.links.length > CONNECTION_LINK_LIMIT))
      throw Error("Invalid connection links");
    const pageUrl = connectionRoute(url.href, binding.domain) ?? `${url.origin}${url.pathname}`;
    const routes = [...new Set((context.links ?? []).flatMap(value => {
      const link = connectionRoute(value, binding.domain, pageUrl);
      return link ? [link] : [];
    }))];
    const revision = row.browserVerification.revision;
    const pageId = route ? connectionRouteId(id, target!) : undefined;
    return { url: pageUrl, revision, routes, linksTruncated: context.linksTruncated === true,
      input: {
      id: pageId ? `connection:${revision}:${pageId}` : `connection:${id}:${revision}`,
      subject: pageId ? `${binding.domain}/route/${pageId}` : binding.domain,
      title: route ? `Connected route on ${binding.domain}` : `Initial context from ${binding.domain}`,
      kind: "episode",
      type: "connected-app-context",
      payload: {
        domain: binding.domain,
        url: pageUrl,
        context: context.text,
        coverage: context.links === undefined ? "Initial connected page only; route discovery unavailable" : "Observed connected page; discovered navigation links queued separately; not proof of complete account coverage",
        linksTruncated: context.linksTruncated === true,
      },
    }};
  }
  private view(row: StoredConnection): Connection {
    const {
      id,
      connectorId,
      provider,
      createdAt,
      relayDisconnectStatus,
      appName,
      toolIds,
    } = row;
    const authorizationUrl =
      row.provider === "browser" ? row.authorizationUrl : undefined;
    let status = row.status;
    if (
      provider === "browser" &&
      ((status === "pending" && row.expiresAt <= Date.now()) ||
        (status === "connected" &&
          (!row.browserVerification ||
            row.browserVerification.expiresAt <= Date.now())))
    )
      status = "failed";
    return {
      id,
      connectorId,
      provider,
      status,
      createdAt,
      ...(appName ? { appName, toolIds: [...(toolIds ?? [])] } : {}),
      ...(provider === "browser" &&
      row.importedUsername &&
      status !== "disconnected"
        ? { importedUsername: row.importedUsername }
        : {}),
      ...(authorizationUrl && status === "pending" && row.expiresAt > Date.now()
        ? { authorizationUrl }
        : {}),
      ...(relayDisconnectStatus ? { relayDisconnectStatus } : {}),
    };
  }
  private async load(id: string): Promise<StoredConnection> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Connection unavailable");
    const row = object(
      await this.options.store.get(`${this.prefix}connection:${id}`),
    ) as StoredConnection;
    if (row.owner !== this.options.owner || row.id !== id)
      throw new Error("Connection unavailable");
    return row;
  }
  private async completeAuthUnlocked(id: string): Promise<Connection> {
    const row = await this.load(id);
    if (row.provider === "browser") return this.completeBrowser(row);
    // Legacy Arcade OAuth rows can no longer complete; the owner disconnects them.
    return this.view(row);
  }
  async connections(): Promise<Connection[]> {
    return (await this.options.store.list(`${this.prefix}connection:`))
      .map((v) => object(v) as StoredConnection)
      .filter((r) => r.owner === this.options.owner)
      .map((r) => this.view(r));
  }
  private browserBinding(row: StoredConnection): SecureBrowserBinding {
    if (row.provider !== "browser" || !row.connectorId.startsWith("browser:"))
      throw new Error("Secure browser binding invalid");
    return {
      owner: row.owner,
      domain: connectorDomain(row.connectorId.slice(8)),
      connectionId: row.id,
    };
  }
  private async completeBrowser(row: StoredConnection): Promise<Connection> {
    if (row.status !== "pending" && row.status !== "connected")
      return this.view(row);
    if (this.view(row).status === "failed") {
      row.status = "failed";
      delete row.authorizationUrl;
      delete row.browserVerification;
      await this.save(row);
      return this.view(row);
    }
    const adapter = this.options.secureBrowser;
    if (!adapter?.status)
      throw new Error("Secure browser completion is not configured");
    const binding = this.browserBinding(row);
    const result = validateBrowserStatus(
      binding,
      await browserOperation((signal) =>
        adapter.status!({ ...binding }, signal),
      ),
    );
    if (result.status === "unknown")
      throw new Error("Secure browser status could not be confirmed");
    // A provider check can consume the last seconds of a pending flow. Never complete after its deadline.
    if (row.status === "pending" && row.expiresAt <= Date.now()) {
      row.status = "failed";
      delete row.authorizationUrl;
      delete row.browserVerification;
    } else if (result.status === "connected") {
      if (
        row.browserVerification &&
        result.verification.revision < row.browserVerification.revision
      )
        throw new Error("Secure browser verification revision regressed");
      row.status = "connected";
      row.browserVerification = result.verification;
      delete row.authorizationUrl;
    } else {
      row.status = result.status;
      delete row.browserVerification;
      if (row.status !== "pending") delete row.authorizationUrl;
    }
    await this.save(row);
    return this.view(row);
  }
  private async disconnectUnlocked(id: string): Promise<Connection> {
    const row = await this.load(id);
    const alreadySettled =
      row.status === "disconnected" &&
      row.relayDisconnectStatus === "confirmed";
    row.status = "disconnected";
    delete row.authorizationUrl;
    delete row.authId;
    delete row.browserVerification;
    const adapter = this.options.secureBrowser;
    if (row.provider === "browser" && !alreadySettled)
      row.relayDisconnectStatus = adapter?.disconnect
        ? "pending"
        : "unavailable";
    // Local access is disabled durably before invoking the host, even if remote revocation fails.
    await this.save(row);
    if (row.provider === "browser" && adapter?.disconnect && !alreadySettled) {
      const binding = this.browserBinding(row);
      try {
        const result = validateBrowserStatus(
          binding,
          await browserOperation((signal) =>
            adapter.disconnect!({ ...binding }, signal),
          ),
        );
        row.relayDisconnectStatus =
          result.status === "disconnected" ? "confirmed" : "unknown";
      } catch {
        row.relayDisconnectStatus = "unknown";
      }
      await this.save(row);
    }
    return this.view(row);
  }
  private async executeUnlocked(
    id: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): Promise<ConnectorExecution> {
    const row = await this.load(id);
    const toolName = row.toolIds
      ? toolId && row.toolIds.includes(toolId)
        ? (await this.describe(toolId)).toolName
        : undefined
      : row.toolName;
    if (row.status !== "connected" || row.provider !== "arcade" || !toolName)
      throw new Error("Connection is not executable");
    object(input);
    if (
      JSON.stringify(input).length > 64000 ||
      Object.keys(input).some((k) =>
        /^(user_id|tool_name|tool_version|authorization|api_key|password|token|cookie)$/i.test(
          k,
        ),
      )
    )
      throw new Error("Invalid connector input");
    const unknown = (): ConnectorExecution => ({
      status: "unknown",
      message:
        "Arcade execution outcome is unknown; the action may have executed. Do not retry automatically. No browser fallback was attempted.",
    });
    let result: Record<string, any>;
    try {
      result = await this.api("tools/execute", {
        tool_name: toolName,
        user_id: row.owner,
        input,
      });
    } catch {
      // A timeout, lost response, HTTP error or parsing failure is not proof that a mutation failed.
      return unknown();
    }
    const output = result.output;
    if (
      output !== undefined &&
      (!output || typeof output !== "object" || Array.isArray(output))
    )
      return unknown();
    if (output?.authorization != null) {
      // Never import a new auth flow from execution output. Reconnect binds a fresh owner/tool flow.
      row.status = "failed";
      delete row.authorizationUrl;
      delete row.authId;
      try {
        await this.save(row);
      } catch {
        throw new Error(
          "Connection authorization invalidation could not be persisted",
        );
      }
      return {
        status: "authorization_required",
        message: "Reconnect this Arcade tool to authorize it.",
      };
    }
    if (result.success === false)
      return {
        status: "failed",
        message: "Arcade did not confirm execution success.",
      };
    // Contradictory status/error or an absent result value cannot confirm completion.
    if (
      result.success !== true ||
      !output ||
      output.error != null ||
      !Object.hasOwn(output, "value")
    )
      return unknown();
    try {
      return { status: "succeeded", value: this.clean(output.value) };
    } catch {
      return unknown();
    }
  }
  private async connectBrowserUnlocked(value: string): Promise<Connection> {
    const domain = connectorDomain(value);
    const connections = await this.connections();
    const existing = connections.find(
      (row) =>
        row.connectorId === `browser:${domain}` &&
        ["pending", "connected"].includes(row.status),
    );
    if (existing) {
      // Staged (imported) rows have no relay authorization yet; start it on first open.
      if (
        !this.options.secureBrowser?.native &&
        existing.status === "pending" &&
        !existing.authorizationUrl &&
        this.options.secureBrowser?.begin
      ) {
        try {
          const result = await browserOperation((signal) =>
            this.options.secureBrowser!.begin!(
              { owner: this.options.owner, domain, connectionId: existing.id },
              signal,
            ),
          );
          const row = await this.load(existing.id);
          row.authorizationUrl = authUrl(result.authorizationUrl);
          await this.save(row);
          return this.view(row);
        } catch {
          /* Fall through to the staged tile; the owner can retry. */
        }
      }
      return existing;
    }
    // A locally revoked connection may still own the private browser lock after a lost reply.
    // Retry only that already-authorized revocation before opening another credential flow.
    if (this.options.secureBrowser?.native)
      for (const value of await this.options.store.list(
        `${this.prefix}connection:`,
      )) {
        const old = object(value) as StoredConnection;
        if (
          old.owner === this.options.owner &&
          old.provider === "browser" &&
          old.status === "disconnected" &&
          ["pending", "unknown"].includes(old.relayDisconnectStatus ?? "")
        ) {
          // Domain cookies may be shared by a newer grant. Never clear that grant as cleanup.
          if (
            connections.some(
              (row) =>
                row.id !== old.id &&
                row.connectorId === old.connectorId &&
                ["pending", "connected"].includes(row.status),
            )
          )
            throw Error(
              "Previous private sign-in cleanup conflicts with an active connection",
            );
          const settled = await this.disconnectUnlocked(old.id);
          if (settled.relayDisconnectStatus !== "confirmed")
            throw Error("Previous private sign-in cleanup is still pending");
        }
      }
    if (!this.options.secureBrowser?.native) {
      const search = await this.search(domain);
      if (search.status !== "absent" || !search.fallbackAllowed)
        throw new Error("Confirmed Arcade absence required");
    }
    if (!this.options.secureBrowser)
      throw new Error("Secure browser/password connection is not configured");
    const row: StoredConnection = {
      id: randomUUID(),
      owner: this.options.owner,
      connectorId: `browser:${domain}`,
      provider: "browser",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1800000,
    };
    // Recoverable local binding exists even when begin times out after creating a remote relay.
    await this.save(row);
    try {
      const result = await browserOperation((signal) =>
        this.options.secureBrowser!.begin(
          { owner: row.owner, domain, connectionId: row.id },
          signal,
        ),
      );
      row.authorizationUrl = authUrl(result.authorizationUrl);
    } catch {
      row.status = "failed";
      await this.save(row);
      throw new Error("Secure browser connection could not be started");
    }
    await this.save(row);
    return this.view(row);
  }
  async discover(value: string, evidenceUrls: string[] = []) {
    const domain = connectorDomain(value);
    const search = await this.search(domain);
    const capabilities: GeneratedCapability[] = [];
    if (search.status !== "absent")
      return {
        status: search.status === "available" ? "arcade" : "unavailable",
        search,
        capabilities,
      };
    const evidence: Array<{
      text: string;
      source: GeneratedCapability["source"];
    }> = [];
    let logs: Array<{ owner: string; id: string; text: string }> = [];
    try {
      logs =
        (await this.options.readOwnedLogs?.(this.options.owner, domain)) ?? [];
    } catch {
      /* Host read failures are not evidence; never surface raw errors. */
    }
    for (const row of logs.slice(0, 100)) {
      if (row.owner !== this.options.owner) continue;
      evidence.push({
        text: row.text.slice(0, 64000),
        source: { kind: "owned-log", reference: `log:${hash(row.id)}` },
      });
    }
    if (evidenceUrls.length > 8) throw new Error("Evidence budget exceeded");
    for (const raw of evidenceUrls) {
      const url = publicTarget(raw);
      if (
        url.href.length > 2048 ||
        this.clean(url.href) !== url.href ||
        url.protocol !== "https:" ||
        !["github.com", "raw.githubusercontent.com", "deepwiki.com"].includes(
          url.hostname,
        ) ||
        url.search ||
        url.hash
      )
        throw new Error("Public GitHub or DeepWiki evidence URL required");
      try {
        const page = await (
          this.options.readPublicEvidence ??
          ((u: string) => readPublicPage(u, AbortSignal.timeout(15000)))
        )(url.href);
        if (page.url !== url.href || page.truncated) continue;
        evidence.push({
          text: page.text.slice(0, 64000),
          source: { kind: "public", reference: url.href },
        });
      } catch {
        /* Missing evidence is never a successful capability. */
      }
    }
    let candidateCount = 0;
    for (const item of evidence) {
      // Extract explicit method + absolute HTTPS endpoint only. Never infer credentials or execute source code.
      for (const match of item.text.matchAll(
        /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(https:\/\/[^\s<>"'`]+)/g,
      )) {
        if (++candidateCount > 256) break;
        try {
          const url = publicTarget(match[2]!);
          if (
            url.hostname !== domain ||
            url.search ||
            url.hash ||
            !/^\/[A-Za-z0-9_./{}:-]*$/.test(url.pathname) ||
            redactor()(url.pathname) !== url.pathname ||
            /token|secret|password|key/i.test(url.pathname)
          )
            continue;
          const id = hash(
            `${domain}\n${match[1]}\n${url.pathname}\n${item.source.reference}`,
          );
          const capability: GeneratedCapability = {
            id,
            domain,
            method: match[1]!,
            path: url.pathname,
            source: item.source,
            status: "review_required",
            version: 1,
            createdAt: Date.now(),
          };
          await this.options.store.set(`${this.prefix}capability:${id}`, {
            ...capability,
            owner: this.options.owner,
          });
        } catch {
          /* Reject unsafe candidate. */
        }
      }
    }
    for (const raw of await this.options.store.list(
      `${this.prefix}capability:`,
    )) {
      const row = object(raw);
      if (row.owner === this.options.owner && row.domain === domain) {
        const { owner: _, ...capability } = row;
        capabilities.push(capability as GeneratedCapability);
      }
    }
    return {
      status: capabilities.length ? "discovered" : "needs_evidence",
      search,
      capabilities,
    };
  }
}
