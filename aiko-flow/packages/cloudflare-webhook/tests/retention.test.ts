import { describe, expect, test } from "bun:test";
import {
  compactCloudflareRetention, projectCloudflareRetention, requireCloudflareCollectible,
  type CloudflareRetentionProjection, type RetentionConfirmation, type RetentionKind, type RetentionPin, type RetentionReader,
} from "../src/retention";

const d = (ordinal: number) => ordinal.toString(16).padStart(64, "0");
const pin = (kind: RetentionKind, authority: "contract" | "neuron", commitOrdinal: number, state: RetentionPin["state"], parents?: readonly number[], environment?: "preview" | "staging" | "production"): RetentionPin => ({
  kind, authority, reference: `${kind}/${commitOrdinal}`, commitOrdinal, digest: d(commitOrdinal), state,
  ...(parents ? { parents } : {}), ...(environment ? { environment } : {}),
});
function terminalPins(): RetentionPin[] {
  return [
    pin("endpoint_manifest", "neuron", 1, "replaced"),
    pin("endpoint_generation", "neuron", 2, "replaced", [0]),
    pin("verifier_key_generation", "neuron", 3, "revoked", [1]),
    pin("verification_evidence", "contract", 4, "settled", [1, 2]),
    pin("destination_audience", "contract", 5, "replaced"),
    pin("queue_delivery", "contract", 6, "settled", [3, 4]),
    pin("retry_attempt", "contract", 7, "settled", [5]),
    pin("dlq_attempt", "contract", 8, "resolved", [5]),
    pin("reconciliation", "contract", 9, "settled", [5]),
    pin("artifact", "neuron", 10, "replaced"),
    pin("provider_version", "neuron", 11, "replaced", [9]),
    pin("environment_promotion", "neuron", 12, "superseded", [10], "preview"),
    pin("environment_promotion", "neuron", 13, "superseded", [10], "staging"),
    pin("environment_promotion", "neuron", 14, "superseded", [10], "production"),
    pin("rollback_target", "neuron", 15, "settled", [10]),
    pin("receipt", "neuron", 16, "settled", [3, 5, 7, 11, 14]),
  ];
}
function confirmation(pin: RetentionPin): RetentionConfirmation {
  return { confirmed: true, kind: pin.kind, reference: pin.reference, commitOrdinal: pin.commitOrdinal, digest: pin.digest, state: pin.state };
}
const confirmingReaders = {
  contract: ((pin: RetentionPin) => confirmation(pin)) satisfies RetentionReader,
  neuron: ((pin: RetentionPin) => confirmation(pin)) satisfies RetentionReader,
};
const replace = (pins: RetentionPin[], index: number, changes: Partial<RetentionPin>) => pins.map((entry, current) => current === index ? { ...entry, ...changes } as RetentionPin : entry);

async function refusal(promise: Promise<unknown>, fragment: string) { await expect(promise).rejects.toThrow(fragment); }

describe("Cloudflare digest/ordinal retention projection", () => {
  test("emits every required secret-free pin and compacts terminal versions only after both authorities confirm", async () => {
    const projection = await projectCloudflareRetention(terminalPins());
    expect(projection.blocksCollection).toBe(false);
    expect(projection.entries.every((entry) => !entry.retained)).toBe(true);
    expect(projection.projectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(requireCloudflareCollectible(projection)).toBe(true);

    const calls = { contract: 0, neuron: 0 };
    const compacted = await compactCloudflareRetention(projection, {
      contract: (entry) => { calls.contract += 1; return confirmation(entry); },
      neuron: (entry) => { calls.neuron += 1; return confirmation(entry); },
    });
    expect(calls.contract).toBeGreaterThan(0); expect(calls.neuron).toBeGreaterThan(0);
    expect(compacted).toMatchObject({ compacted: true, liveDeploymentClaim: false });
    expect(compacted.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(compacted).sort()).toEqual(["compacted", "confirmationDigest", "liveDeploymentClaim", "pins", "schema"]);
    expect(JSON.stringify(compacted)).not.toMatch(/rawBody|requestBody|secretValue|credentialValue|providerLog|liveDeploymentClaim":true/);
  });

  test("omitting any endpoint/key/evidence/queue/DLQ/audience/artifact/version/promotion/rollback/receipt family fails closed", async () => {
    const pins = terminalPins();
    const kinds = [...new Set(pins.map(({ kind }) => kind))];
    for (const kind of kinds) await expect(projectCloudflareRetention(pins.filter((entry) => entry.kind !== kind))).rejects.toThrow();
  });

  test("active queue, retry, DLQ, reconciliation, and deployment state blocks collection through reachability", async () => {
    for (const [index, state] of [[5, "queued"], [6, "retry_pending"], [7, "dead_letter"], [8, "uncertain_reconciliation"], [11, "deploying"]] as const) {
      const projection = await projectCloudflareRetention(replace(terminalPins(), index, { state }));
      expect(projection.blocksCollection).toBe(true);
      expect(projection.entries[index]!.retained).toBe(true);
      expect(() => requireCloudflareCollectible(projection)).toThrow("block collection");
      await refusal(compactCloudflareRetention(projection, confirmingReaders), "block collection");
    }
  });

  test("mutation tests reject changed digest/ordinal/authority, unsafe fields and raw-or-secret-shaped references", async () => {
    const pins = terminalPins();
    await refusal(projectCloudflareRetention(replace(pins, 0, { digest: d(99) }).map((entry, index) => index === 0 ? { ...entry, commitOrdinal: 2 } : entry)), "duplicate retention pin");
    await refusal(projectCloudflareRetention(replace(pins, 0, { digest: "A".repeat(64) })), "digest is invalid");
    await refusal(projectCloudflareRetention(replace(pins, 0, { authority: "contract" })), "authority is invalid");
    await refusal(projectCloudflareRetention(replace(pins, 0, { reference: "endpoint/secret/bearer-token" })), "secret-free");
    await refusal(projectCloudflareRetention([{ ...pins[0], rawRequest: "never" } as RetentionPin, ...pins.slice(1)]), "rawRequest is not allowed");
  });

  test("all three environment promotions retain one immutable provider-version/artifact identity", async () => {
    const pins = terminalPins();
    const secondArtifact = pin("artifact", "neuron", 17, "replaced");
    const secondVersion = pin("provider_version", "neuron", 18, "replaced", [16]);
    const changed = [...pins, secondArtifact, secondVersion];
    changed[12] = { ...changed[12]!, parents: [17] };
    await refusal(projectCloudflareRetention(changed), "changed immutable provider version identity");
    await refusal(projectCloudflareRetention(replace(pins, 12, { environment: "production" })), "exactly one staging");
  });

  test("compaction refuses missing, mismatched, or mutated Contract/Neuron evidence", async () => {
    const projection = await projectCloudflareRetention(terminalPins());
    for (const field of ["reference", "commitOrdinal", "digest", "kind", "state"] as const) {
      const bad: RetentionReader = (entry) => {
        const value: Record<string, unknown> = { ...confirmation(entry) };
        if (entry.authority === "contract") value[field] = field === "commitOrdinal" ? entry.commitOrdinal + 1 : field === "kind" ? "artifact" : field === "state" ? "active" : `changed-${entry[field]}`;
        return value as RetentionConfirmation;
      };
      await refusal(compactCloudflareRetention(projection, { contract: bad, neuron: confirmingReaders.neuron }), "did not confirm");
    }
    await refusal(compactCloudflareRetention(projection, { contract: () => null, neuron: confirmingReaders.neuron }), "did not confirm");
    const tampered = JSON.parse(JSON.stringify(projection)) as CloudflareRetentionProjection;
    (tampered.entries[0] as { digest: string }).digest = d(63);
    await refusal(compactCloudflareRetention(tampered, confirmingReaders), "projection digest mismatch");
  });
});
