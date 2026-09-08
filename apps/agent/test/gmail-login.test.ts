import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import { nativeLogin, prepareNativeLogin, type NativeLoginState } from "../src/native-login.ts";
import { NativeLoginVault, nativeLoginCipher } from "../src/native-login-vault.ts";
import { selectNativeSession } from "../src/browser-driver.ts";
import { nativeCookieDomainAllowed, nativeLoginProviderHost, nativeLoginResourceHost } from "../src/native-login-policy.ts";
import { GMAIL_DOMAIN } from "../../../packages/protocol/src/google-connection.ts";

class Store implements ConnectorStore {
  rows = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.rows.get(key)); }
  async set(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
  async list(prefix: string) { return [...this.rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)); }
}
const binding = { connectionId: "11111111-1111-4111-8111-111111111111", domain: "mail.google.com" };
const state = (): NativeLoginState => ({ ...binding, status: "connected", revision: 2, expiresAt: Date.now() + 60_000 });
const cookie = (domain: string, name = "sid") => ({ name, value: "fixture-only-cookie", domain, path: "/", secure: true, httpOnly: true, expires: -1, hostOnly: !domain.startsWith("."), sameSite: "Lax" as const });

test("native Gmail aliases open one owned mailbox connection without Arcade", async () => {
  const store = new Store(), calls: { owner: string; domain: string }[] = [];
  const create = (owner: string) => new ConnectorEngine({ owner, store, secureBrowser: { native: true,
    begin: async input => { calls.push(input); return { authorizationUrl: "https://aiko.ai/connect" }; },
  }, fetch: async () => { throw Error("No catalog or OAuth round-trip allowed"); } });
  const engine = create("123");
  const first = await engine.connectBrowser("gmail.com");
  for (const alias of ["www.gmail.com", GMAIL_DOMAIN]) expect((await engine.connectBrowser(alias)).id).toBe(first.id);
  expect(first).toMatchObject({ connectorId: "browser:mail.google.com", status: "pending", provider: "browser" });
  expect(calls).toEqual([expect.objectContaining({ owner: "123", domain: GMAIL_DOMAIN })]);
  expect((await create("456").connectBrowser("gmail.com")).id).not.toBe(first.id);
  // Old logical gmail.com records cannot silently change their custody identity.
  for (const row of store.rows.values()) if ((row as any).id === first.id) (row as any).connectorId = "browser:gmail.com";
  await expect(engine.connectBrowser("gmail.com")).rejects.toThrow("Disconnect the previous Gmail");
  expect(calls).toHaveLength(2);
});

test("Google login and parent cookies do not grant access to all Google products or lookalikes", async () => {
  for (const host of ["drive.google.com", "evil.mail.google.com", "accounts.google.com.evil.net", "google.com", "accounts.google.com"]) {
    expect(nativeLoginResourceHost(GMAIL_DOMAIN, host)).toBe(false);
    expect(selectNativeSession([state()], host)).toBeUndefined();
  }
  expect(selectNativeSession([state()], GMAIL_DOMAIN)?.connectionId).toBe(binding.connectionId);
  expect(nativeLoginProviderHost(GMAIL_DOMAIN, "accounts.google.com")).toBe(true);
  expect(nativeLoginProviderHost("example.com", "accounts.google.com")).toBe(false);
  for (const host of [".google.com", "accounts.google.com", ".mail.google.com"]) expect(nativeCookieDomainAllowed(GMAIL_DOMAIN, host)).toBe(true);
  for (const host of [".drive.google.com", ".evil.mail.google.com", ".google.com.evil.net"]) expect(nativeCookieDomainAllowed(GMAIL_DOMAIN, host)).toBe(false);
  for (const domain of ["google.com", "accounts.google.com", "drive.google.com", "gmail.com"]) {
    await expect(prepareNativeLogin({ connectionId: crypto.randomUUID(), domain, action: "begin" }, [state()], async () => {})).rejects.toThrow("overlaps");
    expect(() => selectNativeSession([state(), { ...state(), domain, connectionId: crypto.randomUUID() }], GMAIL_DOMAIN)).toThrow("overlapping");
  }
});

test("Gmail opens the mailbox, permits only its known Google provider, and verifies only the mailbox", async () => {
  let current: NativeLoginState | undefined;
  let host = "accounts.google.com";
  const calls: { method: string; params: any }[] = [];
  const deps = { read: () => current, save: (s: NativeLoginState) => { current = structuredClone(s); }, cdp: { close() {}, async send(method: string, params: any) {
    calls.push({ method, params });
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Target.createTarget") return { targetId: "private" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Runtime.evaluate") return { result: { value: params.expression === "location.hostname" ? host : params.expression === "location.origin" ? `https://${host}` : params.expression.includes("Object.keys(f)") ? ["username"] : true } };
    if (method === "Network.getCookies") return { cookies: [cookie(".google.com")] };
    if (method === "Storage.getCookies") return { cookies: [cookie(".google.com"), cookie("accounts.google.com"), cookie("mail.google.com"), cookie("drive.google.com"), cookie("elsewhere.net")] };
    return {};
  } } };
  const run = (action: "begin" | "form" | "finish" | "credentials" | "disconnect") => nativeLogin({ ...binding, action, ...(action === "credentials" ? { username: "fixture-only-user" } : {}) }, deps);
  expect(await run("begin")).toMatchObject({ status: "pending", fields: ["username"], currentHost: "accounts.google.com" });
  expect(calls.find(c => c.method === "Page.navigate")?.params.url).toBe("https://mail.google.com/mail/u/0/");
  await expect(run("finish")).rejects.toThrow("Return to the selected app");
  host = "accounts.google.com.evil.net";
  expect((await run("form")).requiresOrigin).toBe(`https://${host}`);
  await expect(run("credentials")).rejects.toThrow("left the selected app");
  expect(calls.some(c => c.method === "Input.insertText")).toBe(false);
  host = GMAIL_DOMAIN;
  expect((await run("finish")).status).toBe("connected");
  expect(JSON.stringify(current)).not.toContain("fixture-only-cookie");
  expect(calls.find(c => c.method === "Network.getCookies")?.params.urls.sort()).toEqual(["https://accounts.google.com/", "https://google.com/", "https://mail.google.com/"]);
  expect((await run("disconnect")).status).toBe("disconnected");
  expect(calls.filter(c => c.method === "Network.deleteCookies").map(c => c.params.domain)).toEqual([".google.com", "accounts.google.com", "mail.google.com"]);
});

test("Gmail parent cookies survive encrypted restart, rotate through the SDK, and revoke without capturing Drive", async () => {
  const directory = await mkdtemp("/tmp/unlock-gmail-vault-");
  const db = new Database(`${directory}/vault.sqlite`);
  let vault = new NativeLoginVault(db, "123", nativeLoginCipher(directory, db));
  const current = state();
  try {
    await vault.verified(current, [cookie(".google.com"), cookie("accounts.google.com"), cookie("mail.google.com"), cookie("drive.google.com")]);
    expect(JSON.stringify(db.query("SELECT * FROM native_vault").all())).not.toContain("fixture-only-cookie");
    vault.close();
    vault = new NativeLoginVault(db, "123", nativeLoginCipher(directory, db));
    const saved = await vault.session(current);
    expect(saved?.map(c => c.domain)).toEqual([".google.com", "accounts.google.com", "mail.google.com"]);
    let restored: unknown[] = [];
    await vault.restore(current, { async send(method: string, params: any) {
      if (method === "Storage.getCookies") return { cookies: [] };
      if (method === "Storage.setCookies") restored = params.cookies;
      return {};
    } });
    expect(restored).toHaveLength(3);
    let jar = saved!;
    const scopeCalls: unknown[] = [];
    const bridge = await vault.bridge(current, {
      async exportCookies(domains, descendants) { scopeCalls.push({ domains, descendants }); return structuredClone(jar); },
      async replaceCookies(cookies, domains, descendants) { scopeCalls.push({ domains, descendants }); jar = structuredClone(cookies); },
    }, "fixture-runtime", [GMAIL_DOMAIN, "google.com", "accounts.google.com"], () => current);
    await bridge.run(async () => { jar[0]!.value = "rotated-fixture-cookie"; jar.splice(1, 1); });
    expect(scopeCalls.every((call: any) => call.descendants === false && call.domains.length === 3)).toBe(true);
    expect((await vault.session(current))?.map(c => [c.domain, c.value])).toEqual([[".google.com", "rotated-fixture-cookie"], ["mail.google.com", "fixture-only-cookie"]]);
    await expect(vault.sync(current, 3, [cookie("drive.google.com")], () => current)).rejects.toThrow("scope mismatch");
    const otherOwner = new NativeLoginVault(db, "456", nativeLoginCipher(directory, db));
    await expect(otherOwner.session(current)).rejects.toThrow();
    otherOwner.close();
    vault.remove(current.connectionId);
    expect(await vault.session(current)).toBeUndefined();
  } finally { vault.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
