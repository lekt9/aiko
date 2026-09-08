import { expect, test } from "bun:test";
import { selectLoginEmail, type PrivateLoginEmail } from "../src/native-gmail-page.ts";
import { googleIdentityRequest } from "../src/native-google-sso.ts";
import { runPrivateLogin, type NativeLoginAssistanceDependencies } from "../src/native-login-assistance.ts";
import type { NativeLoginState } from "../src/native-login.ts";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import { connectorApi } from "../src/connector-api.ts";

const recipient = "fixture@example.test", domain = "target.example.com", now = Date.now();
const requestId = "abcdefghijklmnopqrstu";
const message = (): PrivateLoginEmail => ({ from: `signin@${domain}`, to: [recipient], signedBy: domain, date: now, text: `Your sign-in code is 456789. Request: ${requestId}`, links: [{ text: "Sign in", href: `https://${domain}/signin?token=fixture-only-token&state=${requestId}` }] });
const input = { identity: recipient, domain, after: now - 1000, method: "email_code" as const, request: { key: "state", value: requestId } };
test("private email selection binds authenticated sender, recipient, time, target and a unique sign-in value", () => {
  expect(selectLoginEmail(message(), input, now)).toEqual({ status: "found", value: "456789" });
  expect(selectLoginEmail(message(), { ...input, method: "email_link" }, now)).toEqual({ status: "found", value: `https://${domain}/signin?token=fixture-only-token&state=${requestId}` });
  for (const change of [
    { from: `signin@${domain}.evil.net` }, { signedBy: "evil.net" }, { signedBy: "" }, { to: ["other@example.test"] },
    { date: input.after - 1 }, { date: now + 31_000 }, { date: NaN }, { text: "Password reset verification code: 456789" },
    { text: "Invoice reference: 456789" }, { text: "Sign in " + "x".repeat(64_000) },
  ]) expect(selectLoginEmail({ ...message(), ...change }, input, now).status).toBe("unsupported");
  expect(selectLoginEmail(message(), { ...input, request: { key: "state", value: "another-sign-in-request" } }, now).status).toBe("unsupported");
  expect(selectLoginEmail({ ...message(), text: "Sign in codes: 456789 and 654321" }, input, now).status).toBe("ambiguous");
  for (const href of ["http://target.example.com/?token=secret", "https://target.example.com.evil.net/?token=secret", "https://evil.net/?token=secret", "https://target.example.com:8443/?token=secret", "https://name:secret@target.example.com/", "https://target.example.com/reset-password?token=secret", "https://127.0.0.1/?token=secret"]) {
    expect(selectLoginEmail({ ...message(), links: [{ text: "Sign in", href }] }, { ...input, method: "email_link" }, now).status).toBe("unsupported");
  }
  expect(selectLoginEmail({ ...message(), links: [...message().links, { text: "Sign in", href: `https://${domain}/second?token=other&state=${requestId}` }] }, { ...input, method: "email_link" }, now).status).toBe("ambiguous");
});

test("Google consent accepts only identity scopes with this relying party's HTTPS callback", () => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("redirect_uri", `https://${domain}/callback`); url.searchParams.set("scope", "openid email profile");
  expect(googleIdentityRequest(url.href, domain)).toBe(true);
  expect(googleIdentityRequest(`https://accounts.google.com/selectaccount?continue=${encodeURIComponent(url.href)}`, domain)).toBe(true);
  for (const scope of ["", "openid https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive", "openid unknown"]) { const other = new URL(url); other.searchParams.set("scope", scope); expect(googleIdentityRequest(other.href, domain)).toBe(false); }
  for (const destination of ["https://evil.net/", "https://target.example.com.evil.net/", "http://target.example.com/", "https://target.example.com:8080/", "https://user:password@target.example.com/"]) { const other = new URL(url); other.searchParams.set("redirect_uri", destination); expect(googleIdentityRequest(other.href, domain)).toBe(false); }
  expect(googleIdentityRequest(url.href.replace("accounts.google.com", "accounts.google.com.evil.net"), domain)).toBe(false);
  expect(googleIdentityRequest("https://accounts.google.com/signin", domain)).toBe(false);
});

function runtime() {
  const source: NativeLoginState = { connectionId: crypto.randomUUID(), domain: "mail.google.com", revision: 7, expiresAt: Date.now() + 60_000, status: "connected" };
  const grant = { connectionId: source.connectionId, revision: source.revision, expiresAt: source.expiresAt };
  let target: NativeLoginState = { connectionId: crypto.randomUUID(), domain, attemptId: crypto.randomUUID(), targetId: "target", status: "pending", revision: 2, expiresAt: Date.now() + 60_000 };
  const request = { connectionId: target.connectionId, domain, action: "assist" as const, assistMethod: "google" as const, sourceConnectionId: source.connectionId, assistanceId: crypto.randomUUID(), attemptId: target.attemptId, gmailGrant: grant };
  const stages: string[] = [], calls: string[] = [];
  let dispatches = 0, reads = 0, revokedDuringRestore = false;
  const deps: NativeLoginAssistanceDependencies = { read: () => structuredClone(target), save: state => { target = structuredClone(state); if (state.assistance) stages.push(state.assistance.stage); }, source: id => id === source.connectionId ? source : undefined,
    cdp: { close() {}, async send(method, parameters: any) {
      calls.push(method);
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "target", type: "page", url: `https://${domain}/` }] };
      if (method === "Target.createTarget") return { targetId: "private-mailbox" };
      if (method === "Target.closeTarget") return { success: true };
      if (method === "Runtime.evaluate") {
        const expression = parameters.expression;
        if (expression.includes("Google Account:")) return { result: { value: recipient } };
        if (expression === "location.href") return { result: { value: `https://${domain}/` } };
        if (expression === "location.origin") return { result: { value: `https://${domain}` } };
        if (expression === "location.hostname") return { result: { value: domain } };
        if (expression.includes("with google$/")) {
          if (expression.includes("&&true")) { dispatches++; expect(stages.at(-1)).toBe("requesting"); throw Error("Lost acknowledgement after click"); }
          return { result: { value: 1 } };
        }
        return { result: { value: false } };
      }
      return {};
    } },
    vault: { stage() {}, identity: async () => { reads++; return recipient; }, restore: async () => { if (revokedDuringRestore) source.status = "disconnected"; return true; }, bridge: async () => ({ run: async (run: () => Promise<void>) => run(), status: () => ({ ready: true }) }) } as any,
    cookieAdapter: async () => ({ exportCookies: async () => [], replaceCookies: async () => {} }),
  };
  return { request, deps, source, grant, calls, get target() { return target; }, set target(state) { target = state; }, get dispatches() { return dispatches; }, get reads() { return reads; }, revokeDuringRestore() { revokedDuringRestore = true; } };
}

test("a lost Google click acknowledgement is durably fenced and never repeated by polling or replay", async () => {
  const fixture = runtime();
  expect((await runPrivateLogin(fixture.request, fixture.deps)).assistance?.status).toBe("uncertain");
  expect(fixture.dispatches).toBe(1);
  for (const action of ["finish", "form", "assist"] as const) expect((await runPrivateLogin({ ...fixture.request, action }, fixture.deps)).assistance?.status).toBe("uncertain");
  expect(fixture.dispatches).toBe(1); expect(fixture.reads).toBe(1);
  await expect(runPrivateLogin({ ...fixture.request, action: "login", username: recipient, password: "never-dispatch" }, fixture.deps)).rejects.toThrow("Close assisted");
  expect(JSON.stringify(fixture.target)).not.toContain(recipient);
});

test("retained assistance loses authority when Gmail expires, changes, disconnects or the host omits its grant", async () => {
  for (const variant of ["expired", "revision", "disconnected", "missing-grant", "foreign-source"] as const) {
    const fixture = runtime();
    fixture.target = { ...fixture.target, assistance: { id: fixture.request.assistanceId, source: fixture.grant, method: "email_code", startedAt: now, expiresAt: Date.now() + 30_000, stage: "email", status: "waiting_email" } };
    if (variant === "expired") fixture.source.expiresAt = Date.now() - 1;
    if (variant === "revision") fixture.source.revision++;
    if (variant === "disconnected") fixture.source.status = "disconnected";
    if (variant === "foreign-source") fixture.source.connectionId = crypto.randomUUID();
    const result = await runPrivateLogin({ ...fixture.request, action: "finish", gmailGrant: variant === "missing-grant" ? undefined : fixture.grant }, fixture.deps);
    expect(result.assistance?.status).toBe("source_unavailable"); expect(fixture.reads).toBe(0); expect(fixture.dispatches).toBe(0);
    expect(fixture.calls).not.toContain("Target.createTarget");
  }
});

test("source authority is rechecked after restore and before the website receives a Google click", async () => {
  const fixture = runtime(); fixture.revokeDuringRestore();
  expect((await runPrivateLogin(fixture.request, fixture.deps)).assistance?.status).toBe("source_unavailable");
  expect(fixture.dispatches).toBe(0); expect(fixture.calls).not.toContain("Target.createTarget");
});

test("the connector host pins owner-scoped Gmail approval, rejects injected grants, and withdraws it after disconnect", async () => {
  const rows = new Map<string, unknown>();
  const store: ConnectorStore = { async get(key) { return structuredClone(rows.get(key)); }, async set(key, value) { rows.set(key, structuredClone(value)); }, async list(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)); } };
  const calls: any[] = [], expiresAt = Date.now() + 60_000;
  const create = (owner: string) => new ConnectorEngine({ owner, store, secureBrowser: { native: true,
    begin: async () => ({ authorizationUrl: "https://aiko.ai/connect" }),
    status: async binding => ({ ...binding, status: "connected", verification: { verified: true, revision: 3, expiresAt } }),
    control: async (binding, input) => { calls.push(input); return { status: "pending", domain: binding.domain, revision: 1, expiresAt }; },
    disconnect: async binding => ({ ...binding, status: "disconnected" }),
  } });
  const engine = create("123"), foreign = create("456");
  const gmail = await engine.connectBrowser("gmail.com"), target = await engine.connectBrowser(domain), other = await foreign.connectBrowser("gmail.com");
  await engine.completeAuth(gmail.id); await foreign.completeAuth(other.id);
  const fields = { action: "assist" as const, sourceConnectionId: gmail.id, assistMethod: "email_code" as const, assistanceId: crypto.randomUUID(), attemptId: crypto.randomUUID() };
  await expect(engine.nativeControl(target.id, { ...fields, sourceConnectionId: other.id })).rejects.toThrow(); expect(calls).toHaveLength(0);
  const response = await connectorApi(new Request("http://localhost/api/connectors/native", { method: "POST", body: JSON.stringify({ connectionId: target.id, ...fields, gmailGrant: { connectionId: other.id, revision: 3, expiresAt } }) }), engine);
  expect(response.status).toBe(400); expect(calls).toHaveLength(0);
  await engine.nativeControl(target.id, fields);
  expect(calls.at(-1).gmailGrant).toEqual({ connectionId: gmail.id, revision: 3, expiresAt });
  await expect(engine.nativeControl(target.id, { ...fields, assistanceId: crypto.randomUUID() })).rejects.toThrow("already active");
  await expect(engine.nativeControl(target.id, { action: "assist_consent", assistanceId: fields.assistanceId, attemptId: crypto.randomUUID() })).rejects.toThrow("Stale");
  await engine.nativeControl(target.id, { action: "form" }); expect(calls.at(-1).gmailGrant.connectionId).toBe(gmail.id);
  await engine.disconnect(gmail.id);
  await engine.nativeControl(target.id, { action: "finish" }); expect(calls.at(-1).gmailGrant).toBeUndefined();
});
