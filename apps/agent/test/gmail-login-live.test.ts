import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import { connectorApi } from "../src/connector-api.ts";
import { nativeBrowserConnector } from "../src/native-browser-connector.ts";
import type { NativeLoginInput, NativeLoginState } from "../src/native-login.ts";
import { runPrivateLogin } from "../src/native-login-assistance.ts";
import { NativeLoginVault, nativeLoginCipher } from "../src/native-login-vault.ts";
import { openPrivateBrowserCdp, createOwnedCookieAdapter } from "../src/browser-driver.ts";

const endpoint = process.env.AIKO_GMAIL_FIXTURE_CDP;
(endpoint && process.env.AIKO_GMAIL_FIXTURE === "1" ? test : test.skip)(
  "isolated Chrome: Gmail → encrypted restart → Google SSO with consent → emailed OTP → sign-in link → scoped disconnect",
  async () => {
    const cdp = await openPrivateBrowserCdp(endpoint!);
    const directory = await mkdtemp("/tmp/unlock-gmail-live-");
    const db = new Database(`${directory}/vault.sqlite`);
    db.exec("CREATE TABLE login(id TEXT PRIMARY KEY,state TEXT NOT NULL)");
    let currentId = "";
    const readState = (id: string) => { const row = db.query("SELECT state FROM login WHERE id=?").get(id) as { state: string } | null; return row ? JSON.parse(row.state) as NativeLoginState : undefined; };
    let vault = new NativeLoginVault(db, "123", nativeLoginCipher(directory, db));
    const rows = new Map<string, unknown>();
    const store: ConnectorStore = {
      async get(key) { return structuredClone(rows.get(key)); },
      async set(key, value) { rows.set(key, structuredClone(value)); },
      async list(prefix) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)); },
    };
    const dependencies = {
      cdp,
      read: () => readState(currentId),
      save: (state: NativeLoginState) => {
        db.query("INSERT OR REPLACE INTO login VALUES(?,?)").run(state.connectionId, JSON.stringify(state));
        if (state.status === "disconnected") vault.remove(state.connectionId);
      },
      credentials: (state: NativeLoginState, input: NativeLoginInput) => vault.stage(state, input),
      verified: (state: NativeLoginState, cookies: unknown[], identity?: string) => vault.verified(state, cookies, identity),
    };
    const nativeAuth = async (input: NativeLoginInput) => {
      currentId = input.connectionId;
      // No fixture credentials may ever reach the real provider, even if the
      // operator accidentally supplies an unmapped browser endpoint.
      if (["credentials", "login", "assist", "assist_consent"].includes(input.action)) {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: dependencies.read()?.targetId, flatten: true });
        const marker = await cdp.send("Runtime.evaluate", { expression: 'document.querySelector(\'meta[name="unlock-gmail-fixture"]\')?.content === "synthetic"', returnByValue: true }, sessionId);
        if (marker.result?.value !== true) throw Error("Refusing credentials outside synthetic fixture");
      }
      return runPrivateLogin(input, { ...dependencies, vault, source: readState,
        cookieAdapter: async targetId => {
          const inventory = await cdp.send("Target.getTargets", {});
          const target = inventory.targetInfos.find((t: any) => t.targetId === targetId);
          return createOwnedCookieAdapter(cdp, { targetId, browserContextId: target.browserContextId });
        },
      });
    };
    const engine = new ConnectorEngine({ owner: "123", store, secureBrowser: nativeBrowserConnector("123", async () => ({ nativeAuth }) as any, async () => {}) });
    const request = async (path: string, body?: object) => {
      const response = await connectorApi(new Request(`http://localhost/api/connectors/${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined), engine);
      const result = await response.json() as any;
      if (!response.ok) throw Error(`Fixture connector request failed: ${path} ${response.status}`);
      return result;
    };
    try {
      const connection = await request("browser", { domain: "gmail.com" });
      expect(connection.connectorId).toBe("browser:mail.google.com");
      const control = (action: string, input = {}) => request("native", { connectionId: connection.id, action, ...input });
      let view = await control("form");
      for (let n = 0; n < 30 && !view.fields?.includes("username"); n++) { await Bun.sleep(100); view = await control("form"); }
      expect(view.requiresOrigin).toBeUndefined();
      expect(view.currentHost).toBe("accounts.google.com");
      expect(view.fields).toEqual(["username"]);
      const { sessionId: formSession } = await cdp.send("Target.attachToTarget", { targetId: dependencies.read()!.targetId, flatten: true });
      const evaluate = async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, formSession)).result?.value;
      expect(await evaluate('typeof document.querySelector("form").action')).not.toBe("string");
      await evaluate('document.querySelector("button").setAttribute("formaction","https://elsewhere.net/")');
      await expect(control("credentials", { username: "fixture@example.test" })).rejects.toThrow("409");
      expect(await evaluate('document.querySelector("input[autocomplete=username]").value')).toBe("");
      await evaluate('document.querySelector("button").removeAttribute("formaction");document.querySelector("form").insertAdjacentHTML("beforeend",\'<button id="ambiguous">Another submission</button>\')');
      await expect(control("credentials", { username: "fixture@example.test" })).rejects.toThrow("409");
      expect(await evaluate('document.querySelector("input[autocomplete=username]").value')).toBe("");
      await evaluate('document.querySelector("#ambiguous").remove()');
      view = await control("login", { username: "fixture@example.test", password: "fixture-password" });
      expect(view.fields).toEqual(["code"]);
      expect(view.status).toBe("pending");
      expect(db.query("SELECT * FROM native_vault").all()).toHaveLength(0);
      await control("credentials", { code: "654321", attemptId: view.attemptId, challengeId: view.challenge.id, expectedRevision: view.challenge.revision, submissionId: crypto.randomUUID() });
      for (let n = 0; n < 30; n++) {
        await Bun.sleep(100);
        try { view = await control("finish"); if (view.status === "connected") break; } catch {}
      }
      expect(view.status).toBe("connected");
      expect(view.credentialsSaved).toBe(true);
      expect((await request("connections")).connections[0].status).toBe("connected");
      const state = dependencies.read()!;
      expect((await vault.session(state))?.some(cookie => cookie.domain === ".google.com")).toBe(true);
      const metadata = JSON.stringify([db.query("SELECT * FROM login").all(), db.query("SELECT * FROM native_vault").all(), [...rows]]);
      for (const secret of ["fixture-password", "654321", "synthetic-google-session"]) expect(metadata).not.toContain(secret);
      vault.close(); vault = new NativeLoginVault(db, "123", nativeLoginCipher(directory, db));
      await cdp.send("Storage.clearCookies", {});
      expect(await vault.restore(state, cdp)).toBe(true);
      const { targetId } = await cdp.send("Target.createTarget", { url: "https://mail.google.com/mail/u/0/" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      let inbox = false;
      for (let n = 0; n < 30 && !inbox; n++) {
        await Bun.sleep(100);
        inbox = (await cdp.send("Runtime.evaluate", { expression: 'location.hostname === "mail.google.com" && document.body.innerText.includes("Synthetic mailbox is ready")', returnByValue: true }, sessionId)).result?.value === true;
      }
      expect(inbox).toBe(true);
      expect(await vault.identity(state)).toBe("fixture@example.test");
      const downstream: string[] = [];
      const replies: unknown[] = [];
      for (const [method, domain] of [["google", "sso-login-fixture.aiko.ai"], ["email_code", "otp-login-fixture.aiko.ai"], ["email_link", "link-login-fixture.aiko.ai"]] as const) {
        const targetConnection = await request("browser", { domain }); downstream.push(targetConnection.id);
        const targetControl = (action: string, fields = {}) => request("native", { connectionId: targetConnection.id, action, ...fields });
        let targetView = await targetControl("form");
        for (let n = 0; n < 30 && (targetView.pageError || method !== "google" && !targetView.fields?.includes("username")); n++) { await Bun.sleep(100); targetView = await targetControl("form"); }
        const assistanceId = crypto.randomUUID();
        targetView = await targetControl("assist", { sourceConnectionId: connection.id, assistMethod: method, assistanceId, attemptId: targetView.attemptId }); replies.push(targetView);
        let approved = false;
        for (let n = 0; n < 45 && targetView.status !== "connected"; n++) {
          await Bun.sleep(250);
          targetView = await targetControl("finish"); replies.push(targetView);
          if (targetView.assistance?.status === "approval_required") {
            expect(approved).toBe(false);
            await expect(targetControl("assist_consent", { attemptId: targetView.attemptId, assistanceId: crypto.randomUUID() })).rejects.toThrow("409");
            targetView = await targetControl("assist_consent", { attemptId: targetView.attemptId, assistanceId }); approved = true;
          }
          if (["unsupported", "source_unavailable", "ambiguous", "uncertain"].includes(targetView.assistance?.status)) throw Error(`Synthetic ${method} stopped: ${targetView.assistance.status}`);
        }
        expect(targetView.status).toBe("connected"); expect(approved).toBe(method === "google");
        expect((await request("connections")).connections.find((c: any) => c.id === targetConnection.id).status).toBe("connected");
        const targetState = readState(targetConnection.id)!;
        expect((await vault.session(targetState))?.every(c => c.domain === domain)).toBe(true);
        // Independent authenticated page access, not merely a cookie/metadata assertion.
        const page = await cdp.send("Target.createTarget", { url: `https://${domain}/` });
        const attached = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
        let authenticated = false;
        for (let n = 0; n < 30 && !authenticated; n++) {
          await Bun.sleep(100);
          authenticated = (await cdp.send("Runtime.evaluate", { expression: `document.body.innerText.includes('Signed in to ${domain}')`, returnByValue: true }, attached.sessionId)).result?.value === true;
        }
        expect(authenticated).toBe(true); await cdp.send("Target.closeTarget", { targetId: page.targetId });
      }
      // Counts are the only fixture internals exposed to the test. It never
      // receives the generated codes or sign-in link tokens.
      const metricsTarget = await cdp.send("Target.createTarget", { url: "https://mail.google.com/fixture-metrics" });
      const metricsSession = await cdp.send("Target.attachToTarget", { targetId: metricsTarget.targetId, flatten: true });
      await Bun.sleep(300);
      const metrics = (await cdp.send("Runtime.evaluate", { expression: "JSON.parse(document.body.innerText)", returnByValue: true }, metricsSession.sessionId)).result?.value;
      expect(metrics).toEqual({ ssoRequests: 1, accountChoices: 1, consents: 1, otpRequests: 1, linkRequests: 1, otpConsumed: 1, linkConsumed: 1 });
      await cdp.send("Target.closeTarget", { targetId: metricsTarget.targetId });
      const retained = JSON.stringify([db.query("SELECT * FROM login").all(), db.query("SELECT * FROM native_vault").all(), [...rows], replies]);
      for (const secret of ["fixture@example.test", "fixture-password", "654321", "synthetic-google-session", "/accept?token=", "Your verification code is", "signedBy"]) expect(retained).not.toContain(secret);
      expect((await request("disconnect", { connectionId: connection.id })).relayDisconnectStatus).toBe("confirmed");
      expect((await cdp.send("Storage.getCookies", {})).cookies.some((cookie: any) => cookie.name === "sid")).toBe(false);
      expect(db.query("SELECT * FROM native_vault").all()).toHaveLength(3);
      // Disconnecting Gmail removes Google custody, not the independent apps.
      expect((await cdp.send("Storage.getCookies", {})).cookies.filter((c: any) => c.name === "connected")).toHaveLength(3);
      for (const connectionId of downstream) await request("disconnect", { connectionId });
      expect(db.query("SELECT * FROM native_vault").all()).toHaveLength(0);
      try { await cdp.send("Target.closeTarget", { targetId }); } catch { /* Native cleanup may already have closed the old source tab. */ }
    } finally { cdp.close(); vault.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
  }, 90_000,
);
