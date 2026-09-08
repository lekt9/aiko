import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { deriveZohoVaultKey, decryptZohoVaultField } from "@unlock/protocol";
import vector from "./fixtures/zoho-vault-vectors.json";
import { parseManagerProviders } from "../src/password-manager-mcp.ts";
import {
  FilePasswordManagerHost,
  openManagerToken,
  sealManagerToken,
} from "../src/password-managers.ts";
import {
  ConnectorEngine,
  type ConnectorStore,
  type SecureBrowserAdapter,
} from "../src/connectors.ts";
import { connectorApi } from "../src/connector-api.ts";

const config = {
  id: "zoho",
  name: "Zoho Vault",
  kind: "zoho-vault",
  region: "eu",
  clientId: "synthetic-client",
  clientSecret: "synthetic-client-secret",
  redirectUrl: "https://unlock.example/password-manager-callback.html",
};
const providers = parseManagerProviders(JSON.stringify([config]));
const KEY = randomBytes(32).toString("base64");
const owner = "1111111111";
const reference = "zohovault://12345/password";
const access = "synthetic-access",
  refresh = "synthetic-refresh";
const password = vector.values.password.replace(/\r\n/g, "\n");
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
function fixture(sharing?: "1024" | "4096") {
  const calls: { url: URL; body: URLSearchParams; headers: Headers }[] = [];
  const controls: unknown[] = [];
  const store = new Store();
  let rotated = false,
    wrongSite = false,
    fail = false,
    pending = false,
    expiry = Date.now() + 60_000,
    removed = false;
  let duringRead: (() => Promise<void>) | undefined;
  let encryptedMetadata = false,
    pageSize = 1;
  const shared = sharing && vector.sharing[sharing];
  const secret = (id = "12345") => ({
    secretid: id,
    secretname: "Example login",
    secreturl: wrongSite ? "https://other.example" : "https://github.com/login",
    ...(encryptedMetadata
      ? {
          secretname: "stale",
          secreturl: "https://wrong.example",
          encsecretname: shared ? shared.name : vector.encrypted.name,
          encryptedurls: [shared ? shared.url : vector.encrypted.url],
        }
      : {}),
    isshared: shared ? "YES" : "NO",
    istrashed: removed,
    secretData: JSON.stringify({
      username: shared ? shared.username : vector.encrypted.username,
      password: shared
        ? shared.password
        : rotated
          ? vector.encrypted.rotated
          : vector.encrypted.password,
    }),
    notes: "private notes",
  });
  const fetcher: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body ?? ""));
    const headers = new Headers(init?.headers);
    calls.push({ url, body, headers });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    expect(["https://accounts.zoho.eu", "https://vault.zoho.eu"]).toContain(
      url.origin,
    );
    if (fail)
      return Response.json({
        operation: {
          result: {
            status: "Failure",
            message: password + access + vector.key,
          },
        },
      });
    if (url.pathname === "/oauth/v2/token") {
      expect(body.get("client_secret")).toBe(config.clientSecret);
      return Response.json({
        access_token: access,
        ...(body.get("grant_type") === "authorization_code"
          ? { refresh_token: refresh }
          : {}),
        expires_in: 3600,
        api_domain: "https://evil.example",
      });
    }
    expect(headers.get("authorization")).toBe(`Zoho-oauthtoken ${access}`);
    const ok = (details: unknown, old = false) =>
      Response.json({
        operation: {
          result: { status: "Success" },
          [old ? "details" : "Details"]: details,
        },
      });
    if (url.pathname === "/api/json/login") {
      expect(url.searchParams.get("OPERATION_NAME")).toBe("GET_LOGIN");
      return ok(
        {
          LOGIN: "PBKDF2_AES",
          SALT: vector.salt,
          ITERATION: vector.iterations,
          PASSPHRASE: vector.encrypted.challenge,
          LASTMODFIEDTIME: "123",
          CREATIONTIME: "100",
        },
        true,
      );
    }
    if (url.pathname.endsWith("/user/orgkey"))
      return ok(
        shared
          ? {
              sharedKey: shared.sharedKey,
              privateKey: shared.privateKey,
              rsaKeyType: `RSA_${sharing}`,
            }
          : {},
      );
    if (url.pathname.endsWith("/secrets")) {
      expect(url.searchParams.get("rowPerPage")).toBe("50");
      expect(headers.get("LastPassphraseChange")).toBe("123");
      return ok(
        url.searchParams.get("pageNum") !== "0"
          ? []
          : Array.from({ length: pageSize }, (_, i) =>
              secret(String(12345 + i)),
            ),
      );
    }
    if (/\/secrets\/[0-9]+$/.test(url.pathname)) {
      await duringRead?.();
      return ok([secret(url.pathname.split("/").at(-1)!)]);
    }
    throw new Error("Unexpected provider endpoint");
  }) as typeof fetch;
  const host = new FilePasswordManagerHost({
    store,
    owner,
    key: KEY,
    providers,
    fetch: fetcher,
  });
  const browser: SecureBrowserAdapter = {
    native: true,
    begin: async () => ({
      authorizationUrl: "https://t.me/aiko_bot?start=fixture",
    }),
    control: async (binding, input) => {
      controls.push(input);
      pending = false;
      expiry = Date.now() + 60_000;
      return {
        status: "connected",
        domain: binding.domain,
        expiresAt: expiry,
        revision: 3,
      };
    },
    status: async (binding) =>
      pending
        ? { ...binding, status: "pending" }
        : {
            ...binding,
            status: "connected",
            verification: { verified: true, revision: 3, expiresAt: expiry },
          },
  };
  const engine = new ConnectorEngine({
    owner,
    store,
    secureBrowser: browser,
    managers: host,
    fetch: async () => Response.json({ items: [] }),
  });
  async function connect() {
    const added = await host.add({
      kind: "zoho-vault",
      name: "My vault",
      providerId: "zoho",
      entries: [],
    });
    const url = new URL(added.authorizationUrl!);
    expect(url.origin).toBe("https://accounts.zoho.eu");
    expect(url.searchParams.get("scope")).toBe("ZohoVault.secrets.READ");
    const result = await host.finishAuthorization(
      added.id,
      url.searchParams.get("state")!,
      "synthetic-code",
    );
    expect(result.status).toBe("unlock_required");
    expect(
      createHash("sha256")
        .update(calls[0]!.body.get("code_verifier")!)
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge")!);
    expect(await host.unlockParameters(added.id)).toEqual({
      salt: vector.salt,
      iterations: vector.iterations,
    });
    await host.unlock(added.id, vector.key);
    await host.select(added.id, [reference]);
    return added.id;
  }
  return {
    store,
    host,
    engine,
    controls,
    calls,
    connect,
    rotate: () => {
      rotated = true;
    },
    changeSite: () => {
      wrongSite = true;
    },
    trash: () => {
      removed = true;
    },
    fail: () => {
      fail = true;
    },
    encryptedMetadata: () => {
      encryptedMetadata = true;
    },
    fullPage: () => {
      pageSize = 50;
    },
    duringRead: (fn: () => Promise<void>) => {
      duringRead = fn;
    },
    expire: () => {
      for (const row of store.rows.values()) {
        const r = row as any;
        if (r.browserVerification)
          r.browserVerification.expiresAt = Date.now() - 1;
      }
      pending = true;
      expiry = Date.now() - 1;
    },
  };
}

test("PBKDF2 and AES interoperate with independent official extension vectors, including Unicode", async () => {
  expect(await deriveZohoVaultKey(vector.master, vector)).toBe(vector.key);
  expect(
    await decryptZohoVaultField(vector.encrypted.password, vector.key),
  ).toBe(password);
  expect(
    await decryptZohoVaultField(vector.encrypted.challenge, vector.key),
  ).toBe(vector.values.challenge);
  await expect(
    deriveZohoVaultKey(vector.master, {
      salt: vector.salt,
      iterations: 100_000_001,
    }),
  ).rejects.toThrow();
});

test("provider config uses fixed regional OAuth and vault endpoints without user API keys", () => {
  expect(providers[0]?.url).toBe("https://vault.zoho.eu/");
  for (const patch of [
    { region: "unknown" },
    { url: "https://evil.example" },
    { clientSecret: "" },
  ])
    expect(() =>
      parseManagerProviders(JSON.stringify([{ ...config, ...patch }])),
    ).toThrow();
});

test("OAuth, unlock, select and fill pass the actual provider reference privately", async () => {
  const f = fixture();
  const id = await f.connect();
  expect(await f.host.browse(id, 1)).toEqual({
    entries: [{ reference, label: "Example login", website: "github.com" }],
    nextPage: undefined,
  });
  await f.engine.importLogins([{ website: "github.com" }]);
  const connection = (await f.engine.connections())[0]!;
  const result = await f.engine.fillFromManager({
    connectionId: connection.id,
    managerId: id,
    reference,
    username: "different-account",
  });
  expect(f.controls).toEqual([
    {
      action: "login",
      username: vector.values.username,
      password,
      credentialReference: { managerId: id, reference },
    },
  ]);
  for (const value of [
    password,
    vector.key,
    access,
    refresh,
    vector.master,
    config.clientSecret,
    "synthetic-code",
  ])
    for (const output of [
      result,
      await f.host.list(),
      f.host.providers(),
      [...f.store.rows.values()],
    ])
      expect(JSON.stringify(output)).not.toContain(value);
  const count = f.calls.length;
  await expect(
    f.host.resolvePassword(id, reference, "notion.so"),
  ).rejects.toThrow("different website");
  await expect(
    f.host.resolvePassword(id, "zohovault://999/password", "github.com"),
  ).rejects.toThrow();
  expect(f.calls.length).toBe(count);
});

test("renewal resolves a rotated password through the saved reference", async () => {
  const f = fixture();
  const id = await f.connect();
  await f.engine.importLogins([{ website: "github.com" }]);
  const connection = (await f.engine.connections())[0]!;
  await f.engine.fillFromManager({
    connectionId: connection.id,
    managerId: id,
    reference,
  });
  f.rotate();
  f.expire();
  expect((await f.engine.connections())[0]!.status).toBe("connected");
  expect(f.controls).toHaveLength(2);
  expect(f.controls[1]).toMatchObject({
    password: vector.values.rotated,
    credentialReference: { managerId: id, reference },
  });
  expect(JSON.stringify([...f.store.rows.values()])).not.toContain(
    vector.values.rotated,
  );
});

test.each(["1024", "4096"] as const)(
  "shared vault RSA_%s keys resolve the same private login",
  async (version) => {
    const f = fixture(version);
    const id = await f.connect();
    expect(
      await f.host.resolveCredentials(id, reference, "github.com"),
    ).toEqual({ username: vector.values.username, password });
  },
);

test("wrong master key, revoked access and provider errors stay private", async () => {
  const f = fixture();
  const id = await f.connect();
  await expect(f.host.unlock(id, "a".repeat(64))).rejects.toThrow(
    "master password",
  );
  f.fail();
  await expect(
    f.host.resolvePassword(id, reference, "github.com"),
  ).rejects.toThrow("Could not use Zoho Vault");
});

test.each([undefined, "1024", "4096"] as const)(
  "encrypted metadata overrides plaintext labels and websites (%s)",
  async (version) => {
    const f = fixture(version);
    f.encryptedMetadata();
    const id = await f.connect();
    expect((await f.host.browse(id, 1)).entries).toEqual([
      { reference, label: "Encrypted login name", website: "github.com" },
    ]);
    expect(await f.host.resolvePassword(id, reference, "github.com")).toBe(
      password,
    );
  },
);

test("zero-based pagination includes the first 50 records and selection bounds concurrent reads", async () => {
  const f = fixture();
  const id = await f.connect();
  f.fullPage();
  const first = await f.host.browse(id, 1);
  expect(first.entries).toHaveLength(50);
  expect(first.nextPage).toBe(2);
  expect((await f.host.browse(id, 2)).entries).toEqual([]);
  let active = 0,
    maxActive = 0;
  f.duringRead(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  });
  expect(
    (
      await f.host.select(
        id,
        first.entries.map((entry) => entry.reference),
      )
    ).entries,
  ).toHaveLength(50);
  expect(maxActive).toBe(5);
  expect(active).toBe(0);
});

test("cancellation after provider response prevents private submission", async () => {
  const f = fixture();
  const id = await f.connect();
  await f.engine.importLogins([{ website: "github.com" }]);
  const connection = (await f.engine.connections())[0]!;
  const controller = new AbortController();
  f.duringRead(async () => {
    controller.abort();
  });
  await expect(
    f.engine.fillFromManager(
      { connectionId: connection.id, managerId: id, reference },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(f.controls).toHaveLength(0);
});

test("refresh preserves the offline grant and rejects callback replay and foreign ownership", async () => {
  const f = fixture();
  const id = await f.connect();
  const row = [...f.store.rows.values()].find((r: any) => r.id === id) as any;
  const grant = JSON.parse(
    openManagerToken(Buffer.from(KEY, "base64"), owner, id, row.sealed),
  );
  grant.zoho.tokenExpiresAt = 0;
  row.sealed = sealManagerToken(
    Buffer.from(KEY, "base64"),
    owner,
    id,
    JSON.stringify(grant),
  );
  expect(await f.host.resolvePassword(id, reference, "github.com")).toBe(
    password,
  );
  expect(
    f.calls.some(
      (call) =>
        call.body.get("grant_type") === "refresh_token" &&
        call.body.get("refresh_token") === refresh,
    ),
  ).toBe(true);
  const current = [...f.store.rows.values()].find(
    (r: any) => r.id === id,
  ) as any;
  expect(
    JSON.parse(
      openManagerToken(Buffer.from(KEY, "base64"), owner, id, current.sealed),
    ).tokens.refresh_token,
  ).toBe(refresh);
  await expect(
    f.host.finishAuthorization(id, "invalid-state", "code"),
  ).rejects.toThrow();
  const foreign = new FilePasswordManagerHost({
    store: f.store,
    owner: "2222222222",
    key: KEY,
    providers,
  });
  await expect(foreign.browse(id, 1)).rejects.toThrow();
});

test("removed, moved and trashed logins cannot fill; disconnect during a read cannot resurrect custody", async () => {
  for (const operation of ["changeSite", "trash", "disconnect"] as const) {
    const f = fixture();
    const id = await f.connect();
    if (operation === "disconnect") f.duringRead(() => f.host.remove(id));
    else f[operation]();
    await expect(
      f.host.resolvePassword(id, reference, "github.com"),
    ).rejects.toThrow();
    if (operation === "disconnect") expect(await f.host.list()).toEqual([]);
  }
});

test("private routes validate input and return only projected metadata", async () => {
  const f = fixture();
  const id = await f.connect();
  const request = (path: string, body: object) =>
    connectorApi(
      new Request(
        `https://unlock.example/api/connectors/password-managers/${path}`,
        { method: "POST", body: JSON.stringify(body) },
      ),
      f.engine,
    );
  expect((await request("browse", { managerId: id, page: -1 })).status).toBe(
    400,
  );
  expect(
    (await request("unlock", { managerId: id, master: vector.master })).status,
  ).toBe(400);
  const response = await request("browse", { managerId: id, page: 1 });
  expect(response.status).toBe(200);
  const result = await response.text();
  expect(result).toContain(reference);
  for (const value of [
    "secretData",
    "notes",
    "username",
    vector.encrypted.password,
    vector.key,
  ])
    expect(result).not.toContain(value);
  expect(
    (await request("select", { managerId: id, references: [] })).status,
  ).toBe(200);
  await expect(
    f.host.resolvePassword(id, reference, "github.com"),
  ).rejects.toThrow();
});
