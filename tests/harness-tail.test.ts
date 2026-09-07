import { expect, test } from "vitest";
import { eventTail } from "../scripts/harness-tail.mjs";

test("watcher locates the real tail, not the first 100 rows, with bounded requests", async () => {
  for (const size of [0, 1, 2, 3, 99, 100, 101, 200, 201, 17150, 1000000]) {
    let probes = 0;
    const read = async (after: number, limit: number) => {
      probes++;
      const count = Math.max(0, Math.min(size - after, limit));
      const events = Array.from({ length: count }, (_, i) => ({
        seq: after + i + 1,
        event: { type: "Fixture" },
      }));
      return {
        events,
        nextAfter: events.at(-1)?.seq ?? after,
        hasMore: after + count < size,
      };
    };
    const tail = await eventTail(read);
    expect(tail.head).toBe(size);
    expect(tail.rows.map((r: { seq: number }) => r.seq)).toEqual(
      Array.from(
        { length: Math.min(3, size) },
        (_, i) => size - Math.min(3, size) + i + 1,
      ),
    );
    expect(probes).toBeLessThan(64);
    probes = 0;
    expect(await eventTail(read, tail)).toEqual(tail);
    expect(probes).toBe(1);
  }
});

test("new events advance the cached tail without losing the previous final rows", async () => {
  const previous = {
    head: 100,
    rows: [{ seq: 98 }, { seq: 99 }, { seq: 100 }],
  };
  const tail = await eventTail(
    async () => ({ events: [{ seq: 101 }], nextAfter: 101, hasMore: false }),
    previous,
  );
  expect(tail).toEqual({
    head: 101,
    rows: [{ seq: 99 }, { seq: 100 }, { seq: 101 }],
  });
});

test("failed and malformed probes cannot masquerade as an empty or resting account", async () => {
  await expect(
    eventTail(async () => {
      throw new Error("HTTP 503");
    }),
  ).rejects.toThrow("HTTP 503");
  await expect(
    eventTail(async () => ({ events: [], nextAfter: 0, hasMore: true })),
  ).rejects.toThrow("invalid journal page");
  await expect(
    eventTail(async () => ({
      events: [{ seq: 0 }],
      nextAfter: 0,
      hasMore: false,
    })),
  ).rejects.toThrow("invalid journal page");
});
