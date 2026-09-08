import { describe, it, expect } from "vitest";
import {
  makeWatchConfig,
  watchSampleText,
  type WatchDiscovery,
} from "../src/lib/browser-watches";
const discovery: WatchDiscovery = {
  sites: [
    {
      connectionId: "site-owned",
      connectionRevision: "revision-1",
      sourceGeneration: 2,
      origin: "https://example.test",
      label: "Example",
      events: [
        {
          id: "push",
          label: "New notification",
          kind: "push",
          outcome: "received",
        },
      ],
    },
  ],
  actions: [
    {
      id: "summary",
      label: "Ask Aiko",
      supportsInstruction: true,
      action: { kind: "actor", instruction: "Investigate the update" },
    },
  ],
  defaults: { expiresInMs: 86_400_000, backlog: 32, maxOccurrences: 100 },
};
const input = () => ({
  discovery,
  connectionId: "site-owned",
  eventId: "push",
  actionId: "summary",
  instruction: "Summarize the update",
  label: "Updates",
  duration: 3_600_000,
  maxOccurrences: 5,
  id: "new-watch",
  now: 1000,
});
describe("browser watch choices", () => {
  it("uses the selected site's absolute authority deadline even after time spent in setup", () => {
    const current=structuredClone(discovery);current.sites[0]!.expiresAt=120000;
    expect(makeWatchConfig({...input(),discovery:current,now:60000}).expiresAt).toBe(120000);
    expect(()=>makeWatchConfig({...input(),discovery:current,now:120000})).toThrow("connection expired");
  });
  it("builds only current advertised source/action and bounded limits, without asking for credentials or pins", () => {
    const config = makeWatchConfig(input());
    expect(config).toMatchObject({
      connectionId: "site-owned",
      connectionRevision: "revision-1",
      sourceGeneration: 2,
      origin: "https://example.test",
      kind: "push",
      action: { kind: "actor", instruction: "Summarize the update" },
      expiresAt: 3_601_000,
      backlog: 32,
      maxOccurrences: 5,
    });
    expect(() =>
      makeWatchConfig({ ...input(), connectionId: "foreign" }),
    ).toThrow("no longer available");
    expect(() => makeWatchConfig({ ...input(), actionId: "invented" })).toThrow(
      "no longer available",
    );
    expect(() => makeWatchConfig({ ...input(), duration: 86_400_001 })).toThrow(
      "duration",
    );
  });
  it("changing the action preserves pinned source/end/event budget and refuses a reconnected source", () => {
    const prior = makeWatchConfig(input());
    expect(
      makeWatchConfig({
        ...input(),
        prior,
        instruction: "Check the update",
        now: 8000,
        duration: 720_000,
        maxOccurrences: 99,
      }),
    ).toEqual({
      ...prior,
      action: { kind: "actor", instruction: "Check the update" },
    });
    expect(() =>
      makeWatchConfig({
        ...input(),
        prior: { ...prior, connectionRevision: "old" },
      }),
    ).toThrow("connection changed");
  });
  it("preview renders readable bounded text and never interprets HTML or arbitrary metadata", () => {
    expect(
      watchSampleText({ title: "New message", body: "<img onerror=evil()>" }),
    ).toBe("New message\n<img onerror=evil()>");
    expect(
      watchSampleText({
        eventMetadata: [
          { key: "Notification Title", value: "Maya replied" },
          { key: "internal-token", value: "private" },
        ],
      }),
    ).toBe("Maya replied");
    expect(watchSampleText({ opaquePointer: "private" })).toBeUndefined();
    expect(watchSampleText("x".repeat(9000))).toHaveLength(8000);
  });
});
