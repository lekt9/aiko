import { test, expect } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ConnectorEngine,
  type ConnectorStore,
  type SecureBrowserAdapter,
} from "../src/connectors.ts";
import {
  FilePasswordManagerHost,
  parseManagerAdd,
  sealManagerToken,
  openManagerToken,
} from "../src/password-managers.ts";
import {
  extractManagerPassword,
  parseManagerProviders,
} from "../src/password-manager-mcp.ts";
import { connectorApi } from "../src/connector-api.ts";

class Store implements ConnectorStore {
  rows = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.rows.get(key));
  }
  async set(key: string, value: unknown) {
    this.rows.set(key, structuredClone(value));
  }
  async list(prefix: string) {
    return [...this.rows]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => structuredClone(value));
  }
}
const KEY = randomBytes(32).toString("base64");
const owner = "1111111111";
const providers = parseManagerProviders(
  JSON.stringify([
    {
      id: "personal",
      name: "Personal vault",
      kind: "onepassword",
      url: "https://mcp.example/mcp",
      redirectUrl: "https://unlock.example/password-manager-callback.html",
      authorizationOrigins: ["https://auth.example"],
      tool: "read_secret",
      referenceArgument: "reference",
      valuePath: ["password"],
    },
  ]),
);
const add = {
  kind: "onepassword",
  providerId: "personal",
  name: "Personal vault",
  entries: [
    {
      label: "GitHub",
      website: "https://github.com",
      reference: "op://Vault/GitHub/password",
    },
  ],
};
const PASSWORD = "SYNTHETIC-PRIVATE-PASSWORD";
const ACCESS = "SYNTHETIC-ACCESS-TOKEN";
const REFRESH = "SYNTHETIC-REFRESH-TOKEN";

/** Exercises the real SDK's discovery, PKCE, registration and MCP transport over a fake network. */
function network() {
  const calls: {
    url: string;
    method: string;
    body?: any;
    authorization?: string | null;
  }[] = [];
  let rejectAccess = false;
  let failTool = false;
  let metadataOrigin = "https://auth.example";
  let onTool: (() => Promise<void>) | undefined;
  const fetcher: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const raw = String(init?.body ?? "");
    const body = raw.startsWith("{")
      ? JSON.parse(raw)
      : raw
        ? Object.fromEntries(new URLSearchParams(raw))
        : undefined;
    const authorization = new Headers(init?.headers).get("Authorization");
    calls.push({ url: url.href, method, body, authorization });
    expect(init?.redirect).toBe("error");
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://mcp.example/mcp",
        authorization_servers: [metadataOrigin],
      });
    if (
      url.pathname.includes("oauth-authorization-server") ||
      url.pathname.includes("openid-configuration")
    )
      return Response.json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return Response.json(
        { ...body, client_id: "unlock-test-client" },
        { status: 201 },
      );
    if (url.pathname === "/token") {
      rejectAccess = false;
      return Response.json({
        access_token: ACCESS,
        refresh_token: REFRESH,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
    if (!authorization || rejectAccess)
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
        },
      });
    expect(authorization).toBe(`Bearer ${ACCESS}`);
    if (method !== "POST") return new Response(null, { status: 405 });
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    else if (body.method === "tools/list")
      result = {
        tools: [
          {
            name: "read_secret",
            inputSchema: {
              type: "object",
              properties: { reference: { type: "string" } },
              required: ["reference"],
            },
          },
          { name: "delete_vault", inputSchema: { type: "object" } },
        ],
      };
    else if (body.method === "tools/call") {
      expect(body.params).toEqual({
        name: "read_secret",
        arguments: { reference: add.entries[0]!.reference },
      });
      await onTool?.();
      result = failTool
        ? {
            isError: true,
            content: [{ type: "text", text: PASSWORD + ACCESS }],
          }
        : { content: [], structuredContent: { password: PASSWORD } };
    } else throw new Error("Unexpected MCP operation");
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }) as typeof fetch;
  return {
    calls,
    fetch: fetcher,
    expire: () => {
      rejectAccess = true;
    },
    fail: () => {
      failTool = true;
    },
    redirectDiscovery: () => {
      metadataOrigin = "https://untrusted.example";
    },
    duringTool: (fn: () => Promise<void>) => {
      onTool = fn;
    },
  };
}
function fixture() {
  const store = new Store();
  const remote = network();
  const host = new FilePasswordManagerHost({
    store,
    owner,
    key: KEY,
    providers,
    fetch: remote.fetch,
  });
  const submitted: unknown[] = [];
  const browser: SecureBrowserAdapter = {
    native: true,
    begin: async () => ({
      authorizationUrl: "https://t.me/aiko_bot?start=fixture",
    }),
    control: async (_binding, input) => {
      submitted.push(input);
      return {
        status: "connected",
        domain: _binding.domain,
        expiresAt: Date.now() + 60_000,
        revision: 2,
      };
    },
    status: async (binding) => ({
      ...binding,
      status: "connected",
      verification: {
        verified: true,
        revision: 1,
        expiresAt: Date.now() + 60_000,
      },
    }),
  };
  const engine = new ConnectorEngine({
    owner,
    store,
    secureBrowser: browser,
    managers: host,
    fetch: async () => Response.json({ items: [] }),
  });
  return { store, remote, host, engine, submitted };
}
async function connect(f: ReturnType<typeof fixture>) {
  const manager = await f.host.add(add);
  expect(manager.status).toBe("authorization_required");
  const url = new URL(manager.authorizationUrl!);
  expect(url.origin).toBe("https://auth.example");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe(providers[0]!.redirectUrl);
  const state = url.searchParams.get("state")!;
  await f.host.finishAuthorization(manager.id, state, "synthetic-code");
  const tokenRequest = f.remote.calls.find((call) =>
    call.url.endsWith("/token"),
  )!.body;
  expect(
    createHash("sha256").update(tokenRequest.code_verifier).digest("base64url"),
  ).toBe(url.searchParams.get("code_challenge")!);
  expect(tokenRequest.resource).toBe("https://mcp.example/mcp");
  return { ...manager, state };
}

test("new connections reject pasted tokens, arbitrary endpoints and duplicate references", () => {
  expect(() => parseManagerAdd({ ...add, token: "old-token" })).toThrow(
    "pasted tokens",
  );
  expect(() =>
    parseManagerAdd({ ...add, url: "https://evil.example" }),
  ).toThrow();
  expect(() => parseManagerAdd({ ...add, entries: [] })).toThrow();
  expect(() =>
    parseManagerAdd({ ...add, entries: [...add.entries, ...add.entries] }),
  ).toThrow();
  expect(parseManagerAdd(add).entries[0]?.website).toBe("github.com");
  expect(() =>
    parseManagerProviders(
      JSON.stringify([{ ...providers[0], url: "http://localhost/mcp" }]),
    ),
  ).toThrow();
  expect(() =>
    parseManagerProviders(
      JSON.stringify([{ ...providers[0], valuePath: ["__proto__"] }]),
    ),
  ).toThrow();
});

test("OAuth PKCE grants are sealed, owner-bound and never appear in listings", async () => {
  const f = fixture();
  const manager = await connect(f);
  expect((await f.host.list())[0]?.status).toBe("connected");
  for (const secret of [ACCESS, REFRESH, "synthetic-code"]) {
    expect(JSON.stringify([...f.store.rows.values()])).not.toContain(secret);
    expect(JSON.stringify(await f.host.list())).not.toContain(secret);
  }
  const sealed = sealManagerToken(
    Buffer.from(KEY, "base64"),
    owner,
    manager.id,
    "round-trip",
  );
  expect(
    openManagerToken(Buffer.from(KEY, "base64"), owner, manager.id, sealed),
  ).toBe("round-trip");
  expect(() =>
    openManagerToken(
      Buffer.from(KEY, "base64"),
      "someone-else",
      manager.id,
      sealed,
    ),
  ).toThrow();
  await expect(
    f.host.finishAuthorization(manager.id, manager.state, "synthetic-code"),
  ).rejects.toThrow("expired or invalid");
  const foreign = new FilePasswordManagerHost({
    store: f.store,
    owner: "2222222222",
    key: KEY,
    providers,
    fetch: f.remote.fetch,
  });
  expect(await foreign.list()).toEqual([]);
  await expect(
    foreign.resolvePassword(
      manager.id,
      add.entries[0]!.reference,
      "github.com",
    ),
  ).rejects.toThrow();
});

test("private fill resolves only the saved reference and never publishes the password", async () => {
  const f = fixture();
  const manager = await connect(f);
  await f.engine.importLogins([{ website: "github.com", username: "octocat" }]);
  const connection = (await f.engine.connections())[0]!;
  const result = await f.engine.fillFromManager({
    connectionId: connection.id,
    managerId: manager.id,
    reference: add.entries[0]!.reference,
  });
  expect(f.submitted).toEqual([
    {
      action: "login",
      username: "octocat",
      password: PASSWORD,
      credentialReference: {
        managerId: manager.id,
        reference: add.entries[0]!.reference,
      },
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(PASSWORD);
  expect(JSON.stringify([...f.store.rows.values()])).not.toContain(PASSWORD);
  expect(
    f.remote.calls.filter((call) => call.body?.method === "tools/call"),
  ).toHaveLength(1);
});

test("foreign references and wrong destinations fail before contacting the provider", async () => {
  const f = fixture();
  const manager = await connect(f);
  const count = f.remote.calls.length;
  await expect(
    f.host.resolvePassword(
      manager.id,
      "op://Other/Item/password",
      "github.com",
    ),
  ).rejects.toThrow();
  await expect(
    f.host.resolvePassword(manager.id, add.entries[0]!.reference, "notion.so"),
  ).rejects.toThrow("different website");
  await expect(
    f.host.resolvePassword(manager.id, add.entries[0]!.reference),
  ).rejects.toThrow("different website");
  expect(f.remote.calls).toHaveLength(count);
});

test("expired grants refresh privately and provider errors never echo secrets", async () => {
  const f = fixture();
  const manager = await connect(f);
  f.remote.expire();
  expect(
    await f.host.resolvePassword(
      manager.id,
      add.entries[0]!.reference,
      "github.com",
    ),
  ).toBe(PASSWORD);
  expect(
    f.remote.calls.some(
      (call) =>
        call.body?.grant_type === "refresh_token" &&
        call.body.refresh_token === REFRESH,
    ),
  ).toBe(true);
  f.remote.fail();
  await expect(
    f.host.resolvePassword(manager.id, add.entries[0]!.reference, "github.com"),
  ).rejects.toThrow(
    "Could not use this password manager. Reconnect and try again.",
  );
});

test("disconnect during resolution erases grants and prevents the in-flight fill", async () => {
  const f = fixture();
  const manager = await connect(f);
  f.remote.duringTool(() => f.host.remove(manager.id));
  await expect(
    f.host.resolvePassword(manager.id, add.entries[0]!.reference, "github.com"),
  ).rejects.toThrow();
  expect(await f.host.list()).toEqual([]);
  expect(
    [...f.store.rows.values()].every(
      (row) => !(row as { sealed?: unknown }).sealed,
    ),
  ).toBe(true);
});

test("wrong, expired and foreign OAuth state cannot exchange a code", async () => {
  const f = fixture();
  const manager = await f.host.add(add);
  const count = f.remote.calls.length;
  await expect(
    f.host.finishAuthorization(manager.id, "wrong", "code"),
  ).rejects.toThrow();
  expect(f.remote.calls).toHaveLength(count);
  const row = [...f.store.rows.values()][0] as any;
  const grant = JSON.parse(
    openManagerToken(Buffer.from(KEY, "base64"), owner, row.id, row.sealed),
  );
  grant.expiresAt = Date.now() - 1;
  row.sealed = sealManagerToken(
    Buffer.from(KEY, "base64"),
    owner,
    row.id,
    JSON.stringify(grant),
  );
  await expect(
    f.host.finishAuthorization(manager.id, grant.state, "code"),
  ).rejects.toThrow();
  expect(f.remote.calls).toHaveLength(count);
});

test("OAuth discovery cannot redirect credentials to an unconfigured origin", async () => {
  const f = fixture();
  f.remote.redirectDiscovery();
  await expect(f.host.add(add)).rejects.toThrow(
    "Could not use this password manager",
  );
  expect(
    f.remote.calls.every((call) => !call.url.includes("untrusted.example")),
  ).toBe(true);
});

test("missing sealing key and provider configuration fail closed", async () => {
  const f = fixture();
  await expect(
    new FilePasswordManagerHost({ store: f.store, owner, providers }).add(add),
  ).rejects.toThrow("sealing key");
  await expect(
    f.host.add({ ...add, providerId: "unconfigured" }),
  ).rejects.toThrow();
});

test("provider configuration changes invalidate existing grants", async () => {
  const f = fixture();
  const manager = await connect(f);
  const host = new FilePasswordManagerHost({
    store: f.store,
    owner,
    key: KEY,
    providers: [{ ...providers[0]!, tool: "different_tool" }],
    fetch: f.remote.fetch,
  });
  await expect(
    host.resolvePassword(manager.id, add.entries[0]!.reference, "github.com"),
  ).rejects.toThrow("configuration changed");
});

test("legacy token rows require reconnection and can be removed", async () => {
  const f = fixture();
  const manager = await connect(f);
  const row = [...f.store.rows.values()][0] as any;
  delete row.providerId;
  delete row.status;
  expect((await f.host.list())[0]?.status).toBe("authorization_required");
  await expect(
    f.host.resolvePassword(manager.id, add.entries[0]!.reference, "github.com"),
  ).rejects.toThrow("OAuth");
  await f.host.remove(manager.id);
  expect(await f.host.list()).toEqual([]);
});

test("MCP result extraction accepts explicit fields and rejects errors and ambiguous content", () => {
  expect(
    extractManagerPassword(
      { content: [{ type: "text", text: '{"login":{"password":"secret"}}' }] },
      ["login", "password"],
    ),
  ).toBe("secret");
  expect(
    extractManagerPassword({ content: [{ type: "text", text: "secret" }] }, []),
  ).toBe("secret");
  for (const result of [
    { isError: true, structuredContent: { password: "secret" } },
    { structuredContent: { password: {} } },
    {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    },
  ])
    expect(() => extractManagerPassword(result, ["password"])).toThrow();
});

test("connector API exposes provider metadata and completes OAuth without returning credentials", async () => {
  const f = fixture();
  const request = (path: string, body?: object) =>
    connectorApi(
      new Request(
        `https://unlock.example/api/connectors/password-managers${path}`,
        {
          method: body ? "POST" : "GET",
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      ),
      f.engine,
    );
  const listing = (await (await request("")).json()) as any;
  expect(listing.providers).toEqual([
    { id: "personal", name: "Personal vault", kind: "onepassword" },
  ]);
  const manager = (await (await request("/add", add)).json()) as any;
  const state = new URL(manager.authorizationUrl).searchParams.get("state");
  const result = await request("/callback", {
    managerId: manager.id,
    state,
    code: "synthetic-code",
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: "connected" });
  expect(
    (
      await request("/callback", {
        managerId: manager.id,
        state,
        code: "synthetic-code",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("/add", { ...add, token: "no-more-tokens" })).status,
  ).toBe(400);
});

test("CSV import stages metadata and username is still required before filling", async () => {
  const f = fixture();
  const manager = await connect(f);
  const result = await f.engine.importLogins([
    { website: "github.com" },
    { website: "http://insecure.test" },
    { website: "https://user:pass@evil.example" },
  ]);
  expect(result.imported).toBe(1);
  expect(result.skipped).toHaveLength(2);
  const connection = (await f.engine.connections())[0]!;
  await expect(
    f.engine.fillFromManager({
      connectionId: connection.id,
      managerId: manager.id,
      reference: add.entries[0]!.reference,
    }),
  ).rejects.toThrow("username");
  expect(f.submitted).toEqual([]);
});

test("cancellation during reference lookup prevents credential submission", async () => {
  const f = fixture();
  const manager = await connect(f);
  await f.engine.importLogins([{ website: "github.com", username: "octocat" }]);
  const connection = (await f.engine.connections())[0]!;
  const controller = new AbortController();
  f.remote.duringTool(async () => {
    controller.abort();
  });
  await expect(
    f.engine.fillFromManager(
      {
        connectionId: connection.id,
        managerId: manager.id,
        reference: add.entries[0]!.reference,
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(f.submitted).toEqual([]);
});
