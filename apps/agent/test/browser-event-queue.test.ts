import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BrowserEventQueue } from "../src/browser-event-queue.ts";

test("VM trace batches survive reconstruction until acknowledged and preserve compiled drafts", () => {
  const db = new Database(":memory:");
  try {
    let queue = new BrowserEventQueue(db);
    queue.append({ type: "BrowserNetworkToolPrepared", toolDigest: "fixture-digest", definition: { fixture: true } });
    for (let n = 0; n < 300; n++) queue.append({ type: "NetworkFactObserved", sequence: n });
    const first = queue.batch();
    expect(first.events).toHaveLength(256);
    expect(first.hasMore).toBe(true);
    queue = new BrowserEventQueue(db);
    expect(queue.batch()).toEqual(first);
    queue.acknowledge(first.through);
    queue.acknowledge(first.through);
    expect(queue.batch().events).toHaveLength(45);
    expect(() => queue.acknowledge(9999)).toThrow("Invalid");
    const last = queue.batch(); queue.acknowledge(last.through);
    expect(queue.batch()).toEqual({ events: [], through: 0, hasMore: false });
    expect(db.query("SELECT digest FROM browser_drafts").all()).toEqual([{ digest: "fixture-digest" }]);
    queue.append({ type: "NetworkFactObserved", sequence: 301 });
    expect(queue.batch().through).toBeGreaterThan(last.through);
    expect(() => queue.append({ type: "bad", payload: "x".repeat(256_000) })).toThrow("bound");
  } finally { db.close(); }
});
