import { expect, test } from "bun:test";
import { createWork, workView, workEvent } from "../src/commitments.ts";
import {
  workStatusLanguage,
  workDecisionLanguage,
  workCommandLanguage,
  workBriefLanguage,
} from "../../../packages/protocol/src/secretary-language.ts";
import type { WorkReceipt } from "../../../packages/protocol/src/secretary-work.ts";

const now = Date.UTC(2026, 8, 8, 2),
  hour = 3600000;
function proposal() {
  return createWork(
    "123",
    {
      id: "agenda",
      outcome: "Prepare the project review",
      successCondition: "Three agenda items received",
      accountableParty: "Maya",
      nextAction: "Collect agenda items",
      timeZone: "Asia/Singapore",
      dueAt: now + 4 * hour,
      plan: {
        kind: "agenda",
        connectionId: "fixture",
        chat: "456",
        contactName: "Maya",
        count: 3,
        requestText: "Please send three numbered agenda items.",
        reminderText: "Please send the three agenda items.",
        reminderAt: now + hour,
        escalateAt: now + 2 * hour,
      },
    },
    "owner:fixture",
    true,
    now,
  );
}
const receipt = (
  status: WorkReceipt["status"],
  action: WorkReceipt["action"] = "request",
): WorkReceipt => ({
  id: action,
  owner: "123",
  workId: "agenda",
  action,
  planDigest: "fixture",
  token: "fixture",
  status,
  at: now,
});

test("language distinguishes prepared, authorized, sent and completed with supporting evidence", () => {
  const w = proposal();
  expect(workCommandLanguage("capture", undefined, w, [])).toContain(
    "before anything is sent",
  );
  expect(workStatusLanguage(w)).not.toContain("I’ve asked");
  w.status = "ready";
  w.decision!.status = "approved";
  w.mandate = {
    planDigest: "fixture",
    grantId: "fixture",
    approvedAt: now,
    expiresAt: w.dueAt!,
    sourceUpdateId: 1,
  };
  expect(workStatusLanguage(w)).toContain("haven’t confirmed a send");
  w.status = "waiting";
  expect(workStatusLanguage(w, [receipt("delivered")])).toContain(
    "I’ve asked Maya",
  );
  expect(workStatusLanguage(w, [receipt("delivered")])).toContain(
    "still waiting",
  );
  expect(workDecisionLanguage(w, [receipt("delivered")], now)).toBeUndefined();
  w.status = "completed";
  w.evidenceMessageId = 12;
  w.evidenceRefs = ["secretary:fixture:12"];
  expect(workDecisionLanguage(w, [receipt("delivered")], now)?.text).toContain(
    "in your preparation note",
  );
  expect(
    workDecisionLanguage({ ...w, evidenceRefs: [] }, [], now),
  ).toBeUndefined();
});

test("a decision names the action, time zone and no-answer consequence, then becomes silent when stale", () => {
  const w = proposal();
  const speech = workDecisionLanguage(w, [], now)!;
  expect(speech.question).toBe(
    "May I send this request to Maya and one reminder if needed?",
  );
  expect(speech.text).toContain("Sep 8");
  expect(speech.text).toContain("Asia/Singapore");
  expect(speech.consequence).toContain("I won’t start this request");
  expect(speech.text.length).toBeLessThan(1000);
  expect(workDecisionLanguage(w, [], w.decision!.expiresAt)).toBeUndefined();
  expect(
    workDecisionLanguage({ ...w, handling: "owner" }, [], now),
  ).toBeUndefined();
  expect(
    workDecisionLanguage({ ...w, control: "paused" }, [], now),
  ).toBeUndefined();
});

test("uncertain delivery survives pause and takeover wording without claiming cancellation of a send", () => {
  const w = proposal();
  w.status = "waiting";
  for (const status of ["unknown", "started"] as const) {
    const receipts = [receipt(status)];
    expect(workStatusLanguage(w, receipts)).toContain("may have gone through");
    expect(workStatusLanguage({ ...w, control: "paused" }, receipts)).toContain(
      "can’t confirm delivery",
    );
    expect(workStatusLanguage({ ...w, handling: "owner" }, receipts)).toContain(
      "can’t confirm delivery",
    );
    expect(workStatusLanguage(w, receipts)).not.toContain("I’ve sent");
  }
  const foreign = { ...receipt("delivered"), workId: "unrelated" };
  expect(workStatusLanguage(w, [foreign])).not.toContain("I’ve asked Maya");
});

test("what needs me filters waiting work and a briefing prioritizes decisions with bounded coverage", () => {
  const w = proposal();
  const rows = Array.from({ length: 7 }, (_, i) => ({
    ...w,
    id: "work-" + i,
    outcome: "Review " + i,
    status: "waiting" as const,
    decision: i === 6 ? w.decision : undefined,
    receipts: [],
    lane: i === 6 ? "needs_you" : "waiting",
  }));
  const decisions = workBriefLanguage(rows, "decisions", now);
  expect(decisions).toContain("Review 6");
  expect(decisions).not.toContain("Review 0");
  const brief = workBriefLanguage(rows, "brief", now);
  expect(brief.startsWith("• Review 6")).toBe(true);
  expect(brief).toContain("2 more in Secretary Mode");
  expect(workBriefLanguage([], "decisions", now)).toContain(
    "not every conversation",
  );
  expect(workBriefLanguage(rows, "decisions", w.decision!.expiresAt)).toContain(
    "window has passed",
  );
});

test("owner API view and command receipts expose the same grounded conversational status", () => {
  const w = proposal();
  const view = workView(
    [
      workEvent("AikoWorkTransition", {
        owner: "123",
        id: w.id,
        previous: 0,
        snapshot: w,
      }),
    ],
    "123",
    now,
  );
  expect(view.commitments[0].language.status).toBe(workStatusLanguage(w));
  expect(view.commitments[0].language.speech?.kind).toBe("approval");
  w.status = "completed";
  w.preparationNote = "Owner checked the final draft";
  w.evidenceRefs = ["owner:confirmation"];
  expect(workCommandLanguage("change", "complete", w, [])).toContain(
    "your confirmation",
  );
  expect(workCommandLanguage("change", "reopen", w, [])).toContain(
    "fresh evidence",
  );
});

test("expiration stays visible without inventing a voluntary handoff or promising an inactive review", () => {
  const w = proposal();
  w.decision!.status = "expired";
  w.handling = "owner";
  const view = workView(
    [
      workEvent("AikoWorkTransition", {
        owner: w.owner,
        id: w.id,
        previous: 0,
        snapshot: w,
      }),
    ],
    w.owner,
    now + 2 * hour,
  );
  expect(view.commitments[0].lane).toBe("needs_you");
  expect(view.commitments[0].language.status).toContain("without an answer");
  expect(view.commitments[0].language.status).not.toContain("You’re handling");
  const brief = workBriefLanguage(
    view.commitments,
    "decisions",
    now + 2 * hour,
  );
  expect(brief).toContain("decision window has passed");
  expect(brief).not.toContain("Next review:");
  expect(workDecisionLanguage(w, [], now + 2 * hour)).toBeUndefined();
  expect(workCommandLanguage("change", "review", w, [])).toContain(
    "hand it back",
  );
  w.control = "paused";
  expect(workCommandLanguage("change", "review", w, [])).toContain(
    "still paused",
  );
  expect(workCommandLanguage("change", "review", w, [])).not.toContain(
    "I’ll review this on",
  );
});

test("a declined proposal and a stopped reminder retain their actual meaning", () => {
  const w = proposal();
  w.decision!.status = "declined";
  w.handling = "owner";
  expect(workStatusLanguage(w)).toContain("declined this proposal");
  expect(workStatusLanguage(w)).not.toContain("You’re handling");
  w.decision = undefined;
  w.handling = "aiko";
  w.status = "waiting";
  const status = workStatusLanguage(w, [
    receipt("delivered"),
    receipt("blocked", "reminder"),
  ]);
  expect(status).toContain("reminder was stopped before sending");
  expect(status).not.toContain("I’ve sent Maya the reminder");
  expect(
    workStatusLanguage(w, [{ ...receipt("delivered"), owner: "789" }]),
  ).not.toContain("I’ve asked Maya");
});
