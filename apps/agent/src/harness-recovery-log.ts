import { canonicalStringify } from "@unbrowse/browser-harness/har";
import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import type { HarnessWitness } from "./harness-library.ts";

export const RECOVERY_POLICY = "aiko-harness-recovery/v1";
export interface RecoveryTask { thread: string; turn: string; epoch: number }
export const recoverySame = (a: unknown, b: unknown) => canonicalStringify(a ?? null) === canonicalStringify(b ?? null);
export const recoveryOwned = (events: readonly Event[], owner: string, type: string) => events.filter(e => e.owner === owner && e.type === type);
export const browserWatchReceiptOperationId = (owner: string, operationId: string, requestId: string) =>
  `watch-receipt:${createHash("sha256").update(canonicalStringify([owner, operationId, requestId])).digest("hex")}`;
/** A watch owns a native task, independently of model-turn recovery. Only a
 * retained explicit receipt request can create this receipt-only library run. */
function browserWatchReceiptAllowed(event: Event, history: readonly Event[], original: Event, started: Event) {
  const owner = String(event.owner), requestId = String(event.reconciliationCallId);
  const request = recoveryOwned(history, owner, "AikoBrowserWatchReconcileRequested").find(e => e.id === `${original.id}:${requestId}`);
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(requestId) || !request || request.operationId !== original.id || request.requestId !== requestId ||
    ["watchId", "generation", "source"].some(key => request[key] !== started[key]) ||
    event.id !== browserWatchReceiptOperationId(owner, String(original.id), requestId) || event.caseId !== null || original.caseId !== null || original.receiptOf !== undefined ||
    ["harnessDigest", "inputRef", "contextDigest"].some(key => event[key] !== original[key]) ||
    recoveryOwned(history, owner, "AikoHarnessRunStarted").filter(e => e.receiptOf === original.id).length >= 7 ||
    recoveryOwned(history, owner, "AikoBrowserWatchSettled").some(e => e.operationId === original.id && e.status !== "unknown") ||
    recoveryOwned(history, owner, "AikoHarnessChecked").some(e => e.id === original.id && (e.witness as HarnessWitness)?.status === "satisfied")) return false;
  return recoveryOwned(history, owner, "AikoBrowserWatchSettled").some(e => e.operationId === original.id && e.source === started.source && e.status === "unknown");
}
export function recoveryActive(events: readonly Event[], owner: string, task: RecoveryTask) {
  return task?.thread === `user-${owner}` && Number.isSafeInteger(task.epoch) && task.epoch >= 0 &&
    events.some(e => e.type === "MessageReceived" && e.id === task.turn && (e.epoch ?? 0) === task.epoch) &&
    !events.some(e => ["TurnCancelled", "TurnCompleted", "TurnFailed"].includes(e.type) && e.turn === task.turn && (e.epoch ?? 0) === task.epoch ||
      e.type === "CancellationRequested" && (e.invocation as any)?.method === "message" && (e.invocation as any)?.id === task.turn && ((e.invocation as any)?.epoch ?? 0) === task.epoch);
}
export function recoveryTask(events: readonly Event[], owner: string, thread: string, call: { callId: string; turn?: string }): RecoveryTask | undefined {
  if (thread !== `user-${owner}` || !call.turn) return undefined;
  const names = ["harness_run", "harness_call", "harness_recover", "harness_reconcile"];
  const invocation = events.findLast(e => e.callId === call.callId && e.turn === call.turn &&
    (e.type === "ToolCalled" && names.includes(String(e.name)) || e.type === "AikoCodeToolStarted" && e.owner === owner && names.includes(String(e.tool))));
  if (!invocation) return undefined;
  const parent = events.findLast(e => e.type === "PackageCalled" && e.callId === call.callId && e.turn === call.turn);
  const task = { thread, turn: call.turn, epoch: Number(invocation.epoch ?? parent?.epoch ?? 0) };
  return recoveryActive(events, owner, task) ? task : undefined;
}
/** An independent receipt check supersedes uncertainty without rewriting its
 * original witness. The checker is the original pinned contract's verifier. */
export function harnessReconciledWitness(event: Event, events: readonly Event[]): HarnessWitness | undefined {
  if (event.type !== "AikoHarnessReconciled" || event.policyVersion !== RECOVERY_POLICY) return undefined;
  const owner = String(event.owner), original = recoveryOwned(events, owner, "AikoHarnessRunStarted").find(e => e.id === event.operationId);
  const run = recoveryOwned(events, owner, "AikoHarnessRunStarted").find(e => e.id === event.id);
  const association = recoveryOwned(events, owner, "AikoHarnessTaskBound").find(e => e.id === event.operationId);
  const checked = recoveryOwned(events, owner, "AikoHarnessChecked").find(e => e.id === event.id)?.witness as HarnessWitness | undefined;
  const registered = recoveryOwned(events, owner, "AikoHarnessContractRegistered").find(e => e.id === association?.contractDigest);
  if (!original || !run || !association || !checked || !recoverySame(event.task, association.task) ||
    original.caseId !== null || run.caseId !== null || run.receiptOf !== original.id ||
    run.harnessDigest !== original.harnessDigest || run.inputRef !== original.inputRef || run.contextDigest !== original.contextDigest ||
    original.harnessDigest !== association.harnessDigest || original.inputRef !== association.inputRef || original.contextDigest !== association.contextDigest ||
    checked.operationId !== run.id || checked.harnessDigest !== run.harnessDigest || checked.contextDigest !== run.contextDigest ||
    checked.contractDigest !== association.contractDigest || checked.verifierDigest !== registered?.verifierDigest || checked.evaluatorDigest !== registered.evaluatorDigest ||
    checked.status !== "satisfied" || !checked.outputRef) return undefined;
  return { ...checked, operationId: String(original.id), evidence: [...checked.evidence, `reconciled-witness:${run.id}`] };
}
export function recoveryWitness(events: readonly Event[], owner: string, association: Event): HarnessWitness | undefined {
  const run = recoveryOwned(events, owner, "AikoHarnessRunStarted").find(e => e.id === association.id);
  const reconciliation = recoveryOwned(events, owner, "AikoHarnessReconciled").filter(e => e.operationId === association.id)
    .map(e => harnessReconciledWitness(e, events)).findLast(w => !!w);
  const witness = reconciliation ?? recoveryOwned(events, owner, "AikoHarnessChecked").find(e => e.id === association.id)?.witness as HarnessWitness | undefined;
  const contract = recoveryOwned(events, owner, "AikoHarnessContractRegistered").find(e => e.id === association.contractDigest);
  return !!run && !!witness && run.caseId === null && run.harnessDigest === association.harnessDigest && run.inputRef === association.inputRef &&
    witness.operationId === association.id && witness.harnessDigest === association.harnessDigest && witness.contractDigest === association.contractDigest &&
    run.contextDigest === association.contextDigest && witness.contextDigest === association.contextDigest &&
    contract?.verifierDigest === witness.verifierDigest && contract.evaluatorDigest === witness.evaluatorDigest ? witness : undefined;
}
/** References to checked work in this exact parent, never evaluation outputs or
 * another turn's successes. A receipt is historical evidence, not fresh access
 * authority; harness_output still checks private custody when it is requested. */
export function recoveryPartialResults(events: readonly Event[], owner: string, task: RecoveryTask) {
  const results = recoveryOwned(events, owner, "AikoHarnessTaskBound")
    .filter(e => recoverySame(e.task, task))
    .filter((e, i, all) => all.findIndex(other => other.id === e.id) === i)
    .flatMap(e => {
      const witness = recoveryWitness(events, owner, e);
      return witness?.status === "satisfied" ? [{ operationId: witness.operationId, status: "satisfied" as const,
        harnessDigest: witness.harnessDigest, contractDigest: witness.contractDigest, outputRef: witness.outputRef ?? null,
        scope: "historical-checked-partial" as const, outputTool: { name: "harness_output", arguments: { operationId: witness.operationId } } }] : [];
    });
  return { partialResults: results.slice(-16), partialResultsTotal: results.length, partialResultsTruncated: results.length > 16 };
}
/** A failed outcome check does not prove that a write had no side effects. */
export function recoveryUncertainWrite(events: readonly Event[], owner: string, task: RecoveryTask, except?: string) {
  return recoveryOwned(events, owner, "AikoHarnessTaskBound").some(e => e.id !== except && recoverySame(e.task, task) && e.effect !== "read" &&
    !["blocked", "satisfied"].includes(recoveryWitness(events, owner, e)?.status ?? ""));
}
export function equivalentHarnessFailures(events: readonly Event[], owner: string, task: RecoveryTask, signature: string) {
  return recoveryOwned(events, owner, "AikoHarnessTaskBound").filter(e => !e.recoveryId && recoverySame(e.task, task) && e.signature === signature &&
    ["violated", "blocked"].includes(recoveryWitness(events, owner, e)?.status ?? ""))
    .filter((e, i, all) => all.findIndex(r => r.id === e.id) === i);
}
export function repeatedHarnessFailure(events: readonly Event[], owner: string, task: RecoveryTask, signature: string) {
  const recent = equivalentHarnessFailures(events, owner, task, signature).slice(-2);
  if (recent.length !== 2) return undefined;
  const [first, last] = recent.map(e => recoveryWitness(events, owner, e)!);
  return first!.status === last!.status && recoverySame(first!.evidence, last!.evidence) ? recent : undefined;
}

/** Runs inside the existing host append transaction, before a competing caller
 * can reserve another strategy or an execution with an unsettled write. */
export function harnessRecoveryAppendAllowed(batch: readonly Event[], read: () => readonly Event[]): boolean {
  const history = [...read()];
  for (const event of batch) {
    if (event.type === "AikoHarnessRunStarted") {
      const owner = String(event.owner);
      if (event.receiptOf !== undefined) {
        const original = recoveryOwned(history, owner, "AikoHarnessRunStarted").find(e => e.id === event.receiptOf);
        const watch = recoveryOwned(history, owner, "AikoBrowserWatchStarted").find(e => e.id === event.receiptOf);
        const parent = recoveryOwned(history, owner, "AikoHarnessTaskBound").find(e => e.id === event.receiptOf);
        const task = parent?.task as RecoveryTask;
        const message = parent && history.find(e => e.type === "MessageReceived" && e.id === task.turn && (e.epoch ?? 0) === task.epoch);
        const deadlineAt = Math.min(Number((message?.call as any)?.deadlineAt ?? message?.deadlineAt ?? Number.MAX_SAFE_INTEGER), Number(parent?.at) + 60_000);
        if (watch ? !original || !browserWatchReceiptAllowed(event, history, original, watch) : !original || !parent || event.caseId !== null || original.caseId !== null || !recoveryActive(history, owner, task) ||
          !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() ||
          !recoverySame(recoveryTask(history, owner, task.thread, { callId: String(event.reconciliationCallId), turn: task.turn }), task) ||
          ["harnessDigest", "inputRef", "contextDigest"].some(key => event[key] !== original[key]) ||
          recoveryOwned(history, owner, "AikoHarnessRunStarted").filter(e => e.receiptOf === original.id).length >= 2 ||
          recoveryWitness(history, owner, parent)?.status === "satisfied") return false;
      }
      const association = recoveryOwned(history, owner, "AikoHarnessTaskBound").find(e => e.id === event.id);
      if (association) {
        const task = association.task as RecoveryTask;
        if (!recoveryActive(history, owner, task) || event.harnessDigest !== association.harnessDigest || event.inputRef !== association.inputRef ||
          event.contextDigest !== association.contextDigest || event.caseId !== null) return false;
        if (association.recoveryId) {
          const start = recoveryOwned(history, owner, "AikoHarnessRecoveryStarted").find(e => e.id === association.recoveryId);
          if (!start || Number(start.deadlineAt) <= Date.now() || recoveryOwned(history, owner, "AikoHarnessRecoverySettled").some(e => e.id === start.id)) return false;
        }
      }
    }
    if (["AikoHarnessTaskBound", "AikoHarnessImpasseRecorded", "AikoHarnessRecoveryStarted", "AikoHarnessRecoverySettled", "AikoHarnessReconciled"].includes(event.type)) {
      const owner = String(event.owner), task = event.task as RecoveryTask;
      if (event.policyVersion !== RECOVERY_POLICY || !recoveryActive(history, owner, task)) return false;
      const old = recoveryOwned(history, owner, event.type).find(e => e.id === event.id);
      if (old) { if (!recoverySame(old, event)) return false; continue; }
      if (event.type === "AikoHarnessReconciled" && !harnessReconciledWitness(event, history)) return false;
      if (event.type === "AikoHarnessTaskBound") {
        if (!recoverySame(recoveryTask(history, owner, task.thread, { callId: String(event.callId), turn: task.turn }), task)) return false;
        const attempts = recoveryOwned(history, owner, event.type).filter(e => recoverySame(e.task, task));
        if (event.effect !== "read" && recoveryUncertainWrite(history, owner, task)) return false;
        if (attempts.some(e => e.signature === event.signature && !recoveryWitness(history, owner, e))) return false;
        if (event.recoveryId) {
          const start = recoveryOwned(history, owner, "AikoHarnessRecoveryStarted").find(e => e.id === event.recoveryId && recoverySame(e.task, task));
          if (!start || recoveryOwned(history, owner, "AikoHarnessRecoverySettled").some(e => e.id === start.id) || Number(start.deadlineAt) <= Date.now()) return false;
          if (!["child", "parent"].includes(String(event.stage)) || event.id !== `recover:${String(start.id).slice(7)}:${event.stage}`) return false;
        } else if (repeatedHarnessFailure(history, owner, task, String(event.signature))) return false;
      }
      if (event.type === "AikoHarnessImpasseRecorded") {
        const failures = repeatedHarnessFailure(history, owner, task, String(event.signature));
        if (!failures || !recoverySame(event.failures, failures.map(e => e.id)) || event.goalRef !== task.turn ||
          event.maxStrategies !== 2 || event.maxSubgoalDepth !== 1 || event.maxExecutions !== 4 || !Number.isSafeInteger(event.deadlineAt) ||
          Number(event.deadlineAt) > Number(failures[0]!.at) + 60_000 ||
          ["harnessDigest", "contractDigest", "contextDigest", "inputRef"].some(key => event[key] !== failures[1]![key])) return false;
      }
      if (event.type === "AikoHarnessRecoveryStarted") {
        const impasse = recoveryOwned(history, owner, "AikoHarnessImpasseRecorded").find(e => e.id === event.impasseId && recoverySame(e.task, task));
        const started = recoveryOwned(history, owner, event.type).filter(e => e.impasseId === event.impasseId);
        const settled = recoveryOwned(history, owner, "AikoHarnessRecoverySettled");
        if (!impasse || !["verified-procedure", "refresh-schema", "alternate-capability", "owner-information"].includes(String(event.strategy)) ||
          event.depth !== 1 || event.deadlineAt !== impasse.deadlineAt || Number(event.deadlineAt) <= Date.now() || started.length >= 2 ||
          started.some(e => e.strategy === event.strategy || e.strategyDigest === event.strategyDigest || !settled.some(r => r.id === e.id) || settled.some(r => r.id === e.id && r.status === "recovered"))) return false;
      }
      if (event.type === "AikoHarnessRecoverySettled") {
        const start = recoveryOwned(history, owner, "AikoHarnessRecoveryStarted").find(e => e.id === event.id);
        if (!start || start.claimId !== event.claimId || start.impasseId !== event.impasseId || !recoverySame(start.task, task)) return false;
        // Legacy settlements remain readable. New partial-result references
        // must be derived from checked receipts in this transaction's parent.
        if (event.partialResults !== undefined) {
          const partial = recoveryPartialResults(history, owner, task);
          if (!recoverySame(event.partialResults, partial.partialResults) || event.partialResultsTotal !== partial.partialResultsTotal ||
            event.partialResultsTruncated !== partial.partialResultsTruncated) return false;
        }
        if (event.status === "recovered") {
          const impasse = recoveryOwned(history, owner, "AikoHarnessImpasseRecorded").find(e => e.id === start.impasseId);
          const associations = recoveryOwned(history, owner, "AikoHarnessTaskBound").filter(e => e.recoveryId === start.id);
          const child = associations.find(e => e.stage === "child" && e.id === event.childId);
          const parent = associations.find(e => e.id === event.parentWitnessId && e.stage === (start.strategy === "alternate-capability" ? "child" : "parent"));
          if (!impasse || !child || !parent || event.parentTaskCompleted !== false || event.contractDigest !== impasse.contractDigest ||
            parent.inputRef !== impasse.inputRef || parent.contractDigest !== impasse.contractDigest ||
            recoveryWitness(history, owner, child)?.status !== "satisfied" || recoveryWitness(history, owner, parent)?.status !== "satisfied") return false;
        }
      }
    }
    history.push(event);
  }
  return true;
}
