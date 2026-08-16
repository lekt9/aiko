import {
  FAILURE_CLASSES,
  RECEIPT_STATES,
  admitToQueue,
  defineRecoveryLimits,
  receiptTransition,
  recoveryDecision,
  selectFair,
} from "./contractRecoveryPolicy.js";

export const CRASH_POINTS = Object.freeze([
  "before_claim", "after_claim",
  "before_smithers_journal", "after_smithers_journal",
  "before_cell_spawn", "after_cell_spawn", "before_cell_result", "after_cell_result",
  "before_neuron_outbox", "after_neuron_outbox",
  "before_provider_acceptance", "after_provider_acceptance",
  "before_provider_readback", "after_provider_readback",
  "before_contract_settlement", "after_contract_settlement",
]);

const required = (object, names, label) => {
  for (const name of names) if (typeof object?.[name] !== "function") throw new TypeError(`${label}.${name} is required`);
};

/**
 * Recovery coordinator over the two authoritative journals. Contract owns
 * acceptance, claims, evidence and settlement; Neuron owns outbox/provider
 * evidence. Smithers' journal is operational telemetry and is never consulted
 * while deciding whether an effect happened or a Contract settled.
 */
export function createExecutionRecovery({ contract, neuron, cell, smithersJournal, limits: limitsInput = {}, crash = async () => {} }) {
  const limits = defineRecoveryLimits(limitsInput);
  required(contract, ["durableAccept", "readExecution", "claimExecution", "classifyFailure", "recordCellSpawn", "recordCellResult", "markEffectPrepared", "reconcileEffect", "settleExecution"], "contract");
  required(neuron, ["appendOutbox", "readEffect", "dispatch", "readBack"], "neuron");
  required(cell, ["spawn", "result"], "cell");
  required(smithersJournal, ["append"], "smithersJournal");
  if (typeof crash !== "function") throw new TypeError("crash must be a function");

  const hit = async (point, context) => { await crash(point, Object.freeze({ ...context })); };

  async function accept(envelope, acknowledge) {
    const item = Object.freeze({
      tenantId: envelope?.tenantId, rootId: envelope?.rootId,
      operationId: envelope?.operationId, attempt: envelope?.attempt ?? 1,
    });
    // This check is advisory only. Contract performs the authoritative bounded
    // append atomically and may still refuse if another process filled it.
    const admission = admitToQueue(new Array(envelope?.observedQueueDepth ?? 0).fill(item), item, limits);
    if (!admission.accepted) return Object.freeze({ accepted: false, retryable: true, reason: "queue_overloaded" });
    const receipt = await contract.durableAccept(envelope, { maxQueue: limits.maxQueue });
    if (!receipt?.accepted) return Object.freeze({ accepted: false, retryable: true, reason: receipt?.reason ?? "durable_accept_refused" });
    const transition = receiptTransition(RECEIPT_STATES.DURABLY_ACCEPTED, "ack");
    if (!transition.accepted) throw new Error("durable receipt could not transition to ACK");
    if (acknowledge) await acknowledge(receipt);
    return Object.freeze({ accepted: true, acknowledged: Boolean(acknowledge), receiptId: receipt.receiptId });
  }

  async function readAuthoritative(operationId) {
    // Deliberately parallel: neither authoritative journal is derived from the
    // other and Smithers is not read at all.
    const [execution, effect] = await Promise.all([
      contract.readExecution(operationId), neuron.readEffect(operationId),
    ]);
    return { execution, effect };
  }

  async function providerReadBack(context) {
    await hit("before_provider_readback", context);
    const evidence = await neuron.readBack(context.operationId);
    await hit("after_provider_readback", context);
    return evidence;
  }

  async function settle(context, evidence) {
    await hit("before_contract_settlement", context);
    const settled = await contract.settleExecution({
      operationId: context.operationId, claim: context.claim,
      effectId: context.operationId, evidence,
    });
    await hit("after_contract_settlement", context);
    return Object.freeze({ status: settled ? "settled" : "lost_fence" });
  }

  async function reconcile(operationId) {
    const { execution, effect } = await readAuthoritative(operationId);
    if (!execution) return Object.freeze({ status: "unknown" });
    if (execution.settled) return Object.freeze({ status: "settled" });
    const context = { operationId, claim: execution.claim };
    if (effect?.confirmed) return settle(context, effect.evidence);
    if (effect?.status === "uncertain" || execution.effectPrepared) {
      const evidence = await providerReadBack(context);
      if (evidence?.confirmed) return settle(context, evidence);
      if (evidence?.absent) {
        await contract.reconcileEffect({ operationId, result: "effect_absent", evidence });
        return Object.freeze({ status: "retry_scheduled" });
      }
      return Object.freeze({ status: "reconciliation_required" });
    }
    return Object.freeze({ status: "resumable" });
  }

  async function fail(operationId, failureClass) {
    const execution = await contract.readExecution(operationId);
    if (!execution || execution.settled) return Object.freeze({ status: execution?.settled ? "settled" : "unknown" });
    const identity = {
      tenantId: execution.envelope.tenantId, rootId: execution.envelope.rootId,
      operationId, attempt: Math.max(1, execution.attempt),
    };
    const decision = recoveryDecision(failureClass, identity, limits);
    if (!decision.accepted && !decision.action) return Object.freeze({ status: "refused", reason: decision.reason });
    await contract.classifyFailure({ operationId, claim: execution.claim, failureClass, decision });
    if (failureClass === FAILURE_CLASSES.UNCERTAIN) return reconcile(operationId);
    if (decision.action === "retry") return Object.freeze({ status: "retry_scheduled", nextAttempt: decision.nextAttempt, delayMs: decision.delayMs });
    return Object.freeze({ status: "refused", reason: decision.reason });
  }

  async function execute(item) {
    const initial = await reconcile(item.operationId);
    if (initial.status !== "resumable") return initial;
    const policy = recoveryDecision(FAILURE_CLASSES.RETRYABLE, item, limits);
    if (policy.action === "refuse_retry") return Object.freeze({ status: "refused", reason: policy.reason });

    let context = { operationId: item.operationId };
    await hit("before_claim", context);
    const claim = await contract.claimExecution(item);
    await hit("after_claim", { ...context, claim });
    if (!claim) return Object.freeze({ status: "not_claimed" });
    context = { ...context, claim };

    await hit("before_smithers_journal", context);
    await smithersJournal.append({ type: "claimed", operationId: item.operationId, fence: claim.fence });
    await hit("after_smithers_journal", context);

    let execution = await contract.readExecution(item.operationId);
    let spawn = execution.cellSpawn;
    if (!spawn) {
      await hit("before_cell_spawn", context);
      spawn = await cell.spawn({ item, claim, idempotencyKey: item.operationId });
      await hit("after_cell_spawn", context);
      await contract.recordCellSpawn({ operationId: item.operationId, claim, spawn });
    }
    execution = await contract.readExecution(item.operationId);
    let result = execution.cellResult;
    if (!result) {
      await hit("before_cell_result", context);
      result = await cell.result(spawn);
      await hit("after_cell_result", context);
      await contract.recordCellResult({ operationId: item.operationId, claim, result });
    }

    execution = await contract.readExecution(item.operationId);
    if (!execution.effectPrepared) {
      await contract.markEffectPrepared({ operationId: item.operationId, claim, result });
    }
    await hit("before_neuron_outbox", context);
    await neuron.appendOutbox({ effectId: item.operationId, claim, payload: result.effect });
    await hit("after_neuron_outbox", context);

    let effect = await neuron.readEffect(item.operationId);
    if (!effect?.confirmed) {
      if (effect?.status === "uncertain") return reconcile(item.operationId);
      await hit("before_provider_acceptance", context);
      const delivered = await neuron.dispatch(item.operationId);
      await hit("after_provider_acceptance", context);
      if (delivered?.status !== "acknowledged") return reconcile(item.operationId);
    }
    effect = await neuron.readEffect(item.operationId);
    if (!effect?.confirmed) return reconcile(item.operationId);
    return settle(context, effect.evidence);
  }

  function choose(queue, active = [], cursor = {}) { return selectFair(queue, active, limits, cursor); }
  return Object.freeze({ accept, choose, execute, fail, reconcile, limits });
}
