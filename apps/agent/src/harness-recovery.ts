import { Effect } from "effect";
import { Validator } from "@cfworker/json-schema";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { HarnessLibrary, harnessDigest, harnessLibraryState, type HarnessDigest, type HarnessJson, type HarnessJournal, type HarnessLibraryBinding } from "./harness-library.ts";
import { RECOVERY_POLICY, recoveryActive, recoverySame as same, recoveryOwned as owned, recoveryTask, recoveryUncertainWrite, repeatedHarnessFailure, recoveryWitness, recoveryPartialResults, harnessReconciledWitness, type RecoveryTask } from "./harness-recovery-log.ts";
export { RECOVERY_POLICY, recoveryTask, equivalentHarnessFailures, type RecoveryTask } from "./harness-recovery-log.ts";

export type RecoveryStrategy = "verified-procedure" | "refresh-schema" | "alternate-capability" | "owner-information";
export interface RecoveryInput {
  impasseId: string;
  strategy: RecoveryStrategy;
  procedure?: { name: string; contractDigest: HarnessDigest; input: HarnessJson };
}

/** A native package effect over the existing library journal. It neither
 * completes the foreground turn nor creates a second top-level task ledger. */
export class HarnessRecovery {
  readonly library: HarnessLibrary;
  constructor(readonly binding: HarnessLibraryBinding, readonly journal: HarnessJournal) {
    this.library = new HarnessLibrary(binding, journal);
  }
  private emit(type: string, id: string, fields: object) {
    return this.journal.append([{ type, id, owner: this.binding.owner, at: Date.now(), policyVersion: RECOVERY_POLICY, ...fields }]);
  }
  private async current(task: RecoveryTask, signal: AbortSignal) {
    signal.throwIfAborted();
    if (task.thread !== this.binding.thread || !recoveryActive(await this.journal.read(), this.binding.owner, task)) throw Error("Parent task is no longer active");
  }
  private async impasse(task: RecoveryTask, association: Event, signal: AbortSignal) {
    const events = await this.journal.read(), recent = repeatedHarnessFailure(events, this.binding.owner, task, String(association.signature));
    if (!recent) return undefined;
    const witnesses = recent.map(e => recoveryWitness(events, this.binding.owner, e)!);
    const id = harnessDigest([RECOVERY_POLICY, this.binding.owner, task as any, association.signature]);
    const old = owned(events, this.binding.owner, "AikoHarnessImpasseRecorded").find(e => e.id === id);
    if (old) return old;
    const { contract } = await this.library.resolve(association.harnessDigest as HarnessDigest);
    const message = events.find(e => e.type === "MessageReceived" && e.id === task.turn && (e.epoch ?? 0) === task.epoch);
    const nativeDeadline = Number((message?.call as any)?.deadlineAt ?? message?.deadlineAt ?? Number.MAX_SAFE_INTEGER);
    const deadlineAt = Math.min(Number(recent[0]!.at) + 60_000, nativeDeadline);
    await this.current(task, signal);
    await this.emit("AikoHarnessImpasseRecorded", id, { task, signature: association.signature, harnessDigest: association.harnessDigest,
      contractDigest: association.contractDigest, contextDigest: association.contextDigest, inputRef: association.inputRef,
      goalRef: task.turn, successCondition: contract.outcome, failureSignature: harnessDigest([witnesses[0]!.status, witnesses[0]!.evidence]),
      failures: recent.map(e => e.id), maxStrategies: 2, maxSubgoalDepth: 1, maxExecutions: 4, deadlineAt });
    return owned(await this.journal.read(), this.binding.owner, "AikoHarnessImpasseRecorded").find(e => e.id === id);
  }
  async run(hash: HarnessDigest, input: HarnessJson, operationId: string, task: RecoveryTask, callId: string, signal: AbortSignal,
    recovery?: { id: string; stage: "child" | "parent" }, expectedContext?: HarnessDigest) {
    await this.current(task, signal);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(operationId)) throw Error("Invalid harness operation ID");
    const { contract } = await this.library.resolve(hash);
    const contextDigest = harnessDigest(await this.binding.context(signal));
    if (expectedContext && contextDigest !== expectedContext) throw Error("Verified route context changed");
    const inputRef = await this.binding.blobs.putPrivate(this.binding.owner, input);
    let events = await this.journal.read();
    const state = harnessLibraryState(events, this.binding.owner);
    const prior = owned(events, this.binding.owner, "AikoHarnessTaskBound").find(e => e.id === operationId);
    if (prior && (prior.harnessDigest !== hash || prior.inputRef !== inputRef || !same(prior.task, task) || prior.recoveryId !== recovery?.id)) throw Error("Recovery operation identity conflict");
    // A historical unassociated execution cannot be adopted into another task.
    if (!prior && (state.witnesses.has(operationId) || owned(events, this.binding.owner, "AikoHarnessRunStarted").some(e => e.id === operationId))) throw Error("Operation already belongs to another execution");
    // Once an uncertain action is positively reconciled, another transport of
    // the exact input/outcome in this parent reuses that historical result.
    if (contract.effect !== "read") {
      const applied = owned(events, this.binding.owner, "AikoHarnessTaskBound").find(e => same(e.task, task) && e.inputRef === inputRef && e.contractDigest === harnessDigest(contract) &&
        owned(events, this.binding.owner, "AikoHarnessReconciled").some(r => r.operationId === e.id && harnessReconciledWitness(r, events)));
      if (applied) return { ...recoveryWitness(events, this.binding.owner, applied)!, reusedFromOperationId: applied.id, freshness: "historical-reconciled-action" };
    }
    // An unknown write freezes other write transports in this parent task too.
    if (contract.effect !== "read" && recoveryUncertainWrite(events, this.binding.owner, task, operationId))
      return { status: "blocked", reason: "uncertain-write-needs-reconciliation",
        ...recoveryPartialResults(events, this.binding.owner, task), successCondition: contract.outcome, parentTaskCompleted: false,
        instruction: "Inspect the original execution receipt before another write, including through another capability. Retained partial results do not establish that the uncertain action failed." };
    const association = { type: "AikoHarnessTaskBound", id: operationId, owner: this.binding.owner, at: Date.now(), task, callId,
      harnessDigest: hash, contractDigest: harnessDigest(contract), effect: contract.effect, contextDigest, inputRef,
      signature: harnessDigest([hash, inputRef, contextDigest]), ...(recovery ? { recoveryId: recovery.id, stage: recovery.stage } : {}) };
    if (!prior) {
      const blocked = !recovery && await this.impasse(task, association, signal);
      if (blocked) return { status: "blocked", reason: "equivalent-failure-impasse", impasseId: blocked.id,
        ...recoveryPartialResults(await this.journal.read(), this.binding.owner, task), successCondition: blocked.successCondition, parentTaskCompleted: false,
        instruction: "This approach failed twice without a relevant state change. Use a checked recovery strategy or explain the blocker and completed work." };
      await this.emit(association.type, operationId, association);
      const retained = owned(await this.journal.read(), this.binding.owner, association.type).find(e => e.id === operationId);
      if (!retained || retained.harnessDigest !== hash || retained.inputRef !== inputRef || !same(retained.task, task) || retained.recoveryId !== recovery?.id) throw Error("Recovery task association not retained");
    }
    const witness = await this.library.run(hash, input, operationId, signal, { expectedContext: contextDigest });
    if (!recovery && !prior && ["violated", "blocked"].includes(witness.status)) {
      events = await this.journal.read();
      const retained = owned(events, this.binding.owner, association.type).find(e => e.id === operationId);
      const blocked = retained && await this.impasse(task, retained, signal);
      if (blocked) return { ...witness, impasseId: blocked.id, next: "harness_recover" };
    }
    return witness;
  }
  async reconcile(operationId: string, reconciliationId: string, task: RecoveryTask, callId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.current(task, signal);
    if (![operationId, reconciliationId].every(id => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))) return { status: "rejected", reason: "invalid-reconciliation-identity" };
    let events = await this.journal.read();
    const association = owned(events, this.binding.owner, "AikoHarnessTaskBound").find(e => e.id === operationId && same(e.task, task));
    if (!association) return { status: "blocked", reason: "owned-parent-operation-unavailable" };
    const previous = recoveryWitness(events, this.binding.owner, association);
    if (previous?.status === "satisfied" || previous?.status === "blocked") return { ...previous, freshness: "retained-operation" };
    if (!this.binding.reconcile) return { status: "unknown", reason: "trusted-receipt-reader-unavailable" };
    const id = `reconcile:${harnessDigest([RECOVERY_POLICY, task, operationId, reconciliationId]).slice(7)}`;
    const attempts = owned(events, this.binding.owner, "AikoHarnessRunStarted").filter(e => e.receiptOf === operationId);
    if (attempts.length >= 2 && !attempts.some(e => e.id === id)) return { status: "unknown", reason: "reconciliation-read-budget-exhausted" };
    const message = events.find(e => e.type === "MessageReceived" && e.id === task.turn && (e.epoch ?? 0) === task.epoch);
    const deadlineAt = Math.min(Number((message?.call as any)?.deadlineAt ?? message?.deadlineAt ?? Number.MAX_SAFE_INTEGER), Number(association.at) + 60_000);
    if (deadlineAt <= Date.now()) return { status: "unknown", reason: "parent-reconciliation-budget-expired" };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(deadlineAt - Date.now())]);
    const input = await this.binding.blobs.get(this.binding.owner, association.inputRef as HarnessDigest) as HarnessJson;
    const reader = new HarnessLibrary({ ...this.binding, reconcile: async (job, s) => {
      // Custody and the native reservation can await. Recheck the parent and
      // current authority at the physical receipt-read boundary as well.
      await this.current(task, s);
      if (harnessDigest(await this.binding.context(s)) !== association.contextDigest ||
        !await this.binding.authorize(job.artifact, job.contract, job.context, job.input, s))
        return { status: "unknown", evidence: ["receipt-read-authority-or-context-changed"] };
      await this.current(task, s);
      const result = await this.binding.reconcile!(job, s);
      await this.current(task, s);
      return result;
    } }, this.journal);
    const witness = await reader.run(association.harnessDigest as HarnessDigest, input, id, deadline,
      { receiptOf: operationId, reconciliationCallId: callId, expectedContext: association.contextDigest as HarnessDigest });
    if (witness.status !== "satisfied") return { status: "unknown", reason: "receipt-outcome-unconfirmed", operationId, reconciliationWitnessId: id, checkedStatus: witness.status };
    await this.current(task, deadline);
    const { artifact, contract } = await this.library.resolve(association.harnessDigest as HarnessDigest), context = await this.binding.context(deadline);
    if (harnessDigest(context) !== association.contextDigest || !await this.binding.authorize(artifact, contract, context, input, deadline) || harnessDigest(await this.binding.context(deadline)) !== association.contextDigest)
      return { status: "unknown", reason: "reconciliation-authority-or-context-changed" };
    await this.current(task, deadline);
    await this.emit("AikoHarnessReconciled", id, { operationId, task, callId });
    events = await this.journal.read();
    const retained = owned(events, this.binding.owner, "AikoHarnessReconciled").find(e => e.id === id);
    const result = retained && harnessReconciledWitness(retained, events);
    return result ? { ...result, reconciliationWitnessId: id, freshness: "checked-reconciliation", parentTaskCompleted: false }
      : { status: "unknown", reason: "reconciliation-not-retained" };
  }
  async recover(input: RecoveryInput, task: RecoveryTask, callId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.current(task, signal);
    if (!new Validator(recoverySchema as never).validate(input).valid) return { status: "rejected", reason: "invalid-recovery-request" };
    let events = await this.journal.read();
    const impasse = owned(events, this.binding.owner, "AikoHarnessImpasseRecorded").find(e => e.id === input.impasseId && same(e.task, task));
    if (!impasse) return { status: "blocked", reason: "owned-parent-impasse-unavailable" };
    const id = harnessDigest([RECOVERY_POLICY, input.impasseId, input.strategy]);
    const requestDigest = harnessDigest(input as unknown as HarnessJson);
    // Renaming one procedure as a second strategy does not make it distinct.
    const strategyDigest = await this.binding.blobs.putPrivate(this.binding.owner, input.procedure ?? input.strategy);
    const started = owned(events, this.binding.owner, "AikoHarnessRecoveryStarted").filter(e => e.impasseId === input.impasseId);
    const prior = started.find(e => e.id === id);
    if (prior && prior.requestDigest !== requestDigest) return { status: "rejected", reason: "recovery-request-identity-conflict" };
    const settled = owned(events, this.binding.owner, "AikoHarnessRecoverySettled").find(e => e.id === id);
    if (settled) return { ...settled, freshness: "retained-recovery" };
    if (started.some(e => e.id !== id && e.strategyDigest === strategyDigest)) return { status: "blocked", reason: "recovery-procedure-already-attempted" };
    if (owned(events, this.binding.owner, "AikoHarnessRecoverySettled").some(e => e.impasseId === input.impasseId && e.status === "recovered")) return { status: "blocked", reason: "parent-outcome-already-recovered" };
    if (!prior && started.length >= 2) return { status: "blocked", reason: "recovery-strategies-exhausted", failures: impasse.failures,
      ...recoveryPartialResults(events, this.binding.owner, task), successCondition: impasse.successCondition, parentTaskCompleted: false,
      instruction: "Two recovery strategies were already attempted. Explain the blocker and retained partial results; do not repeat them." };
    if (!prior && started.some(e => !owned(events, this.binding.owner, "AikoHarnessRecoverySettled").some(r => r.id === e.id)))
      return { status: "blocked", reason: "recovery-subgoal-already-active" };
    if (!Number.isSafeInteger(impasse.deadlineAt) || Number(impasse.deadlineAt) <= Date.now()) return { status: "blocked", reason: "parent-recovery-budget-expired",
      ...recoveryPartialResults(events, this.binding.owner, task), successCondition: impasse.successCondition, parentTaskCompleted: false,
      instruction: "The original recovery deadline has passed. Explain the unmet outcome and checked partial results; do not reset the budget or retry uncertain actions." };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Number(impasse.deadlineAt) - Date.now())]);
    const claimId = prior?.claimId ?? crypto.randomUUID();
    if (!prior) await this.emit("AikoHarnessRecoveryStarted", id, { impasseId: input.impasseId, task, strategy: input.strategy, strategyDigest, requestDigest, claimId,
      deadlineAt: impasse.deadlineAt, depth: 1, executionBudget: Math.max(0, 4 - started.length * 2) });
    events = await this.journal.read();
    if (owned(events, this.binding.owner, "AikoHarnessRecoveryStarted").find(e => e.id === id)?.claimId !== claimId)
      return { status: "blocked", reason: "recovery-claim-not-owned" };
    const settle = async (fields: object) => {
      const partial = recoveryPartialResults(await this.journal.read(), this.binding.owner, task);
      await this.emit("AikoHarnessRecoverySettled", id, { impasseId: input.impasseId, claimId, task, ...partial,
        successCondition: impasse.successCondition, parentTaskCompleted: false, ...fields });
      return owned(await this.journal.read(), this.binding.owner, "AikoHarnessRecoverySettled").find(e => e.id === id) ?? { status: "unknown", reason: "recovery-settlement-unavailable" };
    };
    if (input.strategy === "owner-information") return settle({ status: "blocked", reason: "owner-information-required", failures: impasse.failures,
      instruction: "Explain the unmet success condition and ask only for the missing information. Preserve completed partial work." });
    if (!input.procedure) return settle({ status: "blocked", reason: "verified-recovery-procedure-required" });
    try {
      await this.current(task, deadline);
      const originalInput = await this.binding.blobs.get(this.binding.owner, impasse.inputRef as HarnessDigest) as HarnessJson;
      if (input.strategy === "alternate-capability" && (input.procedure.contractDigest !== impasse.contractDigest || !same(input.procedure.input, originalInput)))
        return settle({ status: "blocked", reason: "alternate-must-preserve-parent-outcome-and-input" });
      const childId = `recover:${id.slice(7)}:child`, parentId = `recover:${id.slice(7)}:parent`;
      const route = await this.library.verifiedRoute(input.procedure.name, input.procedure.contractDigest, deadline).catch(() => undefined);
      if (!route) return settle({ status: "blocked", reason: "current-verified-procedure-unavailable" });
      const child = await this.run(route.harnessDigest, input.procedure.input, childId, task, callId, deadline, { id, stage: "child" }, route.contextDigest);
      if (child.status === "unknown" && !owned(await this.journal.read(), this.binding.owner, "AikoHarnessChecked").some(e => e.id === childId))
        return { status: "unknown", reason: "recovery-execution-pending-or-interrupted", childId };
      if (child.status !== "satisfied") return settle({ status: child.status === "unknown" ? "unknown" : "failed", reason: "recovery-prerequisite-unchecked", childId });
      await this.current(task, deadline);
      let parent = child;
      if (input.strategy === "alternate-capability") {
        // This is the parent's own operation: the alternate used the exact
        // original input and independent outcome contract. No second write.
        if (!("contractDigest" in child) || child.contractDigest !== impasse.contractDigest || child.contextDigest !== harnessDigest(await this.binding.context(deadline)))
          return settle({ status: "failed", reason: "parent-outcome-check-stale", childId });
      } else {
        parent = await this.run(impasse.harnessDigest as HarnessDigest, originalInput, parentId, task, callId, deadline, { id, stage: "parent" });
      }
      await this.current(task, deadline);
      if (parent.status === "unknown" && !owned(await this.journal.read(), this.binding.owner, "AikoHarnessChecked").some(e => e.id === parentId))
        return { status: "unknown", reason: "recovery-execution-pending-or-interrupted", childId, parentWitnessId: parentId };
      return settle({ status: parent.status === "satisfied" ? "recovered" : parent.status === "unknown" ? "unknown" : "failed",
        reason: parent.status === "satisfied" ? "parent-outcome-checked" : "parent-outcome-unchecked", childId, parentWitnessId: "operationId" in parent ? parent.operationId : null,
        contractDigest: impasse.contractDigest, parentTaskCompleted: false });
    } catch {
      return settle({ status: "unknown", reason: "recovery-interrupted-inspect-existing-witnesses" });
    }
  }
}

const recoverySchema = { type: "object", properties: {
  impasseId: { type: "string" }, strategy: { type: "string", enum: ["verified-procedure", "refresh-schema", "alternate-capability", "owner-information"] },
  procedure: { type: "object", properties: { name: { type: "string" }, contractDigest: { type: "string" }, input: {} }, required: ["name", "contractDigest", "input"], additionalProperties: false },
}, required: ["impasseId", "strategy"], additionalProperties: false };
const reconciliationSchema = { type: "object", properties: { operationId: { type: "string" }, reconciliationId: { type: "string" } }, required: ["operationId", "reconciliationId"], additionalProperties: false };

/** Decorates existing run/call tools; all execution still reaches the same
 * library, current authorization and registered independent verifiers. */
export function withHarnessRecovery(tools: readonly NativeTool<Self | EventLog>[], bindingFor: (journal: HarnessJournal) => HarnessLibraryBinding): NativeTool<Self | EventLog>[] {
  const wrap = (method: string): NativeTool<Self | EventLog>["run"] => (raw, call) => Effect.gen(function* () {
    const self = yield* Self, log = yield* EventLog;
    const journal: HarnessJournal = { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) };
    const binding = bindingFor(journal), controller = new HarnessRecovery(binding, journal);
    const task = recoveryTask(yield* log.read, binding.owner, binding.thread, call);
    const original = tools.find(t => t.spec.name === method);
    const schema = method === "harness_recover" ? recoverySchema : method === "harness_reconcile" ? reconciliationSchema : original!.spec.inputSchema;
    if (self.actor !== "aiko" || self.thread !== binding.thread || !task || !new Validator(schema as never).validate(raw).valid) return { status: "rejected", reason: "native-recovery-task-unavailable" };
    const args = raw as any;
    return yield* Effect.tryPromise({ try: async () => {
      if (method === "harness_recover") return controller.recover(args, task, call.callId, call.signal);
      if (method === "harness_reconcile") return controller.reconcile(args.operationId, args.reconciliationId, task, call.callId, call.signal);
      const route = method === "harness_call" ? await controller.library.verifiedRoute(args.name, args.contractDigest, call.signal).catch(() => undefined) : undefined;
      const hash = method === "harness_run" ? args.digest : route?.harnessDigest;
      if (!hash) return { status: "unavailable", reason: "current-verified-route-unavailable" };
      return controller.run(hash, args.input, args.operationId, task, call.callId, call.signal, undefined, route?.contextDigest);
    }, catch: () => undefined }).pipe(Effect.catch(() => Effect.succeed({ status: "unknown", reason: "inspect-retained-operation-before-retry" })));
  });
  return [...tools.map(t => ["harness_run", "harness_call"].includes(t.spec.name) ? { ...t, run: wrap(t.spec.name) } : t),
    { spec: { name: "harness_recover", inputSchema: recoverySchema, description: "Recover a retained parent impasse using at most two distinct strategies and one checked prerequisite level. Select a currently promoted procedure. The parent keeps its original input and outcome contract. Unknown writes require reconciliation. Parent task completion is separate from recovery." }, run: wrap("harness_recover") },
    { spec: { name: "harness_reconcile", inputSchema: reconciliationSchema, description: "Read the trusted receipt of an uncertain operation in this parent and independently check its original outcome. Never executes or resubmits it. Reuse reconciliationId to inspect the same attempt; at most two receipt reads within the parent's recovery budget. Missing or invalid receipts stay unknown." }, run: wrap("harness_reconcile") }];
}
