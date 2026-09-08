import { expect, test } from "bun:test";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { executableObservedReads, ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { replayBrowserRequest } from "../src/browser-driver.ts";
import { ensureUnlockSession } from "../src/unlock-session.ts";

/** Synthetic messaging reads only. These tests make no network calls and do not
 * attest Instagram's current endpoint, headers, authentication or response format. */
async function inboxCapture(extraHeader?: string) {
  const events: Event[] = []; let sequence = 0;
  const origin = "https://social.example.com";
  const learning = new BrowserLearning({ threadId: "inbox-readiness", nextSequence: () => ++sequence,
    emit: async e => { events.push(e); }, browserSession: origin => ({ id: "implicit-browser-session-v1", origin }) });
  const entries = [0, 1].map(index => ({
    startedDateTime: new Date(1000 + index * 100).toISOString(), time: 20, _observationComplete: true,
    request: { method: "GET", url: `${origin}/api/inbox/`,
      headers: [{ name: "cookie", value: "sid=PRIVATE_COOKIE_SENTINEL" }, ...(extraHeader ? [{ name: extraHeader, value: "PRIVATE_HEADER_SENTINEL" }] : [])],
      cookies: [{ name: "sid", value: "PRIVATE_COOKIE_SENTINEL" }] },
    response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 100,
      text: '{"inbox":{"threads":[{"id":"PRIVATE_THREAD_SENTINEL","message":"PRIVATE_DM_SENTINEL"}]},"status":"ok"}' } },
  }));
  for (let i = 0; i < entries.length; i++) await learning.observe(entries[i]!, i, true);
  const result = await learning.compile(entries, entries.map((_, i) => ({ callId: `read-${i}`, action: "navigate" as const,
    startedAtMs: 999 + i * 100, endedAtMs: 1050 + i * 100, direct: true, resultObserved: true })), origin);
  expect(JSON.stringify([events, result])).not.toMatch(/PRIVATE_COOKIE_SENTINEL|PRIVATE_HEADER_SENTINEL|PRIVATE_THREAD_SENTINEL|PRIVATE_DM_SENTINEL/);
  return { events, result, origin };
}

test("a cookie-backed inbox recipe stays browser-session-bound, not public HTTP, even after indexing", async () => {
  const { events, result } = await inboxCapture();
  expect(result.prepared).toBeGreaterThan(0);
  const definitions = ownedNetworkDefinitions(events);
  for (const definition of definitions) {
    expect(definition.definition.sessionRequirements).toContain("implicit-browser-session-v1");
    events.push({ type: "AikoRequestMemoryIndexed", toolDigest: definition.toolDigest });
  }
  expect(executableObservedReads(events)).toEqual([]);
});

for (const name of ["x-ig-app-id", "x-asbd-id", "x-csrftoken", "authorization"]) {
  test(`an observed ${name} is not silently copied or supplied by ambient browser cookies`, async () => {
    const { result, events } = await inboxCapture(name);
    expect(result.prepared).toBe(0);
    expect(result.fallbacks?.length).toBeGreaterThan(0);
    expect(result.fallbacks?.some(item => item.findings?.some(f => f.location === `request.header.${name}`))).toBe(true);
    expect(ownedNetworkDefinitions(events)).toEqual([]);
  });
}

test("current browser replay rejects custom application headers before opening CDP", async () => {
  for (const name of ["x-ig-app-id", "x-csrftoken", "referer"]) {
    await expect(replayBrowserRequest("must-not-connect", "https://social.example.com", {
      stepId: "inbox", attempt: 1, method: "GET", url: "https://social.example.com/api/inbox/",
      headers: { [name]: "PRIVATE_HEADER_SENTINEL" }, redirect: "manual",
    })).rejects.toThrow("Replay requires same-origin read with browser session credentials");
  }
});

test("host HTTP has no implicit native-VM cookie fallback without an assigned vault bridge", async () => {
  let calls = 0;
  const grant = await ensureUnlockSession({ owner: "123", origin: "https://social.example.com",
    signal: new AbortController().signal, renew: true,
    search: async () => { calls++; throw Error("No catalog or session request without configured custody"); },
    transport: (async (_target: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { calls++; throw Error("No network"); }) as typeof fetch,
  });
  expect(grant).toBeUndefined(); expect(calls).toBe(0);
});
