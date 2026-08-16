import { describe, expect, test } from "bun:test";
import { createContractLifecyclePolicy, ContractLifecyclePolicyError } from "../src/contractLifecyclePolicy.js";

const ALICE = Object.freeze({ verifiedTenant: "tenant-a", verifiedOwner: "owner-alice", grantedScopes: ["run:write"] });
const OTHER_TENANT = Object.freeze({ verifiedTenant: "tenant-b", verifiedOwner: "owner-alice", grantedScopes: ["run:write"] });
const OTHER_OWNER = Object.freeze({ verifiedTenant: "tenant-a", verifiedOwner: "owner-bob", grantedScopes: ["run:write"] });
const pins = () => [
  { kind: "graph", id: "graph-main", digest: "sha256:graph", generation: 1 },
  { kind: "input", id: "input-main", digest: "sha256:input", generation: 2 },
  { kind: "cell", id: "cell-main", digest: "sha256:cell", generation: 3 },
  { kind: "limb", id: "limb-mail", digest: "sha256:limb", generation: 4 },
  { kind: "credential", id: "credential-mail", digest: "sha256:credential", generation: 5 },
];
const run = (overrides = {}) => ({
  tenantId: "tenant-a", ownerId: "owner-alice", contractRoot: "root-immutable", runId: "run-main",
  phase: "runnable", lifecycleGeneration: 7, pins: pins(), activeClaims: [], ...overrides,
});

function fakeContract(initial = run()) {
  let record = structuredClone(initial);
  const commands = [];
  const capabilities = new Map([
    ["tool:browser", { tenantId: "tenant-a", runId: "run-main", kind: "tool", id: "browser", generation: 3, revoked: false }],
    ["credential:mail", { tenantId: "tenant-a", runId: "run-main", kind: "credential", id: "mail", generation: 8, revoked: false }],
  ]);
  let movedPin = null;
  return {
    commands,
    setMovedPin(kind) { movedPin = kind; },
    setRecord(next) { record = structuredClone(next); },
    get record() { return structuredClone(record); },
    async read(query) {
      if (query.projection === "execution_run") {
        if (query.tenantId !== record.tenantId || query.runId !== record.runId) return undefined;
        return structuredClone(record);
      }
      if (query.projection === "pin_validity") {
        return { tenantId: query.tenantId, runId: query.runId, kind: query.kind, id: query.id,
          digest: query.kind === movedPin ? `${query.digest}-moved` : query.digest,
          generation: query.generation, valid: true };
      }
      if (query.projection === "capability_generation") return structuredClone(capabilities.get(`${query.kind}:${query.id}`));
      if (query.projection === "settlement_boundary") return {
        tenantId: query.tenantId, runId: query.runId,
        settlements: [
          { settlementId: "settlement-local", crossed: false },
          { settlementId: "settlement-crossed", crossed: true },
        ],
      };
      throw new Error(`unexpected projection ${query.projection}`);
    },
    async command(command) {
      commands.push(structuredClone(command));
      if (command.expectedGeneration !== undefined && command.type.startsWith("execution.") &&
          command.type !== "execution.operational_fork" && command.expectedGeneration !== record.lifecycleGeneration) {
        throw new ContractLifecyclePolicyError("CAS_CONFLICT", "Contract CAS conflict");
      }
      if (command.next) record = { ...record, ...structuredClone(command.next), activeClaims: record.activeClaims };
      if (command.type === "capability.revoke") {
        const key = `${command.kind}:${command.id}`;
        const current = capabilities.get(key);
        if (current.generation !== command.expectedGeneration) throw new ContractLifecyclePolicyError("CAS_CONFLICT", "Contract CAS conflict");
        capabilities.set(key, { ...current, generation: command.nextGeneration, revoked: true });
      }
      return { accepted: true };
    },
  };
}
function harness(initial, options = {}) {
  const contract = fakeContract(initial);
  const policy = createContractLifecyclePolicy({ contract, allocateForkRunId: options.allocateForkRunId ?? (() => "fork-allocated") });
  return { contract, policy };
}
async function rejectsCode(operation, code) {
  try { await operation(); } catch (error) {
    expect(error).toBeInstanceOf(ContractLifecyclePolicyError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("Contract lifecycle policy kernel", () => {
  test("requires verified tenant, verified owner, and run:write on every entry", async () => {
    const { contract, policy } = harness(run());
    await expect(policy.inspect(ALICE, "run-main")).resolves.toMatchObject({ contractRoot: "root-immutable", runId: "run-main" });
    await rejectsCode(() => policy.inspect(OTHER_TENANT, "run-main"), "NOT_FOUND");
    await rejectsCode(() => policy.inspect(OTHER_OWNER, "run-main"), "OWNER_MISMATCH");
    await rejectsCode(() => policy.inspect({ ...ALICE, grantedScopes: [] }, "run-main"), "FORBIDDEN");
    expect(contract.commands).toHaveLength(0);
  });

  test("pause blocks new claims and explicitly drains crossed work or parks uncrossed work", async () => {
    const { contract, policy } = harness(run({
      phase: "active",
      activeClaims: [{ claimId: "claim-local", crossed: false }, { claimId: "claim-crossed", crossed: true }],
    }));
    const result = await policy.pause(ALICE, "run-main", { expectedGeneration: 7 });
    expect(result.newClaims).toBe("blocked");
    expect(result.claims).toEqual([
      { claimId: "claim-local", instruction: "park" },
      { claimId: "claim-crossed", instruction: "drain" },
    ]);
    expect(contract.commands[0]).toMatchObject({ type: "execution.pause", contractRoot: "root-immutable", runId: "run-main" });
    await rejectsCode(() => policy.claim(ALICE, "run-main", { expectedGeneration: 8, nodeId: "node-next" }), "PAUSED");
    expect(contract.commands).toHaveLength(1);
  });

  test("resume preserves root/run identity and independently revalidates every pin", async () => {
    const { contract, policy } = harness(run({ phase: "paused" }));
    const resumed = await policy.resume(ALICE, "run-main", { expectedGeneration: 7 });
    expect(resumed).toMatchObject({ contractRoot: "root-immutable", runId: "run-main", phase: "runnable", lifecycleGeneration: 8 });
    const command = contract.commands[0];
    expect(command.type).toBe("execution.resume");
    expect(command.revalidatedPins.map((pin) => pin.kind)).toEqual(["graph", "input", "cell", "limb", "credential"]);
    expect(command.next.contractRoot).toBe("root-immutable");
    expect(command.next.runId).toBe("run-main");
  });

  test("resume fails closed if any graph/input/Cell/limb/credential pin moved", async () => {
    for (const kind of ["graph", "input", "cell", "limb", "credential"]) {
      const { contract, policy } = harness(run({ phase: "paused" }));
      contract.setMovedPin(kind);
      await rejectsCode(() => policy.resume(ALICE, "run-main", { expectedGeneration: 7 }), "PIN_MOVED");
      expect(contract.commands).toHaveLength(0);
    }
  });

  test("cancel is terminal and fences claims, resume, pause, and rollback", async () => {
    const { contract, policy } = harness(run());
    const cancelled = await policy.cancel(ALICE, "run-main", { expectedGeneration: 7, reason: "operator-request" });
    expect(cancelled.phase).toBe("cancelled");
    for (const operation of [
      () => policy.claim(ALICE, "run-main", { expectedGeneration: 8, nodeId: "node-next" }),
      () => policy.resume(ALICE, "run-main", { expectedGeneration: 8 }),
      () => policy.pause(ALICE, "run-main", { expectedGeneration: 8 }),
      () => policy.semanticRollback(ALICE, "run-main", { expectedGeneration: 8, targetOccurrenceId: "occurrence-old", reason: "bad-input" }),
    ]) await rejectsCode(operation, "CANCELLED");
    expect(contract.commands).toHaveLength(1);
  });

  test("tool and credential revocation are append-only generation CAS", async () => {
    const { contract, policy } = harness(run());
    await rejectsCode(() => policy.revoke(ALICE, "run-main", { kind: "tool", id: "browser", expectedGeneration: 2, reason: "retire" }), "CAS_CONFLICT");
    const tool = await policy.revoke(ALICE, "run-main", { kind: "tool", id: "browser", expectedGeneration: 3, reason: "retire" });
    const credential = await policy.revoke(ALICE, "run-main", { kind: "credential", id: "mail", expectedGeneration: 8, reason: "rotate" });
    expect(tool).toEqual({ kind: "tool", id: "browser", generation: 4, revoked: true });
    expect(credential.generation).toBe(9);
    expect(contract.commands.slice(-2).every((command) => command.type === "capability.revoke" && command.appendOnly === true)).toBe(true);
    await rejectsCode(() => policy.revoke(ALICE, "run-main", { kind: "tool", id: "browser", expectedGeneration: 3, reason: "again" }), "REVOKED");
  });

  test("semantic rollback appends invalidation and compensates crossed settlement without erase or replay", async () => {
    const { contract, policy } = harness(run());
    const result = await policy.semanticRollback(ALICE, "run-main", {
      expectedGeneration: 7, targetOccurrenceId: "occurrence-old", reason: "semantic-correction",
    });
    expect(result.occurrences).toEqual([
      { kind: "invalidation", targetOccurrenceId: "occurrence-old", reason: "semantic-correction" },
      { kind: "compensation", settlementId: "settlement-crossed", resend: false },
    ]);
    const command = contract.commands[0];
    expect(command).toMatchObject({ type: "execution.semantic_rollback", appendOnly: true, preserveSettlements: true });
    expect(JSON.stringify(command)).not.toMatch(/delete|erase|truncate|rewind|replay|resend.true/i);
  });

  test("time travel is an operational child fork, never semantic rollback or parent mutation", async () => {
    const { contract, policy } = harness(run());
    const fork = await policy.timeTravelFork(ALICE, "run-main", { expectedGeneration: 7, frameNo: 12 });
    expect(fork).toEqual({ contractRoot: "root-immutable", parentRunId: "run-main", childRunId: "fork-allocated", frameNo: 12 });
    expect(contract.commands[0]).toEqual({
      type: "execution.operational_fork", tenantId: "tenant-a", ownerId: "owner-alice",
      contractRoot: "root-immutable", parentRunId: "run-main", childRunId: "fork-allocated",
      expectedGeneration: 7, frameNo: 12, semantics: "operational-only",
    });
    expect(contract.record).toEqual(run());
  });

  test("caller bindings are closed and no Smithers store is accepted as authority", async () => {
    const { contract, policy } = harness(run());
    await rejectsCode(() => policy.pause(ALICE, "run-main", { expectedGeneration: 7, db: { status: "paused" } }), "CLOSED_BINDING");
    await rejectsCode(() => policy.claim(ALICE, "run-main", { expectedGeneration: 7, nodeId: "node-next", tenantId: "tenant-b" }), "CLOSED_BINDING");
    await rejectsCode(() => policy.semanticRollback(ALICE, "run-main", { expectedGeneration: 7, targetOccurrenceId: "occurrence-old", reason: "x", rewind: true }), "CLOSED_BINDING");
    expect(contract.commands).toHaveLength(0);
  });
});
