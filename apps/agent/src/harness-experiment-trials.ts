import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect, type ExternalEffect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { Router } from "tardie/core/communication/router";
import { envelopeOf, linkedEventOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { childCreated, childLineageOf, threadCreatedOf } from "tardie/core/thread";
import type { Event } from "tardie/core/event";
import {
  HarnessLibrary, harnessDigest, harnessLibraryEventKey, harnessLibraryState,
  type HarnessContext, type HarnessDigest, type HarnessJournal, type HarnessLibraryBinding, type HarnessWitness,
} from "./harness-library.ts";
import { createHarnessSandboxBinding, type HarnessSandboxOptions } from "./harness-sandbox.ts";

/** One immutable trial owns one child thread. Trial identity deliberately agrees
 * with HarnessExperiment's existing reservation/execution operation identity. */
export interface HarnessExperimentTrialRequest {
  experimentId: string;
  harnessDigest: HarnessDigest;
  phase: "development" | "held-out";
  caseId: string;
  repeat: number;
  operationId: string;
  contextDigest: HarnessDigest;
  deadlineAt: number;
}
export interface HarnessExperimentTrialScope extends HarnessExperimentTrialRequest {
  owner: string;
  parentThread: string;
  childThread: string;
  contractDigest: HarnessDigest;
  verifierDigest: HarnessDigest;
  evaluatorDigest: HarnessDigest;
  datasetDigest: HarnessDigest;
}
interface Brief extends HarnessExperimentTrialScope { context: HarnessContext }
export interface HarnessExperimentTrialsOptions {
  binding: HarnessLibraryBinding;
  journal: HarnessJournal;
  /** Trusted current experiment/reservation policy. Must check cancellation,
   * generation, regime and the original absolute deadline, not source claims. */
  authorize(scope: HarnessExperimentTrialScope, signal: AbortSignal): Promise<boolean>;
  /** Existing account host read, scoped to this owner's root and admitted children. */
  readThread(thread: string): Promise<readonly Event[]>;
  /** Host-owned transport/current authority; the adapter always sets owner/thread
   * itself. Never reuse a root-thread execute closure for a child trial. */
  sandbox(scope: HarnessExperimentTrialScope, signal: AbortSignal): Promise<Omit<HarnessSandboxOptions, "owner" | "thread">>;
}
export type HarnessExperimentTrialResult =
  | { status: "pending" | "unknown" | "unavailable"; childThread: string }
  | { status: "checked"; childThread: string; witness: HarnessWitness; witnessRef: HarnessDigest };

const prefix = "aiko-harness-trial:";
const kinds = new Set(["Requested", "Dispatched", "Work", "Executed", "Returned", "Sent", "Joined", "Unavailable", "Cancelled", "CancelSent"].map(k => `AikoHarnessTrial${k}`));
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const harnessExperimentTrialOperation = (r: Pick<HarnessExperimentTrialRequest, "experimentId" | "harnessDigest" | "phase" | "caseId" | "repeat">) =>
  `experiment:${harnessDigest([r.experimentId, r.harnessDigest, r.phase, r.caseId, r.repeat]).slice(7)}`;
export const harnessExperimentTrialThread = (owner: string, parent: string, operation: string) =>
  `harness-trial-${harnessDigest([owner, parent, operation]).slice(7)}`;
export const harnessExperimentTrialIsChild = (thread: string) => /^harness-trial-[a-f0-9]{64}$/.test(thread);
export const harnessExperimentTrialEventKey = (e: Event) => kinds.has(e.type) && typeof e.owner === "string" && typeof e.id === "string"
  ? `${prefix}${e.owner}:${e.type}:${e.id}${["AikoHarnessTrialWork", "AikoHarnessTrialReturned", "AikoHarnessTrialCancelled"].includes(e.type) ? `:${harnessDigest([e.link ?? null, e.experimentId ?? null, e.briefRef ?? null, e.childThread ?? null, e.deadlineAt ?? null])}` : ""}` : undefined;
/** These are trusted internal facts. Public ingress and generated tools cannot
 * mint Work, Returned, Joined or the underlying HarnessChecked events. */
export const harnessExperimentTrialExternalEventAllowed = (e: Event) => !kinds.has(e.type);
const find = (rows: readonly Event[], owner: string, kind: string, id: unknown) => rows.find(e => e.owner === owner && e.type === `AikoHarnessTrial${kind}` && e.id === id);
const fact = (owner: string, kind: string, id: string, fields: Record<string, unknown> = {}): Event => ({ type: `AikoHarnessTrial${kind}`, owner, id, at: 0, ...fields });
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && harnessDigest(a) === harnessDigest(b);
const routed = (e: Event, source: string, target: string) => {
  const link = e.link as any;
  return link?.source?.actor === "aiko" && link.target?.actor === "aiko" && link.source.instance === link.target.instance &&
    link.source.thread === source && link.target.thread === target;
};
const nativeJournal = (log: EventLog["Service"]): HarnessJournal => ({ read: () => Effect.runPromise(log.read), append: async rows => { await Effect.runPromise(log.append(rows)); } });
const denied = () => Error("harness_trial_scope_unavailable");
const stops = (scope: {owner: unknown; experimentId: unknown; deadlineAt: unknown} | Event, e: Event) =>
  e.owner === scope.owner && e.experimentId === scope.experimentId &&
    (["AikoHarnessExperimentCancelled", "AikoHarnessExperimentSettled"].includes(e.type) ||
      e.type === "AikoHarnessExperimentProposalSettled" && e.status === "no-hypothesis") ||
  e.type === "AlarmFired" && Number.isFinite(Number(scope.deadlineAt)) && Number(e.at) >= Number(scope.deadlineAt);
const cancels = (work: Event, e: Event) => e.type === "AikoHarnessTrialCancelled" &&
  ["owner", "id", "experimentId", "briefRef", "childThread", "deadlineAt"].every(k => e[k] === work[k]) && same(e.link, work.link);

export interface HarnessExperimentTrialLifecycleOptions {
  owner: string;
  parentThread: string;
  /** Trusted current same-owner account-host root read. No library, execution
   * grant or private custody is required to inspect admitted lifecycle facts. */
  readParent(): Promise<readonly Event[]>;
}
const trialEvent = (owner: string, kind: string, row: Event, fields: Record<string, unknown> = {}) =>
  fact(owner, kind, String(row.id), { experimentId: row.experimentId, childThread: row.childThread,
    briefRef: row.briefRef, deadlineAt: row.deadlineAt, ...fields });
const matchesRequest = (a: Event, b: Event) =>
  ["owner", "id", "experimentId", "briefRef", "childThread", "deadlineAt"].every(k => a[k] === b[k]);
const trialRouting = (options: HarnessExperimentTrialLifecycleOptions, row: Event) => {
  if (row.owner !== options.owner || typeof row.id !== "string" || !identity.test(row.id) || !identity.test(String(row.experimentId)) ||
    row.childThread !== harnessExperimentTrialThread(options.owner, options.parentThread, row.id) ||
    !digestPattern.test(String(row.briefRef)) || !Number.isSafeInteger(row.deadlineAt)) throw denied();
};
type TrialEffect = ExternalEffect<never, Router | Self>;
const trialParentComponent = (options: HarnessExperimentTrialLifecycleOptions,
  advance?: (requested: Event, returned: Event | undefined) => TrialEffect[]) => {
  const { owner, parentThread } = options;
  return component({ name: "aiko.harness-experiment-trials", keys: { prefixes: [prefix], keyOf: harnessExperimentTrialEventKey },
    initial: () => [] as Event[], step: (rows, e) => [...rows, e], output: rows => ({ view: undefined,
      transitions: rows.filter(e => e.type === "AikoHarnessTrialRequested" && e.owner === owner && !find(rows, owner, "Joined", e.id)).flatMap(requested => {
        if (rows.some(e => stops(requested, e))) {
          if (find(rows, owner, "CancelSent", requested.id)) return [];
          return [effect({ key: `${prefix}cancel:${requested.id}`, input: requested, act: row => Effect.gen(function* () {
            const log = yield* EventLog, self = yield* Self;
            if (self.actor !== "aiko" || self.thread !== parentThread) throw denied();
            trialRouting(options, row);
            const latest = yield* log.read, retained = find(latest, owner, "Requested", row.id);
            if (!retained || !matchesRequest(retained, row) || !latest.some(e => stops(row, e))) return [];
            const created = threadCreatedOf(latest), target = { ...self, thread: String(row.childThread) };
            const claim = latest.find(e => e.type === "ChildCreated" && e.callId === row.id && same(e.address, target));
            // Cancellation may deliver to an admitted edge before its Work,
            // but never creates a new ChildCreated edge or execution authority.
            if (claim) {
              if (!created || !same(created.address, self) || claim.depth !== created.depth + 1) throw denied();
              const router = yield* Router;
              const envelope = envelopeOf(linkOf(self, target), trialEvent(owner, "Cancelled", row, { reason: "experiment-stopped" }), childLineageOf(created, "colocated"));
              yield* router.send({ ...envelope, event: linkedEventOf(envelope) });
            }
            return [trialEvent(owner, "CancelSent", row, { status: claim ? "admitted" : "not-dispatched" }),
              trialEvent(owner, "Unavailable", row, { reason: "experiment-stopped", joinedLatencyMs: null })];
          }) })];
        }
        if (!advance || find(rows, owner, "Unavailable", requested.id)) return [];
        const returned = rows.find(e => e.type === "AikoHarnessTrialReturned" && matchesRequest(e, requested) &&
          routed(e, String(requested.childThread), parentThread));
        if (!returned && find(rows, owner, "Dispatched", requested.id)) return [];
        return advance(requested, returned);
      }) }) });
};
type TrialExecute = (row: Event, interruption: AbortSignal) => Effect.Effect<Event[], never, EventLog | Self>;
const trialWorker = (options: HarnessExperimentTrialLifecycleOptions, execute?: TrialExecute) => {
  const { owner, parentThread } = options;
  return component({ name: "aiko.harness-experiment-trial-worker",
    keys: { prefixes: [prefix, "aiko-harness:"], keyOf: e => harnessExperimentTrialEventKey(e) ?? harnessLibraryEventKey(e) },
    initial: () => [] as Event[], step: (rows, e) => [...rows, e], output: rows => {
      const addressed = (e: Event) => e.owner === owner && typeof e.id === "string" &&
        e.childThread === harnessExperimentTrialThread(owner, parentThread, e.id) && routed(e, parentThread, String(e.childThread));
      const work = rows.find(e => e.type === "AikoHarnessTrialWork" && addressed(e)) ?? rows.find(e => e.type === "AikoHarnessTrialCancelled" && addressed(e));
      if (!work || find(rows, owner, "Sent", work.id)) return { view: undefined, transitions: [] };
      const executed = find(rows, owner, "Executed", work.id), cancelled = rows.some(e => cancels(work, e));
      if (!executed && !cancelled && !execute) return { view: undefined, transitions: [] };
      return { view: undefined, transitions: [effect({ key: `${prefix}${executed ? "return" : cancelled ? "cancel-execute" : "execute"}:${work.id}`, input: work,
        interrupts: (row, event) => cancels(row, event),
        act: (row, interruption) => Effect.gen(function* () {
          const log = yield* EventLog, self = yield* Self, created = threadCreatedOf(yield* log.read), parent = created?.parent;
          const link = row.link as any;
          if (!parent || self.actor !== "aiko" || parent.thread !== parentThread || self.thread !== row.childThread ||
            !same(created?.address, self) || !same(link?.source, parent) || !same(link?.target, self)) throw denied();
          trialRouting(options, row);
          const parentRows = yield* Effect.promise(options.readParent), requested = find(parentRows, owner, "Requested", row.id);
          const root = threadCreatedOf(parentRows);
          const claim = parentRows.find(e => e.type === "ChildCreated" && e.callId === row.id && same(e.address, self));
          if (!requested || !matchesRequest(requested, row) || !root || !same(root.address, parent) ||
            !claim || claim.depth !== created!.depth || created!.depth !== root.depth + 1) throw denied();
          if (executed) {
            if (!matchesRequest(executed, row) || !["checked", "unknown", "unavailable"].includes(String(executed.status)) ||
              executed.status === "checked" && !digestPattern.test(String(executed.witnessRef))) throw denied();
            const router = yield* Router;
            const envelope = envelopeOf(linkOf(self, parent), trialEvent(owner, "Returned", row, {
              status: executed.status, ...(executed.witnessRef ? { witnessRef: executed.witnessRef } : {}),
            }));
            yield* router.send({ ...envelope, event: linkedEventOf(envelope) });
            return [trialEvent(owner, "Sent", row)];
          }
          if (cancelled) {
            if (!parentRows.some(e => stops(row, e))) throw denied();
            const latest = yield* log.read;
            const started = latest.some(e => e.type === "AikoHarnessRunStarted" && e.owner === owner && e.id === row.id);
            return [trialEvent(owner, "Executed", row, { status: started ? "unknown" : "unavailable", cancelled: true })];
          }
          return execute ? yield* execute(row, interruption) : [];
        }) })] };
    } });
};

/** Keep admitted cleanup mounted when execution bindings disappear. These same
 * projections back the full adapter; this factory supplies no execution path. */
export function harnessExperimentTrialLifecycle(options: HarnessExperimentTrialLifecycleOptions) {
  if (!options.owner || options.parentThread !== `user-${options.owner}` || typeof options.readParent !== "function") throw denied();
  return { component: () => trialParentComponent(options), worker: () => trialWorker(options) };
}

/** Retain trial requests without driving another scheduler. Mount component()
 * on the experiment root and worker() on admitted trial children in the existing
 * account host; its Router, EventLog and native effects own all progress. */
export class HarnessExperimentTrials {
  readonly library: HarnessLibrary;
  constructor(readonly options: HarnessExperimentTrialsOptions) {
    if (options.binding.thread !== `user-${options.binding.owner}`) throw denied();
    this.library = new HarnessLibrary(options.binding, options.journal);
  }
  private get owner() { return this.options.binding.owner; }
  private get lifecycle(): HarnessExperimentTrialLifecycleOptions {
    return { owner: this.owner, parentThread: this.options.binding.thread, readParent: this.options.journal.read };
  }
  private event(kind: string, row: Event, fields: Record<string, unknown> = {}) {
    return trialEvent(this.owner, kind, row, fields);
  }
  private async current(brief: Brief, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await this.options.journal.read()).some(e => stops(brief, e))) throw denied();
    if (brief.owner !== this.owner || brief.parentThread !== this.options.binding.thread ||
      brief.operationId !== harnessExperimentTrialOperation(brief) ||
      brief.childThread !== harnessExperimentTrialThread(this.owner, brief.parentThread, brief.operationId) ||
      !Number.isSafeInteger(brief.deadlineAt) || brief.deadlineAt <= Date.now() ||
      harnessDigest(brief.context) !== brief.contextDigest || !await this.options.authorize(brief, signal)) throw denied();
    const resolved = await this.library.resolve(brief.harnessDigest);
    const fixture = resolved.verifier.cases.find(c => c.id === brief.caseId && c.split === brief.phase);
    if (!fixture || resolved.artifact.contractDigest !== brief.contractDigest || resolved.verifier.digest !== brief.verifierDigest ||
      resolved.verifier.evaluatorDigest !== brief.evaluatorDigest || harnessDigest(resolved.verifier.cases) !== brief.datasetDigest ||
      harnessDigest(await this.options.binding.context(signal)) !== brief.contextDigest ||
      !await this.options.binding.authorize(resolved.artifact, resolved.contract, brief.context, fixture.input, signal) ||
      (this.options.binding.authorizeEvaluation ? !await this.options.binding.authorizeEvaluation(resolved.artifact, resolved.contract, brief.context, fixture, signal) : resolved.contract.effect !== "read")) throw denied();
    signal.throwIfAborted();
    if ((await this.options.journal.read()).some(e => stops(brief, e))) throw denied();
    return { ...resolved, fixture };
  }
  private async open(row: Event, signal: AbortSignal) {
    if (row.owner !== this.owner || typeof row.id !== "string" || !digestPattern.test(String(row.briefRef))) throw denied();
    const brief = await this.options.binding.blobs.get(this.owner, row.briefRef as HarnessDigest) as Brief;
    if (brief.operationId !== row.id || brief.childThread !== row.childThread || brief.experimentId !== row.experimentId) throw denied();
    const requested = find(await this.options.journal.read(), this.owner, "Requested", row.id);
    if (!requested || requested.briefRef !== row.briefRef || requested.childThread !== row.childThread) throw denied();
    const resolved = await this.current(brief, signal);
    return { brief, ...resolved };
  }
  async request(raw: HarnessExperimentTrialRequest, signal: AbortSignal): Promise<HarnessExperimentTrialResult> {
    const request = structuredClone(raw);
    if (!identity.test(request.experimentId) || !identity.test(request.caseId) || !digestPattern.test(request.harnessDigest) ||
      !digestPattern.test(request.contextDigest) || !["development", "held-out"].includes(request.phase) ||
      !Number.isSafeInteger(request.repeat) || request.repeat < 0 || request.repeat > 7 ||
      request.operationId !== harnessExperimentTrialOperation(request)) throw denied();
    const prior = find(await this.options.journal.read(), this.owner, "Requested", request.operationId);
    if (prior) {
      const { brief } = await this.open(prior, signal);
      if (Object.entries(request).some(([key, value]) => !same(value, brief[key as keyof Brief]))) throw Error("harness_trial_identity_conflict");
      return this.result(request.operationId, signal);
    }
    const resolved = await this.library.resolve(request.harnessDigest);
    const brief: Brief = { ...request, owner: this.owner, parentThread: this.options.binding.thread,
      childThread: harnessExperimentTrialThread(this.owner, this.options.binding.thread, request.operationId),
      contractDigest: resolved.artifact.contractDigest, verifierDigest: resolved.verifier.digest,
      evaluatorDigest: resolved.verifier.evaluatorDigest, datasetDigest: harnessDigest(resolved.verifier.cases),
      context: await this.options.binding.context(signal) };
    await this.current(brief, signal);
    const briefRef = await this.options.binding.blobs.putPrivate(this.owner, brief);
    await this.options.journal.append([fact(this.owner, "Requested", request.operationId, { experimentId: brief.experimentId, briefRef, childThread: brief.childThread, deadlineAt: brief.deadlineAt })]);
    const retained = find(await this.options.journal.read(), this.owner, "Requested", request.operationId);
    if (retained?.briefRef !== briefRef) throw Error("harness_trial_identity_conflict");
    return this.result(request.operationId, signal);
  }
  async result(operationId: string, signal: AbortSignal): Promise<HarnessExperimentTrialResult> {
    const rows = await this.options.journal.read(), requested = find(rows, this.owner, "Requested", operationId);
    if (!requested) throw denied();
    const { brief } = await this.open(requested, signal);
    const joined = find(rows, this.owner, "Joined", operationId);
    if (!joined) return { status: find(rows, this.owner, "Unavailable", operationId) ? "unavailable" : "pending", childThread: brief.childThread };
    if (joined.status !== "checked") return { status: joined.status === "unknown" ? "unknown" : "unavailable", childThread: brief.childThread };
    const witness = await this.checked(brief, joined.witnessRef as HarnessDigest, signal);
    return { status: "checked", childThread: brief.childThread, witness, witnessRef: joined.witnessRef as HarnessDigest };
  }
  private async checked(brief: Brief, witnessRef: HarnessDigest, signal: AbortSignal): Promise<HarnessWitness> {
    const { fixture } = await this.current(brief, signal);
    const rows = await this.options.readThread(brief.childThread), created = threadCreatedOf(rows);
    if (created?.parent?.thread !== brief.parentThread || created.address.thread !== brief.childThread || created.parent.actor !== created.address.actor || created.parent.instance !== created.address.instance) throw denied();
    const work = find(rows, this.owner, "Work", brief.operationId);
    const requested = find(await this.options.journal.read(), this.owner, "Requested", brief.operationId);
    const checked = rows.find(e => e.type === "AikoHarnessChecked" && e.owner === this.owner && e.id === brief.operationId);
    const started = rows.find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.owner && e.id === brief.operationId);
    const witness = harnessLibraryState(rows, this.owner).witnesses.get(brief.operationId);
    if (!work || work.briefRef !== requested?.briefRef || !checked || !started || !witness ||
      started.harnessDigest !== brief.harnessDigest || started.caseId !== brief.caseId || started.contextDigest !== brief.contextDigest ||
      !same(await this.options.binding.blobs.get(this.owner, started.inputRef as HarnessDigest), fixture.input) ||
      witness.operationId !== brief.operationId || witness.harnessDigest !== brief.harnessDigest || witness.contractDigest !== brief.contractDigest ||
      witness.contextDigest !== brief.contextDigest || witness.verifierDigest !== brief.verifierDigest || witness.evaluatorDigest !== brief.evaluatorDigest ||
      !same(await this.options.binding.blobs.get(this.owner, witnessRef), witness)) throw denied();
    if (witness.outputRef) await this.options.binding.blobs.get(this.owner, witness.outputRef);
    await this.current(brief, signal);
    return structuredClone(witness);
  }
  component() {
    const adapter = this, owner = this.owner;
    return trialParentComponent(this.lifecycle, (requested, returned) => {
          return [effect({ key: `${prefix}${returned ? "join" : "dispatch"}:${requested.id}`, input: requested,
            interrupts: (row, event) => stops(row, event),
            act: (row, interruption) => Effect.gen(function* () {
              const log = yield* EventLog, self = yield* Self;
              if (self.actor !== "aiko" || self.thread !== adapter.options.binding.thread) throw denied();
              const signal = AbortSignal.any([interruption, AbortSignal.timeout(Math.max(1, Number(row.deadlineAt) - Date.now()))]);
              const opened = yield* Effect.promise(() => adapter.open(row, signal).catch(() => undefined));
              if (!opened) return [adapter.event("Unavailable", row, { reason: "scope_or_private_data_unavailable", joinedLatencyMs: null })];
              const { brief } = opened;
              if (returned) {
                let witnessDigest: HarnessDigest | undefined, inputRef: HarnessDigest | undefined;
                const confirmed = yield* Effect.promise(async () => { try {
                  const link = returned.link as any;
                  if (link?.source?.thread !== brief.childThread || link.source.actor !== self.actor || link.source.instance !== self.instance ||
                    !same(link.target, self) || returned.experimentId !== brief.experimentId || returned.briefRef !== row.briefRef || returned.childThread !== brief.childThread) throw denied();
                  const childRows = await adapter.options.readThread(brief.childThread);
                  signal.throwIfAborted();
                  const executed = find(childRows, owner, "Executed", brief.operationId);
                  if (!executed || executed.briefRef !== row.briefRef || executed.status !== returned.status || executed.witnessRef !== returned.witnessRef) throw denied();
                  if (returned.status === "checked") {
                    witnessDigest = harnessDigest(await adapter.checked(brief, returned.witnessRef as HarnessDigest, signal));
                    const started = childRows.find(e => e.type === "AikoHarnessRunStarted" && e.owner === owner && e.id === brief.operationId);
                    if (!started || !digestPattern.test(String(started.inputRef))) throw denied();
                    inputRef = started.inputRef as HarnessDigest;
                  }
                  else if (!["unknown", "unavailable"].includes(String(returned.status))) throw denied();
                  return true;
                } catch { return false; } });
                return confirmed ? [adapter.event("Joined", row, { status: returned.status, joinedLatencyMs: null,
                  ...(witnessDigest ? { witnessDigest, inputRef } : {}),
                  ...(returned.witnessRef ? { witnessRef: returned.witnessRef } : {}) })]
                  : [adapter.event("Unavailable", row, { reason: "child_receipt_unconfirmed", joinedLatencyMs: null })];
              }
              const router = yield* Router, created = threadCreatedOf(yield* log.read);
              if (!created) throw denied();
              const target = { ...self, thread: brief.childThread }, lineage = childLineageOf(created, "colocated");
              signal.throwIfAborted();
              yield* log.append([childCreated(brief.operationId, target, lineage, Date.now())]);
              signal.throwIfAborted();
              const envelope = envelopeOf(linkOf(self, target), adapter.event("Work", row), lineage);
              // The account host normalizes this link from the Router envelope.
              yield* router.send({ ...envelope, event: linkedEventOf(envelope) });
              return [adapter.event("Dispatched", row)];
            }) })];
    });
  }
  worker() {
    const adapter = this, owner = this.owner;
    return trialWorker(this.lifecycle, (row, interruption) => Effect.gen(function* () {
            const log = yield* EventLog, self = yield* Self;
            const deadline = AbortSignal.any([interruption, AbortSignal.timeout(Math.max(1, Number(row.deadlineAt) - Date.now()))]);
            let status: "checked" | "unknown" | "unavailable" = "unavailable", witnessRef: HarnessDigest | undefined;
            yield* Effect.promise(async nativeSignal => { const signal = AbortSignal.any([deadline, nativeSignal]); try {
              const { brief, artifact, contract, fixture } = await adapter.open(row, signal);
              const sandbox = await adapter.options.sandbox(brief, signal);
              const bridge = createHarnessSandboxBinding({ ...sandbox, owner, thread: self.thread });
              const childBinding: HarnessLibraryBinding = { ...adapter.options.binding, ...bridge, thread: self.thread,
                authorize: async (...args) => { await adapter.current(brief, args[4]); return bridge.authorize(...args); },
                execute: async (...args) => { await adapter.current(brief, args[1]); return bridge.execute(...args); } };
              const journal = nativeJournal(log), library = new HarnessLibrary(childBinding, journal);
              await library.registerContract(contract); await library.record(artifact);
              await library.run(brief.harnessDigest, fixture.input, brief.operationId, signal, { caseId: brief.caseId, expectedContext: brief.contextDigest });
              const retained = harnessLibraryState(await journal.read(), owner).witnesses.get(brief.operationId);
              status = retained ? "checked" : "unknown";
              if (retained) witnessRef = await adapter.options.binding.blobs.putPrivate(owner, retained);
            } catch {
              // A durable start without a checked receipt may already have
              // executed. Never relabel that uncertainty as safe to retry.
              if ((await Effect.runPromise(log.read)).some(e => e.type === "AikoHarnessRunStarted" && e.owner === owner && e.id === row.id)) status = "unknown";
            } });
            return [adapter.event("Executed", row, { status, ...(witnessRef ? { witnessRef } : {}) })];
    }));
  }
}
