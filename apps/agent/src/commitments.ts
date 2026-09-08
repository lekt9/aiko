import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import { canonical } from "./action-approval.ts";
import {
  workDecisionLanguage,
  workStatusLanguage,
} from "../../../packages/protocol/src/secretary-language.ts";

import type {
  Commitment,
  WorkReceipt,
  WorkNoticeRef,
  WorkStatus,
  AgendaPlan,
  WorkDecision,
} from "../../../packages/protocol/src/secretary-work.ts";
export type {
  Commitment,
  WorkReceipt,
  WorkNoticeRef,
  WorkStatus,
  AgendaPlan,
  WorkDecision,
} from "../../../packages/protocol/src/secretary-work.ts";
export interface WorkJournal {
  read(): Promise<readonly Event[]>;
  append(events: Event[]): Promise<void>;
}
export class WorkError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const workDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const workEvent = (
  type: string,
  fields: Record<string, unknown>,
  at = Date.now(),
): Event => ({ type, at, ...fields });
export const workTerminal = (w: Commitment) =>
  w.status === "completed" || w.status === "cancelled";
export const workActive = (w: Commitment) =>
  !workTerminal(w) &&
  w.status !== "candidate" &&
  w.control === "active" &&
  w.handling === "aiko";
export const planDigest = (w: Commitment) =>
  workDigest({
    outcome: w.outcome,
    successCondition: w.successCondition,
    dueAt: w.dueAt,
    timeZone: w.timeZone,
    plan: w.plan ?? null,
  });
export const executionId = (w: Commitment, action: WorkReceipt["action"]) =>
  w.id + ":" + planDigest(w) + ":" + action;

/** Recovery is a projection of checked native occurrences, never a new task. */
export function workEvaluationFailure(events: readonly Event[], w: Commitment) {
  const last = events.findLast(e => e.owner === w.owner && e.workId === w.id && e.workVersion === w.version &&
    (e.type === "AikoWorkEvaluationFailed" || e.type === "AikoWorkEvaluated" && e.status === "checked"));
  return last?.type === "AikoWorkEvaluationFailed" ? last : undefined;
}

export function workRecoveryAt(events: readonly Event[], w: Commitment): number | undefined {
  const failure = workEvaluationFailure(events, w);
  if (!failure || failure.recoveryVersion !== 1 || failure.cause !== "source-unavailable" ||
    !Number.isSafeInteger(failure.attempt) || Number(failure.attempt) < 1 || Number(failure.attempt) > 2 ||
    !Number.isSafeInteger(failure.retryAt) || !Number.isSafeInteger(failure.deadlineAt) ||
    Number(failure.retryAt) >= Number(failure.deadlineAt) ||
    !workActive(w) || w.decision?.status === "pending") return;
  return Number(failure.retryAt);
}

export function workEventKey(e: Event): string | undefined {
  if (
    !/^AikoWork[A-Z]/.test(e.type) ||
    typeof e.owner !== "string" ||
    typeof e.id !== "string"
  )
    return;
  return (
    "aiko-work:" +
    e.owner +
    ":" +
    e.type +
    ":" +
    e.id +
    (e.type === "AikoWorkTransition" ? ":" + e.previous : "")
  );
}
export const workExternalEventAllowed = (e: Event) =>
  !/^AikoWork[A-Z]/.test(e.type);

export function workState(events: readonly Event[], owner: string) {
  const commitments = new Map<string, Commitment>();
  const receipts = new Map<string, WorkReceipt>();
  const contactHandling = new Map<string, "aiko" | "owner">();
  for (const e of events) {
    if (e.owner !== owner) continue;
    if (e.type === "AikoWorkTransition") {
      const w = e.snapshot as Commitment;
      if (
        w?.owner === owner &&
        w.id === e.id &&
        e.previous === (commitments.get(w.id)?.version ?? 0) &&
        w.version === Number(e.previous) + 1
      )
        commitments.set(w.id, w);
    }
    if (e.type === "AikoWorkDispatch" && !receipts.has(String(e.id)))
      receipts.set(String(e.id), e.receipt as WorkReceipt);
    if (e.type === "AikoWorkDelivery") {
      const receipt = receipts.get(String(e.id));
      if (receipt && receipt.token === e.token && receipt.status === "started")
        receipts.set(receipt.id, {
          ...receipt,
          status: e.status as WorkReceipt["status"],
          reason: typeof e.reason === "string" ? e.reason : undefined,
          providerId:
            typeof e.providerId === "string" ? e.providerId : undefined,
        });
    }
    if (e.type === "AikoWorkContactHandling")
      contactHandling.set(
        JSON.stringify([e.connectionId, e.chat]),
        e.handling as "aiko" | "owner",
      );
  }
  return { commitments, receipts, contactHandling };
}

/** Atomic host fence: stale writers cannot replace a newer snapshot or start its old action. */
export function workAppendAllowed(
  thread: string,
  batch: readonly Event[],
  read: () => readonly Event[],
) {
  const prior = [...read()];
  for (const e of batch) {
    // Worker and Workflow events have their own custody and keys. The shared
    // "AikoWork" prefix alone also matches those unrelated event families.
    if (!/^AikoWork[A-Z]/.test(e.type)) {
      prior.push(e);
      continue;
    }
    if (
      typeof e.owner !== "string" ||
      thread !== "user-" + e.owner ||
      !workEventKey(e)
    )
      return false;
    const s = workState(prior, e.owner);
    if (e.type === "AikoWorkTransition") {
      const w = e.snapshot as Commitment;
      if (
        e.previous !== (s.commitments.get(String(e.id))?.version ?? 0) ||
        w?.version !== Number(e.previous) + 1 ||
        w.owner !== e.owner ||
        w.id !== e.id
      )
        return false;
    }
    if (e.type === "AikoWorkDispatch") {
      const r = e.receipt as WorkReceipt,
        w = s.commitments.get(r?.workId);
      if (
        !w ||
        !workActive(w) ||
        w.version !== e.workVersion ||
        r.owner !== e.owner ||
        !w.mandate ||
        w.mandate.planDigest !== planDigest(w) ||
        r.planDigest !== planDigest(w) ||
        Number(e.at) >= w.mandate.expiresAt ||
        s.receipts.has(String(e.id)) ||
        s.contactHandling.get(
          JSON.stringify([w.plan?.connectionId, w.plan?.chat]),
        ) === "owner"
      )
        return false;
    }
    if (e.type === "AikoWorkContactHandling") {
      const last = prior.findLast(
        (p) =>
          p.owner === e.owner &&
          p.type === e.type &&
          p.connectionId === e.connectionId &&
          p.chat === e.chat,
      );
      if (
        (last?.id ?? null) !== e.previousId ||
        !["owner", "aiko"].includes(String(e.handling))
      )
        return false;
    }
    prior.push(e);
  }
  return true;
}

export function contactReplyAllowed(
  events: readonly Event[],
  owner: string,
  connectionId: string,
  chat: string,
) {
  const s = workState(events, owner);
  return (
    s.contactHandling.get(JSON.stringify([connectionId, chat])) !== "owner" &&
    ![...s.commitments.values()].some(
      (w) =>
        w.plan?.connectionId === connectionId &&
        w.plan.chat === chat &&
        !workTerminal(w) &&
        (w.handling === "owner" || !!w.mandate),
    )
  );
}

export function readyWorkNotice(events: readonly Event[], owner: string, w: Commitment): WorkNoticeRef | undefined {
  if (w.owner !== owner || w.status !== "waiting" || !w.dependencyRefs.length || w.decision?.status === "pending") return undefined;
  const state = workState(events, owner);
  const readyDependencies = [...w.dependencyRefs].sort().map(workId => {
    const dependency = state.commitments.get(workId);
    return dependency?.status === "completed" && dependency.evidenceRefs.length > 0 && dependency.control === "active"
      ? { workId, version: dependency.version } : undefined;
  });
  return readyDependencies.every((d): d is { workId: string; version: number } => d !== undefined)
    ? { workId: w.id, version: w.version, readyDependencies } : undefined;
}

export function workNoticeCurrent(
  events: readonly Event[],
  owner: string,
  ref: unknown,
  now?: number,
): ref is WorkNoticeRef {
  if (!ref || typeof ref !== "object") return false;
  const r = ref as WorkNoticeRef,
    state = workState(events, owner),
    w = state.commitments.get(r.workId);
  return (
    !!w &&
    w.version === r.version &&
    w.control === "active" &&
    w.handling === "aiko" &&
    w.status !== "cancelled" &&
    (!w.plan ||
      state.contactHandling.get(
        JSON.stringify([w.plan.connectionId, w.plan.chat]),
      ) !== "owner") &&
    (r.readyDependencies !== undefined ? (w.dueAt === null || now === undefined || now < w.dueAt) &&
        workDigest(r) === workDigest(readyWorkNotice(events, owner, w) ?? null) : (w.status === "completed" ||
      (w.decision?.status === "pending" &&
        (now === undefined || now < w.decision.expiresAt))))
  );
}
export function workView(
  events: readonly Event[],
  owner: string,
  now = Date.now(),
) {
  const s = workState(events, owner);
  const rows = [...s.commitments.values()].sort(
    (a, b) =>
      (a.decision?.status === "pending"
        ? a.decision.neededBy
        : (a.dueAt ?? Infinity)) -
      (b.decision?.status === "pending"
        ? b.decision.neededBy
        : (b.dueAt ?? Infinity)),
  );
  const decorated = rows.map((w) => ({
    ...w,
    language: {
      status: workStatusLanguage(w, [...s.receipts.values()]),
      speech: workDecisionLanguage(w, [...s.receipts.values()], now),
    },
    overdue: !workTerminal(w) && w.dueAt !== null && w.dueAt <= now,
    atRisk:
      !workTerminal(w) &&
      (w.decision?.status === "pending" ||
        (w.dueAt !== null && w.dueAt <= now)),
    recoveryIssue: workEvaluationFailure(events, w)?.reason as string | undefined,
    recoveryAt: workRecoveryAt(events, w),
    lane:
      w.status === "completed" || w.status === "cancelled"
        ? "done"
        : w.decision?.status === "pending" ||
            w.decision?.status === "expired" && w.control === "active" ||
            (workEvaluationFailure(events, w) && workRecoveryAt(events, w) === undefined)
          ? "needs_you"
          : w.status === "waiting" ||
              w.control === "paused" ||
              w.handling === "owner"
            ? "waiting"
            : "in_motion",
    receipts: [...s.receipts.values()].filter((r) => r.workId === w.id),
  }));
  return {
    now,
    commitments: decorated,
    coverage:
      "Observed owner instructions and connected Secretary Mode contacts. Unconnected sources and unsupported media are not included.",
  };
}

export function workText(raw: unknown, name: string, max = 1000): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max)
    throw new WorkError("Invalid " + name);
  return raw.trim();
}
export function workTime(raw: unknown, name: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) <= 0)
    throw new WorkError("Invalid " + name + "; use an explicit timestamp");
  return Number(raw);
}
function refs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > 32 ||
    raw.some((x) => typeof x !== "string" || !x || x.length > 256)
  )
    throw new WorkError("Invalid references");
  return [...new Set(raw)];
}
export function validateWork(w: Commitment) {
  if (!w.outcome || !w.nextAction || !w.actionAssignee || !w.successCondition)
    throw new WorkError(
      "An outcome, next step, assignee and success condition are required",
    );
  if (w.control === "paused" && (!w.suspensionReason || !w.resumeWhen))
    throw new WorkError("Paused work needs a reason and resume condition");
  if (
    workActive(w) &&
    w.status === "waiting" &&
    (!w.waitingFor || !w.nextReviewAt)
  )
    throw new WorkError("Waiting work needs a dependency and next review");
  if (
    w.nextReviewAt !== undefined &&
    (!Number.isSafeInteger(w.nextReviewAt) || w.nextReviewAt <= 0)
  )
    throw new WorkError("Invalid next review");
}

export function createWork(
  owner: string,
  input: Record<string, unknown>,
  sourceRef: string,
  trusted: boolean,
  now = Date.now(),
): Commitment {
  const id = workText(input.id, "id", 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new WorkError("Invalid work id");
  const dueAt =
    input.dueAt === undefined || input.dueAt === null
      ? null
      : workTime(input.dueAt, "deadline");
  if (dueAt !== null && dueAt > now + 365 * 86400000)
    throw new WorkError("Deadline must be within the next year");
  const timeZone = workText(input.timeZone, "time zone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(now);
  } catch {
    throw new WorkError("Invalid time zone");
  }
  const w: Commitment = {
    id,
    owner,
    version: 1,
    outcome: workText(input.outcome, "outcome"),
    successCondition: workText(input.successCondition, "success condition"),
    accountableParty: workText(
      input.accountableParty,
      "responsible person",
      200,
    ),
    nextAction: workText(input.nextAction, "next action"),
    actionAssignee: workText(
      input.actionAssignee ?? "Aiko",
      "next action assignee",
      200,
    ),
    status: trusted ? "ready" : "candidate",
    acceptanceBasis: trusted ? "ownerInstruction" : "tentativeInference",
    handling: "aiko",
    control: "active",
    dueAt,
    timeZone,
    nextReviewAt: workTime(
      input.nextReviewAt ??
        (dueAt === null ? now + 86400000 : Math.max(now, dueAt)),
      "next review",
    ),
    sourceRefs: [sourceRef],
    dependencyRefs: refs(input.dependencyRefs),
    evidenceRefs: [],
    coverage: "Owner instruction; external completion not yet verified.",
    createdAt: now,
    updatedAt: now,
  };
  if (input.plan !== undefined && input.plan !== null) {
    const p = input.plan as Record<string, unknown>;
    if (
      !p ||
      p.kind !== "agenda" ||
      Object.keys(p).some(
        (k) =>
          ![
            "kind",
            "connectionId",
            "chat",
            "contactName",
            "count",
            "requestText",
            "reminderText",
            "reminderAt",
            "escalateAt",
          ].includes(k),
      )
    )
      throw new WorkError("Unsupported workflow");
    const count = Number(p.count);
    if (!Number.isInteger(count) || count < 1 || count > 10)
      throw new WorkError("Request 1–10 agenda items");
    const chat = workText(p.chat, "contact", 32);
    if (!/^[1-9]\d{0,15}$/.test(chat) || chat === owner)
      throw new WorkError("Choose an observed private contact");
    w.plan = {
      kind: "agenda",
      connectionId: workText(p.connectionId, "connection", 256),
      chat,
      contactName: workText(p.contactName, "contact name", 200),
      count,
      requestText: workText(p.requestText, "request message", 2000),
      reminderText: workText(p.reminderText, "reminder message", 2000),
      reminderAt: workTime(p.reminderAt, "reminder time"),
      escalateAt: workTime(p.escalateAt, "decision time"),
    };
    if (
      dueAt === null ||
      !(
        now < w.plan.reminderAt &&
        w.plan.reminderAt < w.plan.escalateAt &&
        w.plan.escalateAt < dueAt
      )
    )
      throw new WorkError(
        "Use future times in order: reminder, decision, deadline",
      );
    w.status = "candidate";
    w.nextReviewAt = w.plan.reminderAt;
    w.nextAction = "Review the request and one reminder";
    w.actionAssignee = "You";
    w.decision = {
      id: id + ":authorize:" + workDigest(w.plan).slice(0, 16),
      kind: "authorize",
      issue: "Authorize this request and one reminder to " + w.plan.contactName,
      recommendation:
        "Send the prepared request, remind once if needed, and flag missing agenda items before the deadline.",
      neededBy: w.plan.reminderAt,
      expiresAt: w.plan.reminderAt,
      status: "pending",
      planDigest: planDigest(w),
      fallback: "keep_waiting",
    };
  } else if (!trusted) {
    w.decision = {
      id: id + ":accept",
      kind: "review",
      issue: "Confirm this inferred commitment",
      recommendation: w.nextAction,
      neededBy: w.nextReviewAt!,
      expiresAt: Math.max(now + 3600000, dueAt ?? w.nextReviewAt!),
      status: "pending",
      planDigest: planDigest(w),
      fallback: "keep_waiting",
    };
  }
  validateWork(w);
  return w;
}

export async function saveWork(
  journal: WorkJournal,
  w: Commitment,
  previous: number,
  operationId: string,
) {
  validateWork(w);
  const events = await journal.read();
  const priorOperation = events.find(
    (e) =>
      e.type === "AikoWorkTransition" &&
      e.owner === w.owner &&
      e.operationId === operationId,
  );
  if (priorOperation) {
    if (canonical(priorOperation.snapshot) !== canonical(w))
      throw new WorkError("Operation id already used", 409);
    return priorOperation.snapshot as Commitment;
  }
  if (
    (workState(events, w.owner).commitments.get(w.id)?.version ?? 0) !==
    previous
  )
    throw new WorkError("Work changed; refresh and try again", 409);
  for (const dependency of w.dependencyRefs) {
    if (
      dependency === w.id ||
      !workState(events, w.owner).commitments.has(dependency)
    )
      throw new WorkError("Invalid dependency");
    const visit = (id: string, seen = new Set<string>()): boolean => {
      if (id === w.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (
        workState(events, w.owner)
          .commitments.get(id)
          ?.dependencyRefs.some((d) => visit(d, seen)) ?? false
      );
    };
    if (visit(dependency)) throw new WorkError("Dependency cycle");
  }
  const token = crypto.randomUUID();
  await journal.append([
    workEvent(
      "AikoWorkTransition",
      { owner: w.owner, id: w.id, previous, operationId, token, snapshot: w },
      w.updatedAt,
    ),
  ]);
  if (
    !(await journal.read()).some(
      (e) => e.type === "AikoWorkTransition" && e.token === token,
    )
  )
    throw new WorkError("Work changed; refresh and try again", 409);
  return w;
}

/** A numbered list is a constrained receipt format, not a claim of semantic entailment. */
export function agendaItems(text: string, count: number): string[] | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((x) => x.trim());
  if (lines.length !== count) return;
  const items = lines.map((line, i) => {
    const match = /^(\d+)[.)]\s+(.+)$/.exec(line.trim());
    return match && Number(match[1]) === i + 1 && match[2].trim().length >= 3
      ? match[2].trim()
      : "";
  });
  return items.every(Boolean) && new Set(items).size === count
    ? items
    : undefined;
}
