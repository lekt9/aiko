import type { Commitment, WorkReceipt } from "./secretary-work.js";

export type SecretarySpeech = {
  kind: "approval" | "decision" | "completion";
  text: string;
  question?: string;
  consequence?: string;
};

/** Display language only. These functions neither authorize work nor infer new facts. */
const plain = (text: string, limit = 180) => {
  const value = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > limit
    ? value.slice(0, limit - 1).trimEnd() + "…"
    : value;
};
export const secretaryTime = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat("en", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at) +
  " (" +
  timeZone +
  ")";
const items = (w: Commitment) =>
  `${w.plan!.count} agenda item${w.plan!.count === 1 ? "" : "s"}`;
const contact = (w: Commitment) => plain(w.plan!.contactName, 80);
const ownReceipts = (w: Commitment, receipts: readonly WorkReceipt[]) =>
  receipts.filter((r) => r.workId === w.id);
const uncertain = (receipts: readonly WorkReceipt[]) =>
  receipts.find((r) => r.status === "started" || r.status === "unknown");

export function workStatusLanguage(
  w: Commitment,
  all: readonly WorkReceipt[] = [],
): string {
  const receipts = ownReceipts(w, all),
    pending = uncertain(receipts);
  const uncertainty = pending
    ? `The ${pending.action} may have gone through; I can’t confirm delivery. Check the conversation before sending again.`
    : "";
  if (w.status === "cancelled")
    return (
      "I’ve withdrawn this work. I won’t start another message for it." +
      (uncertainty ? " " + uncertainty : "")
    );
  if (w.status === "completed")
    return w.evidenceMessageId && w.plan
      ? `${contact(w)}’s ${items(w)} are in your preparation note.`
      : "I’ve recorded your confirmation that this is complete.";
  if (w.handling === "owner")
    return (
      "You’re handling this. I won’t start another message for this work unless you hand it back." +
      (uncertainty ? " " + uncertainty : "")
    );
  if (w.control === "paused")
    return (
      "This is paused. I won’t start another message for it until you resume." +
      (uncertainty ? " " + uncertainty : "")
    );
  if (pending) return uncertainty;
  if (w.plan) {
    if (w.status === "candidate")
      return `I’ve prepared the request to ${contact(w)} for your review.`;
    const request = receipts.find((r) => r.action === "request"),
      reminder = receipts.find((r) => r.action === "reminder");
    if (request?.status === "blocked")
      return "The request was stopped before sending. This still needs your attention.";
    if (request?.status === "delivered")
      return reminder?.status === "delivered"
        ? `I’ve sent ${contact(w)} the reminder. I’m still waiting for the complete agenda.`
        : `I’ve asked ${contact(w)} for ${items(w)}. I’m still waiting for the complete agenda.`;
    if (w.mandate)
      return "You’ve authorized the request and one reminder. I haven’t confirmed a send yet.";
  }
  if (w.status === "candidate")
    return "I’ve noted this as a possible commitment for you to confirm.";
  if (w.status === "waiting")
    return `I’m waiting on ${plain(w.waitingFor ?? w.accountableParty, 80)}. Next: ${plain(w.nextAction)}.`;
  return `I’m tracking this. Next: ${plain(w.nextAction)}.`;
}

/** Only decisions and evidenced completion produce unsolicited speech; normal waiting stays quiet. */
export function workDecisionLanguage(
  w: Commitment,
  receipts: readonly WorkReceipt[],
  now: number,
): SecretarySpeech | undefined {
  if (
    w.control !== "active" ||
    w.handling !== "aiko" ||
    w.status === "cancelled"
  )
    return;
  if (w.status === "completed") {
    if (!w.evidenceRefs.length) return;
    return {
      kind: "completion",
      text:
        workStatusLanguage(w, receipts) +
        " Open Secretary Mode to read the preparation note and its evidence.",
    };
  }
  const d = w.decision;
  if (!d || d.status !== "pending" || now >= d.expiresAt) return;
  const timing =
    d.neededBy <= now
      ? "A decision is needed now."
      : `Please decide by ${secretaryTime(d.neededBy, w.timeZone)}.`;
  if (d.kind === "authorize" && w.plan) {
    const question = `May I send this request to ${contact(w)} and one reminder if needed?`;
    const consequence =
      "If you leave this unanswered, I won’t start this request.";
    return {
      kind: "approval",
      question,
      consequence,
      text: `I’ve prepared the request for ${items(w)}. ${question} ${timing} ${consequence} Review the exact messages in Secretary Mode → Needs you.`,
    };
  }
  if (w.status === "candidate") {
    const question = "Should I track this as a commitment?";
    const consequence = "Until you confirm, I’ll keep it as a suggestion.";
    return {
      kind: "decision",
      question,
      consequence,
      text: `${question} ${timing} ${consequence} Open Secretary Mode → Needs you.`,
    };
  }
  const pending = uncertain(ownReceipts(w, receipts));
  const question = pending
    ? "Can you check whether it arrived before we decide the next step?"
    : "Would you like to take over or choose a later review?";
  const context = pending
    ? workStatusLanguage(w, receipts)
    : plain(d.issue, 240).replace(/[.!?]+$/, "") + ".";
  const consequence =
    "If you leave this unanswered, the work stays open and I won’t send another follow-up.";
  return {
    kind: "decision",
    question,
    consequence,
    text: `${context} ${question} ${timing} ${consequence} Open Secretary Mode → Needs you.`,
  };
}

export function workCommandLanguage(
  action: string,
  change: string | undefined,
  w: Commitment,
  receipts: readonly WorkReceipt[],
): string {
  if (action === "capture" || change === "edit")
    return w.plan
      ? `I’ve prepared the request to ${contact(w)}. Review the exact messages in Needs you before anything is sent.`
      : w.status === "candidate"
        ? "I’ve added this as a suggestion for you to confirm."
        : `I’m tracking “${plain(w.outcome)}”.`;
  if (change === "retry")
    return "I’ll check the saved work again. Any uncertain delivery stays held for review.";
  if (change === "reopen")
    return "I’ve reopened this. I’ll need fresh evidence before marking it complete again.";
  if (change === "review")
    return `I’ll review this on ${secretaryTime(w.nextReviewAt!, w.timeZone)}. I won’t send another follow-up without fresh authorization.`;
  if (change === "resume")
    return "I’ve resumed this. I’ll check what’s still authorized before continuing.";
  if (action === "decide" && w.decision?.status === "approved")
    return w.plan
      ? "You’ve authorized the request and one reminder. I’ll check the current reply permission before sending."
      : "I’m tracking this commitment now.";
  return workStatusLanguage(w, receipts);
}

export function workBriefLanguage(
  rows: readonly (Commitment & {
    receipts: WorkReceipt[];
    lane: string;
    recoveryIssue?: string;
  })[],
  mode: "brief" | "decisions" | "waiting",
  now: number,
): string {
  const open = rows.filter(
    (w) => !["completed", "cancelled"].includes(w.status),
  );
  const relevant = open.filter(
    (w) =>
      mode === "brief" ||
      (mode === "decisions" ? w.lane === "needs_you" : w.lane === "waiting"),
  );
  if (!relevant.length)
    return (
      (mode === "decisions"
        ? "Nothing needs your decision in the work I’m tracking."
        : mode === "waiting"
          ? "There’s nothing on the waiting list I’m tracking."
          : "I’m not tracking any open commitments yet.") +
      " This covers recorded work, not every conversation or connected source."
    );
  const ordered = [...relevant].sort(
    (a, b) => Number(b.lane === "needs_you") - Number(a.lane === "needs_you"),
  );
  const lines = ordered.slice(0, 5).map((w) => {
    const speech = workDecisionLanguage(w, w.receipts, now);
    const expired =
      w.decision?.status === "pending" && now >= w.decision.expiresAt;
    const status = w.recoveryIssue
      ? plain(w.recoveryIssue)
      : expired
        ? "The decision window has passed; review the work before authorizing anything."
        : speech?.kind !== "completion" && speech
          ? speech.kind === "approval"
            ? speech.question
            : plain(w.decision!.issue)
          : workStatusLanguage(w, w.receipts);
    const time =
      w.decision?.status === "pending" && !expired
        ? ` Decision ${w.decision.neededBy <= now ? "needed now" : "by " + secretaryTime(w.decision.neededBy, w.timeZone)}.`
        : expired
          ? ""
          : w.nextReviewAt
            ? ` Next review: ${secretaryTime(w.nextReviewAt, w.timeZone)}.`
            : "";
    return `• ${plain(w.outcome, 100)}: ${status}${time}`;
  });
  return (
    lines.join("\n\n") +
    (ordered.length > 5
      ? `\n\n${ordered.length - 5} more in Secretary Mode.`
      : "") +
    "\n\nThis covers recorded work. Open Secretary Mode for decisions and evidence."
  );
}
