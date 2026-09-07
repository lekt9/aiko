import { test, expect } from "bun:test";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  ConnectorEngine,
  connectorStorePrefix,
  type ConnectorStore,
  type SecureBrowserAdapter,
} from "../src/connectors.ts";
import {
  defaultResolvers,
  FilePasswordManagerHost,
  parseManagerAdd,
  openManagerToken,
  sealManagerToken,
  validReference,
} from "../src/password-managers.ts";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";

const cleanup: (() => Promise<void>)[] = [];

class Store implements ConnectorStore {
  rows = new Map<string, unknown>();
  async get(k: string) {
    return structuredClone(this.rows.get(k));
  }
  async set(k: string, v: unknown) {
    this.rows.set(k, structuredClone(v));
  }
  async list(p: string) {
    return [...this.rows]
      .filter(([k]) => k.startsWith(p))
      .map(([, v]) => structuredClone(v));
  }
}

const KEY = Buffer.from(randomBytes(32)).toString("base64");
const alice = "1111111111";

const onePasswordAdd = {
  kind: "onepassword",
  name: "Personal vault",
  token: "synthetic-op-service-token",
  entries: [
    {
      label: "GitHub login",
      website: "https://github.com",
      reference: "op://Vault/GitHub/password",
    },
  ],
};

const fakeBrowser = (
  submitted: { username?: string; password?: string }[] = [],
): SecureBrowserAdapter => ({
  native: true,
  begin: async () => ({
    authorizationUrl: "https://t.me/aiko_bot?start=fixture",
  }),
  control: async (_binding, input) => {
    if (input.action === "credentials") {
      submitted.push({ username: input.username, password: input.password });
      return {
        status: "connected",
        domain: _binding.domain,
        expiresAt: Date.now() + 600000,
        revision: 2,
      };
    }
    return {
      status: "pending",
      domain: _binding.domain,
      fields: ["username", "password"],
      expiresAt: Date.now() + 600000,
      revision: 1,
    };
  },
  status: async (binding) => ({
    ...binding,
    status: "connected" as const,
    verification: {
      verified: true,
      revision: 1,
      expiresAt: Date.now() + 300000,
    },
  }),
});

const engineWith = (
  options: {
    store?: Store;
    browser?: SecureBrowserAdapter;
    managers?: FilePasswordManagerHost;
    owner?: string;
  } = {},
) =>
  new ConnectorEngine({
    owner: options.owner ?? alice,
    store: options.store ?? new Store(),
    secureBrowser: options.browser ?? fakeBrowser(),
    managers: options.managers,
    fetch: async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
  });

test("manager reference validation matches each provider's syntax", () => {
  expect(validReference("onepassword", "op://Vault/Item/password")).toBe(true);
  expect(
    validReference("onepassword", "op://Vault/Item/Section/password"),
  ).toBe(true);
  expect(validReference("onepassword", "op://Vault/Item")).toBe(false);
  expect(
    validReference("onepassword-connect", "op://Vault/Item/password"),
  ).toBe(true);
  expect(
    validReference("onepassword-connect", "op://Vault/Item/Section/password"),
  ).toBe(true);
  expect(validReference("onepassword-connect", "doppler://API_KEY")).toBe(
    false,
  );
  expect(
    validReference("keeper", "keeper://abcdefghijklmnopqrstuv/field/password"),
  ).toBe(true);
  expect(validReference("keeper", "keeper://short/field/password")).toBe(false);
  expect(
    validReference("hashicorp-vault", "vault://secret/data/app/token#value"),
  ).toBe(true);
  expect(
    validReference("hashicorp-vault", "vault://secret/data/../etc#value"),
  ).toBe(false);
  expect(
    validReference("hashicorp-vault", "vault://secret/data/app/token"),
  ).toBe(false);
  expect(validReference("doppler", "doppler://API_KEY")).toBe(true);
  expect(validReference("doppler", "doppler://project/config/NAME")).toBe(
    false,
  );
  expect(() =>
    parseManagerAdd({ ...onePasswordAdd, kind: "bitwarden" }),
  ).toThrow();
  expect(
    parseManagerAdd({ ...onePasswordAdd, kind: "onepassword-connect" }).kind,
  ).toBe("onepassword-connect");
  expect(() => parseManagerAdd({ ...onePasswordAdd, entries: [] })).toThrow();
  expect(() =>
    parseManagerAdd({
      ...onePasswordAdd,
      entries: [
        { label: "a", reference: "op://Vault/A/password" },
        { label: "b", reference: "op://Vault/A/password" },
      ],
    }),
  ).toThrow();
  const parsed = parseManagerAdd({
    ...onePasswordAdd,
    entries: [{ ...onePasswordAdd.entries[0] }],
  });
  expect(parsed.entries[0]?.website).toBe("github.com");
});

test("tokens are sealed at rest and never present in listings", async () => {
  const store = new Store();
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    resolvers: {
      onepassword: async () => "SYNTHETIC-RESOLVED-PASSWORD",
    } as never,
  });
  const view = await host.add(onePasswordAdd);
  expect(view.entries[0]?.reference).toBe("op://Vault/GitHub/password");
  expect(JSON.stringify([...store.rows.values()])).not.toContain(
    "synthetic-op-service-token",
  );
  expect(JSON.stringify(await host.list())).not.toContain(
    "synthetic-op-service-token",
  );
  const key = Buffer.from(KEY, "base64");
  const sealed = sealManagerToken(key, alice, view.id, "round-trip-value");
  expect(openManagerToken(key, alice, view.id, sealed)).toBe(
    "round-trip-value",
  );
  expect(() =>
    openManagerToken(key, "someone-else", view.id, sealed),
  ).toThrow();
  expect(
    await host.resolvePassword(view.id, "op://Vault/GitHub/password"),
  ).toBe("SYNTHETIC-RESOLVED-PASSWORD");
  await expect(
    host.resolvePassword(view.id, "op://Vault/Other/password"),
  ).rejects.toThrow();
});

test("adding without a host sealing key fails closed", async () => {
  const host = new FilePasswordManagerHost({
    store: new Store(),
    owner: alice,
  });
  await expect(host.add(onePasswordAdd)).rejects.toThrow("sealing key");
});

test("removal tombstones the record so in-flight fills fail closed", async () => {
  const store = new Store();
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    resolvers: {
      onepassword: async () => "x",
    } as never,
  });
  const view = await host.add(onePasswordAdd);
  await host.remove(view.id);
  expect(await host.list()).toEqual([]);
  await expect(
    host.resolvePassword(view.id, "op://Vault/GitHub/password"),
  ).rejects.toThrow();
});

test("CSV rows stage app tiles with usernames and never store passwords", async () => {
  const store = new Store();
  const engine = engineWith({ store });
  const result = await engine.importLogins([
    { name: "GitHub", website: "https://github.com", username: "octocat" },
    { website: "notion.so", username: "owner@example.com" },
    { website: "http://insecure.test", username: "x" },
    { website: "https://user:pass@evil.example", username: "x" },
    { website: "https://github.com", username: "duplicate" },
    { username: "no-website" },
  ]);
  expect(result.imported).toBe(2);
  expect(result.updated).toBe(0);
  expect(result.skipped.map((s) => s.row)).toEqual([3, 4, 5, 6]);
  const connections = await engine.connections();
  const github = connections.find(
    (c) => c.connectorId === "browser:github.com",
  );
  expect(github).toMatchObject({
    status: "pending",
    importedUsername: "octocat",
    appName: "GitHub",
  });
  expect(
    connections.find((c) => c.connectorId === "browser:notion.so"),
  ).toMatchObject({ importedUsername: "owner@example.com" });
  expect(JSON.stringify([...store.rows.values()])).not.toContain(
    "SYNTHETIC-PASSWORD",
  );
  // Same domain again updates the staged username instead of duplicating the tile.
  const second = await engine.importLogins([
    { website: "github.com", username: "octocat" },
  ]);
  expect(second.imported).toBe(0);
});

test("fill resolves the saved reference server-side and submits it privately", async () => {
  const store = new Store();
  const submitted: { username?: string; password?: string }[] = [];
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    resolvers: {
      onepassword: async (_token: string, reference: string) =>
        reference === "op://Vault/GitHub/password"
          ? "SYNTHETIC-FILLED-PASSWORD"
          : (() => {
              throw new Error("unavailable");
            })(),
    } as never,
  });
  const manager = await host.add(onePasswordAdd);
  const engine = engineWith({
    store,
    browser: fakeBrowser(submitted),
    managers: host,
  });
  await engine.importLogins([
    { name: "GitHub", website: "https://github.com", username: "octocat" },
  ]);
  const connection = (await engine.connections()).find(
    (c) => c.connectorId === "browser:github.com",
  )!;
  const result = await engine.fillFromManager({
    connectionId: connection.id,
    managerId: manager.id,
    reference: "op://Vault/GitHub/password",
  });
  expect(submitted).toEqual([
    { username: "octocat", password: "SYNTHETIC-FILLED-PASSWORD" },
  ]);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC-FILLED-PASSWORD");
  expect(
    (await engine.connections()).find((c) => c.id === connection.id)?.status,
  ).toBe("connected");
});

test("fill fails closed on unknown managers, foreign references and unresolvable tokens", async () => {
  const store = new Store();
  const submitted: { username?: string; password?: string }[] = [];
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    resolvers: {
      onepassword: async () => {
        throw new Error("provider down");
      },
    } as never,
  });
  const manager = await host.add(onePasswordAdd);
  const engine = engineWith({
    store,
    browser: fakeBrowser(submitted),
    managers: host,
  });
  await engine.importLogins([
    { website: "https://github.com", username: "octocat" },
  ]);
  const connection = (await engine.connections())[0]!;
  await expect(
    engine.fillFromManager({
      connectionId: connection.id,
      managerId: randomUUID(),
      reference: "op://Vault/GitHub/password",
    }),
  ).rejects.toThrow();
  await expect(
    engine.fillFromManager({
      connectionId: connection.id,
      managerId: manager.id,
      reference: "op://Vault/Other/password",
    }),
  ).rejects.toThrow();
  await expect(
    engine.fillFromManager({
      connectionId: connection.id,
      managerId: manager.id,
      reference: "op://Vault/GitHub/password",
    }),
  ).rejects.toThrow();
  expect(submitted).toEqual([]);
  // A foreign owner's engine cannot even see the connection.
  const foreign = engineWith({ store, owner: "2222222222", managers: host });
  await expect(
    foreign.fillFromManager({
      connectionId: connection.id,
      managerId: manager.id,
      reference: "op://Vault/GitHub/password",
    }),
  ).rejects.toThrow();
});

test("fill without a stored username asks for one instead of guessing", async () => {
  const store = new Store();
  const submitted: { username?: string; password?: string }[] = [];
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    resolvers: {
      onepassword: async () => "SYNTHETIC-PASSWORD",
    } as never,
  });
  const manager = await host.add(onePasswordAdd);
  const engine = engineWith({
    store,
    browser: fakeBrowser(submitted),
    managers: host,
  });
  await engine.importLogins([{ website: "https://github.com" }]);
  const connection = (await engine.connections())[0]!;
  await expect(
    engine.fillFromManager({
      connectionId: connection.id,
      managerId: manager.id,
      reference: "op://Vault/GitHub/password",
    }),
  ).rejects.toThrow("username");
  const result = await engine.fillFromManager({
    connectionId: connection.id,
    managerId: manager.id,
    reference: "op://Vault/GitHub/password",
    username: "typed@example.com",
  });
  expect(submitted[0]?.username).toBe("typed@example.com");
  expect(result.status).toBe("connected");
});

test("password manager routes authenticate and round-trip through the connector API", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-managers-api-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const token = "aiko_test_manager_api_token_1234567890";
  const submitted: { username?: string; password?: string }[] = [];
  const config: AikoConfig = {
    mode: "demo",
    port: 4242,
    stateDir,
    operatorToken: "private-test-operator-1234567890123456",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["1111111111"]),
    arcadeKey: "private-test-arcade-key-123456",
    managerKey: KEY,
    planeCredentials: [
      {
        account: "1111111111",
        digest: credentialDigest(token),
        scopes: ["read", "write"],
      },
    ],
  };
  const service = await createService(config, {
    connectorFetch: async () => Response.json({ items: [] }),
    connectorBrowser: () => fakeBrowser(submitted),
    managerResolvers: {
      onepassword: async (_token: string, reference: string) =>
        reference === "op://Vault/GitHub/password"
          ? "SYNTHETIC-RESOLVED-PASSWORD"
          : (() => {
              throw new Error("unavailable");
            })(),
    } as never,
  });
  cleanup.push(() => service.close());
  const request = (path: string, body?: unknown, authorization?: string) =>
    service.fetch(
      new Request("http://127.0.0.1:4242" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(authorization
            ? { Authorization: "Bearer " + authorization }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  expect((await request("/api/connectors/password-managers")).status).toBe(401);
  expect(
    await (
      await request("/api/connectors/password-managers", undefined, token)
    ).json(),
  ).toEqual({ managers: [] });
  const added = await request(
    "/api/connectors/password-managers/add",
    onePasswordAdd,
    token,
  );
  expect(added.status).toBe(200);
  const view = (await added.json()) as {
    id: string;
    entries: { reference: string }[];
  };
  expect(view.entries[0]?.reference).toBe("op://Vault/GitHub/password");
  expect(JSON.stringify(view)).not.toContain("synthetic-op-service-token");
  const invalid = await request(
    "/api/connectors/password-managers/add",
    { ...onePasswordAdd, name: "" },
    token,
  );
  expect(invalid.status).toBe(400);
  expect(((await invalid.json()) as { message?: string }).message).toContain(
    "name",
  );
  const staged = await request(
    "/api/connectors/imports/logins",
    {
      rows: [
        { name: "GitHub", website: "https://github.com", username: "octocat" },
      ],
    },
    token,
  );
  expect(staged.status).toBe(200);
  expect(((await staged.json()) as { imported: number }).imported).toBe(1);
  const connections = (await (
    await request("/api/connectors/connections", undefined, token)
  ).json()) as { connections: { id: string; importedUsername?: string }[] };
  const connection = connections.connections.find(
    (c) => c.importedUsername === "octocat",
  );
  expect(connection).toBeDefined();
  const fill = await request(
    "/api/connectors/password-managers/fill",
    {
      connectionId: connection!.id,
      managerId: view.id,
      reference: "op://Vault/GitHub/password",
    },
    token,
  );
  expect(fill.status).toBe(200);
  expect(((await fill.json()) as { status: string }).status).toBe("connected");
  expect(submitted[0]?.password).toBe("SYNTHETIC-RESOLVED-PASSWORD");
  expect(JSON.stringify(submitted)).not.toContain("synthetic-op-service-token");
});

test("onepassword-connect resolves references through the Connect REST API", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Token connect-credentials-token",
    );
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (
      url.endsWith(`/v1/vaults?filter=${encodeURIComponent('name eq "Vault"')}`)
    )
      return json([
        { id: "11111111-1111-4111-8111-111111111111", name: "Vault" },
      ]);
    if (
      url.includes(
        "/v1/vaults/11111111-1111-4111-8111-111111111111/items?filter=",
      )
    )
      return json([
        { id: "22222222-2222-4222-8222-222222222222", title: "GitHub" },
      ]);
    if (
      url.endsWith(
        "/v1/vaults/11111111-1111-4111-8111-111111111111/items/22222222-2222-4222-8222-222222222222",
      )
    )
      return json({
        fields: [
          { label: "username", type: "TEXT", value: "canary" },
          {
            label: "password",
            type: "CONCEALED",
            value: "SYNTHETIC-CONNECT-PASSWORD",
          },
        ],
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const resolvers = defaultResolvers(
      undefined,
      undefined,
      "https://connect.aiko-check.net",
    );
    const value = await resolvers["onepassword-connect"](
      "connect-credentials-token",
      "op://Vault/GitHub/password",
    );
    expect(value).toBe("SYNTHETIC-CONNECT-PASSWORD");
    expect(calls.length).toBe(3);
    await expect(
      resolvers["onepassword-connect"](
        "connect-credentials-token",
        "op://Missing/Item/password",
      ),
    ).rejects.toThrow("Could not reach onepassword-connect");
    // Without operator configuration the kind fails closed without touching the network.
    await expect(
      defaultResolvers()["onepassword-connect"](
        "connect-credentials-token",
        "op://Vault/GitHub/password",
      ),
    ).rejects.toThrow("Could not reach onepassword-connect");
    // The missing vault performed one lookup before failing closed; the
    // offline check (no operator URL) touched the network zero times.
    expect(calls.length).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a sandbox resolver overrides only its kind, like the deployed VM path", async () => {
  const store = new Store();
  const submitted: { username?: string; password?: string }[] = [];
  let sandboxCalls = 0;
  const host = new FilePasswordManagerHost({
    store,
    owner: alice,
    key: KEY,
    sandboxResolvers: {
      onepassword: async (token: string, reference: string) => {
        sandboxCalls++;
        expect(token).toBe("synthetic-op-service-token");
        return "SANDBOX-RESOLVED-PASSWORD";
      },
    },
  });
  const manager = await host.add(onePasswordAdd);
  const engine = engineWith({
    store,
    browser: fakeBrowser(submitted),
    managers: host,
  });
  await engine.importLogins([
    { name: "GitHub", website: "https://github.com", username: "octocat" },
  ]);
  const connection = (await engine.connections()).find(
    (c) => c.connectorId === "browser:github.com",
  )!;
  const result = await engine.fillFromManager({
    connectionId: connection.id,
    managerId: manager.id,
    reference: "op://Vault/GitHub/password",
  });
  expect(sandboxCalls).toBe(1);
  expect(submitted[0]?.password).toBe("SANDBOX-RESOLVED-PASSWORD");
  expect(result.status).toBe("connected");
});

test("the embedded wasm build initializes the 1Password core end to end", async () => {
  const wasm = await Bun.file(
    "node_modules/@1password/sdk-core/nodejs/core_bg.wasm",
  ).arrayBuffer();
  const b64 = Buffer.from(wasm).toString("base64");
  const entry = `${import.meta.dir}/fixture-op-entry.mjs`;
  await Bun.write(
    entry,
    `import { resolveOnePassword } from ${JSON.stringify(
      new URL("../src/onepassword-core.ts", import.meta.url).pathname,
    )};
try {
  await resolveOnePassword("ops_definitely_not_a_real_token", "op://Vault/Item/password");
  console.log("UNEXPECTED-RESOLVE");
} catch (error) {
  console.log("CORE-ERROR:", String(error.message).slice(0, 60));
}`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: false,
    define: { OP_WASM_B64: JSON.stringify(b64) },
  });
  expect(build.success).toBe(true);
  const artifact = `${import.meta.dir}/fixture-op-bundle.mjs`;
  await Bun.write(artifact, build.outputs[0]!);
  const proc = Bun.spawnSync(["bun", artifact], { cwd: import.meta.dir });
  const out = proc.stdout.toString();
  expect(out).not.toContain("UNEXPECTED-RESOLVE");
  // The Rust core parsed the token shape: the wasm bridge works in the embedded build.
  expect(out).toContain("CORE-ERROR:");
  expect(out.toLowerCase()).toContain("service account token");
  await rm(entry, { force: true });
  await rm(artifact, { force: true });
});
