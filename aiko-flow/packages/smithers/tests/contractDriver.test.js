import { describe, expect, test } from "bun:test";
import { createContractDriver, descriptorDigest } from "../src/index.js";

function claim(overrides = {}) {
  return { leaseId: "lease-1", rootId: "root", occurrenceId: "occ", executionId: "exec", attempt: 1, fence: 7,
    graphDigest: "g", nodeDigest: "n", inputDigest: "i", sourceDigest: "s", cellPackageDigest: "cp",
    cellManifestDigest: "cm", limbDigest: "l", attachmentGeneration: "a1", credentialGeneration: "c1",
    credentialScopeDigest: "cs", firingId: "fire", effectId: "effect", verifiedSubject: "subject",
    verifiedScopeDigest: "vs", verifiedRequestDigest: "vr", cellRequest: { node_id: "node" }, sourceRefs: ["occ:source"], ...overrides };
}

describe("Contract Smithers driver", () => {
  test("signals are hints; duplicate/missing/reordered ordinals all reread Contract", async () => {
    const orders = []; const invocations = [];
    const contract = { readFrontier: async (x) => { orders.push(x.signalOrder); return []; }, acquireFencedLease: async () => null };
    const driver = createContractDriver({ contract, graphHarnessCell: async (x) => invocations.push(x), owner: "smithers" });
    for (const commitOrdinal of [4, 4, 8, 6, 9]) await driver.handleSignal({ commitOrdinal });
    expect(orders).toEqual(["initial", "duplicate", "missing", "reordered", "next"]);
    expect(invocations).toHaveLength(0);
  });

  test("pins, invokes actual Cell route, read-backs effects, revalidates, then settles fence once", async () => {
    const calls = []; const c = claim(); let pinnedDigest;
    const contract = {
      readFrontier: async () => [{ workId: "w" }],
      acquireFencedLease: async () => c,
      recordInvocation: async (x) => calls.push(["invocation", x]),
      appendEffectOutbox: async (x) => calls.push(["outbox", x]),
      readBackEffect: async (x) => (calls.push(["readback", x]), { confirmed: true }),
      revalidatePins: async (x) => (calls.push(["revalidate", x]), x.descriptorDigest === pinnedDigest),
      settleFenced: async (x) => (calls.push(["settle", x]), true),
    };
    const driver = createContractDriver({ contract, owner: "smithers", graphHarnessCell: async ({ descriptor, descriptorDigest: digest }) => {
      expect(Object.isFrozen(descriptor)).toBe(true); expect(() => { descriptor.fence = 99; }).toThrow();
      pinnedDigest = digest; expect(digest).toBe(descriptorDigest(descriptor)); calls.push(["cell", descriptor]);
      return { effects: [{ effectId: "effect", payloadDigest: "p" }], evidenceDigest: "e" };
    }});
    const result = await driver.handleSignal({ commitOrdinal: 1 });
    expect(result.results[0].status).toBe("settled");
    expect(calls.map(([name]) => name)).toEqual(["invocation", "outbox", "cell", "readback", "revalidate", "settle"]);
    expect(calls.at(-1)[1].fence).toBe(7);
  });

  test("stale pins refuse settlement and missing pin refuses invocation", async () => {
    let settlements = 0; let invocations = 0;
    const contract = { readFrontier: async () => [{ workId: "w" }], acquireFencedLease: async () => claim(), appendEffectOutbox: async () => {}, readBackEffect: async () => ({ confirmed: true }), revalidatePins: async () => false, settleFenced: async () => settlements++ };
    const driver = createContractDriver({ contract, owner: "o", graphHarnessCell: async () => (invocations++, {}) });
    expect((await driver.handleSignal({ commitOrdinal: 1 })).results[0].status).toBe("stale");
    expect(invocations).toBe(1); expect(settlements).toBe(0);
    contract.acquireFencedLease = async () => claim({ credentialGeneration: undefined });
    await expect(driver.handleSignal({ commitOrdinal: 2 })).rejects.toThrow("missing pin: credentialGeneration");
  });
});
