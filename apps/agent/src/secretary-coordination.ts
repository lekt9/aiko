import { Effect, Schema } from "effect";
import { workDecisionLanguage } from "../../../packages/protocol/src/secretary-language.ts";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { intent } from "tardie/core/intent";
import { actorMethod } from "tardie/core/method/method";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { openMemory } from "./memory.ts";
import { CONTRIBUTION_POLICY } from "./proactive-policy.ts";
import { harnessDigest } from "./harness-library.ts";
import {
  contactForWork,
  workAdmission,
  type SecretaryWorkBinding,
} from "./secretary-policy.ts";
import {
  agendaItems,
  executionId,
  planDigest,
  saveWork,
  workActive,
  workDigest,
  workEvent,
  workEventKey,
  workEvaluationFailure,
  workRecoveryAt,
  workNoticeCurrent,
  readyWorkNotice,
  workState,
  workTerminal,
  type Commitment,
  type WorkReceipt,
} from "./commitments.ts";

export const workWaitMethod = actorMethod({
  input: Schema.Struct({ workId: Schema.String, version: Schema.Number }),
  output: Schema.String,
  event: (call) => ({
    type: "AikoWorkDeadline",
    id: call.invocation.id,
    workId: call.input.workId,
    version: call.input.version,
    at: call.at,
    call: { invocation: call.invocation, deadlineAt: call.deadlineAt },
  }),
  projection: {
    initial: () => [] as Event[],
    step: (rows: Event[], e: Event) => [...rows, e],
    output: (rows) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const index = rows.findIndex(
          (e) =>
            e.type === "AikoWorkDeadline" &&
            (e.call as any)?.invocation.id === invocation.id,
        );
        const deadline = rows[index];
        if (!deadline) return undefined;
        const work = workState(rows, String(deadline.owner)).commitments.get(
          String(deadline.workId),
        );
        const changed =
          !work ||
          work.version !== deadline.version ||
          workTerminal(work) ||
          work.control === "paused" ||
          work.handling === "owner";
        return changed ||
          rows
            .slice(index + 1)
            .some(
              (e) =>
                (e.type === "AlarmFired" &&
                  Number(e.at) >= Number((deadline.call as any).deadlineAt)) ||
                (deadline.recoveryVersion !== 1 && (e.type === "AikoWorkContactObserved" ||
                e.type === "AikoWorkContactHandling")),
            )
          ? { status: "completed" as const, output: "recheck" }
          : { status: "pending" as const };
      },
    }),
  },
});

function nextWake(w: Commitment): number | undefined {
  if (workTerminal(w) || w.control === "paused" || w.handling === "owner")
    return;
  if (w.decision?.status === "pending") return w.decision.expiresAt;
  if (w.status !== "candidate") return w.nextReviewAt;
}

export function reviewWork(
  w: Commitment,
  reason: string,
  now: number,
): Commitment {
  const decisionId =
    w.id +
    ":review:" +
    workDigest([reason, w.nextReviewAt ?? w.dueAt]).slice(0, 16);
  if (w.decision?.id === decisionId) return w;
  return {
    ...w,
    version: w.version + 1,
    updatedAt: now,
    status: "waiting",
    waitingFor: w.accountableParty,
    nextAction: reason,
    actionAssignee: "You",
    nextReviewAt: Math.max(now + 3600000, w.dueAt ?? 0),
    decision: {
      id: decisionId,
      kind: "review",
      issue: reason,
      recommendation:
        "Review the evidence, take over, or choose a later follow-up. No additional message is authorized by silence.",
      neededBy: Math.max(
        now,
        Math.min(w.plan?.escalateAt ?? w.dueAt ?? now, w.dueAt ?? now),
      ),
      expiresAt: Math.max(now + 3600000, w.dueAt ?? 0),
      status: "pending",
      planDigest: planDigest(w),
      fallback: "keep_waiting",
    },
  };
}

async function dispatch(
  binding: SecretaryWorkBinding,
  w: Commitment,
  action: WorkReceipt["action"],
  signal: AbortSignal,
) {
  const now = binding.now?.() ?? Date.now(),
    id = executionId(w, action);
  const check = await workAdmission(binding, w, now);
  if (check.reason || !check.contact)
    return check.reason ?? "Contact is unavailable";
  const connection = await binding
    .telegram!.resolve(w.plan!.connectionId, signal)
    .catch(() => undefined);
  if (
    !connection?.enabled ||
    !connection.canReply ||
    connection.owner !== binding.owner
  )
    return "Telegram reply permission is unavailable";
  const current = await workAdmission(
    binding,
    w,
    binding.now?.() ?? Date.now(),
  );
  if (current.reason || !current.contact?.incoming)
    return current.reason ?? "The incoming message is unavailable";
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const receipt: WorkReceipt = {
    id,
    owner: binding.owner,
    workId: w.id,
    action,
    planDigest: planDigest(w),
    token,
    status: "started",
    at: now,
    afterMessageId: current.contact.incoming.messageId,
  };
  await binding.append([
    workEvent(
      "AikoWorkDispatch",
      { owner: binding.owner, id, workVersion: w.version, receipt },
      now,
    ),
  ]);
  if (
    workState(await binding.read(), binding.owner).receipts.get(id)?.token !==
    token
  )
    return "Another execution already claimed this action";
  // Admission is repeated after the durable claim; a change here is a known no-send.
  const final = await workAdmission(binding, w, binding.now?.() ?? Date.now());
  if (final.reason || signal.aborted) {
    await binding.append([
      workEvent("AikoWorkDelivery", {
        owner: binding.owner,
        id,
        token,
        status: "blocked",
        reason: final.reason ?? "Cancelled before sending",
      }),
    ]);
    return final.reason ?? "Cancelled before sending";
  }
  const result = await binding
    .telegram!.send(
      connection,
      current.contact.incoming,
      action === "request" ? w.plan!.requestText : w.plan!.reminderText,
      signal,
    )
    .catch(() => ({ status: "unknown" as const }));
  await binding.append([
    workEvent(
      "AikoWorkDelivery",
      {
        owner: binding.owner,
        id,
        token,
        status: result.status,
        ...("providerId" in result && result.providerId
          ? { providerId: result.providerId }
          : {}),
      },
      binding.now?.() ?? Date.now(),
    ),
  ]);
  return result.status === "delivered"
    ? undefined
    : "Message delivery is uncertain; reconcile it before any further send";
}

class WorkSourceUnavailable extends Error {}

/** One bounded evaluation. Native effects and method deadlines own replay and scheduling. */
export async function coordinateWork(
  binding: SecretaryWorkBinding,
  id: string,
  signal: AbortSignal,
) {
  const now = binding.now?.() ?? Date.now();
  const rows = await binding.read(),
    state = workState(rows, binding.owner),
    original = state.commitments.get(id);
  if (!original) return;
  let w = structuredClone(original);
  // Only this initial read is retryable: no action has been dispatched by this
  // evaluation. Exceptions after this boundary retain the manual recovery fence.
  let source: readonly Event[] = [];
  if (w.plan) {
    try { source = await binding.readSecretary(); }
    catch { signal.throwIfAborted(); throw new WorkSourceUnavailable(); }
  }
  signal.throwIfAborted();
  const contact = w.plan ? contactForWork(source, binding.owner, w) : undefined;
  const request = state.receipts.get(executionId(w, "request"));
  if (w.plan && w.evidenceMessageId && w.status === "completed") {
    const evidence = contact?.messages.find(
      (m) => m.messageId === w.evidenceMessageId,
    );
    const items =
      evidence &&
      !evidence.unsupported &&
      !evidence.viaBot &&
      agendaItems(evidence.text, w.plan.count);
    const note = items
      ? items.map((item, i) => String(i + 1) + ". " + item).join("\n")
      : undefined;
    if (note !== w.preparationNote) {
      w = reviewWork(
        {
          ...w,
          status: "waiting",
          evidenceRefs: [],
          preparationNote: undefined,
          evidenceMessageId: undefined,
          mandate: undefined,
          coverage:
            "The source was edited or deleted. Previous completion is no longer current.",
        },
        "The agenda evidence changed; review the preparation note",
        now,
      );
    }
  } else if (
    w.plan &&
    w.status !== "cancelled" &&
    request?.status === "delivered"
  ) {
    const evidence = contact?.messages
      .filter(
        (m) =>
          m.sender === w.plan!.chat &&
          !m.viaBot &&
          !m.unsupported &&
          m.chatType === "private" &&
          m.messageId >
            Math.max(
              request.afterMessageId ?? 0,
              w.evidenceAfterMessageId ?? 0,
            ) &&
          m.date * 1000 >= Math.floor(request.at / 1000) * 1000,
      )
      .sort((a, b) => b.date - a.date || b.messageId - a.messageId)
      .find((m) => agendaItems(m.text, w.plan!.count));
    if (evidence) {
      const items = agendaItems(evidence.text, w.plan.count)!;
      w = {
        ...w,
        version: w.version + 1,
        updatedAt: now,
        status: "completed",
        nextAction: "Agenda items added to your preparation note",
        evidenceMessageId: evidence.messageId,
        evidenceRefs: [
          "secretary:" +
            w.plan.connectionId +
            ":" +
            w.plan.chat +
            ":" +
            evidence.messageId +
            ":" +
            workDigest(evidence.text),
        ],
        preparationNote: items
          .map((item, i) => String(i + 1) + ". " + item)
          .join("\n"),
        coverage:
          "Received the requested number of distinct numbered text items from this contact. Content is the contact's statement, not independent verification.",
      };
      if (w.decision?.status === "pending") w.decision.status = "superseded";
    }
  }
  if (w.version !== original.version) {
    await saveWork(
      binding,
      w,
      original.version,
      "evaluate:" + w.id + ":" + w.version,
    );
    return;
  }
  if (workTerminal(w) || w.control === "paused" || w.handling === "owner")
    return;
  if (w.decision?.status === "pending") {
    if (now >= w.decision.expiresAt) {
      w.decision.status = "expired";
      w.handling = "owner";
      w.actionAssignee = "You";
      w.nextAction = "Decision expired; the obligation remains open";
      w.version++;
      w.updatedAt = now;
      await saveWork(binding, w, original.version, "expire:" + w.decision.id);
    }
    return;
  }
  if (!workActive(w)) return;
  if (
    w.dependencyRefs.some(
      (dep) => state.commitments.get(dep)?.status !== "completed",
    )
  ) {
    if (now >= (w.nextReviewAt ?? w.dueAt ?? Infinity))
      w = reviewWork(w, "A dependency is still open", now);
  } else if (w.plan && w.mandate) {
    const reminder = state.receipts.get(executionId(w, "reminder"));
    const uncertain = [request, reminder].find(
      (r) => r && r.status !== "delivered",
    );
    if (uncertain) {
      if (uncertain.status === "started")
        await binding.append([
          workEvent(
            "AikoWorkDelivery",
            {
              owner: binding.owner,
              id: uncertain.id,
              token: uncertain.token,
              status: "unknown",
              reason: "Dispatch was interrupted; no automatic retry",
            },
            now,
          ),
        ]);
      w = reviewWork(
        w,
        uncertain.reason ??
          "Message delivery is uncertain; reconcile it before any further send",
        now,
      );
    } else if (now >= w.plan.escalateAt)
      w = reviewWork(
        w,
        "Still waiting for " + w.plan.contactName + "'s agenda items",
        now,
      );
    else if (!request || (!reminder && now >= w.plan.reminderAt)) {
      const action = request ? "reminder" : "request";
      const reason = await dispatch(binding, w, action, signal);
      // The effect may have yielded while the owner edited or paused this work.
      if (
        workState(await binding.read(), binding.owner).commitments.get(id)
          ?.version !== original.version
      )
        return;
      if (reason) w = reviewWork(w, reason, now);
      else
        w = {
          ...w,
          version: w.version + 1,
          updatedAt: now,
          status: "waiting",
          waitingFor: w.plan.contactName,
          nextAction:
            action === "request"
              ? "Await agenda items; remind once if needed"
              : "Await agenda items; flag missing items before the deadline",
          actionAssignee: "Aiko",
          nextReviewAt:
            action === "request" ? w.plan.reminderAt : w.plan.escalateAt,
        };
    } else {
      const nextReviewAt = reminder ? w.plan.escalateAt : w.plan.reminderAt;
      if (w.nextReviewAt !== nextReviewAt)
        w = { ...w, version: w.version + 1, updatedAt: now, nextReviewAt };
    }
  } else if (now >= (w.nextReviewAt ?? w.dueAt ?? Infinity))
    w = reviewWork(w, "Review the next step for: " + w.outcome, now);
  if (w.version !== original.version)
    await saveWork(
      binding,
      w,
      original.version,
      "evaluate:" + w.id + ":" + w.version,
    );
}

function evaluationId(w: Commitment, rows: readonly Event[]) {
  // Source changes and clocks are retained events; the pure projection never samples wall time.
  const signal = rows.findLast(
    (e) =>
      e.type === "AlarmFired" ||
      e.type === "AikoWorkContactObserved" ||
      e.type === "AikoWorkContactHandling" ||
      e.type === "AikoWorkDelivery" ||
      (e.type === "AikoWorkTransition" && e.id !== w.id),
  );
  return w.id + ":" + w.version + ":" + workDigest(signal ?? null).slice(0, 16);
}

export function secretaryCoordination(binding: SecretaryWorkBinding, contributions = false) {
  if (
    binding.thread !== "user-" + binding.owner ||
    binding.memory.owner !== binding.owner
  )
    throw Error("Invalid secretary coordination scope");
  return component({
    name: "aiko.secretary-coordination",
    keys: { prefixes: ["aiko-work:"], keyOf: workEventKey },
    initial: () => [] as Event[],
    step: (rows, e) => [...rows, e],
    output: (rows) => {
      const work = [...workState(rows, binding.owner).commitments.values()];
      const recoveryDue = (w: Commitment) => {
        const at = workRecoveryAt(rows, w), failure = workEvaluationFailure(rows, w);
        // Only a committed host alarm can release a retry; unrelated messages,
        // projection replay and wall-clock passage do not create another attempt.
        return at !== undefined && rows.slice(rows.indexOf(failure!) + 1).some(e => e.type === "AlarmFired" && Number(e.at) >= at);
      };
      const checkedId = (w: Commitment) => {
        const failure = workEvaluationFailure(rows, w);
        return failure ? `${failure.id}:retry:${failure.attempt}` : evaluationId(w, rows);
      };
      const due = work.find(
        (w) =>
          (!workEvaluationFailure(rows, w) || recoveryDue(w)) &&
          !rows.some(
            (e) =>
              e.type === "AikoWorkEvaluated" && e.id === checkedId(w),
          ),
      );
      if (due) {
        const id = checkedId(due);
        return {
          view: undefined,
          transitions: [
            effect({
              key: "aiko-work:evaluate:" + id,
              input: { id, workId: due.id, workVersion: due.version },
              act: ({ id, workId, workVersion }, signal) =>
                Effect.gen(function* () {
                  const failure = yield* Effect.tryPromise({
                    try: async () => {
                      const current = workState(await binding.read(), binding.owner).commitments.get(workId);
                      if (current?.version !== workVersion) return;
                      const prior = workEvaluationFailure(rows, due);
                      if (prior && (binding.now?.() ?? Date.now()) >= Number(prior.deadlineAt)) throw new WorkSourceUnavailable();
                      await coordinateWork(binding, workId, signal);
                    },
                    catch: error => error,
                  }).pipe(
                    Effect.map(() => undefined),
                    Effect.catch((error) => {
                      const prior = workEvaluationFailure(rows, due);
                      const attempt = prior?.recoveryVersion === 1 ? Number(prior.attempt) + 1 : 1;
                      const at = binding.now?.() ?? Date.now();
                      const deadlineAt = prior?.recoveryVersion === 1 ? Number(prior.deadlineAt) : Math.min(at + 120_000, due.dueAt ?? Infinity);
                      const retryAt = at + 30_000 * attempt;
                      const retry = error instanceof WorkSourceUnavailable && !signal.aborted && workActive(due) &&
                        due.decision?.status !== "pending" && attempt <= 2 && retryAt < deadlineAt;
                      return Effect.succeed(workEvent("AikoWorkEvaluationFailed", {
                          owner: binding.owner,
                          id,
                          workId,
                          workVersion,
                          ...(error instanceof WorkSourceUnavailable ? { recoveryVersion: 1, cause: "source-unavailable", attempt, deadlineAt, ...(retry ? { retryAt } : {}) } : {}),
                          reason: retry ? "Aiko could not check the latest evidence. It will check again shortly; your work is preserved."
                            : "Aiko could not check this work. Review its evidence, then retry the check. Any uncertain send will remain held for review.",
                        }, at));
                    }),
                  );
                  if (failure)
                    return [
                      failure,
                      workEvent("AikoWorkEvaluated", {
                        owner: binding.owner,
                        id,
                      }),
                    ];
                  return [
                    ...(id !== evaluationId(due, rows) ? [workEvent("AikoWorkEvaluated", { owner: binding.owner, id: evaluationId(due, rows) })] : []),
                    workEvent("AikoWorkEvaluated", {
                      owner: binding.owner,
                      id,
                      workId,
                      workVersion,
                      status: "checked",
                    }),
                  ];
                }),
            }),
          ],
        };
      }
      const notice = work.map(w => {
        const ref = contributions ? readyWorkNotice(rows, binding.owner, w) ?? { workId: w.id, version: w.version } : { workId: w.id, version: w.version };
        const id = w.id + ":" + w.version + ("readyDependencies" in ref ? ":ready:" + workDigest(ref).slice(0, 16) : "");
        return { w, ref, id };
      }).find(
        ({ ref, id }) =>
          workNoticeCurrent(rows, binding.owner, ref) &&
          !rows.some(
            (e) =>
              e.type === "AikoWorkNotice" && e.id === id,
          ),
      );
      if (notice)
        return {
          view: undefined,
          transitions: [
            effect({
              key: "aiko-work:notice:" + notice.id,
              input: notice,
              act: ({ w, ref, id }) =>
                Effect.gen(function* () {
                  const log = yield* EventLog;
                  if (
                    !workNoticeCurrent(
                      yield* log.read,
                      binding.owner,
                      ref,
                      binding.now?.() ?? Date.now(),
                    )
                  )
                    return [
                      workEvent("AikoWorkNotice", { owner: binding.owner, id }),
                    ];
                  const speech = "readyDependencies" in ref ? { text: `The prerequisites are ready. ${w.nextAction || "You can resume this work."}` } : workDecisionLanguage(
                    w,
                    [
                      ...workState(
                        yield* log.read,
                        binding.owner,
                      ).receipts.values(),
                    ],
                    binding.now?.() ?? Date.now(),
                  );
                  if (!speech)
                    return [
                      workEvent("AikoWorkNotice", { owner: binding.owner, id }),
                    ];
                  const text =
                    w.outcome.replace(/\s+/g, " ").slice(0, 100) +
                    ": " +
                    speech.text;
                  const memory = openMemory(binding.memory);
                  let supports: string[];
                  try {
                    const saved = memory.remember(
                      {
                        subject: "secretary-work:" + id,
                        title: w.outcome,
                        type: "secretary-work",
                        kind: "fact",
                        payload: {
                          workId: w.id,
                          version: w.version,
                          status: w.status,
                          text,
                          ...( "readyDependencies" in ref ? { readyDependencies: ref.readyDependencies } : {}),
                        },
                      },
                      {
                        key: "secretary-work:" + id,
                        producer: {
                          kind: "tool",
                          reference: "aiko-secretary-coordination/v1",
                        },
                      },
                    );
                    supports = [saved.id];
                  } finally {
                    memory.close();
                  }
                  const at = binding.now?.() ?? Date.now();
                  return [
                    workEvent("AikoWorkNotice", { owner: binding.owner, id }),
                    workEvent("AikoProactiveDecision", {
                      owner: binding.owner,
                      id: "work:" + id,
                      sourceThread: binding.thread,
                      text: text.slice(0, 1200),
                      supports,
                      work: ref,
                      ...(contributions ? { policyVersion: CONTRIBUTION_POLICY,
                      contribution: {
                        version: 2,
                        topic: harnessDigest(["aiko-work-contribution/v2", binding.owner, w.id]),
                        trigger: id,
                        triggerSupports: supports,
                        createdAt: at,
                        notBefore: at,
                        expiresAt: Math.min(at + 86_400_000, w.dueAt ?? Number.MAX_SAFE_INTEGER,
                          w.decision?.status === "pending" ? w.decision.expiresAt : Number.MAX_SAFE_INTEGER),
                        action: "notify",
                      } } : {}),
                    }, at),
                  ];
                }),
            }),
          ],
        };
      return {
        view: undefined,
        transitions: work.flatMap((w) => {
          const failure = workEvaluationFailure(rows, w);
          const at = failure ? workRecoveryAt(rows, w) : nextWake(w);
          if (at === undefined) return [];
          const id = (failure ? `${failure.id}:recovery` : evaluationId(w, rows)) + ":" + at;
          if (rows.some((e) => e.type === "AikoWorkDeadline" && e.id === id))
            return [];
          return [
            intent({
              key: "aiko-work:deadline:" + id,
              input: w,
              events: (_, committedAt) => [
                {
                  ...workWaitMethod.event({
                    invocation: { method: "workWait", id, epoch: 0 },
                    input: { workId: w.id, version: w.version },
                    deadlineAt: at,
                    at: committedAt,
                  }),
                  owner: binding.owner,
                  ...(failure ? { recoveryVersion: 1 } : {}),
                },
              ],
            }),
          ];
        }),
      };
    },
  });
}
