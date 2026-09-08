import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { VaultCipher } from "../../apps/server/src/crypto.js";
import {
  OnePasswordKeyWrapper,
  ONE_PASSWORD_REF,
} from "../../apps/server/src/onepassword.js";
import { configSchema } from "../../apps/server/src/config.js";

const KEY = randomBytes(32).toString("base64");
const SECRET_REF = "op://aiko-vault/aiko-deks/root";
const ORIGIN = "https://connect.example";
const TOKEN = "ops_0123456789abcdef0123456789abcdef";

const itemBody = (value: string) =>
  JSON.stringify({
    id: "item-1",
    fields: [
      { id: "password", type: "CONCEALED", value: "unrelated" },
      { id: "root", label: "root", type: "BYTES", value },
    ],
  });

const connectFetch = (value = KEY, calls: string[] = []) =>
  (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = String(target);
    calls.push(url);
    if (url === `${ORIGIN}/v1/vaults/aiko-vault/items/aiko-deks` && init?.redirect === "error") {
      return new Response(itemBody(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

const wrapper = (overrides: Record<string, unknown> = {}, fetch?: typeof fetch) =>
  new OnePasswordKeyWrapper(
    {
      origin: ORIGIN,
      token: TOKEN,
      secretRef: SECRET_REF,
      ...overrides,
    },
    fetch ?? connectFetch(),
  );

describe("1Password key wrapper", () => {
  it("parses strict op:// references", () => {
    expect(ONE_PASSWORD_REF.test(SECRET_REF)).toBe(true);
    expect(ONE_PASSWORD_REF.test("op://vault/item")).toBe(false);
    expect(ONE_PASSWORD_REF.test("https://vault/item/field")).toBe(false);
    expect(ONE_PASSWORD_REF.test("op://vault/item/field/extra")).toBe(false);
  });

  it("seals and opens envelopes with the 1Password-held key", async () => {
    const cipher = new VaultCipher(wrapper());
    const sealed = await cipher.seal("tenant:a:credential:1", { password: "x".repeat(64) });
    expect(sealed.key.provider).toBe("1password-connect");
    expect(JSON.stringify(sealed)).not.toContain(KEY);
    expect(await cipher.open("tenant:a:credential:1", sealed)).toEqual({ password: "x".repeat(64) });
    await expect(cipher.open("tenant:b:credential:1", sealed)).rejects.toThrow();
    await expect(cipher.open("tenant:a:session:1", sealed)).rejects.toThrow();
  });

  it("caches the key and refreshes after the TTL", async () => {
    const calls: string[] = [];
    const w = wrapper({ cacheTtlMs: 20 }, connectFetch(KEY, calls));
    const cipher = new VaultCipher(w);
    await cipher.seal("c:1", { a: 1 });
    await cipher.seal("c:2", { a: 1 });
    expect(calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    await cipher.seal("c:3", { a: 1 });
    expect(calls).toHaveLength(2);
  });

  it("fails closed on malformed key material, missing fields, and server errors", async () => {
    const shortKey = wrapper({}, connectFetch(randomBytes(16).toString("base64")));
    const cipher = new VaultCipher(shortKey);
    await expect(cipher.seal("c:1", { a: 1 })).rejects.toThrow("32 bytes");

    const noField = wrapper(
      {},
      (async () => new Response(JSON.stringify({ fields: [] }), { status: 200 })) as typeof fetch,
    );
    await expect(new VaultCipher(noField).seal("c:1", { a: 1 })).rejects.toThrow();

    const failing = wrapper({}, (async () => new Response("{}", { status: 500 })) as typeof fetch);
    await expect(new VaultCipher(failing).seal("c:1", { a: 1 })).rejects.toThrow();
  });

  it("rejects records wrapped by a different provider or key id", async () => {
    const cipher = new VaultCipher(wrapper());
    const sealed = await cipher.seal("c:1", { a: 1 });
    sealed.key = { ...sealed.key, provider: "local" };
    await expect(cipher.open("c:1", sealed)).rejects.toThrow("Unknown encryption key");
    sealed.key = { ...sealed.key, provider: "1password-connect", keyId: "different" };
    await expect(cipher.open("c:1", sealed)).rejects.toThrow("Unknown encryption key");
  });

  it("migrates envelopes between the local keyring and 1Password without exposing the DEK", async () => {
    const local = new VaultCipher(
      new (await import("../../apps/server/src/crypto.js")).LocalKeyring("a", {
        a: randomBytes(32).toString("base64"),
      }),
    );
    const sealed = await local.seal("c:1", { password: "keep-me" });
    const remote = new VaultCipher(wrapper());
    // Provider migration is open-with-old, seal-with-new (same shape ops.ts uses for rotation).
    const moved = await remote.seal("c:1", await local.open("c:1", sealed));
    expect(moved.key.provider).toBe("1password-connect");
    expect(await remote.open("c:1", moved)).toEqual({ password: "keep-me" });
    await expect(remote.open("c:1", sealed)).rejects.toThrow();
  });

  it("constructor rejects non-HTTPS origins unless local development", () => {
    expect(() => wrapper({ origin: "http://connect.example" })).toThrow("Invalid 1Password origin");
    expect(() => wrapper({ origin: "https://connect.example/path" })).toThrow();
    expect(() =>
      wrapper({ origin: "http://127.0.0.1:8081", localDevelopment: true }),
    ).not.toThrow();
  });

  it("config schema requires HTTPS for the 1Password origin outside loopback development", () => {
    const base = {
      origin: "https://vault.example.com",
      databaseUrl: "postgres://localhost/unlock",
      oauth: {
        jwks: { keys: [{ kty: "oct", k: "x" }] },
        cookieKeys: [randomBytes(32).toString("hex")],
      },
      recipes: [],
    };
    const attempt = (encryption: Record<string, unknown>, localDevelopment: boolean) =>
      configSchema.safeParse({ ...base, localDevelopment, encryption }).success;
    const httpOrigin = {
      kind: "1password-connect",
      origin: "http://connect.example",
      token: TOKEN,
      secretRef: SECRET_REF,
    };
    const loopbackOrigin = { ...httpOrigin, origin: "http://127.0.0.1:8081" };
    const httpsOrigin = { ...httpOrigin, origin: "https://connect.example" };
    expect(attempt(httpOrigin, false)).toBe(false);
    expect(attempt(httpOrigin, true)).toBe(false);
    expect(attempt(loopbackOrigin, true)).toBe(true);
    expect(attempt(loopbackOrigin, false)).toBe(false);
    expect(attempt(httpsOrigin, false)).toBe(true);
  });
});
