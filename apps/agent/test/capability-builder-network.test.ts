import { expect, test } from "bun:test";
import type { Event } from "tardie/core/event";
import { BrowserLearning } from "../src/browser-learning.ts";
import { executableObservedReads, fixedNetworkReads, ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { ownedApiEvidence } from "../src/capability-builder.ts";
async function observed(query = "") {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({ threadId: "owned-trace", nextSequence: () => ++sequence, emit: async e => { events.push(e); } });
  const entry = { startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true, request: { method: "GET", url: `https://api.vendor.com/items${query}`, headers: [], cookies: [] }, response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{"items":[]}' } } };
  await learning.observe(entry, 0, true);
  await learning.compile([entry], [{ callId: "call", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true }], "https://api.vendor.com");
  return events;
}
test("real native browser compiler evidence is reusable only with its graph and observed prefix", async () => {
  const events = await observed();
  expect(ownedNetworkDefinitions(events)).toHaveLength(1);
  // Native paths may be masked: no fabricated restoration of a literal URL is permitted.
  const reads = fixedNetworkReads(events);
  expect(ownedApiEvidence("123", events).length).toBeLessThanOrEqual(reads.length);
  expect(ownedNetworkDefinitions(events.filter(e => e.type !== "NetworkFactObserved"))).toEqual([]);
  expect(ownedNetworkDefinitions(events.filter(e => e.type !== "NetworkGraphCheckpointPrepared"))).toEqual([]);
  const prepared = events.find(e => e.type === "BrowserNetworkToolPrepared")!;
  expect(ownedNetworkDefinitions([{ type: "ToolReturned", result: prepared }])).toEqual([]);
  const altered = events.map(e => e === prepared ? { ...e, toolDigest: `sha256:${"0".repeat(64)}` } : e);
  expect(ownedNetworkDefinitions(altered)).toEqual([]);
});
test("indexed Merkle DAGs with caller bindings become host-executable skills; session-free compile is not enough", async () => {
  const events = await observed("?locale=en");
  const prepared = events.find(e => e.type === "BrowserNetworkToolPrepared")!;
  expect(executableObservedReads(events)).toEqual([]);
  expect(executableObservedReads([...events, { type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest }])).toHaveLength(1);
  expect(executableObservedReads(events.filter(e => e.type !== "NetworkGraphCheckpointPrepared").concat([{ type: "AikoRequestMemoryIndexed", toolDigest: prepared.toolDigest }]))).toEqual([]);
});
test("native caller bindings and credential dependencies never become fixed public reads", async () => {
  const caller = await observed("?locale=en");
  expect(ownedNetworkDefinitions(caller)).toHaveLength(1);
  expect(fixedNetworkReads(caller)).toEqual([]);
  const credential = await observed("?access_token=secret");
  expect(ownedNetworkDefinitions(credential)).toEqual([]);
  expect(fixedNetworkReads(credential)).toEqual([]);
});
