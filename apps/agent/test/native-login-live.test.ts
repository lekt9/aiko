import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { nativeLogin, type NativeLoginInput, type NativeLoginState } from "../src/native-login.ts";
import { NativeLoginVault, nativeLoginCipher } from "../src/native-login-vault.ts";
import { renewNativeLogin } from "../src/native-login-renewal.ts";
import { openPrivateBrowserCdp } from "../src/browser-driver.ts";

const endpoint = process.env.AIKO_NATIVE_LOGIN_TEST_CDP;
(endpoint ? test : test.skip)("real Chrome verifies login, restores its encrypted session, renews the password and revokes it", async () => {
  const directory = await mkdtemp("/tmp/unlock-login-live-");
  const db = new Database(`${directory}/vault.sqlite`);
  db.exec("CREATE TABLE login(state TEXT NOT NULL)");
  let vault = new NativeLoginVault(db,"live_fixture",nativeLoginCipher(directory,db));
  const cdp = await openPrivateBrowserCdp(endpoint!);
  const binding = {connectionId:crypto.randomUUID(),domain:"login-fixture.aiko.ai"};
  const dependencies = {
    cdp,
    read: () => {
      const row=db.query("SELECT state FROM login LIMIT 1").get() as {state:string}|null;
      return row ? JSON.parse(row.state) as NativeLoginState : undefined;
    },
    save: (state:NativeLoginState) => db.transaction(() => {db.exec("DELETE FROM login");db.query("INSERT INTO login VALUES(?)").run(JSON.stringify(state));})(),
    credentials: (state:NativeLoginState,input:NativeLoginInput) => vault.stage(state,input),
    verified: (state:NativeLoginState,cookies:unknown[]) => vault.verified(state,cookies),
  };
  const run = (action:NativeLoginInput["action"], fields:object={}) => nativeLogin({...binding,action,...fields},dependencies);
  try {
    let view=await run("begin");
    for(let attempt=0;attempt<30&&!view.fields?.includes("password");attempt++) {
      await Bun.sleep(100); view=await run("form");
    }
    expect(view.fields).toEqual(["username","password"]);
    await run("credentials",{username:"fixture-user",password:"fixture-password"});
    for(let attempt=0;attempt<30;attempt++) {
      try {view=await run("finish"); if(view.status === "connected") break; } catch {}
      await Bun.sleep(100);
    }
    expect(view.status).toBe("connected");
    expect(view.credentialsSaved).toBe(true);
    const state=dependencies.read()!;
    const cookies=await vault.session(state);
    expect(cookies?.some(c=>c.httpOnly&&c.secure)).toBe(true);
    // Lose the in-memory vault and browser cookies, then recover from disk.
    vault.close(); vault=new NativeLoginVault(db,"live_fixture",nativeLoginCipher(directory,db));
    await cdp.send("Storage.clearCookies",{});
    expect(await vault.restore(state,cdp)).toBe(true);
    expect((await cdp.send("Storage.getCookies",{})).cookies.some((c:any)=>c.name === "sid")).toBe(true);
    // Cookie loss now requires a fresh password submission into the real form.
    await cdp.send("Storage.clearCookies",{});
    view=await renewNativeLogin({...binding,action:"renew"},dependencies,vault);
    expect(view.status).toBe("connected");
    expect(view.credentialsSaved).toBe(true);
    expect(view.revision).toBe(state.revision+2);
    expect(JSON.stringify(db.query("SELECT * FROM native_vault").all())).not.toContain("fixture-password");
    expect(JSON.stringify(db.query("SELECT * FROM login").all())).not.toContain("fixture-password");
    expect((await run("disconnect")).status).toBe("disconnected");
    vault.remove(binding.connectionId);
    expect((await cdp.send("Storage.getCookies",{})).cookies.some((c:any)=>c.domain === binding.domain)).toBe(false);
    expect(await vault.renew(dependencies.read()!,async()=>true)).toBeUndefined();
  } finally {
    cdp.close(); vault.close(); db.close(); await rm(directory,{recursive:true,force:true});
  }
},30000);
