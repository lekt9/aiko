/** Real Chromium + actual local MiniLM; local HTTPS fixture only. Explicit session capability opt-in. */
import { expect, test } from "bun:test";
import { replayBrowserRequest } from "../src/browser-driver.ts";
import type { HarnessTransportRequest } from "../../../packages/browser-runtime/src/harness-runtime.ts";
const endpoint = process.env.AIKO_REPLAY_TEST_CDP;
const request = (url: string): HarnessTransportRequest => ({stepId:"items",attempt:1,method:"GET",url,headers:{},redirect:"manual"});
(endpoint && process.env.AIKO_REPLAY_TEST_EMBEDDING ? test : test.skip)(
  "live observation auto-indexes locally then semantically searches and rehydrates fresh browser data",
  async () => {
    const { CdpNetworkListener } =
      await import("@unbrowse/browser-runtime/network-listener");
    const { BrowserLearning } = await import("../src/browser-learning.ts");
    const { RequestMemory } = await import("../src/request-memory.ts");
    const { createRequestEmbedding } =
      await import("../src/request-embedding.ts");
    const { nodeStorage } = await import("entity-learn");
    const { ownedNetworkDefinitions } =
      await import("../src/capability-builder-network.ts");
    const origin = "https://replay-fixture.aiko.ai",
      events: any[] = [],
      consumed: any[] = [];
    const storage = nodeStorage(":memory:");
    const memory = new RequestMemory({
      owner: "browser_qa",
      storage,
      readOwnedEvents: async () => events,
      embedding: createRequestEmbedding("/tmp/aiko-request-embedding-qa"),
      embedResponseValues: true,
      authorizeSession: async () => true,
      transport: { send: (r) => replayBrowserRequest(endpoint!, origin, r) },
      consume: async (r) => {
        consumed.push(r);
      },
    });
    let sequence = 0,
      indexed = 0;
    const learning = new BrowserLearning({
      threadId: "browser-qa",
      browserSession: origin => ({id:"implicit-browser-session-v1",origin}),
      nextSequence: () => ++sequence,
      emit: async (e) => {
        events.push(e);
      },
      onPrepared: async (e, responses) => {
        await memory.index(e.toolDigest, ["catalog"], responses);
        indexed++;
      },
    });
    const observer = new CdpNetworkListener((entry, index, complete) =>
      learning.observe(entry, index, complete),
    );
    try {
      await observer.connect(endpoint!);
      const startedAtMs = Date.now();
      const first = await replayBrowserRequest(
        endpoint!,
        origin,
        request(origin + "/items"),
      );
      await replayBrowserRequest(
        endpoint!,
        origin,
        request(origin + "/details?item=" + first.body.item),
      );
      const endedAtMs = Date.now();
      const entries = await observer.stopAndSnapshot();
      await learning.compile(
        entries,
        [
          {
            callId: "qa",
            action: "navigate",
            startedAtMs,
            endedAtMs,
            direct: true,
            resultObserved: true,
          },
        ],
        origin,
      );
      if (!indexed)
        await Bun.write(
          "artifacts/request-memory/live-pipeline-witness.json",
          JSON.stringify(
            {
              status: "blocked",
              observedRequests: entries.length,
              indexed,
              blockers: events
                .filter((e) => e.type === "AikoBrowserLearningPending")
                .map((e) => ({ reason: e.reason, findings: e.findings })),
            },
            null,
            2,
          ),
        );
      expect(indexed).toBeGreaterThan(0);
      const found = await memory.search("catalog item details");
      expect(found.items.length).toBeGreaterThan(0);
      const definitions = ownedNetworkDefinitions(events);
      const pointer =
        found.items.find((p) => p.requestIds.length === 2) ?? found.items[0]!;
      expect(pointer.requestIds).toHaveLength(2);
      expect(events.some(e=>e.type==="AikoBrowserSessionFindingResolved")).toBe(true);
      const definition = definitions.find(
        (d) =>
          JSON.stringify(d.definition.evidence.map(e=>e.requestId)) ===
          JSON.stringify(pointer.requestIds),
      )!.definition;
      const inputs = Object.fromEntries(
        definition.inputs.map((i) => [
          i.name,
          i.name.includes("0001") ? "items" : "details",
        ]),
      );
      const hydrated = await memory.hydrate(pointer.pointerId, inputs);
      expect(hydrated.status).toBe("completed");
      expect(hydrated.counts.requests).toBe(2);
      expect(consumed).toHaveLength(1);
      expect(JSON.stringify(memory.memory.exportArchive())).not.toContain(
        "TRANSIENT_BROWSER_RESULT",
      );
      expect(JSON.stringify(hydrated)).not.toContain(
        "TRANSIENT_BROWSER_RESULT",
      );
      await Bun.write(
        "artifacts/request-memory/live-pipeline-witness.json",
        JSON.stringify(
          {
            model: found.model,
            indexed,
            observedRequests: entries.length,
            shortlist: found.items.length,
            status: hydrated.status,
            requests: hydrated.counts.requests,
            consumed: hydrated.consumed,
            responseValuesPersisted: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await observer.stopAndSnapshot().catch(() => {});
      storage.close();
    }
  },
  60000,
);
