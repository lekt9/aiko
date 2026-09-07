import { test, expect } from "bun:test";
import { ConnectorEngine, type ConnectorStore, type SecureBrowserAdapter, type SecureBrowserBinding } from "../src/connectors.ts";
import { nativeBrowserConnector } from "../src/native-browser-connector.ts";
import { BrowserLearning } from "../src/browser-learning.ts";
import { executableObservedReads } from "../src/capability-builder-network.ts";
import type { Event } from "tardie/core/event";
import { connectionRoute } from "../src/connection-index.ts";
class Store implements ConnectorStore {
 rows = new Map<string, any>();
 async get(key: string) { return structuredClone(this.rows.get(key)); }
 async set(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
 async list(prefix: string) { return [...this.rows].filter(([key]) => key.startsWith(prefix)).map(([, row]) => structuredClone(row)); }
}
const catalogFetch = async (url: Parameters<typeof fetch>[0]) => new Response(JSON.stringify(String(url).includes("tools?") ? { items: [{ qualified_name: "GitHub.Read", toolkit: { name: "GitHub" }, metadata: { classification: { service_domains: ["github.com"] } } }], offset: 0, total_count: 1 } : { items: [], offset: 0, total_count: 0 }));
const engine = (secureBrowser: SecureBrowserAdapter, store = new Store(), owner = "123") => new ConnectorEngine({ owner, store, env: { ARCADE_API_KEY: "fixture-only-browser-key" }, fetch: catalogFetch, secureBrowser });
const begin = async () => ({ authorizationUrl: "https://signin.aiko.com/owner-only-relay" });
const verified = (binding: SecureBrowserBinding, revision = 1) => ({ ...binding, status: "connected" as const, verification: { verified: true as const, revision, expiresAt: Date.now() + 600000 } });

test("expired native connections renew in place and expose a resumable MFA challenge",async()=>{
 for(const challenge of [false,true]) {
  const store=new Store(); let checks=0;
  const e=engine({native:true,begin,status:async b=>{checks++;return challenge && checks>1?{...b,status:"pending"}:verified(b,checks);}},store);
  const first=await e.connectBrowser("service.net");
  await e.completeAuth(first.id);
  for(const row of store.rows.values()) if(row.id===first.id) row.browserVerification.expiresAt=Date.now()-1;
  const result=(await e.connections())[0]!;
  expect(result.id).toBe(first.id);
  expect(result.status).toBe(challenge?"pending":"connected");
  expect(checks).toBe(2);
  if(challenge)expect(result.authorizationUrl).toContain("signin.aiko.com");
  await e.connections();expect(checks).toBe(2);
  await e.disconnect(first.id);
  await e.connections();expect(checks).toBe(2);
 }
});

test("native connect reuses its flow and reconciles only already-revoked browser grants", async()=>{
 const store=new Store();let cleanup=0;let confirmed=false;
 const adapter:SecureBrowserAdapter={native:true,begin,disconnect:async b=>{cleanup++;return {...b,status:confirmed?"disconnected":"unknown"}}};
 const e=new ConnectorEngine({owner:"123",store,secureBrowser:adapter});
 const first=await e.connectBrowser("service.net");
 expect((await e.connectBrowser("service.net")).id).toBe(first.id);
 await e.disconnect(first.id);expect(cleanup).toBe(1);
 await expect(e.connectBrowser("second.net")).rejects.toThrow("cleanup");expect(cleanup).toBe(2);
 confirmed=true;const next=await e.connectBrowser("second.net");expect(cleanup).toBe(3);expect(next.status).toBe("pending");
 // A legacy duplicate with a newer grant must not lose that grant's cookies.
 for(const row of store.rows.values())if(row.id===first.id){row.connectorId="browser:second.net";row.relayDisconnectStatus="unknown";}
 await expect(e.connectBrowser("third.net")).rejects.toThrow("active connection");expect(cleanup).toBe(3);
});

test("native initial context uses read-only actions, rejects login walls and strips URL secrets",async()=>{
 const calls:string[]=[];let login=0;let url="https://service.net/home?session=private#fragment";
 const adapter=nativeBrowserConnector("123",async()=>({execute:async(input:any)=>{
   calls.push(input.action);
   if(input.action==="url")return {url};
   if(input.action==="get_count")return {count:login};
   return {text:"Project review due tomorrow"};
 }} as any), async () => {});
 const binding={owner:"123",connectionId:"fixture-context",domain:"service.net"};
 const context=await adapter.readContext!(binding);expect(context.url).toBe("https://service.net/home");
 expect(calls).toEqual(["navigate","url","get_count","snapshot","get_text","url","get_count","url"]);
 expect(JSON.stringify(context)).not.toContain("session");
 login=1;await expect(adapter.readContext!(binding)).rejects.toThrow("sign-in");
 login=0;url="https://other.net/";await expect(adapter.readContext!(binding)).rejects.toThrow("domain");
 const count=calls.length;await expect(adapter.readContext!({...binding,owner:"456"})).rejects.toThrow("Owner");expect(calls).toHaveLength(count);
});

test("route discovery retains ordinary parameters and excludes credentials, actions and foreign destinations", async () => {
 const hrefs = ["/projects?id=12", "/projects?id=12#heading", "#/projects/12", "/logout", "#/logout", "/projects?session=private", "//other.net/projects", "/%64elete/12"];
 let current = "https://service.net/home";
 const adapter = nativeBrowserConnector("123", async () => ({close:async()=>{},execute:async action => {
  if (action.action === "navigate") current = action.url;
  if (action.action === "url") return {url:current};
  if (action.action === "get_count") return {count:action.selector === "a[href]" ? hrefs.length : 0};
  if (action.action === "get_attribute") return {value:hrefs[Number(action.selector.split("nth=")[1])]};
  return {text:"Projects"};
 }}), async () => {});
 const page = await adapter.readContext!({owner:"123",domain:"service.net",connectionId:"route-test"}, undefined, current);
 expect(page.links).toEqual(["https://service.net/projects?id=12", "https://service.net/home#/projects/12"]);
 expect(page.linksTruncated).toBe(false);
 for (const href of ["https://service.net/#/logout", "https://service.net/?token=private", "https://service.net/#/projects?secret=private", "https://127.0.0.1/projects", "javascript:alert(1)"])
  expect(connectionRoute(href,"service.net")).toBeUndefined();
});

test("native link batches continue beyond the first 256 anchors", async () => {
 const selected: number[] = [];
 const adapter = nativeBrowserConnector("123", async () => ({close:async()=>{},execute:async action => {
  if (action.action === "url") return {url:"https://service.net/home"};
  if (action.action === "get_count") return {count:action.selector === "a[href]" ? 258 : 0};
  if (action.action === "get_attribute") {const index = Number(action.selector.split("nth=")[1]);selected.push(index);return {value:`/projects/${index}`};}
  return {text:"Projects"};
 }}), async () => {});
 const binding = {owner:"123",domain:"service.net",connectionId:"route-batches"};
 const first = await adapter.readContext!(binding);
 expect(first.links).toHaveLength(256);
 expect(first).toMatchObject({linksTruncated:true,nextLinkOffset:256});
 const last = await adapter.readContext!(binding, undefined, first.url, first.nextLinkOffset);
 expect(last.links).toEqual(["https://service.net/projects/256","https://service.net/projects/257"]);
 expect(last.linksTruncated).toBe(false);
 expect(last.nextLinkOffset).toBeUndefined();
 expect(selected).toEqual(Array.from({length:258},(_,i)=>i));
});

test("connection events are durable metadata and replay a lost delivery acknowledgement", async () => {
 const store=new Store(); const seen:any[]=[]; let unavailable=true;
 const options={owner:"123",store,arcadeOAuthEnabled:false,secureBrowser:{native:true,begin,status:async (b:SecureBrowserBinding)=>verified(b)},onEvent:async(e:any)=>{if(unavailable)throw Error("offline");seen.push(e)}};
 const first=new ConnectorEngine(options); const row=await first.connectBrowser("service.net");
 expect(seen).toHaveLength(0);
 expect([...store.rows.values()][0].pendingEvents).toHaveLength(1);
 unavailable=false;const recovered=new ConnectorEngine(options);await recovered.flushEvents();
 await recovered.completeAuth(row.id);await recovered.completeAuth(row.id);await recovered.flushEvents();
 expect(seen.map(e=>e.status)).toEqual(["pending","connected"]);
 expect(new Set(seen.map(e=>e.id)).size).toBe(2);
 expect(JSON.stringify(seen)).not.toMatch(/authorization|password|cookie|token|owner-only-relay/);
 expect([...store.rows.values()][0].pendingEvents).toHaveLength(0);
});
test("post-login context forwards the complete learned request graph before acknowledging it", async () => {
 const events: Event[] = [];
 let offline = false;
 const adapter = nativeBrowserConnector("123", async ({owner, emit}) => {
  expect(owner).toBe("123");
  let sequence = 0;
  const learning = new BrowserLearning({
   threadId: "connected-page-trace", nextSequence: () => ++sequence,
   emit: e => emit(e),
   onPrepared: async e => { await emit({type: "AikoRequestMemoryIndexed", toolDigest: e.toolDigest}); },
  });
  return {close: async () => {}, execute: async input => {
   if (input.action === "navigate") {
    const entry = {startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true,
     request: {method: "GET", url: "https://service.net/api/projects", headers: [], cookies: []},
     response: {status: 200, headers: [], cookies: [], content: {mimeType: "application/json", size: 15, text: '{"projects":[]}'}}};
    await learning.observe(entry, 0, true);
    await learning.compile([entry], [{callId: "navigate", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true}], "https://service.net");
   }
   if (input.action === "url") return {url: "https://service.net/home"};
   if (input.action === "get_count") return {count: 0};
   return {text: "Projects"};
  }};
 }, async e => { if (offline) throw new Error("Host log unavailable"); events.push(e as Event); });
 const binding = {owner: "123", connectionId: "connected-context", domain: "service.net"};
 await adapter.readContext!(binding);
 expect(executableObservedReads(events)).toHaveLength(1);
 expect(JSON.stringify(events)).not.toContain('{"projects":[]}');
 offline = true;
 await expect(adapter.readContext!(binding)).rejects.toThrow("Host log unavailable");
});
test("initial context needs verified owner access and rechecks disconnection after the read", async()=>{
 const store=new Store();let reads=0;let revoke:undefined|(()=>Promise<unknown>);
 const adapter:SecureBrowserAdapter={native:true,begin,status:async b=>verified(b),readContext:async b=>{reads++;await revoke?.();return {url:`https://${b.domain}/home`,text:"A project has a review due tomorrow."}}};
 const e=new ConnectorEngine({owner:"123",store,secureBrowser:adapter});
 const c=await e.connectBrowser("service.net");
 await expect(e.initialContext(c.id)).rejects.toThrow();expect(reads).toBe(0);
 await e.completeAuth(c.id);
 const context=await e.initialContext(c.id);expect(context.type).toBe("connected-app-context");
 const other=new ConnectorEngine({owner:"456",store,secureBrowser:adapter});
 await expect(other.initialContext(c.id)).rejects.toThrow();expect(reads).toBe(1);
 revoke=()=>e.disconnect(c.id);
 await expect(e.initialContext(c.id)).rejects.toThrow("revoked");
});

test("initial context rejects a session replaced during the browser read", async () => {
 const store = new Store();
 let revision = 1;
 let replaceSession: (() => Promise<unknown>) | undefined;
 const adapter: SecureBrowserAdapter = {
  native: true, begin, status: async b => verified(b, revision),
  readContext: async b => {
   await replaceSession?.();
   return {url: `https://${b.domain}/home`, text: "Context from the previous session"};
  },
 };
 const e = new ConnectorEngine({owner: "123", store, secureBrowser: adapter});
 const c = await e.connectBrowser("service.net");
 await e.completeAuth(c.id);
 replaceSession = async () => { revision = 2; await e.completeAuth(c.id); };
 await expect(e.initialContext(c.id)).rejects.toThrow("session changed");
 expect((await e.connections())[0]!.status).toBe("connected");
 replaceSession = undefined;
 expect((await e.initialContext(c.id)).id).toBe(`connection:${c.id}:2`);
});

test("begin-only relay stays pending; browser execution is never fabricated", async () => {
 const e = engine({ begin }); const connection = await e.connectBrowser("service.net");
 expect(connection.status).toBe("pending");
 await expect(e.completeAuth(connection.id)).rejects.toThrow("not configured");
 expect((await e.connections())[0]!.status).toBe("pending");
 await expect(e.execute(connection.id, {})).rejects.toThrow("not executable");
});

test("owner-bound verified relay completion survives restart and persists only safe metadata", async () => {
 const store = new Store(); let received: SecureBrowserBinding | undefined;
 const adapter: SecureBrowserAdapter = { begin, status: async (binding, signal) => {
  received = binding; expect(signal).toBeInstanceOf(AbortSignal);
  return { ...verified(binding), password: "private-password", cookies: [{ value: "private-cookie" }], identity: "private-identity" } as any;
 } };
 const one = engine(adapter, store); const pending = await one.connectBrowser("service.net");
 const two = engine(adapter, store); const connected = await two.completeAuth(pending.id);
 expect(received).toEqual({ owner: "123", domain: "service.net", connectionId: pending.id });
 expect(connected).toEqual({ ...pending, status: "connected", authorizationUrl: undefined });
 expect((await engine(adapter, store).connections())[0]!.status).toBe("connected");
 const saved = JSON.stringify([...store.rows.values()]);
 expect(saved).not.toMatch(/private-password|private-cookie|private-identity|owner-only-relay/);
 expect([...store.rows.values()][0].browserVerification).toMatchObject({ verified: true, revision: 1 });
 await expect(two.execute(connected.id, {})).rejects.toThrow("not executable");
});

test("foreign owner never invokes relay status or disconnect hooks", async () => {
 const store = new Store(); let statusCalls = 0; let disconnectCalls = 0;
 const adapter: SecureBrowserAdapter = { begin, status: async b => { statusCalls++; return verified(b); }, disconnect: async b => { disconnectCalls++; return { ...b, status: "disconnected" }; } };
 const connection = await engine(adapter, store).connectBrowser("service.net");
 const foreign = engine(adapter, store, "456");
 await expect(foreign.completeAuth(connection.id)).rejects.toThrow();
 await expect(foreign.disconnect(connection.id)).rejects.toThrow();
 expect(statusCalls).toBe(0); expect(disconnectCalls).toBe(0);
});

test("wrong owner/domain/flow, unverified session and expired evidence cannot complete a relay", async () => {
 for (const override of [
  { owner: "456" }, { domain: "other.net" }, { connectionId: "different-flow" },
  { verification: undefined }, { verification: { verified: false, revision: 1, expiresAt: Date.now() + 600000 } },
  { verification: { verified: true, revision: 0, expiresAt: Date.now() + 600000 } },
  { verification: { verified: true, revision: 1, expiresAt: Date.now() - 1 } },
 ]) {
  const e = engine({ begin, status: async b => ({ ...verified(b), ...override }) as any });
  const pending = await e.connectBrowser("service.net");
  await expect(e.completeAuth(pending.id)).rejects.toThrow();
  expect((await e.connections())[0]!.status).toBe("pending");
 }
});

test("pending/unknown/failure status never invents a completed grant or exposes host errors", async () => {
 let mode = "pending";
 const e = engine({ begin, status: async b => {
  if (mode === "throw") throw new Error("password=private-host-secret");
  return { ...b, status: mode } as any;
 } });
 const connection = await e.connectBrowser("service.net");
 expect((await e.completeAuth(connection.id)).status).toBe("pending");
 mode = "unknown"; await expect(e.completeAuth(connection.id)).rejects.toThrow("could not be confirmed");
 mode = "throw"; await expect(e.completeAuth(connection.id)).rejects.toThrow("Secure browser operation unavailable");
 mode = "failed"; expect((await e.completeAuth(connection.id)).status).toBe("failed");
 expect((await e.connections())[0]).not.toHaveProperty("authorizationUrl");
});

test("expired pending and verified browser sessions are not shown as connected", async () => {
 const store = new Store(); let checks = 0;
 const e = engine({ begin, status: async b => { checks++; return verified(b); } }, store);
 const pending = await e.connectBrowser("service.net");
 for (const row of store.rows.values()) row.expiresAt = Date.now() - 1;
 expect((await e.completeAuth(pending.id)).status).toBe("failed"); expect(checks).toBe(0);
 const fresh = await e.connectBrowser("service.net"); await e.completeAuth(fresh.id);
 for (const row of store.rows.values()) if (row.id === fresh.id) row.browserVerification.expiresAt = Date.now() - 1;
 expect((await e.connections()).find(c => c.id === fresh.id)!.status).toBe("failed");
 expect((await e.completeAuth(fresh.id)).status).toBe("failed"); expect(checks).toBe(1);
});

test("connected browser status can be revoked and cannot regress its verified revision", async () => {
 let status = "connected"; let revision = 2;
 const e = engine({ begin, status: async b => status === "connected" ? verified(b, revision) : { ...b, status: "failed" } });
 const connection = await e.connectBrowser("service.net"); await e.completeAuth(connection.id);
 revision = 1; await expect(e.completeAuth(connection.id)).rejects.toThrow("revision regressed");
 status = "failed"; expect((await e.completeAuth(connection.id)).status).toBe("failed");
});

test("disconnect is durably local first, explicitly confirms host revocation, and is idempotent", async () => {
 const store = new Store(); let calls = 0; let last: SecureBrowserBinding | undefined;
 const adapter: SecureBrowserAdapter = { begin, status: async b => verified(b), disconnect: async b => {
  calls++; last = b; const row = [...store.rows.values()].find(row => row.id === b.connectionId);
  expect(row.status).toBe("disconnected"); expect(row).not.toHaveProperty("browserVerification");
  return { ...b, status: "disconnected" };
 } };
 const e = engine(adapter, store); const connection = await e.connectBrowser("service.net"); await e.completeAuth(connection.id);
 expect(await e.disconnect(connection.id)).toMatchObject({ status: "disconnected", relayDisconnectStatus: "confirmed" });
 expect(last).toEqual({ owner: "123", domain: "service.net", connectionId: connection.id });
 await engine(adapter, store).disconnect(connection.id); expect(calls).toBe(1);
 expect((await e.completeAuth(connection.id)).status).toBe("disconnected");
});

test("unavailable or mismatched host revocation never claims remote success", async () => {
 for (const adapter of [
  { begin },
  { begin, disconnect: async () => { throw new Error("private-password"); } },
  { begin, disconnect: async (b: SecureBrowserBinding) => ({ ...b, owner: "456", status: "disconnected" as const }) },
  { begin, disconnect: async (b: SecureBrowserBinding) => ({ ...b, status: "unknown" as const }) },
 ]) {
  const e = engine(adapter); const connection = await e.connectBrowser("service.net");
  const disconnected = await e.disconnect(connection.id);
  expect(disconnected.status).toBe("disconnected");
  expect(disconnected.relayDisconnectStatus).toBe("disconnect" in adapter ? "unknown" : "unavailable");
  expect(disconnected).not.toHaveProperty("authorizationUrl");
 }
});

test("failed begin leaves a recoverable local binding for host cleanup, no raw secrets", async () => {
 let calls = 0;
 const e = engine({ begin: async () => { throw new Error("private-relay-password"); }, disconnect: async b => { calls++; return { ...b, status: "disconnected" }; } });
 await expect(e.connectBrowser("service.net")).rejects.toThrow("Secure browser connection could not be started");
 const connection = (await e.connections())[0]!;
 expect(connection.status).toBe("failed"); expect(connection).not.toHaveProperty("authorizationUrl");
 await e.disconnect(connection.id); expect(calls).toBe(1);
});

test("disconnect queued during relay completion cannot be undone by late host status", async () => {
 const store = new Store(); let entered!: () => void; let release!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const waiting = new Promise<void>(resolve => { release = resolve; });
 const adapter: SecureBrowserAdapter = { begin, status: async b => { entered(); await waiting; return verified(b); }, disconnect: async b => ({ ...b, status: "disconnected" }) };
 const one = engine(adapter, store); const two = engine(adapter, store);
 const connection = await one.connectBrowser("service.net");
 const completing = one.completeAuth(connection.id); await started;
 const disconnecting = two.disconnect(connection.id); release(); await completing; await disconnecting;
 expect((await one.connections())[0]).toMatchObject({ status: "disconnected", relayDisconnectStatus: "confirmed" });
});
