import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedNetworkDefinitions, ownedObservedActions } from "../src/capability-builder-network.ts";
import { createObservedNetworkTools } from "../src/observed-network.ts";
import { cookieHeader } from "../src/unlock-session.ts";
import { createActionApprovals } from "../src/action-approval.ts";
import type { HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";

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
