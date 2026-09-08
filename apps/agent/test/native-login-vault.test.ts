import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, chmod, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeLogin, prepareNativeLogin, type NativeLoginState } from "../src/native-login.ts";
import {
  NativeLoginVault,
  nativeLoginCipher,
} from "../src/native-login-vault.ts";
import { createCdpCookieAdapter } from "../../../packages/sdk/src/cdp.ts";
import { renewNativeLogin, submitNativeLogin } from "../src/native-login-renewal.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const cookie = {
  name: "session",
  value: "fixture-session-value",
  domain: ".service.net",
  path: "/",
  secure: true,
  httpOnly: true,
  expires: -1,
  sameSite: "Lax" as const,
  hostOnly: false,
};
async function fixture() {
  const directory = await mkdtemp("/tmp/unlock-native-vault-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "vault.sqlite");
  const db = new Database(path);
  cleanup.push(async () => {
    db.close();
  });
  const cipher = nativeLoginCipher(directory);
  const vault = new NativeLoginVault(db, "123", cipher);
  cleanup.push(async () => {
    vault.close();
  });
  let state: NativeLoginState = {
    connectionId: id,
    domain: "service.net",
    targetId: "private",
    status: "pending",
    expiresAt: Date.now() + 600000,
    revision: 1,
  };
  let authenticated = false;
  const dependencies = {
    read: () => structuredClone(state),
    save: (value: NativeLoginState) => {
      state = structuredClone(value);
    },
    credentials: vault.stage.bind(vault),
    verified: vault.verified.bind(vault),
    cdp: {
      close() {},
      async send(method: string, params: any): Promise<any> {
        if (method === "Target.attachToTarget")
          return { sessionId: "private-session" };
        if (method === "Target.getTargets") return { targetInfos: [] };
        if (method === "Runtime.evaluate")
          return {
            result: {
              value:
                params.expression === "location.hostname"
                  ? "service.net"
                  : params.expression === "location.origin"
                    ? "https://service.net"
                    : params.expression.startsWith(
                          "Boolean(document.querySelector",
                        )
                      ? authenticated
                      : true,
            },
          };
        if (method === "Network.getCookies") return { cookies: [cookie] };
        return {};
      },
    },
  };
  const run = (action: "credentials" | "finish", input: object = {}) =>
    nativeLogin(
      { connectionId: id, domain: "service.net", action, ...input },
      dependencies,
    );
  return {
    directory,
    path,
    db,
    cipher,
    vault,
    dependencies,
    run,
    get state() {
      return state;
    },
    authenticate() {
      authenticated = true;
    },
  };
}

test("submitted credentials are saved only after verified login and survive restart as Unlock ciphertext", async () => {
  const f = await fixture();
  const attemptId=crypto.randomUUID(),challengeId=crypto.randomUUID();
  f.dependencies.save({...f.dependencies.read(),attemptId,challenge:{id:challengeId,revision:1,expiresAt:Date.now()+60000}});
  await f.run("credentials", {
    username: "fixture-user",
    password: "fixture-password",
    code: "fixture-otp",attemptId,challengeId,expectedRevision:1,submissionId:crypto.randomUUID(),
  });
  expect(f.db.query("SELECT * FROM native_vault").all()).toEqual([]);
  await expect(f.run("finish")).rejects.toThrow("could not be verified");
  expect(f.db.query("SELECT * FROM native_vault").all()).toEqual([]);
  expect(f.state.status).toBe("pending");
  f.authenticate();
  expect(await f.run("finish")).toMatchObject({
    status: "connected",
    credentialsSaved: true,
  });
  const row = f.db
    .query("SELECT envelope FROM native_vault WHERE id=?")
    .get(id) as { envelope: string };
  const saved = await f.cipher.open<any>(
    `unlock:native-login:v1:123:${id}:service.net`,
    JSON.parse(row.envelope),
  );
  expect(saved.credentials).toEqual({
    username: "fixture-user",
    password: "fixture-password",
  });
  expect(saved.cookies).toEqual([cookie]);
  const persisted = (await readFile(f.path)).toString();
  for (const secret of [
    "fixture-user",
    "fixture-password",
    "fixture-session-value",
    "fixture-otp",
  ])
    expect(JSON.stringify([row, f.state, persisted])).not.toContain(secret);
  f.vault.close();
  const restarted = new NativeLoginVault(
    f.db,
    "123",
    nativeLoginCipher(f.directory),
  );
  expect(await restarted.session(f.state)).toEqual([cookie]);
  restarted.remove(id);
  await expect(restarted.session(f.state)).rejects.toThrow("missing");
  expect(
    await restarted.session({ ...f.state, status: "disconnected" }),
  ).toBeUndefined();
});

test("vault binding, revision and expiry prevent foreign or stale session restoration", async () => {
  const f = await fixture();
  await f.run("credentials", {
    username: "fixture-user",
    password: "fixture-password",
  });
  f.authenticate();
  await f.run("finish");
  await expect(
    new NativeLoginVault(f.db, "456", f.cipher).session(f.state),
  ).rejects.toThrow();
  await expect(
    f.vault.session({ ...f.state, domain: "other.net" }),
  ).rejects.toThrow("binding");
  await expect(f.vault.session({ ...f.state, revision: 3 })).rejects.toThrow(
    "changed",
  );
  expect(
    await f.vault.session({ ...f.state, expiresAt: Date.now() - 1 }),
  ).toBeUndefined();
  expect(
    await f.vault.session({ ...f.state, status: "disconnected" }),
  ).toBeUndefined();
});

test("multi-step credentials stay transient; incomplete and abandoned candidates are never saved", async () => {
  const f = await fixture();
  await f.run("credentials", { username: "fixture-user" });
  await f.run("credentials", { password: "fixture-password" });
  expect(f.db.query("SELECT * FROM native_vault").all()).toEqual([]);
  f.vault.discard(id);
  f.authenticate();
  expect(await f.run("finish")).toMatchObject({
    status: "connected",
    credentialsSaved: false,
  });
  const row = f.db
    .query("SELECT envelope FROM native_vault WHERE id=?")
    .get(id) as { envelope: string };
  expect(
    await f.cipher.open<any>(
      `unlock:native-login:v1:123:${id}:service.net`,
      JSON.parse(row.envelope),
    ),
  ).not.toHaveProperty("credentials");
});

test("failed vault custody cannot mark a login connected", async () => {
  const f = await fixture();
  f.authenticate();
  f.dependencies.verified = async () => {
    throw Error("Storage unavailable");
  };
  await expect(f.run("finish")).rejects.toThrow("Storage unavailable");
  expect(f.state.status).toBe("pending");
});

test("retrying verified custody after tab cleanup failure preserves the saved password", async () => {
  const f = await fixture();
  await f.run("credentials", {
    username: "fixture-user",
    password: "fixture-password",
  });
  f.authenticate();
  await f.run("finish");
  expect(
    await f.vault.verified({ ...f.state, expiresAt: f.state.expiresAt + 1 }, [
      cookie,
    ]),
  ).toBe(true);
});

test("verified login resumes cleanup after its original tab has closed", async () => {
  const f = await fixture();
  await f.run("credentials", {
    username: "fixture-user",
    password: "fixture-password",
  });
  f.authenticate();
  const send = f.dependencies.cdp.send;
  const targets = new Set(["private", "popup"]);
  let failPopup = true;
  let captures = 0;
  f.dependencies.cdp.send = async (method, params) => {
    if (method === "Target.getTargets")
      return {
        targetInfos: [...targets].map((targetId) => ({
          targetId,
          type: "page",
        })),
      };
    if (method === "Target.attachToTarget" && !targets.has(params.targetId))
      throw Error("Target gone");
    if (method === "Target.closeTarget") {
      if (params.targetId === "popup" && failPopup) return { success: false };
      if (!targets.delete(params.targetId)) throw Error("Target gone");
      return { success: true };
    }
    if (method === "Network.getCookies") captures++;
    return send(method, params);
  };
  await expect(f.run("finish")).rejects.toThrow("did not close");
  expect(f.state.status).toBe("pending");
  expect(f.state.verifiedSession?.credentialsSaved).toBe(true);
  expect(targets.has("private")).toBe(false);
  expect(await f.vault.session(f.state)).toBeUndefined();
  await expect(
    f.run("credentials", { password: "replacement" }),
  ).rejects.toThrow("verified");
  failPopup = false;
  f.dependencies.save({...f.state, expiresAt:1});
  let removed=false;
  await prepareNativeLogin({connectionId:id,domain:"service.net",action:"form"},[f.state],async input=>{
    if(input.action==="disconnect")removed=true;
    return nativeLogin(input,f.dependencies);
  });
  expect(removed).toBe(false);
  expect(await f.run("finish")).toMatchObject({
    status: "connected",
    credentialsSaved: true,
  });
  expect(captures).toBe(1);
  expect(f.state).not.toHaveProperty("verifiedSession");
  expect(f.state).not.toHaveProperty("targetId");
  expect(await f.vault.session(f.state)).toEqual([cookie]);
  expect(targets.size).toBe(0);
});

test("a loose or symlinked VM wrapping key is rejected", async () => {
  const f = await fixture();
  const path = join(f.directory, "unlock-vault.key");
  await chmod(path, 0o644);
  expect(() => nativeLoginCipher(f.directory)).toThrow("Unsafe");
  await rm(path);
  await symlink("/dev/zero", path);
  expect(() => nativeLoginCipher(f.directory)).toThrow();
});

test("missing key material with saved ciphertext is not silently regenerated", async () => {
  const f = await fixture();
  f.authenticate();
  await f.run("finish");
  const path = join(f.directory, "unlock-vault.key");
  await rm(path);
  expect(() => nativeLoginCipher(f.directory, f.db)).toThrow(
    "wrapping key missing",
  );
  expect(await Bun.file(path).exists()).toBe(false);
});

test("session restore uses SDK cookie scopes and preserves a newer browser-profile session", async () => {
  const f = await fixture();
  f.authenticate();
  await f.run("finish");
  const writes: any[] = [];
  let current: object[] = [];
  const cdp = {
    async send(method: string, params: object) {
      if (method === "Storage.getCookies") return { cookies: current };
      writes.push({ method, params });
      return {};
    },
  };
  expect(await f.vault.restore(f.state, cdp)).toBe(true);
  expect(writes).toEqual([
    {
      method: "Storage.setCookies",
      params: {
        cookies: [
          {
            name: cookie.name,
            value: cookie.value,
            url: "https://service.net/",
            domain: cookie.domain,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      },
    },
  ]);
  current = [{ ...cookie, value: "rotated-session-value" }];
  expect(await f.vault.restore(f.state, cdp)).toBe(true);
  expect(writes).toHaveLength(1);
});

test("partial browser sessions restore missing cookies without replacing rotated values", async () => {
  const f = await fixture();
  f.authenticate();
  await f.run("finish");
  const csrf = { ...cookie, name: "csrf", httpOnly: false };
  const partitioned = {
    ...cookie,
    partitionKey: {
      topLevelSite: "https://service.net",
      hasCrossSiteAncestor: false,
    },
  };
  await f.vault.verified(f.state, [cookie, csrf, partitioned]);
  const writes: any[] = [];
  const cdp = {
    async send(method: string, params: any) {
      if (method === "Storage.getCookies")
        return {
          cookies: [
            { ...cookie, value: "rotated-session" },
            { ...csrf, value: "expired-csrf", expires: 1 },
            {
              ...partitioned,
              value: "different-partition",
              partitionKey: {
                ...partitioned.partitionKey,
                hasCrossSiteAncestor: true,
              },
            },
          ],
        };
      writes.push({ method, params });
      return {};
    },
  };
  await f.vault.restore(f.state, cdp);
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("Storage.setCookies");
  expect(writes[0].params.cookies).toMatchObject([
    { name: "csrf", value: csrf.value, httpOnly: false },
    { name: "session", partitionKey: partitioned.partitionKey },
  ]);
  expect(writes[0].params.cookies).toHaveLength(2);
});

test("saved login renews privately, submits each step once, and leaves MFA pending", async () => {
  for (const challenge of [false, true]) {
    const f = await fixture();
    await f.run("credentials", {
      username: "fixture-user",
      password: "fixture-password",
    });
    f.authenticate();
    await f.run("finish");
    const before = f.state.revision;
    let sent = 0;
    const base = f.dependencies.cdp.send;
    f.dependencies.cdp.send = async (method, params) => {
      if (method === "Target.createTarget") return { targetId: "renewal" };
      if (method === "Input.insertText") sent++;
      if (method === "Runtime.evaluate") {
        const expression = params.expression as string;
        if (expression.startsWith("Boolean(document.querySelector"))
          return { result: { value: sent === 2 && !challenge } };
        if (expression.includes("Object.keys(f).filter"))
          return {
            result: { value: sent < 2 ? ["username", "password"] : ["code"] },
          };
      }
      return base(method, params);
    };
    const result = await renewNativeLogin(
      { connectionId: id, domain: "service.net", action: "renew" },
      f.dependencies,
      f.vault,
      undefined,
      async () => {},
    );
    expect(sent).toBe(2);
    expect(result.status).toBe(challenge ? "pending" : "connected");
    expect(f.state.revision).toBe(before + (challenge ? 1 : 2));
    expect(JSON.stringify(result)).not.toContain("fixture-password");
    if (challenge) {
      // Repeated control-plane polls do not start another password attempt.
      await renewNativeLogin(
        { connectionId: id, domain: "service.net", action: "renew" },
        f.dependencies,
        f.vault,
        undefined,
        async () => {},
      );
      expect(sent).toBe(2);
    } else expect(await f.vault.session(f.state)).toEqual([cookie]);
  }
});

test("disconnected or replaced generations cannot use saved passwords for renewal", async () => {
  const f = await fixture();
  await f.run("credentials", {
    username: "fixture-user",
    password: "fixture-password",
  });
  f.authenticate();
  await f.run("finish");
  let used = false;
  const use = async () => {
    used = true;
  };
  await f.vault.renew({ ...f.state, status: "disconnected" }, use);
  await expect(
    f.vault.renew({ ...f.state, revision: f.state.revision + 1 }, use),
  ).rejects.toThrow("changed");
  expect(used).toBe(false);
});

test("one initial credential submission spans username and password pages without resubmission",async()=>{
  const f=await fixture();let sent=0;
  const base=f.dependencies.cdp.send;
  f.dependencies.cdp.send=async(method,params)=>{
    if(method === "Input.insertText")sent++;
    if(method === "Runtime.evaluate") {
      if(params.expression.startsWith("Boolean(document.querySelector"))return {result:{value:sent===2}};
      if(params.expression.includes("Object.keys(f).filter"))return {result:{value:[sent===0?"username":"password"]}};
    }
    return base(method,params);
  };
  const result=await submitNativeLogin({connectionId:id,domain:"service.net",action:"login",username:"fixture-user",password:"fixture-password"},f.dependencies,f.vault,undefined,async()=>{});
  expect(result.status).toBe("connected");expect(result.credentialsSaved).toBe(true);expect(sent).toBe(2);
});

test("a pre-existing signed-in page cannot verify an unsubmitted new password",async()=>{
  const f=await fixture();f.authenticate();
  const result=await submitNativeLogin({connectionId:id,domain:"service.net",action:"login",username:"unused-user",password:"unused-password"},f.dependencies,f.vault,undefined,async()=>{});
  expect(result.status).toBe("connected");expect(result.credentialsSaved).toBe(false);
  const row=f.db.query("SELECT envelope FROM native_vault WHERE id=?").get(id) as {envelope:string};
  expect(await f.cipher.open<any>(`unlock:native-login:v1:123:${id}:service.net`,JSON.parse(row.envelope))).not.toHaveProperty("credentials");
});

test("password manager fills persist the reference and session without copying the external password", async () => {
  const f = await fixture();
  const credentialReference = { managerId: id, reference: "op://Vault/Item/password" };
  await f.run("credentials", { username: "fixture-user", password: "external-password", credentialReference });
  // A subsequent OTP submission must retain the external-source binding.
  const pending=f.dependencies.read();
  const attemptId=crypto.randomUUID(),challengeId=crypto.randomUUID();
  f.dependencies.save({...pending,attemptId,challenge:{id:challengeId,revision:1,expiresAt:Date.now()+60000}});
  await f.run("credentials", {code:"123456",attemptId,challengeId,expectedRevision:1,submissionId:crypto.randomUUID()});
  f.authenticate();
  expect(await f.run("finish")).toMatchObject({ status: "connected", credentialsSaved: false });
  const row = f.db.query("SELECT envelope FROM native_vault WHERE id=?").get(id) as { envelope: string };
  const saved = await f.cipher.open<any>(`unlock:native-login:v1:123:${id}:service.net`, JSON.parse(row.envelope));
  expect(saved.credentialReference).toEqual(credentialReference);
  expect(saved.credentials).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("external-password");
  expect(saved.cookies).toEqual([cookie]);
});

 test("credential workflows never replace missing targets before or after submission",async()=>{
  for(const failAfter of [0,2]) {
   const f=await fixture();const send=f.dependencies.cdp.send;
   let inserted=0,created=0;
   f.dependencies.cdp.send=async(method,params)=>{
    if(method==="Target.attachToTarget"&&inserted>=failAfter)throw Error("Missing target");
    if(method==="Target.createTarget")created++;
    if(method==="Input.insertText")inserted++;
    if(method==="Runtime.evaluate"&&params.expression.includes("Object.keys(f)"))return {result:{value:["username","password"]}};
    return send(method,params);
   };
   await expect(submitNativeLogin({connectionId:id,domain:"service.net",action:"login",username:"fixture-user",password:"fixture-password"},f.dependencies,f.vault,undefined,async()=>{})).rejects.toThrow("Missing target");
   expect(created).toBe(0);expect(inserted).toBe(failAfter);
  }
 });
 test("disconnected login returns without polling or staging credentials",async()=>{
  const f=await fixture();f.dependencies.save({...f.state,status:"disconnected"});let pauses=0;
  const view=await submitNativeLogin({connectionId:id,domain:"service.net",action:"login",username:"fixture-user",password:"fixture-password"},f.dependencies,f.vault,undefined,async()=>{pauses++});
  expect(view.status).toBe("disconnected");expect(pauses).toBe(0);
  expect(f.db.query("SELECT * FROM native_vault").all()).toEqual([]);
 });

async function rotatingFixture(useCdp = false) {
  const f = await fixture();
  f.vault.stage(f.state, {
    connectionId: id,
    domain: "service.net",
    action: "credentials",
    username: "saved-user",
    password: "saved-password",
  });
  f.dependencies.save({ ...f.state, status: "connected", revision: 2 });
  const initial: import("@unlock/protocol").VaultCookie[] = [
    cookie,
    { ...cookie, name: "csrf", httpOnly: false },
    { ...cookie, name: "removed" },
  ];
  await f.vault.verified(f.state, initial);
  let jar = structuredClone(initial);
  let failExport = false;
  const browser = {
    async replaceCookies(cookies: typeof jar) {
      jar = structuredClone(cookies);
    },
    async exportCookies() {
      if (failExport) throw Error("Export unavailable");
      return structuredClone(jar);
    },
  };
  const adapter = useCdp
    ? await createCdpCookieAdapter(
        {
          async send(method, params): Promise<any> {
            if (method === "Target.getTargetInfo")
              return { targetInfo: { browserContextId: "owned" } };
            if (method === "Target.attachToTarget")
              return { sessionId: "session" };
            if (method === "Storage.getCookies") return { cookies: jar };
            if (method === "Network.deleteCookies")
              jar = jar.filter(
                (c) =>
                  !(
                    c.name === params.name &&
                    c.domain === params.domain &&
                    c.path === params.path
                  ),
              );
            if (method === "Storage.setCookies")
              jar.push(
                ...(params.cookies as any[]).map((c) => ({
                  ...c,
                  domain: c.domain ?? new URL(c.url).hostname,
                  expires: c.expires ?? -1,
                })),
              );
            return {};
          },
        },
        { browserContextId: "owned", targetId: "page" },
      )
    : browser;
  const bridge = await f.vault.bridge(
    f.state,
    adapter,
    "runtime",
    ["service.net"],
    f.dependencies.read,
  );
  return {
    f,
    browser,
    bridge,
    get jar() {
      return jar;
    },
    set jar(value) {
      jar = value;
    },
    failExport() {
      failExport = true;
    },
  };
}

test("SDK checkpoints rotation and deletions to account ciphertext for a fresh browser, retaining renewal credentials", async () => {
  const r = await rotatingFixture();
  const authRevision = r.f.state.revision;
  expect(
    await r.bridge.run(async () => {
      r.jar = [
        { ...cookie, value: "rotated-session" },
        { ...cookie, name: "csrf", value: "rotated-csrf", httpOnly: false },
        {
          ...cookie,
          name: "partitioned",
          value: "partition-value",
          partitionKey: {
            topLevelSite: "https://service.net",
            hasCrossSiteAncestor: true,
          },
        },
      ];
      return "action-complete";
    }),
  ).toBe("action-complete");
  expect(r.f.state.revision).toBe(authRevision);
  const reopened = new Database(r.f.path);
  try {
    const vault = new NativeLoginVault(reopened, "123", r.f.cipher);
    let restored: any[] = [];
    await vault.restore(r.f.state, {
      async send(method, params): Promise<any> {
        if (method === "Storage.getCookies") return { cookies: [] };
        if (method === "Storage.setCookies") restored = (params as {cookies: any[]}).cookies;
        return {};
      },
    });
    expect(restored.map((c) => [c.name, c.value])).toEqual([
      ["session", "rotated-session"],
      ["csrf", "rotated-csrf"],
      ["partitioned", "partition-value"],
    ]);
    expect(restored[2].partitionKey).toEqual({
      topLevelSite: "https://service.net",
      hasCrossSiteAncestor: true,
    });
    expect(await vault.renew(r.f.state, async (c) => c)).toEqual({
      username: "saved-user",
      password: "saved-password",
    });
    const foreign = new NativeLoginVault(
      reopened,
      "different-owner",
      r.f.cipher,
    );
    await expect(foreign.session(r.f.state)).rejects.toThrow();
    const plaintext = JSON.stringify(
      reopened.query("SELECT * FROM native_vault").all(),
    );
    for (const secret of ["rotated-session", "rotated-csrf", "saved-password"])
      expect(plaintext).not.toContain(secret);
  } finally {
    reopened.close();
  }
});

test("failed post-action export preserves result and durably blocks old-jar restoration and replay after restart", async () => {
  const r = await rotatingFixture();
  let actions = 0,
    failures = 0;
  expect(
    await r.bridge.run(
      async () => {
        actions++;
        r.jar = [{ ...cookie, value: "uncheckpointed" }];
        r.failExport();
        return "sent-once";
      },
      () => failures++,
    ),
  ).toBe("sent-once");
  expect(failures).toBe(1);
  expect(r.bridge.status().ready).toBe(false);
  await expect(
    r.bridge.run(async () => {
      actions++;
    }),
  ).rejects.toThrow();
  const reopened = new Database(r.f.path);
  try {
    const vault = new NativeLoginVault(reopened, "123", r.f.cipher);
    await expect(vault.session(r.f.state)).rejects.toThrow(
      "uncertain cookie save",
    );
    let browserCalls = 0;
    await expect(
      vault.restore(r.f.state, {
        async send() {
          browserCalls++;
          return {};
        },
      }),
    ).rejects.toThrow("uncertain cookie save");
    expect(browserCalls).toBe(0);
    await expect(
      vault.sync(r.f.state, 2, [cookie], r.f.dependencies.read),
    ).rejects.toThrow("uncertain cookie save");
    await expect(vault.verified(r.f.state, [cookie])).rejects.toThrow(
      "uncertain cookie save",
    );
    const fresh = { ...r.f.state, revision: r.f.state.revision + 2 };
    r.f.dependencies.save(fresh);
    await vault.verified(fresh, [{ ...cookie, value: "newly-verified" }]);
    expect((await vault.session(fresh))?.[0].value).toBe("newly-verified");
    await expect(r.bridge.recover()).rejects.toThrow();
    expect(
      reopened.query("SELECT * FROM native_cookie_checkpoint").all(),
    ).toEqual([]);
  } finally {
    reopened.close();
  }
  expect(actions).toBe(1);
});

test("in-flight browser action fences another process before it can restore stale cookies", async () => {
  const r = await rotatingFixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const running = r.bridge.run(async () => {
    entered();
    await gate;
    r.jar = [{ ...cookie, value: "finished" }];
  });
  await started;
  const reopened = new Database(r.f.path);
  try {
    const vault = new NativeLoginVault(reopened, "123", r.f.cipher);
    await expect(vault.session(r.f.state)).rejects.toThrow(
      "uncertain cookie save",
    );
  } finally {
    reopened.close();
    release();
  }
  await running;
  expect((await r.f.vault.session(r.f.state))?.[0].value).toBe("finished");
});

test("cookie CAS rejects stale writers, foreign scopes and revoked generations", async () => {
  const r = await rotatingFixture();
  const results = await Promise.allSettled([
    r.f.vault.sync(
      r.f.state,
      2,
      [{ ...cookie, value: "writer-a" }],
      r.f.dependencies.read,
    ),
    r.f.vault.sync(
      r.f.state,
      2,
      [{ ...cookie, value: "writer-b" }],
      r.f.dependencies.read,
    ),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
  for (const invalid of [
    { ...cookie, domain: ".foreign.net" },
    { ...cookie, secure: false },
    {
      ...cookie,
      partitionKey: {
        topLevelSite: "https://foreign.net",
        hasCrossSiteAncestor: true,
      },
    },
  ])
    await expect(
      r.f.vault.sync(r.f.state, 3, [invalid], r.f.dependencies.read),
    ).rejects.toThrow("scope mismatch");
  const state = r.f.state;
  r.f.dependencies.save({
    ...state,
    status: "disconnected",
    revision: state.revision + 1,
  });
  await expect(
    r.f.vault.sync(state, 3, [cookie], r.f.dependencies.read),
  ).rejects.toThrow("session changed");
  r.f.vault.remove(id);
  await expect(
    r.f.vault.session({ ...state, credentialsSaved: true }),
  ).rejects.toThrow("session missing");
});

test("logout checkpoints an empty jar so future browsers cannot resurrect authentication", async () => {
  const r = await rotatingFixture();
  await r.bridge.run(async () => {
    r.jar = [];
  });
  expect(r.bridge.status().ready).toBe(false);
  const restarted = new NativeLoginVault(r.f.db, "123", r.f.cipher);
  await expect(restarted.session(r.f.state)).rejects.toThrow("session expired");
  expect(r.f.db.query("SELECT * FROM native_cookie_checkpoint").all()).toEqual(
    [],
  );
});

test("native SDK scope checkpoints cookies on newly discovered app subdomains and preserves foreign cookies", async () => {
  const r = await rotatingFixture(true);
  await r.bridge.run(async () => {
    r.jar.push({
      ...cookie,
      name: "new-host",
      value: "new-host-value",
      domain: "api.service.net",
      hostOnly: true,
    });
    r.jar.push({
      ...cookie,
      name: "foreign",
      domain: "other.net",
      hostOnly: true,
    });
  });
  const saved = await new NativeLoginVault(r.f.db, "123", r.f.cipher).session(
    r.f.state,
  );
  expect(saved?.find((c) => c.name === "new-host")).toMatchObject({
    domain: "api.service.net",
    value: "new-host-value",
    hostOnly: true,
  });
  expect(saved?.some((c) => c.name === "foreign")).toBe(false);
  expect(r.jar.some((c) => c.name === "foreign")).toBe(true);
  await r.bridge.run(async () => {
    r.jar = r.jar.filter((c) => c.name !== "new-host");
  });
  expect(
    (await r.f.vault.session(r.f.state))?.some((c) => c.name === "new-host"),
  ).toBe(false);
});

const rotationEndpoint = process.env.AIKO_SESSION_TEST_CDP;
(rotationEndpoint ? test : test.skip)(
  "live Chrome rotation survives encrypted restart into a different empty browser context",
  async () => {
    const { openPrivateBrowserCdp, createOwnedCookieAdapter } =
      await import("../src/browser-driver.ts");
    const f = await fixture();
    f.dependencies.save({ ...f.state, status: "connected", revision: 2 });
    await f.vault.verified(f.state, [cookie]);
    const cdp = await openPrivateBrowserCdp(rotationEndpoint!);
    const contexts: string[] = [];
    const newBrowser = async () => {
      const { browserContextId } = await cdp.send(
        "Target.createBrowserContext",
        {},
      );
      contexts.push(browserContextId);
      const { targetId } = await cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      return {
        browserContextId,
        adapter: await createOwnedCookieAdapter(cdp, {
          browserContextId,
          targetId,
        }),
      };
    };
    try {
      const first = await newBrowser();
      await first.adapter.replaceCookies([cookie], ["service.net"], true);
      const bridge = await f.vault.bridge(
        f.state,
        first.adapter,
        "live-runtime",
        ["service.net"],
        f.dependencies.read,
      );
      await bridge.run(async () => {
        await first.adapter.replaceCookies(
          [
            { ...cookie, value: "LIVE_ROTATED_FIXTURE" },
            {
              ...cookie,
              name: "subdomain",
              domain: "api.service.net",
              hostOnly: true,
              value: "LIVE_HOST_FIXTURE",
            },
          ],
          ["service.net"],
          true,
        );
      });
      f.vault.close();
      const reopened = new Database(f.path);
      try {
        const vault = new NativeLoginVault(reopened, "123", f.cipher);
        const second = await newBrowser();
        expect(
          await second.adapter.exportCookies(["service.net"], true),
        ).toEqual([]);
        await vault.restore(f.state, {
          send: (method, params) =>
            cdp.send(method, {
              ...params,
              browserContextId: second.browserContextId,
            }),
        });
        const actual = await second.adapter.exportCookies(
          ["service.net"],
          true,
        );
        expect(actual.find((c) => c.name === "session")?.value).toBe(
          "LIVE_ROTATED_FIXTURE",
        );
        expect(actual.find((c) => c.name === "subdomain")?.value).toBe(
          "LIVE_HOST_FIXTURE",
        );
        expect(actual.every((c) => c.httpOnly && c.secure)).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      for (const browserContextId of contexts)
        await cdp.send("Target.disposeBrowserContext", { browserContextId });
      cdp.close();
    }
  },
);
