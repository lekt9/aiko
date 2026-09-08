import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, chmod, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeLogin, prepareNativeLogin, type NativeLoginState } from "../src/native-login.ts";
import {
  NativeLoginVault,
  nativeLoginCipher,
} from "../src/native-login-vault.ts";
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
