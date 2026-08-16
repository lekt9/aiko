import { describe, expect, test } from "bun:test";
import { CRASH_POINTS, createExecutionRecovery } from "../src/index.js";

const limits = { maxAttempts: 5, maxQueue: 4, maxInFlight: 2, maxTenantInFlight: 1, maxRootInFlight: 1, baseDelayMs: 10, maxDelayMs: 40 };
const item = { tenantId: "tenant", rootId: "root", operationId: "effect-1", attempt: 1 };

function durableSystem({ crashPoint, uncertainDispatch = false } = {}) {
  const executions = new Map(); const neuronRows = new Map(); const provider = new Map();
  const smithersRows = []; const spawns = new Map(); let crashed = false; let receiptOrdinal = 0;
  const state = () => executions.get(item.operationId);
  const contract = {
    async durableAccept(envelope, { maxQueue }) {
      if ([...executions.values()].filter((x) => !x.settled).length >= maxQueue) return { accepted: false, reason: "queue_overloaded" };
      if (!executions.has(envelope.operationId)) executions.set(envelope.operationId, { envelope: structuredClone(envelope), attempt: 0, settled: false, effectPrepared: false });
      return { accepted: true, receiptId: `receipt-${++receiptOrdinal}` };
    },
    async readExecution(id) { const row = executions.get(id); return row && structuredClone(row); },
    async classifyFailure({ operationId, failureClass, decision }) {
      const row = executions.get(operationId); row.failureClass = failureClass; row.claim = null;
      if (decision.action === "retry") row.nextEligibleDelayMs = decision.delayMs;
      if (decision.action === "refuse_retry") row.refused = true;
      if (failureClass === "uncertain") row.effectPrepared = true;
    },
    async claimExecution(work) {
      const row = executions.get(work.operationId); if (!row || row.settled) return null;
      if (!row.claim) row.claim = { id: `claim-${row.attempt + 1}`, fence: row.attempt + 1 };
      row.attempt = Math.max(row.attempt, row.claim.fence); return structuredClone(row.claim);
    },
    async recordCellSpawn({ operationId, claim, spawn }) { const row = executions.get(operationId); if (row.claim.id === claim.id) row.cellSpawn = structuredClone(spawn); },
    async recordCellResult({ operationId, claim, result }) { const row = executions.get(operationId); if (row.claim.id === claim.id) row.cellResult = structuredClone(result); },
    async markEffectPrepared({ operationId, claim }) { const row = executions.get(operationId); if (row.claim.id === claim.id) row.effectPrepared = true; },
    async reconcileEffect({ operationId, result }) { const row = executions.get(operationId); if (result === "effect_absent") { row.effectPrepared = false; row.claim = null; } },
    async settleExecution({ operationId, claim, evidence }) {
      const row = executions.get(operationId); if (row.settled) return true;
      if (!claim || row.claim?.id !== claim.id || !evidence?.providerReceipt) return false;
      row.settled = true; row.settlementEvidence = structuredClone(evidence); row.claim = null; return true;
    },
  };
  const neuron = {
    async appendOutbox({ effectId, payload }) { if (!neuronRows.has(effectId)) neuronRows.set(effectId, { effectId, payload, status: "queued", confirmed: false }); },
    async readEffect(id) { const row = neuronRows.get(id); return row && structuredClone(row); },
    async dispatch(id) {
      const row = neuronRows.get(id); if (!row) throw new Error("outbox must precede dispatch");
      // Provider idempotency is the logical effect id. Even an uncertain reply
      // cannot create a second externally accepted effect on redelivery.
      if (!provider.has(id)) provider.set(id, { providerReceipt: `provider-${id}` });
      if (uncertainDispatch && row.status === "queued") { row.status = "uncertain"; return { status: "uncertain" }; }
      row.status = "acknowledged"; row.confirmed = true; row.evidence = provider.get(id); return { status: "acknowledged" };
    },
    async readBack(id) {
      const found = provider.get(id);
      if (found) { const row = neuronRows.get(id); if (row) { row.status = "acknowledged"; row.confirmed = true; row.evidence = found; } return { confirmed: true, ...found }; }
      return { confirmed: false, absent: true };
    },
  };
  const cell = {
    async spawn({ idempotencyKey }) { if (!spawns.has(idempotencyKey)) spawns.set(idempotencyKey, { id: `cell-${idempotencyKey}` }); return structuredClone(spawns.get(idempotencyKey)); },
    async result(spawn) { return { spawnId: spawn.id, effect: { body: "hello" } }; },
  };
  const recovery = createExecutionRecovery({ contract, neuron, cell, limits,
    smithersJournal: { append: async (row) => smithersRows.push(structuredClone(row)) },
    crash: async (point) => { if (!crashed && point === crashPoint) { crashed = true; throw new Error(`crash:${point}`); } },
  });
  return { recovery, contract, executions, neuronRows, provider, smithersRows, spawns, state };
}

async function runToSettlement(system) {
  if (!system.state()) await system.recovery.accept(item);
  for (let n = 0; n < 12 && !system.state().settled; n += 1) {
    try { await system.recovery.execute({ ...item, attempt: Math.max(1, system.state().attempt || 1) }); } catch (error) {
      if (!String(error).includes("crash:")) throw error;
    }
  }
  return system.state();
}

describe("production Contract + Neuron recovery coordinator", () => {
  test("durably accepts before ACK and returns retryable refusal on overload", async () => {
    const system = durableSystem(); const ordering = [];
    const original = system.contract.durableAccept;
    system.contract.durableAccept = async (...args) => { ordering.push("contract-durable"); return original(...args); };
    const accepted = await system.recovery.accept(item, async () => ordering.push("ack"));
    expect(accepted).toMatchObject({ accepted: true, acknowledged: true });
    expect(ordering).toEqual(["contract-durable", "ack"]);
    const overloaded = await system.recovery.accept({ ...item, operationId: "other", observedQueueDepth: limits.maxQueue });
    expect(overloaded).toEqual({ accepted: false, retryable: true, reason: "queue_overloaded" });
  });

  test("every declared crash point converges without duplicate provider effect", async () => {
    expect(CRASH_POINTS).toHaveLength(16);
    for (const point of CRASH_POINTS) {
      const uncertain = point.includes("provider_readback");
      const system = durableSystem({ crashPoint: point, uncertainDispatch: uncertain });
      const final = await runToSettlement(system);
      expect(final.settled, point).toBe(true);
      expect(system.provider.size, point).toBe(1);
      expect(system.spawns.size, point).toBe(1);
      expect(system.neuronRows.size, point).toBe(1);
    }
  });

  test("persists deterministic retry eligibility and closes permanent/attempt budgets", async () => {
    const a = durableSystem(); const b = durableSystem();
    await a.recovery.accept(item); await b.recovery.accept(item);
    await a.contract.claimExecution(item); await b.contract.claimExecution(item);
    const first = await a.recovery.fail(item.operationId, "retryable");
    const replay = await b.recovery.fail(item.operationId, "retryable");
    expect(first).toEqual(replay);
    expect(a.state().nextEligibleDelayMs).toBe(first.delayMs);

    const permanent = durableSystem(); await permanent.recovery.accept(item); await permanent.contract.claimExecution(item);
    expect(await permanent.recovery.fail(item.operationId, "permanent")).toEqual({ status: "refused", reason: "permanent_failure" });
  });

  test("uncertain provider response is read back and never blindly dispatched twice", async () => {
    const system = durableSystem({ uncertainDispatch: true });
    await system.recovery.accept(item);
    expect((await system.recovery.execute(item)).status).toBe("settled");
    expect(system.provider.size).toBe(1);
    expect(system.neuronRows.get(item.operationId)).toMatchObject({ confirmed: true, status: "acknowledged" });
  });

  test("reconciliation derives truth from Contract plus Neuron, never Smithers", async () => {
    const system = durableSystem(); await system.recovery.accept(item); await runToSettlement(system);
    system.smithersRows.splice(0, system.smithersRows.length, { type: "false_success" });
    expect(await system.recovery.reconcile(item.operationId)).toEqual({ status: "settled" });
    const source = await Bun.file(new URL("../src/contractRecovery.js", import.meta.url)).text();
    const reconcileBody = source.slice(source.indexOf("async function reconcile"), source.indexOf("async function execute"));
    expect(reconcileBody).not.toContain("smithersJournal");
  });

  test("fair chooser enforces tenant/root concurrency and rotates persisted cursor", () => {
    const system = durableSystem(); const queue = [
      item, { tenantId: "tenant", rootId: "other-root", operationId: "e2", attempt: 1 },
      { tenantId: "other", rootId: "r", operationId: "e3", attempt: 1 },
    ];
    const blockedTenant = system.recovery.choose(queue, [item]);
    expect(blockedTenant.selected.tenantId).toBe("other");
    const first = system.recovery.choose(queue); const second = system.recovery.choose(queue, [], first.cursor);
    expect([first.selected.tenantId, second.selected.tenantId]).toEqual(["other", "tenant"]);
  });
});
