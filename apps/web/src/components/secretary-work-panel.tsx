import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SecretarySpeech } from "../../../../packages/protocol/src/secretary-language";
import type {
  Commitment,
  WorkReceipt,
} from "../../../../packages/protocol/src/secretary-work";

type Lane = "needs_you" | "in_motion" | "waiting" | "done";
type Work = Commitment & {
  language?: { status: string; speech?: SecretarySpeech };
  lane: Lane;
  overdue: boolean;
  receipts: WorkReceipt[];
  recoveryIssue?: string;
};
type Contact = {
  connectionId: string;
  chat: string;
  name: string;
  enabled: boolean;
  handling: string;
  handlingRevision: string | null;
};
type Attention = {
  revision: string;
  preferences: {
    version: 1;
    enabled: boolean;
    dailyLimit: number;
    cooldownMs: number;
    batchWindowMs: number;
    dismissedTopics: string[];
    quietHours: null | {
      timeZone: string;
      startMinute: number;
      endMinute: number;
    };
  };
};
type View = {
  now: number;
  commitments: Work[];
  contacts: Contact[];
  coverage: string;
  attention?: Attention;
};
type Request = <T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<T>;
const lanes: [Lane, string][] = [
  ["needs_you", "Needs you"],
  ["in_motion", "In motion"],
  ["waiting", "Waiting"],
  ["done", "Done"],
];
const localTime = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
const dateInput = (at: number | null | undefined) =>
  at == null
    ? ""
    : new Date(at - new Date(at).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);

export function SecretaryWorkPanel({ request }: { request: Request }) {
  const [view, setView] = useState<View>();
  const [lane, setLane] = useState<Lane>("needs_you");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState("agenda");
  const [contactKey, setContactKey] = useState("");
  const [outcome, setOutcome] = useState("");
  const [responsible, setResponsible] = useState("");
  const [success, setSuccess] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [due, setDue] = useState("");
  const [reminder, setReminder] = useState("");
  const [escalate, setEscalate] = useState("");
  const [requestText, setRequestText] = useState(
    "Please send three agenda items for our review as a numbered list (1, 2, 3).",
  );
  const [reminderText, setReminderText] = useState(
    "A reminder to send the three numbered agenda items before the review. Thank you.",
  );
  const pendingCapture = useRef<
    { signature: string; command: object } | undefined
  >(undefined);
  const controller = useRef<AbortController | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void request<View>("/secretary/work", undefined, abort.signal)
      .then(setView)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [request]);
  async function perform(body?: object) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    const signal = controller.current?.signal;
    try {
      if (body) {
        const result = await request<{ message?: string }>(
          "/secretary/work",
          body,
          signal,
        );
        if (!signal?.aborted)
          setNotice(result.message ?? "Your change is saved.");
      }
      const next = await request<View>("/secretary/work", undefined, signal);
      if (signal?.aborted) return false;
      setView(next);
      return true;
    } catch (e) {
      if (!signal?.aborted) setError((e as Error).message);
      return false;
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  const change = (w: Work, action: string, extra: object = {}) =>
    perform({
      action: "change",
      change: action,
      id: w.id,
      expectedVersion: w.version,
      operationId: crypto.randomUUID(),
      ...extra,
    });
  async function capture(e: FormEvent) {
    e.preventDefault();
    const contact = view?.contacts.find(
      (c) => JSON.stringify([c.connectionId, c.chat]) === contactKey,
    );
    if (mode === "agenda" && !contact) {
      setError("Choose an observed contact.");
      return;
    }
    const fields = {
      action: "capture",
      outcome,
      successCondition:
        mode === "agenda"
          ? "Receive three distinct numbered agenda items and include them in my preparation note"
          : success,
      accountableParty: mode === "agenda" ? contact!.name : responsible,
      nextAction: mode === "agenda" ? "Collect the agenda items" : nextStep,
      dueAt: due ? new Date(due).getTime() : null,
      timeZone,
      ...(mode === "agenda"
        ? {
            plan: {
              kind: "agenda",
              connectionId: contact!.connectionId,
              chat: contact!.chat,
              contactName: contact!.name,
              count: 3,
              requestText,
              reminderText,
              reminderAt: new Date(reminder).getTime(),
              escalateAt: new Date(escalate).getTime(),
            },
          }
        : {}),
    };
    const signature = JSON.stringify(fields);
    if (pendingCapture.current?.signature !== signature)
      pendingCapture.current = {
        signature,
        command: {
          ...fields,
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
        },
      };
    if (await perform(pendingCapture.current!.command)) {
      pendingCapture.current = undefined;
      setAdding(false);
      setOutcome("");
      setLane(mode === "agenda" ? "needs_you" : "in_motion");
    }
  }
  return (
    <section
      className="secretary-work"
      aria-labelledby="secretary-work-title"
      aria-busy={busy}
    >
      <div className="app-section-heading">
        <h3 id="secretary-work-title">Your work</h3>
        <div className="work-actions">
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void perform()}
          >
            Refresh work
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
          >
            Add work
          </button>
        </div>
      </div>
      <p>
        Keep track of what is owed, what happens next, and what needs your
        decision.
      </p>
      {error && (
        <p role="alert" className="work-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!view && !error && <p role="status">Loading your work…</p>}
      {adding && (
        <form className="work-form" onSubmit={capture}>
          <label>
            What should Aiko track?
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="agenda">Collect meeting agenda items</option>
              <option value="commitment">Track a commitment</option>
            </select>
          </label>
          <label>
            Outcome
            <input
              required
              maxLength={1000}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="Prepare for Thursday’s project review"
            />
          </label>
          {mode === "agenda" ? (
            <>
              <label>
                Contact
                <select
                  required
                  value={contactKey}
                  onChange={(e) => setContactKey(e.target.value)}
                >
                  <option value="">Choose a contact</option>
                  {view?.contacts.map((c) => (
                    <option
                      key={JSON.stringify([c.connectionId, c.chat])}
                      value={JSON.stringify([c.connectionId, c.chat])}
                    >
                      {c.name}
                      {c.enabled ? "" : " — reply permission needed"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Request to send
                <textarea
                  required
                  maxLength={2000}
                  rows={3}
                  value={requestText}
                  onChange={(e) => setRequestText(e.target.value)}
                />
              </label>
              <label>
                One reminder
                <textarea
                  required
                  maxLength={2000}
                  rows={3}
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                />
              </label>
              <div className="work-times">
                <label>
                  Remind at
                  <input
                    required
                    type="datetime-local"
                    value={reminder}
                    onChange={(e) => setReminder(e.target.value)}
                  />
                </label>
                <label>
                  Tell me if still missing by
                  <input
                    required
                    type="datetime-local"
                    value={escalate}
                    onChange={(e) => setEscalate(e.target.value)}
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <label>
                Who owes the outcome?
                <input
                  required
                  maxLength={200}
                  value={responsible}
                  onChange={(e) => setResponsible(e.target.value)}
                />
              </label>
              <label>
                What establishes completion?
                <input
                  required
                  maxLength={1000}
                  value={success}
                  onChange={(e) => setSuccess(e.target.value)}
                />
              </label>
              <label>
                Next step
                <input
                  required
                  maxLength={1000}
                  value={nextStep}
                  onChange={(e) => setNextStep(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Outcome due{mode !== "agenda" && " (optional)"}
            <input
              required={mode === "agenda"}
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          {mode !== "agenda" && (
            <p className="aiko-fineprint">
              If the deadline is unknown, leave it blank. Aiko will review the
              next step tomorrow.
            </p>
          )}
          <p className="aiko-fineprint">
            Times are in {timeZone}.{" "}
            {mode === "agenda"
              ? "You will review the messages and authorize the request and one reminder before anything is sent."
              : "Tracking records the obligation. It does not execute an external action."}
          </p>
          <div className="work-actions">
            <button type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : mode === "agenda"
                  ? "Prepare for review"
                  : "Track commitment"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {view && (
        <>
          <div className="work-tabs" role="group" aria-label="Work views">
            {lanes.map(([value, label]) => (
              <button
                key={value}
                aria-pressed={lane === value}
                onClick={() => setLane(value)}
              >
                {label}{" "}
                <span>
                  {view.commitments.filter((w) => w.lane === value).length}
                </span>
              </button>
            ))}
          </div>
          <div className="work-list">
            {!view.commitments.some((w) => w.lane === lane) && (
              <p className="work-empty">
                {lane === "needs_you"
                  ? "No decisions need you here."
                  : lane === "waiting"
                    ? "Nothing is waiting in this view."
                    : lane === "done"
                      ? "Completed and withdrawn work will appear here."
                      : "Add an outcome or delegate one to Aiko in chat."}
              </p>
            )}
            {view.commitments
              .filter((w) => w.lane === lane)
              .map((w) => (
                <article className="work-item" key={w.id}>
                  <div className="work-item-heading">
                    <h4>{w.outcome}</h4>
                    <span className={w.overdue ? "work-overdue" : "work-state"}>
                      {w.overdue
                        ? "Overdue"
                        : w.control === "paused"
                          ? "Paused"
                          : w.handling === "owner"
                            ? "You are handling this"
                            : {
                                candidate: "Review needed",
                                ready: "Ready",
                                acting: "In progress",
                                waiting: "Waiting",
                                completed: "Complete",
                                cancelled: "Withdrawn",
                              }[w.status]}
                    </span>
                  </div>
                  <p>{w.language?.status ?? w.nextAction}</p>
                  <p className="aiko-fineprint">
                    {w.accountableParty} ·{" "}
                    {w.dueAt === null
                      ? "Deadline not set"
                      : "Due " + localTime(w.dueAt, w.timeZone)}{" "}
                    · {w.timeZone}
                  </p>
                  {w.recoveryIssue && (
                    <div className="work-error">
                      <p>{w.recoveryIssue}</p>
                      <button
                        disabled={busy}
                        onClick={() => void change(w, "retry")}
                      >
                        Retry check
                      </button>
                    </div>
                  )}
                  {w.nextReviewAt && w.status !== "completed" && (
                    <p className="aiko-fineprint">
                      Next review: {localTime(w.nextReviewAt, w.timeZone)}
                    </p>
                  )}
                  {w.decision?.status === "pending" && (
                    <div className="work-decision">
                      <strong>
                        {w.language?.speech?.question ?? "Your decision"}
                      </strong>
                      {view.now >= w.decision.expiresAt ? (
                        <p>
                          This decision window has passed. Refresh the work and
                          edit the proposal if you still want to proceed.
                        </p>
                      ) : w.control === "paused" ? (
                        <p>This is paused. Resume it before deciding.</p>
                      ) : (
                        <>
                          {w.decision.kind === "review" && (
                            <p>{w.decision.issue}</p>
                          )}
                          <p>
                            {w.decision.neededBy <= view.now
                              ? "A decision is needed now."
                              : "Please decide by " +
                                localTime(w.decision.neededBy, w.timeZone) +
                                "."}
                          </p>
                          {w.language?.speech?.consequence && (
                            <p className="aiko-fineprint">
                              {w.language.speech.consequence}
                            </p>
                          )}
                        </>
                      )}
                      {w.plan && w.decision.kind === "authorize" && (
                        <>
                          <p>
                            To {w.plan.contactName} · Request now and at most
                            one reminder
                          </p>
                          <blockquote>{w.plan.requestText}</blockquote>
                          <p>
                            Reminder at{" "}
                            {localTime(w.plan.reminderAt, w.timeZone)}:
                          </p>
                          <blockquote>{w.plan.reminderText}</blockquote>
                          <p className="aiko-fineprint">
                            Aiko will flag missing items by{" "}
                            {localTime(w.plan.escalateAt, w.timeZone)}.
                            Telegram’s current reply permission and reply window
                            must still allow each send.
                          </p>
                        </>
                      )}
                      <div className="work-actions">
                        {(w.decision.kind === "authorize" ||
                          w.status === "candidate") && (
                          <button
                            disabled={
                              busy ||
                              w.control !== "active" ||
                              w.handling !== "aiko" ||
                              view.now >= w.decision.expiresAt
                            }
                            onClick={() =>
                              void perform({
                                action: "decide",
                                operationId: crypto.randomUUID(),
                                id: w.id,
                                expectedVersion: w.version,
                                decisionId: w.decision!.id,
                                planDigest: w.decision!.planDigest,
                                choice: "approve",
                              })
                            }
                          >
                            {w.decision.kind === "authorize"
                              ? "Authorize request and reminder"
                              : "Accept commitment"}
                          </button>
                        )}
                        <button
                          disabled={busy}
                          onClick={() => void change(w, "takeover")}
                        >
                          I’ll handle this
                        </button>
                      </div>
                    </div>
                  )}
                  {w.preparationNote && (
                    <div className="work-note">
                      <strong>Preparation note</strong>
                      <p>{w.preparationNote}</p>
                    </div>
                  )}
                  <details>
                    <summary>Evidence and history</summary>
                    <p>{w.successCondition}</p>
                    <p className="aiko-fineprint">{w.coverage}</p>
                    {w.evidenceRefs.length > 0 && (
                      <p>
                        {w.evidenceRefs.length} recorded evidence reference
                        {w.evidenceRefs.length === 1 ? "" : "s"}.
                      </p>
                    )}
                    {w.receipts.map((r) => (
                      <p key={r.id}>
                        {r.action === "request" ? "Request" : "Reminder"}:{" "}
                        {r.status === "started"
                          ? "Delivery uncertain"
                          : r.status}
                        {r.reason ? " — " + r.reason : ""}
                      </p>
                    ))}
                  </details>
                  {!["completed", "cancelled"].includes(w.status) && (
                    <div className="work-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void change(
                            w,
                            w.control === "paused" || w.handling === "owner"
                              ? "resume"
                              : "pause",
                          )
                        }
                      >
                        {w.control === "paused" || w.handling === "owner"
                          ? "Resume with Aiko"
                          : "Pause"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void change(w, "cancel")}
                      >
                        Withdraw
                      </button>
                    </div>
                  )}
                  <WorkDetailsControls
                    key={w.version}
                    work={w}
                    busy={busy}
                    change={(action, extra) => change(w, action, extra)}
                  />
                </article>
              ))}
          </div>
          <details className="work-handoffs">
            <summary>Contact handoffs</summary>
            {!view.contacts.length && (
              <p>Contacts appear after an observed Secretary Mode message.</p>
            )}
            {view.contacts.map((c) => (
              <div
                className="work-item-heading"
                key={JSON.stringify([c.connectionId, c.chat])}
              >
                <span>{c.name}</span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      action: "contact",
                      operationId: crypto.randomUUID(),
                      connectionId: c.connectionId,
                      chat: c.chat,
                      expectedRevision: c.handlingRevision,
                      handling: c.handling === "owner" ? "aiko" : "owner",
                    })
                  }
                >
                  {c.handling === "owner"
                    ? "Hand back to Aiko"
                    : "I’ll handle this contact"}
                </button>
              </div>
            ))}
          </details>
          {view.attention && (
            <AttentionControls
              key={view.attention.revision}
              attention={view.attention}
              busy={busy}
              save={(preferences) =>
                perform({
                  action: "attention",
                  operationId: crypto.randomUUID(),
                  expectedRevision: view.attention!.revision,
                  preferences,
                })
              }
            />
          )}
          <p className="aiko-fineprint">{view.coverage}</p>
        </>
      )}
    </section>
  );
}

function AttentionControls({
  attention,
  busy,
  save,
}: {
  attention: Attention;
  busy: boolean;
  save: (p: Attention["preferences"]) => Promise<boolean>;
}) {
  const p = attention.preferences;
  const [enabled, setEnabled] = useState(p.enabled);
  const [limit, setLimit] = useState(p.dailyLimit);
  const [quiet, setQuiet] = useState(!!p.quietHours);
  const time = (minutes: number) =>
    String(Math.floor(minutes / 60)).padStart(2, "0") +
    ":" +
    String(minutes % 60).padStart(2, "0");
  const [start, setStart] = useState(time(p.quietHours?.startMinute ?? 1320));
  const [end, setEnd] = useState(time(p.quietHours?.endMinute ?? 420));
  const zone =
    p.quietHours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutes = (value: string) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return (
    <details>
      <summary>When Aiko updates you</summary>
      <form
        className="work-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            ...p,
            enabled,
            dailyLimit: limit,
            quietHours: quiet
              ? {
                  timeZone: zone,
                  startMinute: minutes(start),
                  endMinute: minutes(end),
                }
              : null,
          });
        }}
      >
        <label>
          <span>Proactive updates</span>
          <select
            value={enabled ? "on" : "off"}
            onChange={(e) => setEnabled(e.target.value === "on")}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label>
          Daily update limit
          <input
            required
            type="number"
            min={0}
            max={200}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </label>
        <label>
          <span>Quiet hours</span>
          <select
            value={quiet ? "on" : "off"}
            onChange={(e) => setQuiet(e.target.value === "on")}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
        {quiet && (
          <div className="work-times">
            <label>
              From
              <input
                required
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Until
              <input
                required
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <p className="aiko-fineprint">
          Quiet hours use {zone}. These preferences apply to all Aiko proactive
          updates. Decisions remain visible here even when notifications are
          deferred or disabled.
        </p>
        <button disabled={busy} type="submit">
          Save update preferences
        </button>
      </form>
    </details>
  );
}

function WorkDetailsControls({
  work: w,
  busy,
  change,
}: {
  work: Work;
  busy: boolean;
  change: (action: string, extra?: object) => Promise<boolean>;
}) {
  const [mode, setMode] = useState("");
  const [reviewAt, setReviewAt] = useState("");
  const [evidence, setEvidence] = useState("");
  const [outcome, setOutcome] = useState(w.outcome);
  const [requestText, setRequestText] = useState(w.plan?.requestText ?? "");
  const [reminderText, setReminderText] = useState(w.plan?.reminderText ?? "");
  const [due, setDue] = useState(dateInput(w.dueAt));
  const [reminder, setReminder] = useState(dateInput(w.plan?.reminderAt));
  const [escalate, setEscalate] = useState(dateInput(w.plan?.escalateAt));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const terminal = w.status === "completed" || w.status === "cancelled";
  async function submit(e: FormEvent) {
    e.preventDefault();
    const extra =
      mode === "complete"
        ? { evidence }
        : mode === "edit"
          ? {
              outcome,
              successCondition: w.successCondition,
              accountableParty: w.accountableParty,
              nextAction: w.nextAction,
              dueAt: due ? new Date(due).getTime() : null,
              timeZone,
              dependencyRefs: w.dependencyRefs,
              ...(w.plan
                ? {
                    plan: {
                      ...w.plan,
                      requestText,
                      reminderText,
                      reminderAt: new Date(reminder).getTime(),
                      escalateAt: new Date(escalate).getTime(),
                    },
                  }
                : {}),
            }
          : {
              nextReviewAt: new Date(reviewAt).getTime(),
              waitingFor: w.accountableParty,
            };
    if (await change(mode, extra)) setMode("");
  }
  return (
    <details className="work-edit">
      <summary>Adjust this work</summary>
      <div className="work-actions">
        {terminal ? (
          <button disabled={busy} onClick={() => setMode("reopen")}>
            Reopen
          </button>
        ) : (
          <>
            <button disabled={busy} onClick={() => setMode("review")}>
              Review later
            </button>
            <button disabled={busy} onClick={() => setMode("complete")}>
              Confirm completion
            </button>
            {!w.receipts.length && (
              <button disabled={busy} onClick={() => setMode("edit")}>
                Edit proposal
              </button>
            )}
          </>
        )}
      </div>
      {mode && (
        <form className="work-form" onSubmit={submit}>
          {mode === "complete" ? (
            <label>
              What confirms the outcome?
              <textarea
                required
                maxLength={4000}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
            </label>
          ) : mode === "edit" ? (
            <>
              <label>
                Outcome
                <input
                  required
                  maxLength={1000}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
              </label>
              <label>
                Outcome due{!w.plan && " (optional)"}
                <input
                  required={!!w.plan}
                  type="datetime-local"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </label>
              {w.plan && (
                <>
                  <label>
                    Request message
                    <textarea
                      required
                      maxLength={2000}
                      value={requestText}
                      onChange={(e) => setRequestText(e.target.value)}
                    />
                  </label>
                  <label>
                    Reminder message
                    <textarea
                      required
                      maxLength={2000}
                      value={reminderText}
                      onChange={(e) => setReminderText(e.target.value)}
                    />
                  </label>
                  <label>
                    Remind at
                    <input
                      required
                      type="datetime-local"
                      value={reminder}
                      onChange={(e) => setReminder(e.target.value)}
                    />
                  </label>
                  <label>
                    Tell me if still missing by
                    <input
                      required
                      type="datetime-local"
                      value={escalate}
                      onChange={(e) => setEscalate(e.target.value)}
                    />
                  </label>
                  <p className="aiko-fineprint">
                    Changing the proposal requires fresh authorization.
                  </p>
                </>
              )}
              <p className="aiko-fineprint">Times are in {timeZone}.</p>
            </>
          ) : (
            <label>
              Next review ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              <input
                required
                type="datetime-local"
                value={reviewAt}
                onChange={(e) => setReviewAt(e.target.value)}
              />
            </label>
          )}
          <div className="work-actions">
            <button disabled={busy} type="submit">
              Save change
            </button>
            <button type="button" disabled={busy} onClick={() => setMode("")}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </details>
  );
}
