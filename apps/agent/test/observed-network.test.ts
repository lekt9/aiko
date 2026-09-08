import { expect, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { artifactDigestOf, ownedNetworkDefinitions, ownedObservedActions } from "../src/capability-builder-network.ts";
import { createObservedNetworkTools, resolveObservedRead, sendObservedHttp, sendPublicHarnessRequest, type ObservedHttpOptions } from "../src/observed-network.ts";
import { cookieHeader } from "../src/unlock-session.ts";
import { createActionApprovals } from "../src/action-approval.ts";
import type { HarnessTransportRequest, HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";

async function compiled(query = "") {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({
    threadId: "owned-trace",
    nextSequence: () => ++sequence,
    emit: async e => { events.push(e); },
  });
  const entry = {
    startedDateTime: new Date(1000).toISOString(),
    time: 20,
    _observationComplete: true,
    request: { method: "GET", url: `https://api.vendor.com/items${query}`, headers: [], cookies: [] },
    response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{"items":[]}' } },
  };
  await learning.observe(entry, 0, true);
  await learning.compile([entry], [{ callId: "call", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true }], "https://api.vendor.com");
  return events;
}

test("database read adapter uses owned Merkle contracts and transient selection without raw result retention", async () => {
  let events = await compiled(), calls = 0;
  const learned = ownedNetworkDefinitions(events)[0]!;
  events.push({ type: "AikoRequestMemoryIndexed", toolDigest: learned.toolDigest, owner: "123", at: 2000 });
  const binding = { owner: "123", thread: "user-123", redact: (text: string) => text, readEvents: async () => events, checkArcade: async () => true, send: async (_request: HarnessTransportRequest) => {
    calls++; return { status: 200, headers: { "content-type": "application/json" }, classification: "application" as const, body: { count: 12, title: "PRIVATE_SELECTED_TITLE", ignored: "RAW_SOURCE_CANARY" } };
  } };
  const signal = new AbortController().signal;
  const contract = await resolveObservedRead(binding, learned.toolDigest, signal);
  expect(calls).toBe(0); expect(contract.generation).toBe("public");
  const selected: unknown[] = [], inputs = Object.fromEntries(contract.inputs.map(input => [input.name, "items"]));
  const receipt = await contract.execute(inputs, (_step, body) => { const value = body as { count: number; title: string }; selected.push(value.count, value.title); }, signal, { maxCalls: 1, maxBytes: 1000 });
  expect(calls).toBe(1); expect(selected).toEqual([12, "PRIVATE_SELECTED_TITLE"]);
  expect(receipt.calls).toBe(1); expect(JSON.stringify(receipt)).not.toContain("RAW_SOURCE_CANARY");
  expect(JSON.stringify(events)).not.toContain("PRIVATE_SELECTED_TITLE");
  events = [];
  await expect(contract.execute(inputs, () => {}, signal, { maxCalls: 1, maxBytes: 1000 })).rejects.toThrow("unavailable");
  expect(calls).toBe(1);
  await expect(resolveObservedRead(binding, "https://api.vendor.com/items", signal)).rejects.toThrow();
});

const STALE_SID = { name: "sid", value: "SECRET_COOKIE", domain: ".vendor.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" as const, hostOnly: false };

function logOf(events: Event[]) {
  return {
    read: Effect.sync(() => events),
    head: Effect.sync(() => events.length),
    readFrom: (n: number) => Effect.sync(() => events.slice(n)),
    append: (items: Event[]) => Effect.sync(() => { events.push(...items); }),
  } as any;
}
async function run(events: Event[], input: unknown, extra: { send?: (request: any) => Promise<HarnessTransportResponse>; arcade?: () => Promise<boolean>; session?: any; callId?: string } = {}): Promise<Record<string, any>> {
  const tool = createObservedNetworkTools({
    owner: "123",
    thread: "user-123",
    redact: text => text.replaceAll("SECRET_COOKIE", "[redacted]"),
    checkArcade: extra.arcade ?? (async () => true),
    ...(extra.send ? { send: extra.send } : {}),
    ...(extra.session ? { session: extra.session } : {}),
  }).find(t => t.spec.name === "observed_network_run")!;
  return Effect.runPromise(tool.run(input, { callId: extra.callId ?? "c1", turn: "turn-1", signal: new AbortController().signal }).pipe(
    Effect.provideService(Self, { actor: "aiko", instance: "test", thread: "user-123" }),
    Effect.provideService(EventLog, logOf(events)),
  )) as Promise<Record<string, any>>;
}
async function compiledWrite() {
  const events: Event[] = [];
  let sequence = 0;
  const learning = new BrowserLearning({ threadId: "owned-trace", nextSequence: () => ++sequence, emit: async e => { events.push(e); } });
  const get = { startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true, request: { method: "GET", url: "https://api.vendor.com/csrf", headers: [], cookies: [] }, response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 16, text: '{"csrf":"fresh"}' } } };
  const post = { startedDateTime: new Date(1100).toISOString(), time: 20, _observationComplete: true, request: { method: "POST", url: "https://api.vendor.com/items", headers: [{ name: "content-type", value: "application/json" }], cookies: [{ name: "sid", value: "SECRET_COOKIE" }], postData: { mimeType: "application/json", text: '{"title":"n"}' } }, response: { status: 201, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{"ok":true}' } } };
  await learning.observe(get, 0, true);
  await learning.observe(post, 1, true);
  await learning.compile([get, post], [{ callId: "call", action: "click", startedAtMs: 1090, endedAtMs: 1150, direct: true, resultObserved: true }], "https://api.vendor.com");
  return events;
}

test("observed_network_run replays an indexed Merkle DAG over host HTTP without a browser", async () => {
  const events = await compiled();
  const prepared = ownedNetworkDefinitions(events)[0]!;
  const requests: string[] = [];
  const result = await run(
    [...events, { type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest }],
    { toolDigest: prepared.toolDigest, inputs: Object.fromEntries(prepared.definition.inputs.map(i => [i.name, "items"])) },
    { send: async request => {
      requests.push(request.url);
      expect(request.method).toBe("GET");
      return { status: 200, headers: {}, classification: "application" as const, body: { items: ["fresh"] } };
    } },
  );
  expect(result).toMatchObject({ kind: "observed-network-receipt", status: "completed", browser: false, merkle: prepared.sourceTraceDigest });
  expect(JSON.stringify(result)).toContain("fresh");
  expect(requests.some(url => url.includes("api.vendor.com"))).toBe(true);
});

test("real observed HTTP adapter sends scoped current cookies and response-derived CSRF, including rotation and deletion", async () => {
  const received: { path: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk.toString(); });
    request.on("end", () => {
      received.push({ path: request.url!, method: request.method!, headers: request.headers, body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/redirect") {
        response.statusCode = 302;
        response.setHeader("location", "http://127.0.0.1/private");
        response.end();
      } else if (request.url === "/csrf") {
        response.setHeader("set-cookie", [
          "sid=ROTATED_SESSION; Domain=vendor.com; Path=/; Secure",
          "logout=; Domain=vendor.com; Path=/; Max-Age=0",
          "escape=FOREIGN_JAR; Domain=com; Path=/",
        ]);
        response.end(JSON.stringify({ csrf: "RUNTIME_CSRF" }));
      } else {
        response.statusCode = 201;
        response.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const resolved: string[] = [];
  // Only the host socket endpoint is replaced. Admission, DNS validation, header
  // construction, body transfer and response parsing run through the real adapter.
  const transport: ObservedHttpOptions = {
    lookup: async host => { resolved.push(host); return ["93.184.216.34"]; },
    request: ((target: string, options: any, callback: any) => {
      const url = new URL(target);
      return httpRequest({ ...options, hostname: "127.0.0.1", port, path: url.pathname + url.search, headers: { ...options.headers, host: url.host } }, callback);
    }) as typeof httpRequest,
  };
  try {
    const events = await compiledWrite();
    const prepared = events.find(event => event.type === "AikoObservedActionPrepared")!;
    const original = ownedObservedActions(events)[0]!;
    // Host-prepared binding fixture: exercise supported native response producers;
    // this test makes no claim that the capture compiler infers this CSRF binding.
    const artifact = validateSiteHarnessArtifact({ ...original.artifact, actions: [{
      ...original.artifact.actions[0]!, steps: [
        { id: "bootstrap", dependsOn: [], method: "GET", origin: "https://api.vendor.com", path: "/csrf", pathParameters: {}, query: {}, headers: {}, expectedStatuses: [200] },
        { ...original.artifact.actions[0]!.steps[0]!, dependsOn: ["bootstrap"], headers: {
          ...original.artifact.actions[0]!.steps[0]!.headers,
          "x-csrf-token": { kind: "response_json", stepId: "bootstrap", pointer: "/csrf" },
        } },
      ],
    }] });
    events[events.indexOf(prepared)] = { ...prepared, artifact, artifactDigest: artifactDigestOf(artifact) };
    const action = ownedObservedActions(events)[0]!;
    expect(action.artifact.actions[0]!.steps).toHaveLength(2);
    const inputs = Object.fromEntries(action.artifact.actions[0]!.inputs.map(i => [i.name, i.name.includes("title") ? "n" : "items"]));
    const session = { connectionId: "conn", revision: "1", domains: ["vendor.com"], cookies: [
      STALE_SID,
      { ...STALE_SID, name: "logout", value: "BASE_DELETED" },
      { ...STALE_SID, name: "path", value: "ONLY_CSRF", path: "/csrf" },
      { ...STALE_SID, name: "foreign", value: "WRONG_HOST", domain: "other.vendor.com", hostOnly: true },
      { ...STALE_SID, name: "expired", value: "EXPIRED", expires: 1 },
    ] };
    const send = (request: HarnessTransportRequest) => sendObservedHttp(request, new AbortController().signal, transport);
    const pending = await run(events, { artifactDigest: action.artifactDigest, inputs }, { session, send });
    expect(pending.status).toBe("authorization_required");
    expect(received).toHaveLength(0);
    await Effect.runPromise(createActionApprovals({ owner: "123", thread: "user-123" }).decide(
      { owner: "123", subject: "account:123", authenticated: true },
      { id: pending.approvalId, hash: pending.hash, decision: "approve" },
    ).pipe(Effect.provideService(EventLog, logOf(events))));
    const result = await run(events, { artifactDigest: action.artifactDigest, inputs, approvalId: pending.approvalId, hash: pending.hash }, { session, send, callId: "approved" });
    expect(result).toMatchObject({ status: "completed", session: true, effect: "write" });
    expect(resolved).toEqual(["api.vendor.com", "api.vendor.com"]);
    expect(received.map(r => r.path)).toEqual(["/csrf", "/items"]);
    expect(received[0]!.headers.cookie).toBe("sid=SECRET_COOKIE; logout=BASE_DELETED; path=ONLY_CSRF");
    expect(received[1]!.headers.cookie).toBe("sid=ROTATED_SESSION");
    expect(received[1]!.headers["x-csrf-token"]).toBe("RUNTIME_CSRF");
    expect(received[1]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(received[1]!.body)).toEqual({ title: "n" });
    expect(JSON.stringify(events)).not.toMatch(/ROTATED_SESSION|BASE_DELETED|ONLY_CSRF|WRONG_HOST|EXPIRED|RUNTIME_CSRF|FOREIGN_JAR/);
    const redirect = await sendObservedHttp({ stepId: "redirect", attempt: 1, method: "GET", url: "https://api.vendor.com/redirect", headers: { authorization: "Bearer HOST_ONLY" }, redirect: "manual" }, new AbortController().signal, transport);
    expect(redirect.status).toBe(302);
    expect(received).toHaveLength(3);
    expect(received[2]!.headers.authorization).toBe("Bearer HOST_ONLY");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("transport preserves public admission and rejects unsafe dispatch headers before opening a socket", async () => {
  const request: HarnessTransportRequest = { stepId: "read", attempt: 1, method: "GET", url: "https://api.vendor.com/items", headers: {}, redirect: "manual" };
  let sockets = 0;
  const transport: ObservedHttpOptions = {
    lookup: async () => ["93.184.216.34"],
    request: (() => { sockets++; throw new Error("Unexpected socket"); }) as typeof httpRequest,
  };
  const unsafeHeaders: Record<string, string>[] = [
    { host: "other.vendor.com" }, { "content-length": "1" }, { connection: "keep-alive" },
    { "proxy-authorization": "secret" }, { "transfer-encoding": "chunked" },
    { "x-csrf-token": "bad\r\nheader:value" }, { Accept: "one", accept: "two" },
  ];
  for (const headers of unsafeHeaders) await expect(sendObservedHttp({ ...request, headers }, new AbortController().signal, transport)).rejects.toThrow("Unsafe observed dispatch headers");
  for (const url of ["https://127.0.0.1/items", "https://user:pass@api.vendor.com/items", "https://api.vendor.com:444/items"]) {
    await expect(sendObservedHttp({ ...request, url }, new AbortController().signal, transport)).rejects.toThrow("Public HTTP(S) host required");
  }
  await expect(sendObservedHttp(request, new AbortController().signal, { ...transport, lookup: async () => ["93.184.216.34", "127.0.0.1"] })).rejects.toThrow("Non-public DNS answer");
  await expect(sendObservedHttp({ ...request, url: "http://api.vendor.com/items", headers: { cookie: "sid=secret" } }, new AbortController().signal, transport)).rejects.toThrow("Unsafe observed dispatch headers");
  await expect(sendPublicHarnessRequest({ ...request, headers: { Authorization: "Bearer secret" } }, new AbortController().signal)).rejects.toThrow("Public replay cannot carry credentials");
  expect(sockets).toBe(0);
});

test("captured cookie and authorization headers remain forbidden in learned artifacts", async () => {
  const action = ownedObservedActions(await compiledWrite())[0]!;
  for (const name of ["cookie", "authorization"]) {
    const artifact = structuredClone(action.artifact);
    (artifact.actions[0]!.steps[0]!.headers as Record<string, unknown>)[name] = { kind: "constant", value: "captured" };
    expect(() => validateSiteHarnessArtifact(artifact)).toThrow();
  }
});

test("unindexed, arcade-owned, or foreign-thread DAGs do not start host HTTP", async () => {
  const events = await compiled();
  const prepared = ownedNetworkDefinitions(events)[0]!;
  let sends = 0;
  const send = async () => { sends++; return { status: 200, headers: {}, classification: "application" as const, body: {} }; };
  expect((await run(events, { toolDigest: prepared.toolDigest }, { send })).status).toBe("rejected");
  expect((await run([...events, { type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest }], { toolDigest: prepared.toolDigest }, { send, arcade: async () => false })).status).toBe("rejected");
  expect(sends).toBe(0);
});

test("vault cookies are attached at send time and never stored on the learned write skill", async () => {
  expect(cookieHeader(new URL("https://api.vendor.com/items"), [
    { name: "sid", value: "SECRET_COOKIE", domain: ".vendor.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax", hostOnly: false },
    { name: "other", value: "nope", domain: "other.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax", hostOnly: true },
  ])).toBe("sid=SECRET_COOKIE");
  const events = await compiledWrite();
  const action = ownedObservedActions(events)[0];
  expect(action?.effect).toBe("write");
  expect(JSON.stringify(action)).not.toContain("SECRET_COOKIE");
  const inputs = Object.fromEntries(action!.artifact.actions[0]!.inputs.map(i => [i.name, i.name.includes("title") ? "n" : "items"]));
  const headers: string[] = [];
  const pending = await run(events, { artifactDigest: action!.artifactDigest, inputs }, {
    session: async () => ({ connectionId: "conn", revision: "1", domains: ["vendor.com", "api.vendor.com"], cookies: [{ name: "sid", value: "SECRET_COOKIE", domain: ".vendor.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" as const, hostOnly: false }] }),
    send: async request => { headers.push(request.headers.cookie ?? request.headers.Cookie ?? ""); return { status: 201, headers: {}, classification: "application" as const, body: { ok: true } }; },
  });
  expect(pending).toMatchObject({ status: "authorization_required", effect: "write" });
  expect(headers).toEqual([]);
  await Effect.runPromise(createActionApprovals({ owner: "123", thread: "user-123" }).decide(
    { owner: "123", subject: "account:123", authenticated: true },
    { id: (pending as any).approvalId, hash: (pending as any).hash, decision: "approve" },
  ).pipe(Effect.provideService(EventLog, logOf(events))));
  const result = await run(events, { artifactDigest: action!.artifactDigest, inputs, approvalId: (pending as any).approvalId, hash: (pending as any).hash }, {
    callId: "c2",
    session: async () => ({ connectionId: "conn", revision: "1", domains: ["vendor.com", "api.vendor.com"], cookies: [{ name: "sid", value: "SECRET_COOKIE", domain: ".vendor.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" as const, hostOnly: false }] }),
    send: async request => { headers.push(JSON.stringify(request.headers)); return { status: 201, headers: { "set-cookie": "sid=other" }, classification: "application" as const, body: { ok: true } }; },
  });
  expect(result).toMatchObject({ status: "completed", effect: "write", browser: false, session: true });
  expect(headers.join("")).toContain("SECRET_COOKIE");
  expect(JSON.stringify(result)).not.toContain("SECRET_COOKIE");
  expect(JSON.stringify(result)).not.toContain("set-cookie");
});

test("vault cookies ride the write and a fresh Set-Cookie is recomputed into the run jar; the log records value-free events", async () => {
  const events = await compiledWrite();
  const action = ownedObservedActions(events)[0]!;
  const inputs = Object.fromEntries(action.artifact.actions[0]!.inputs.map(i => [i.name, i.name.includes("title") ? "n" : "items"]));
  const session = { connectionId: "conn", revision: "1", domains: ["vendor.com", "api.vendor.com"], cookies: [STALE_SID] };
  const cookies: string[] = [];
  const send = async (request: { headers: Record<string, string> }): Promise<HarnessTransportResponse> => {
    cookies.push(request.headers.cookie ?? "");
    return { status: 201, headers: {}, classification: "application", body: { ok: true }, setCookies: ["sid=QnJhbmROZXdWYWx1ZQ; Path=/"] };
  };
  const pending = await run(events, { artifactDigest: action.artifactDigest, inputs }, { session, send });
  expect(pending).toMatchObject({ status: "authorization_required", effect: "write" });
  expect(cookies).toEqual([]);
  await Effect.runPromise(createActionApprovals({ owner: "123", thread: "user-123" }).decide(
    { owner: "123", subject: "account:123", authenticated: true },
    { id: (pending as any).approvalId, hash: (pending as any).hash, decision: "approve" },
  ).pipe(Effect.provideService(EventLog, logOf(events))));
  const result = await run(events, { artifactDigest: action.artifactDigest, inputs, approvalId: (pending as any).approvalId, hash: (pending as any).hash }, {
    callId: "c2",
    session,
    send,
  });
  expect(result).toMatchObject({ status: "completed", effect: "write", browser: false, session: true });
  // The POST rode the vault cookie; the runtime recomputed its fresh Set-Cookie into the run jar.
  expect(cookies).toEqual(["sid=SECRET_COOKIE"]);
  const lifecycle = events.filter(e => ["AikoObservedSessionResolved", "AikoUnlockSessionRenewed", "AikoObservedHeadersRecomputed"].includes(e.type));
  expect(lifecycle.filter(e => e.type === "AikoObservedSessionResolved")).toHaveLength(2);
  const recomputed = lifecycle.find(e => e.type === "AikoObservedHeadersRecomputed");
  expect(recomputed).toMatchObject({ owner: "123", artifactDigest: action.artifactDigest, sessions: 1, cookieEvents: 1, cookieNames: ["sid"] });
  expect(JSON.stringify(lifecycle)).not.toContain("SECRET_COOKIE");
  expect(JSON.stringify(lifecycle)).not.toContain("QnJhbmROZXdWYWx1ZQ");
});

test("anti-bot challenges are classified value-free and never retried host-side", async () => {
  const events = await compiled();
  const prepared = ownedNetworkDefinitions(events)[0]!;
  let sends = 0;
  const journal = [...events, { type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest } as Event];
  const result = await run(
    journal,
    { toolDigest: prepared.toolDigest, inputs: Object.fromEntries(prepared.definition.inputs.map(i => [i.name, "items"])) },
    { send: async () => { sends++; return { status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare" }, classification: "application" as const, body: { error: "blocked" } }; } },
  );
  expect(result).toMatchObject({ kind: "observed-network-receipt", challenged: true, browser: false });
  expect(sends).toBe(1);
  const lifecycle = journal.filter(e => e.type === "AikoObservedOriginChallenged");
  expect(lifecycle).toHaveLength(1);
  expect(lifecycle[0]).toMatchObject({ owner: "123", status: 403, headerNames: ["cf-mitigated", "server"] });
  expect(JSON.stringify(lifecycle)).not.toContain("cloudflare");
});

test("a renewed grant is recorded as ordered lifecycle events before replay", async () => {
  const events = await compiledWrite();
  const action = ownedObservedActions(events)[0]!;
  const inputs = Object.fromEntries(action.artifact.actions[0]!.inputs.map(i => [i.name, i.name.includes("title") ? "n" : "items"]));
  const pending = await run(events, { artifactDigest: action.artifactDigest, inputs }, {
    session: async () => ({ connectionId: "conn", revision: "7", domains: ["vendor.com", "api.vendor.com"], cookies: [STALE_SID], renewed: true }),
    send: async () => ({ status: 201, headers: {}, classification: "application" as const, body: { ok: true } }),
  });
  expect(pending).toMatchObject({ status: "authorization_required" });
  await Effect.runPromise(createActionApprovals({ owner: "123", thread: "user-123" }).decide(
    { owner: "123", subject: "account:123", authenticated: true },
    { id: (pending as any).approvalId, hash: (pending as any).hash, decision: "approve" },
  ).pipe(Effect.provideService(EventLog, logOf(events))));
  const result = await run(events, { artifactDigest: action.artifactDigest, inputs, approvalId: (pending as any).approvalId, hash: (pending as any).hash }, {
    callId: "c2",
    session: async () => ({ connectionId: "conn", revision: "7", domains: ["vendor.com", "api.vendor.com"], cookies: [STALE_SID], renewed: true }),
    send: async () => ({ status: 201, headers: {}, classification: "application" as const, body: { ok: true } }),
  });
  expect(result).toMatchObject({ status: "completed", session: true });
  const lifecycle = events.filter(e => ["AikoObservedSessionResolved", "AikoUnlockSessionRenewed"].includes(e.type));
  expect(lifecycle).toHaveLength(4); // renewed+resolved on the prepare run, then again on the dispatch run
  expect(lifecycle.map(e => e.type)).toEqual([
    "AikoUnlockSessionRenewed", "AikoObservedSessionResolved",
    "AikoUnlockSessionRenewed", "AikoObservedSessionResolved",
  ]);
  expect(lifecycle[0]).toMatchObject({ owner: "123", connectionId: "conn", revision: "7" });
  expect(JSON.stringify(lifecycle)).not.toContain("SECRET_COOKIE");
});

test("host requests leave durable start and change receipts without private request or response values",async()=>{
 const events=await compiled();const prepared=ownedNetworkDefinitions(events)[0]!;
 events.push({type:"AikoRequestMemoryIndexed",toolDigest:prepared.toolDigest});
 const input={toolDigest:prepared.toolDigest,inputs:Object.fromEntries(prepared.definition.inputs.map(i=>[i.name,"items"]))};
 let body={value:"PRIVATE_FIRST"};
 const send=async()=>({status:200,headers:{},classification:"application" as const,body});
 await run(events,input,{send,callId:"first"});
 await run(events,input,{send,callId:"same"});
 body={value:"PRIVATE_SECOND"};await run(events,input,{send,callId:"changed"});
 const checks=events.filter(e=>e.type==="AikoNetworkRequestSettled");
 expect(checks.map(e=>e.changed)).toEqual([null,false,true]);
 expect(events.filter(e=>e.type==="AikoNetworkRequestStarted")).toHaveLength(3);
 expect(JSON.stringify(checks)).not.toMatch(/PRIVATE_FIRST|PRIVATE_SECOND/);
 expect(checks[0]!.definitionDigest).toBe(prepared.toolDigest);
});
