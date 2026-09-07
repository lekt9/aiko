/** Private MCP client. Never register the upstream secret-reading tool with the model. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export type ManagerProvider = {
  id: string;
  name: string;
  kind: string;
  url: string;
  redirectUrl: string;
  /** Explicit operator allowlist for OAuth discovery, registration and token endpoints. */
  authorizationOrigins: string[];
  clientId?: string;
  scope?: string;
  tool: string;
  referenceArgument: string;
  /** Path within structuredContent, or a single JSON text content block; [] means plain text. */
  valuePath: string[];
};
export type ManagerGrant = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
  expiresAt?: number;
};

function httpsUrl(value: unknown): URL {
  if (typeof value !== "string")
    throw new Error("Invalid password manager provider URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error(
      "Password manager provider URLs must use HTTPS without credentials or query parameters",
    );
  return url;
}

export function parseManagerProviders(raw?: string): ManagerProvider[] {
  if (!raw) return [];
  const providers: unknown = JSON.parse(raw);
  if (!Array.isArray(providers) || providers.length > 20)
    throw new Error("Invalid password manager providers");
  const ids = new Set<string>();
  return providers.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw new Error("Invalid password manager provider");
    if (
      Object.keys(p).some(
        (key) =>
          ![
            "id",
            "name",
            "kind",
            "url",
            "redirectUrl",
            "authorizationOrigins",
            "clientId",
            "scope",
            "tool",
            "referenceArgument",
            "valuePath",
          ].includes(key),
      )
    )
      throw new Error("Unsupported password manager provider configuration");
    if (
      ![
        "remote-mcp",
        "bitwarden",
        "onepassword",
        "onepassword-connect",
        "keeper",
        "hashicorp-vault",
        "doppler",
      ].includes(p.kind)
    )
      throw new Error("Unsupported password manager provider kind");
    for (const key of ["id", "name", "kind", "tool", "referenceArgument"])
      if (typeof p[key] !== "string" || !/^[\w .:-]{1,100}$/.test(p[key]))
        throw new Error("Invalid password manager provider field");
    if (ids.has(p.id)) throw new Error("Duplicate password manager provider");
    ids.add(p.id);
    const url = httpsUrl(p.url).href;
    const redirectUrl = httpsUrl(p.redirectUrl).href;
    if (
      !Array.isArray(p.authorizationOrigins) ||
      !p.authorizationOrigins.length ||
      p.authorizationOrigins.length > 10
    )
      throw new Error("Configure password manager OAuth authorization origins");
    const authorizationOrigins = p.authorizationOrigins.map(
      (origin: unknown) => {
        const parsed = httpsUrl(origin);
        if (parsed.pathname !== "/")
          throw new Error("OAuth allowlist entries must be origins");
        return parsed.origin;
      },
    );
    if (
      !Array.isArray(p.valuePath) ||
      p.valuePath.length > 10 ||
      p.valuePath.some(
        (key: unknown) =>
          typeof key !== "string" ||
          !/^[\w-]{1,100}$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      throw new Error("Invalid password manager value path");
    for (const key of ["clientId", "scope"])
      if (
        p[key] !== undefined &&
        (typeof p[key] !== "string" ||
          p[key].length > 2048 ||
          /\p{C}/u.test(p[key]))
      )
        throw new Error("Invalid OAuth client configuration");
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      url,
      redirectUrl,
      authorizationOrigins,
      tool: p.tool,
      referenceArgument: p.referenceArgument,
      valuePath: p.valuePath,
      ...(p.clientId ? { clientId: p.clientId } : {}),
      ...(p.scope ? { scope: p.scope } : {}),
    };
  });
}

export function extractManagerPassword(
  result: Record<string, unknown>,
  path: string[],
): string {
  if (result.isError) throw new Error("Password manager tool failed");
  let value: unknown = result.structuredContent;
  if (value === undefined) {
    const content = result.content;
    if (
      !Array.isArray(content) ||
      content.length !== 1 ||
      content[0]?.type !== "text"
    )
      throw new Error("Invalid password manager result");
    value = path.length ? JSON.parse(content[0].text) : content[0].text;
  }
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("Invalid password manager result");
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== "string" || !value || value.length > 2048)
    throw new Error("Invalid password manager result");
  return value;
}

/** A fresh client per operation avoids cross-owner sessions and keeps secrets transient. */
export async function managerMcp(
  provider: ManagerProvider,
  grant: ManagerGrant,
  input: { code?: string; reference?: string; signal?: AbortSignal },
  fetchFn: FetchLike = fetch,
): Promise<{ authorizationUrl?: string; password?: string }> {
  let authorizationUrl: string | undefined;
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const allowed = new Set([
    new URL(provider.url).origin,
    ...provider.authorizationOrigins,
  ]);
  const guardedFetch: FetchLike = async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !allowed.has(target.origin)
    )
      throw new Error("Untrusted password manager endpoint");
    return fetchFn(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(15_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  };
  const authProvider: OAuthClientProvider = {
    redirectUrl: provider.redirectUrl,
    clientMetadata: {
      client_name: "Unlock",
      redirect_uris: [provider.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(provider.scope ? { scope: provider.scope } : {}),
    },
    state: () => {
      if (!grant.state) throw new Error("Reconnect your password manager");
      return grant.state;
    },
    clientInformation: () =>
      provider.clientId ? { client_id: provider.clientId } : grant.client,
    saveClientInformation: (client) => {
      grant.client = client;
    },
    tokens: () => grant.tokens,
    saveTokens: (tokens) => {
      grant.tokens = tokens;
    },
    saveCodeVerifier: (verifier) => {
      grant.verifier = verifier;
    },
    codeVerifier: () => {
      if (!grant.verifier) throw new Error("Reconnect your password manager");
      return grant.verifier;
    },
    redirectToAuthorization: (url) => {
      if (
        !grant.state ||
        !grant.expiresAt ||
        grant.expiresAt < Date.now() ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !provider.authorizationOrigins.includes(url.origin)
      )
        throw new Error("Reconnect your password manager");
      authorizationUrl = url.href;
    },
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "tokens") delete grant.tokens;
      if (scope === "all" || scope === "client") delete grant.client;
      if (scope === "all" || scope === "verifier") delete grant.verifier;
    },
  };
  const client = new Client({
    name: "unlock-private-password-fill",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(provider.url), {
    authProvider,
    fetch: guardedFetch,
  });
  try {
    if (input.code) await transport.finishAuth(input.code);
    await client.connect(transport, { timeout: 15_000, signal });
    // An unauthenticated, shared remote vault is not an owner-bound authorization.
    if (!grant.tokens) throw new Error("Password manager requires OAuth");
    let cursor: string | undefined;
    let found = false;
    for (let page = 0; page < 10; page++) {
      const listing = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: 15_000,
        signal,
      });
      const tool = listing.tools.find((entry) => entry.name === provider.tool);
      if (tool) {
        if (
          !Object.hasOwn(
            tool.inputSchema.properties ?? {},
            provider.referenceArgument,
          )
        )
          throw new Error("Password manager tool schema changed");
        found = true;
        break;
      }
      cursor = listing.nextCursor;
      if (!cursor) break;
    }
    if (!found) throw new Error("Password manager reference tool unavailable");
    if (!input.reference) return {};
    const result = await client.callTool(
      {
        name: provider.tool,
        arguments: { [provider.referenceArgument]: input.reference },
      },
      undefined,
      { timeout: 15_000, signal },
    );
    return { password: extractManagerPassword(result, provider.valuePath) };
  } catch (error) {
    if (
      error instanceof UnauthorizedError &&
      authorizationUrl &&
      !input.reference
    )
      return { authorizationUrl };
    // Never expose upstream errors: they can contain passwords, codes or tokens.
    throw new Error(
      "Could not use this password manager. Reconnect and try again.",
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
