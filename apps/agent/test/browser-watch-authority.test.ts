import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserWatchConnectionAuthorized, PrivateBrowserSessions, type PrivateSessionRecord } from "../src/browser-driver.ts";
import type { NativeLoginState } from "../src/native-login.ts";
import type { BrowserProducerGrant } from "../src/browser-events.ts";
import { nativeLoginCipher } from "../src/native-login-vault.ts";
import { registryExternalEventAllowed } from "../src/registry-host.ts";

const now = 1_800_000_000_000;
const grant: BrowserProducerGrant = {owner:"alice",profile:"profile-a",producer:"producer",epoch:"epoch",generation:1,
  connectionId:"connected-site",connectionRevision:"7",origins:["https://example.com"],kinds:["push"],
  active:true,expiresAt:now+10000,registeredAt:now-1000,secret:"fixture-only-secret-000000000000000000"};
const native = {connectionId:"connected-site",domain:"example.com",revision:7,status:"connected",expiresAt:now+10000} as NativeLoginState;
test("generic host ingress cannot forge signed browser facts or trusted watch lifecycle receipts", () => {
  for (const type of ["AikoBrowserPushObserved","AikoBrowserNotificationObserved","AikoBrowserNetworkObserved",
    "AikoBrowserWatchPrepared","AikoBrowserWatchActivated","AikoBrowserWatchStarted","AikoBrowserWatchSettled"])
    expect(registryExternalEventAllowed({type,owner:"alice",id:"forged"})).toBe(false);
  expect(registryExternalEventAllowed({type:"AikoBrowserSetupProgress",owner:"alice",id:"diagnostic"})).toBe(true);
});
test("watch authority binds exact owner, profile, connection revision and every origin", () => {
  const allowed = (g=grant, states=[native]) => browserWatchConnectionAuthorized(g,"alice","profile-a",states,()=>false,now);
  expect(allowed()).toBe(true);
  for (const changes of [{owner:"bob"},{profile:"profile-b"},{connectionId:"other"},{connectionRevision:"6"},
    {active:false},{expiresAt:now},{origins:["https://example.com","https://other.example"]}])
    expect(allowed({...grant,...changes})).toBe(false);
  expect(allowed(grant,[{...native,expiresAt:now}])).toBe(false);
  expect(allowed(grant,[{...native,status:"disconnected"}])).toBe(false);
  expect(browserWatchConnectionAuthorized(grant,"alice","profile-a",[{...native,status:"disconnected"}],()=>true,now)).toBe(false);
  expect(browserWatchConnectionAuthorized(grant,"alice","profile-a",[],(id,revision,origin)=>id===grant.connectionId&&revision==="7"&&origin==="https://example.com",now)).toBe(true);
});

test("persisted cookie metadata cannot revive a watch after the browser context rotates", () => {
  const record: PrivateSessionRecord = {owner:"alice",contextId:"old-context",generation:1,domain:"example.com",tenantId:"tenant",
    profileId:"profile",runtimeId:"runtime",connectionId:"connected-site",allowedDomains:["example.com"],
    connectionGeneration:1,revision:7,expiresAt:now+10000,active:true,revoked:false};
  const sessions = new PrivateBrowserSessions({owner:"alice",contextId:"new-context",generation:1},
    async()=>{throw Error("Authority inspection must not touch browser");},()=>{},[record],()=>now);
  expect(sessions.watchAuthorized("connected-site","7","example.com")).toBe(false);
  expect(sessions.watchAuthorized("other","7","example.com")).toBe(false);
});

for (const table of ["browser_watch_leases", "browser_watch_health"])
test(`missing encryption key preserves retained ciphertext in ${table}`, () => {
  const dir = mkdtempSync(join(tmpdir(),"aiko-watch-key-")), db=new Database(":memory:");
  try {
    db.exec(`CREATE TABLE ${table}(producer TEXT PRIMARY KEY,owner TEXT,envelope TEXT)`);
    db.query(`INSERT INTO ${table} VALUES(?,?,?)`).run("producer","alice","encrypted-fixture");
    expect(()=>nativeLoginCipher(dir,db)).toThrow("Browser watch wrapping key missing");
    expect(existsSync(join(dir,"unlock-vault.key"))).toBe(false);
    expect(db.query(`SELECT envelope FROM ${table}`).get()).toEqual({envelope:"encrypted-fixture"});
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
