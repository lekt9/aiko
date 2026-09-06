import type { Connector } from "./connectors.ts";
import { publicTarget } from "./browser-proxy.ts";

export type ConnectorAuthProvider = {
  id: string; providerId: string; type: string; status: string; description: string;
  kind: "auth_provider"; executable: false; domains: string[]; authorizationDomains: string[];
};
export type ConnectorDescription = Connector & {
  toolkit: { name: string; description?: string; version?: string };
  inputSchema: Record<string, unknown>;
  input: Record<string, unknown>;
  requirements: Record<string, unknown>;
  metadata: Record<string, unknown>;
  domainEvidence: Array<{ domain: string; source: "metadata" | "documented-toolkit" | "provider-scope"; reference?: string }>;
};
export type CatalogSnapshot = {
  tools: ConnectorDescription[];
  byId: Map<string, ConnectorDescription>;
  completeDomainMetadata: boolean;
  index: CatalogIndex;
};
export type CatalogAPI = (path: string, body?: unknown, maxBytes?: number) => Promise<Record<string, any>>;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const host = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  try { return publicTarget(v.includes("://") ? v : `https://${v}`).hostname; } catch { return undefined; }
};

// Explicit identity mappings, never inferred from arbitrary brand substrings. Sources in connector-engine.md.
const integrations = [
  { toolkits: ["gmail"], provider: "google", domains: ["gmail.com", "mail.google.com"], scope: "https://www.googleapis.com/auth/gmail.", source: "https://docs.arcade.dev/en/resources/integrations/productivity/gmail" },
  { toolkits: ["slack", "slackapi"], provider: "slack", domains: ["slack.com"], source: "https://docs.arcade.dev/en/resources/integrations/social/slack" },
  { toolkits: ["github", "githubapi"], provider: "github", domains: ["github.com"], source: "https://docs.arcade.dev/en/references/auth-providers/github" },
];
function domainEvidence(tool: Record<string, any>): ConnectorDescription["domainEvidence"] {
  const evidence: ConnectorDescription["domainEvidence"] = [];
  const classified = tool.metadata?.classification?.service_domains;
  if (classified !== undefined && (!Array.isArray(classified) || classified.some(d => typeof d !== "string"))) throw new Error("Catalog metadata malformed");
  for (const value of classified ?? []) {
    // Arcade also uses semantic service classes such as EMAIL. Those are not DNS names.
    const domain = host(value);
    if (domain) evidence.push({ domain, source: "metadata" });
  }
  const auth = record(tool.requirements?.authorization);
  const provider = String(auth.provider_id ?? auth.id ?? "").replace(/^arcade-/, "").toLowerCase();
  for (const mapping of integrations) {
    const toolkitMatches = mapping.toolkits.includes(String(tool.toolkit.name).toLowerCase());
    const scopeMatches = provider === mapping.provider && (mapping.scope
      ? Array.isArray(auth.oauth2?.scopes) && auth.oauth2.scopes.some((scope: unknown) => typeof scope === "string" && scope.startsWith(mapping.scope!))
      : true);
    if (toolkitMatches || scopeMatches) for (const domain of mapping.domains)
      evidence.push({ domain, source: toolkitMatches ? "documented-toolkit" : "provider-scope", reference: mapping.source });
  }
  // URL-shaped OAuth scopes explicitly identify a resource host, not arbitrary endpoint text.
  for (const scope of Array.isArray(auth.oauth2?.scopes) ? auth.oauth2.scopes : []) {
    if (typeof scope !== "string" || !scope.startsWith("https://")) continue;
    const domain = host(scope);
    if (domain) evidence.push({ domain, source: "provider-scope" });
  }
  return evidence;
}

/** Structural projection preserves schema property names (including token-related parameter names), never example/default values. */
function schema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 12) throw new Error("Schema nesting limit");
  const raw = record(value);
  const out: Record<string, unknown> = {};
  for (const key of ["type", "description", "format", "title", "enum", "required", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"])
    if (raw[key] !== undefined && (typeof raw[key] !== "object" || Array.isArray(raw[key]))) out[key] = raw[key];
  if (raw.properties) out.properties = Object.fromEntries(Object.entries(record(raw.properties)).map(([key, value]) => [key, schema(value, depth + 1)]));
  if (raw.items) out.items = schema(raw.items, depth + 1);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(raw[key])) out[key] = raw[key].map((v: unknown) => schema(v, depth + 1));
  return out;
}
function valueSchema(raw: Record<string, any>): Record<string, unknown> {
  const types: Record<string, string> = { str: "string", string: "string", int: "integer", integer: "integer", float: "number", number: "number", bool: "boolean", boolean: "boolean", list: "array", array: "array", dict: "object", object: "object", null: "null" };
  const type = types[String(raw.val_type).toLowerCase()];
  return { ...(type ? { type } : {}), ...(Array.isArray(raw.enum) ? { enum: raw.enum.filter((v: unknown) => typeof v === "string") } : {}), ...(type === "array" ? { items: raw.inner_val_type ? valueSchema({ val_type: raw.inner_val_type }) : {} } : {}) };
}
export function describeTool(raw: Record<string, any>, text: (v: string) => string): ConnectorDescription {
  const toolkit = record(raw.toolkit);
  if (typeof raw.qualified_name !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(raw.qualified_name) || typeof toolkit.name !== "string") throw new Error("Catalog malformed");
  const evidence = domainEvidence(raw);
  const parameters = raw.input?.parameters;
  if (parameters !== undefined && !Array.isArray(parameters)) throw new Error("Invalid tool input");
  const safeParameters = (parameters ?? []).map((p: any) => {
    if (typeof p.name !== "string" || p.name.length > 200 || typeof p.value_schema?.val_type !== "string") throw new Error("Invalid tool parameter");
    return { name: p.name, required: p.required === true, description: text(p.description ?? ""), value_schema: { val_type: p.value_schema.val_type, ...(typeof p.value_schema.inner_val_type === "string" ? { inner_val_type: p.value_schema.inner_val_type } : {}), ...(Array.isArray(p.value_schema.enum) ? { enum: p.value_schema.enum.filter((v: unknown) => typeof v === "string").map(text) } : {}) } };
  });
  const formatted = record(raw.formatted_schema);
  const formattedInput = formatted.function?.parameters ?? formatted.parameters ?? formatted.input_schema ?? (formatted.type === "object" ? formatted : undefined);
  const redactSchema = (v: unknown): unknown => typeof v === "string" ? text(v) : Array.isArray(v) ? v.map(redactSchema) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, redactSchema(value)])) : v;
  const inputSchema = formattedInput ? redactSchema(schema(formattedInput)) as Record<string, unknown> : {
    type: "object", properties: Object.fromEntries(safeParameters.map((p: any) => [p.name, { ...valueSchema(p.value_schema), description: p.description }])), required: safeParameters.filter((p: any) => p.required).map((p: any) => p.name), additionalProperties: false,
  };
  const auth = record(raw.requirements?.authorization);
  const requirements: Record<string, unknown> = {};
  if (typeof raw.requirements?.met === "boolean") requirements.met = raw.requirements.met;
  if (Object.keys(auth).length) requirements.authorization = {
    ...Object.fromEntries(["id", "provider_id", "provider_type", "status", "status_reason", "token_status"].filter(k => typeof auth[k] === "string").map(k => [k, text(auth[k])])),
    ...(Array.isArray(auth.oauth2?.scopes) ? { oauth2: { scopes: auth.oauth2.scopes.filter((v: unknown) => typeof v === "string").map(text) } } : {}),
  };
  if (Array.isArray(raw.requirements?.secrets)) requirements.secrets = raw.requirements.secrets.map((s: any) => ({ key: text(String(s.key ?? "")), ...(typeof s.met === "boolean" ? { met: s.met } : {}) }));
  const behavior = record(raw.metadata?.behavior);
  const metadata = {
    ...(raw.metadata?.classification ? { classification: { service_domains: (raw.metadata.classification.service_domains ?? []).map(text) } } : {}),
    behavior: { ...Object.fromEntries(["read_only", "destructive", "idempotent", "open_world"].filter(k => typeof behavior[k] === "boolean").map(k => [k, behavior[k]])), ...(Array.isArray(behavior.operations) ? { operations: behavior.operations.filter((v: unknown) => typeof v === "string").map(text) } : {}) },
  };
  return { id: `arcade:${raw.qualified_name}`, name: raw.qualified_name, toolName: raw.qualified_name, provider: "arcade", description: text(raw.description ?? ""), domains: [...new Set(evidence.map(e => e.domain))], domainEvidence: evidence,
    toolkit: { name: text(toolkit.name), ...(typeof toolkit.description === "string" ? { description: text(toolkit.description) } : {}), ...(typeof toolkit.version === "string" ? { version: toolkit.version } : {}) },
    input: { parameters: safeParameters }, inputSchema: parameters === undefined && !formattedInput ? { type: "object" } : inputSchema, requirements, metadata,
  };
}

/** Complete snapshots only, with at most three page reads in flight after the first page. */
export async function fetchCatalog(api: CatalogAPI, text: (v: string) => string): Promise<CatalogSnapshot> {
  const first = await api("tools?limit=1000&offset=0", undefined, 16_000_000);
  const validate = (data: Record<string, any>, offset: number, total?: number) => {
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 50000 || data.offset !== offset || (total !== undefined && data.total_count !== total) || data.items.length > 1000 || offset + data.items.length > data.total_count) throw new Error("Catalog incomplete");
  };
  validate(first, 0);
  const total = first.total_count;
  const pageSize = first.items.length;
  if (total && !pageSize) throw new Error("Catalog incomplete");
  const pages: Record<string, any>[] = [first];
  if (pageSize && Math.ceil(total / pageSize) > 100) throw new Error("Catalog page budget exceeded");
  for (let offset = pageSize; offset < total;) {
    const offsets = Array.from({ length: Math.min(3, Math.ceil((total - offset) / pageSize)) }, (_, index) => offset + index * pageSize);
    const batch = await Promise.all(offsets.map(async offset => {
      const data = await api(`tools?limit=1000&offset=${offset}`, undefined, 16_000_000);
      validate(data, offset, total);
      if (data.items.length !== Math.min(pageSize, total - offset)) throw new Error("Catalog incomplete");
      return data;
    }));
    pages.push(...batch); offset += pageSize * offsets.length;
  }
  const tools: ConnectorDescription[] = pages.flatMap(page => page.items.map((raw: any) => describeTool(raw, text)));
  const byId = new Map(tools.map(t => [t.id, t]));
  if (byId.size !== tools.length) throw new Error("Catalog contains repeated tools");
  return { tools, byId, completeDomainMetadata: tools.length > 0 && tools.every(t => t.domainEvidence.some(e => e.source === "metadata")), index: new CatalogIndex(tools) };
}

export async function fetchAuthProviders(api: CatalogAPI, text: (v: string) => string): Promise<ConnectorAuthProvider[]> {
  const data = await api("admin/auth_providers");
  if (!Array.isArray(data.items) || (data.total_count !== undefined && data.total_count !== data.items.length) || (data.offset !== undefined && data.offset !== 0)) throw new Error("Auth provider listing incomplete");
  return data.items.map((p: any) => {
    if (typeof p.id !== "string" || !p.id || typeof p.provider_id !== "string") throw new Error("Auth provider listing malformed");
    const providerId = p.provider_id.toLowerCase();
    // Authorization origins are informative only, never used as proof of resource-domain coverage.
    const authorizationDomains = [...new Set([p.oauth2?.authorize_request?.endpoint].map(host).filter((v): v is string => !!v))];
    return { id: text(p.id), providerId: text(p.provider_id), type: text(p.type ?? "unknown"), status: text(p.status ?? "unknown"), description: text(p.description ?? ""), kind: "auth_provider", executable: false,
      domains: [...new Set(integrations.filter(m => m.provider === providerId).flatMap(m => m.domains))], authorizationDomains,
    };
  });
}

const tokens = (text: string) => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** Sparse weighted token index; BM25 ranks only posting-list candidates, not the entire catalog per query. */
export class CatalogIndex {
  private postings = new Map<string, Map<number, number>>();
  private lengths: number[] = [];
  private average = 1;
  constructor(private tools: ConnectorDescription[]) {
    for (const [index, tool] of tools.entries()) {
      const words = [...tokens(tool.toolkit.name).flatMap(t => [t, t, t, t]), ...tokens(tool.name).flatMap(t => [t, t, t]), ...tokens(tool.description.slice(0, 4000))];
      this.lengths[index] = words.length;
      for (const word of words) {
        const posting = this.postings.get(word) ?? new Map<number, number>();
        posting.set(index, (posting.get(index) ?? 0) + 1); this.postings.set(word, posting);
      }
    }
    this.average = this.lengths.reduce((a, b) => a + b, 0) / Math.max(tools.length, 1) || 1;
  }
  search(query: string, domain?: string): ConnectorDescription[] {
    if (domain) return this.tools.filter(t => t.domains.some(d => domain === d || domain.endsWith(`.${d}`))).sort((a, b) => Number(a.toolkit.name.endsWith("Api")) - Number(b.toolkit.name.endsWith("Api")) || a.name.localeCompare(b.name));
    if (!query) return this.tools;
    const scores = new Map<number, number>();
    for (const word of new Set(tokens(query))) {
      const posting = this.postings.get(word); if (!posting) continue;
      const idf = Math.log(1 + (this.tools.length - posting.size + 0.5) / (posting.size + 0.5));
      for (const [index, frequency] of posting) scores.set(index, (scores.get(index) ?? 0) + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * this.lengths[index]! / this.average)));
    }
    // Full provider/qualified-name equality takes precedence over descriptions mentioning another provider.
    this.tools.forEach((tool, index) => {
      if (tool.toolkit.name.toLowerCase() === query || tool.name.toLowerCase() === query) scores.set(index, (scores.get(index) ?? 0) + 1000);
    });
    return [...scores].sort((a, b) => b[1] - a[1] || this.tools[a[0]]!.name.localeCompare(this.tools[b[0]]!.name)).map(([i]) => this.tools[i]!);
  }
}

export class CatalogCache {
  private snapshot?: { value: CatalogSnapshot; until: number };
  private loading?: Promise<CatalogSnapshot>;
  private revalidating?: Promise<void>;
  private failedUntil = 0;
  private providers?: { value: ConnectorAuthProvider[]; until: number };
  private providersLoading?: Promise<ConnectorAuthProvider[]>;
  private providersRevalidating?: Promise<void>;
  private providersFailedUntil = 0;
  async catalog(api: CatalogAPI, text: (v: string) => string): Promise<CatalogSnapshot> {
    if (this.snapshot && this.snapshot.until > Date.now()) return this.snapshot.value;
    if (this.loading) return this.loading;
    if (this.failedUntil > Date.now()) throw new Error("Catalog temporarily unavailable");
    // A stale snapshot serves immediately while a refresh runs in the background;
    // a cold Arcade page walk takes tens of seconds and must not stall callers.
    if (this.snapshot) {
      if (!this.revalidating)
        this.revalidating = fetchCatalog(api, text).then(value => { this.snapshot = { value, until: Date.now() + 1_800_000 }; }, () => undefined).finally(() => { this.revalidating = undefined; });
      return this.snapshot.value;
    }
    this.loading = fetchCatalog(api, text).then(value => { this.snapshot = { value, until: Date.now() + 1_800_000 }; return value; }, error => { this.snapshot = undefined; this.failedUntil = Date.now() + 5000; throw error; }).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  async authProviders(api: CatalogAPI, text: (v: string) => string): Promise<ConnectorAuthProvider[]> {
    if (this.providers && this.providers.until > Date.now()) return this.providers.value;
    if (this.providersLoading) return this.providersLoading;
    if (this.providersFailedUntil > Date.now()) throw new Error("Auth providers temporarily unavailable");
    if (this.providers) {
      if (!this.providersRevalidating)
        this.providersRevalidating = fetchAuthProviders(api, text).then(value => { this.providers = { value, until: Date.now() + 1_800_000 }; }, () => undefined).finally(() => { this.providersRevalidating = undefined; });
      return this.providers.value;
    }
    this.providersLoading = fetchAuthProviders(api, text).then(value => { this.providers = { value, until: Date.now() + 1_800_000 }; return value; }, error => { this.providers = undefined; this.providersFailedUntil = Date.now() + 5000; throw error; }).finally(() => { this.providersLoading = undefined; });
    return this.providersLoading;
  }
}
