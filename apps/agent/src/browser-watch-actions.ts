import type { Event } from "tardie/core/event";
import { channelDigest } from "./channel-bindings.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryState, type HarnessJson, type HarnessExecution } from "./harness-library.ts";
import type { BrowserWatchBindings, BrowserWatchDispatch } from "./browser-watches.ts";
import { browserWatchReceiptOperationId } from "./harness-recovery-log.ts";

export interface BrowserWatchHarnessActionBinding {
  library: HarnessLibrary;
  /** Current account, connection and saved watch authority. Called again at the
   * physical executor boundary, including for explicit receipt reads. */
  current(intent: BrowserWatchDispatch, signal: AbortSignal, operation: "execute" | "reconcile"): Promise<boolean>;
}
type Result = Awaited<ReturnType<BrowserWatchBindings["execute"]>>;
const rejected = (reason: string): Result => ({ status: "failed", result: { reason } });
const uncertain = (reason: string): Result => ({ status: "unknown", result: { reason } });

/** Executes one pinned harness through its existing journal and executor. Other
 * action kinds remain unavailable until their own native adapters are bound. */
export function browserWatchHarnessActions(binding: BrowserWatchHarnessActionBinding): Pick<BrowserWatchBindings, "execute" | "reconcile"> {
  const { library } = binding, { owner, thread } = library.binding;
  if (thread !== `user-${owner}`) throw Error("watch_harness_owner_mismatch");
  const owned = (events: readonly Event[]) => events.filter(e => e.owner === owner);
  const runOf = (events: readonly Event[], id: string) => owned(events).find(e => e.type === "AikoHarnessRunStarted" && e.id === id);
  const watchClaim = (intent: BrowserWatchDispatch, events: readonly Event[]) => {
    const claim = owned(events).find(e => e.type === "AikoBrowserWatchStarted" && e.id === intent.operationId);
    if (!claim || claim.watchId !== intent.watchId || claim.generation !== intent.generation || claim.eventId !== intent.event.id)
      throw Error("watch_native_dispatch_required");
    return claim;
  };
  const identity = (intent: BrowserWatchDispatch) => {
    if (intent.action.kind !== "harness") throw Error("watch_action_unsupported");
    if (intent.event.owner !== owner || !Number.isSafeInteger(intent.generation) || intent.generation < 1 ||
      intent.operationId !== `watch:${intent.watchId}:${intent.generation}:${channelDigest([owner, intent.event.id, intent.action])}`)
      throw Error("watch_harness_operation_mismatch");
    return intent.action;
  };
  const authorize = async (intent: BrowserWatchDispatch, signal: AbortSignal, operation: "execute" | "reconcile" = "execute") => {
    identity(intent); signal.throwIfAborted();
    if (!await binding.current(structuredClone(intent), signal, operation)) throw Error("watch_harness_authority_unavailable");
    signal.throwIfAborted();
  };
  const exactRun = async (intent: BrowserWatchDispatch, events: readonly Event[]) => {
    const action = identity(intent), run = runOf(events, intent.operationId);
    const claim = watchClaim(intent, events);
    if (!run) return undefined;
    if (events.indexOf(run) <= events.indexOf(claim) || run.harnessDigest !== action.digest || run.caseId !== null || run.receiptOf !== undefined)
      throw Error("watch_harness_operation_conflict");
    const input = await library.binding.blobs.get(owner, run.inputRef as `sha256:${string}`) as HarnessJson;
    if (intent.input !== undefined && harnessDigest(input) !== harnessDigest(intent.input)) throw Error("watch_harness_input_conflict");
    return { run, input };
  };
  const terminal = (intent: BrowserWatchDispatch, events: readonly Event[], id = intent.operationId): Result | undefined => {
    const action = identity(intent), witness = harnessLibraryState(events, owner).witnesses.get(id);
    if (!witness) return undefined;
    if (witness.harnessDigest !== action.digest || witness.contractDigest !== action.contractDigest || witness.operationId !== id)
      throw Error("watch_harness_receipt_conflict");
    return { status: witness.status === "satisfied" ? "completed" : witness.status === "unknown" ? "unknown" : "failed",
      result: { operationId: intent.operationId, receiptOperationId: id, witness: structuredClone(witness) } };
  };
  const eligible = async (intent: BrowserWatchDispatch, signal: AbortSignal) => {
    await authorize(intent, signal);
    const action = identity(intent), { artifact, contract } = await library.resolve(action.digest);
    if (artifact.contractDigest !== action.contractDigest) throw Error("watch_contract_pin_mismatch");
    if (intent.input === undefined || !library.inputValid(contract.inputSchema, intent.input)) throw Error("watch_input_schema_mismatch");
    const context = await library.binding.context(signal), contextDigest = harnessDigest(context);
    const evaluated = [...harnessLibraryState(await library.journal.read(), owner).evaluations.values()].some(e =>
      e.eligible === true && e.harnessDigest === action.digest && e.contractDigest === action.contractDigest && e.contextDigest === contextDigest);
    if (!evaluated) throw Error("watch_harness_current_evaluation_required");
    await authorize(intent, signal);
    return { action, artifact, contract, context, contextDigest };
  };
  const guarded = (intent: BrowserWatchDispatch, operation: "execute" | "reconcile" = "execute") => new HarnessLibrary({ ...library.binding,
    authorize: async (artifact, contract, context, input, signal) => {
      await authorize(intent, signal, operation);
      return library.binding.authorize(artifact, contract, context, input, signal);
    },
    execute: async (job, signal) => {
      // Native admission can await durable custody. Close that authority gap
      // before invoking the existing executor, while failure is still definite.
      try {
        const ready = await eligible(intent, signal);
        if (ready.contextDigest !== harnessDigest(job.context) || !await library.binding.authorize(job.artifact, job.contract, job.context, job.input, signal))
          return { status: "failed", evidence: ["watch_harness_authority_changed_before_dispatch"] };
        await authorize(intent, signal);
      } catch { return { status: "failed", evidence: ["watch_harness_authority_unavailable_before_dispatch"] }; }
      return library.binding.execute(job, signal);
    },
    ...(library.binding.reconcile ? { reconcile: async (job: Parameters<NonNullable<typeof library.binding.reconcile>>[0], signal: AbortSignal): Promise<HarnessExecution> => {
      await authorize(intent, signal, "reconcile");
      if (harnessDigest(await library.binding.context(signal)) !== harnessDigest(job.context) ||
        !await library.binding.authorize(job.artifact, job.contract, job.context, job.input, signal))
        return { status: "unknown", evidence: ["watch_harness_receipt_authority_changed"] };
      await authorize(intent, signal, "reconcile");
      return library.binding.reconcile!(job, signal);
    } } : {}),
  }, library.journal);
  const execute: BrowserWatchBindings["execute"] = async (raw, signal) => {
    const intent = structuredClone(raw);
    try {
      identity(intent);
      const events = await library.journal.read(), existing = await exactRun(intent, events);
      await authorize(intent, signal);
      if (existing) return terminal(intent, events) ?? uncertain("watch_harness_execution_unconfirmed");
      const ready = await eligible(intent, signal);
      await guarded(intent).run(ready.action.digest, intent.input!, intent.operationId, signal, { expectedContext: ready.contextDigest });
      return terminal(intent, await library.journal.read()) ?? uncertain("watch_harness_receipt_unavailable");
    } catch {
      // A lost custody acknowledgement may follow a real execution. Read the
      // durable claim before classifying; an unreadable journal is uncertain.
      try {
        const events = await library.journal.read();
        if (runOf(events, intent.operationId)) return uncertain("watch_harness_execution_unconfirmed");
        return rejected(intent.action.kind === "harness" ? "watch_harness_dispatch_unavailable" : "watch_action_unsupported");
      } catch { return uncertain("watch_harness_journal_unavailable"); }
    }
  };
  const reconcile: NonNullable<BrowserWatchBindings["reconcile"]> = async (raw, signal) => {
    const intent = structuredClone(raw);
    try {
      await authorize(intent, signal, "reconcile");
      let events = await library.journal.read();
      const existing = await exactRun(intent, events);
      if (!existing) return uncertain("watch_harness_receipt_unavailable");
      const receipt = terminal(intent, events);
      if (receipt && receipt.status !== "unknown") return receipt;
      const priorChecks = owned(events).filter(e => e.type === "AikoHarnessRunStarted" && e.receiptOf === intent.operationId &&
        e.harnessDigest === existing.run.harnessDigest && e.inputRef === existing.run.inputRef && e.contextDigest === existing.run.contextDigest && e.caseId === null);
      for (const check of priorChecks) {
        const confirmed = terminal(intent, events, String(check.id));
        if (confirmed?.status === "completed") return confirmed;
      }
      // Crash recovery reads already retained receipts. Only an explicit named
      // receipt check can invoke the existing provider's read-only reconciler.
      if (!intent.reconciliationRequestId || !library.binding.reconcile) return receipt ?? uncertain("watch_harness_execution_unconfirmed");
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(intent.reconciliationRequestId)) return uncertain("watch_harness_reconciliation_identity_invalid");
      intent.input = existing.input;
      const action = identity(intent), { artifact } = await library.resolve(action.digest);
      if (artifact.contractDigest !== action.contractDigest) throw Error("watch_contract_pin_mismatch");
      const id = browserWatchReceiptOperationId(owner, intent.operationId, intent.reconciliationRequestId);
      const checks = owned(events).filter(e => e.type === "AikoHarnessRunStarted" && e.receiptOf === intent.operationId);
      if (checks.length >= 7 && !checks.some(e => e.id === id)) return uncertain("watch_harness_reconciliation_budget_exhausted");
      await guarded(intent, "reconcile").run(action.digest, existing.input, id, signal, { receiptOf: intent.operationId, reconciliationCallId: intent.reconciliationRequestId });
      events = await library.journal.read();
      const checked = terminal(intent, events, id);
      return checked?.status === "completed" ? checked : uncertain("watch_harness_receipt_unconfirmed");
    } catch { return uncertain("watch_harness_reconciliation_unavailable"); }
  };
  return { execute, reconcile };
}
