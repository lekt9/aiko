import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { decidePromise, listPromises, pendingPromiseCount, promiseAccessDenied, promiseStatus, type PromiseDecision, type PromiseRequest, type PromiseReview } from "../lib/promises";
import { pollWhileVisible } from "../lib/poll";

type Props = { request: PromiseRequest; authScope: string; onPendingCount?: (count: number) => void; children: ReactNode };
type ReviewState = { rows?: PromiseReview[]; error: string; notice: string; busy?: string; fresh: boolean; refresh(): Promise<void>; decide(row: PromiseReview, decision: PromiseDecision): Promise<void> };
const PromiseReviewContext = createContext<ReviewState | undefined>(undefined);
/** One persistent account subscription supplies root and full-screen reviews.
 * Navigation never remounts an uncertain decision or creates a second poller. */
export function PromisesProvider(props: Props) { return <PromiseAccountProvider key={props.authScope} {...props} />; }
function PromiseAccountProvider({ request, onPendingCount, children }: Props) {
  const latest = useRef({ request, onPendingCount }); latest.current = { request, onPendingCount };
  const [rows, setRows] = useState<PromiseReview[]>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();
  const [fresh, setFresh] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const order = useRef(0), submitting = useRef(false);
  async function refresh() {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || submitting.current) return;
    const revision = ++order.current;
    try {
      const result = await listPromises(latest.current.request, controller.signal);
      if (controller.signal.aborted || revision !== order.current) return;
      setRows(result.promises); setFresh(true); setError("");
      latest.current.onPendingCount?.(pendingPromiseCount(result.promises));
    } catch (failure) {
      if (controller.signal.aborted || revision !== order.current) return;
      setFresh(false);
      if (promiseAccessDenied(failure)) { setRows(undefined); latest.current.onPendingCount?.(0); }
      setError(promiseAccessDenied(failure) ? "Your access changed. Reopen Aiko to review your tasks." : "Could not refresh tasks. Your last view is kept; refresh before deciding.");
    }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    latest.current.onPendingCount?.(0);
    void refresh();
    const stopPolling = pollWhileVisible(() => { void refresh(); }, 5000);
    return () => { stopPolling(); controller.abort(); ++order.current; };
  }, []);
  async function decide(row: PromiseReview, decision: PromiseDecision) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || submitting.current || !fresh) return;
    submitting.current = true; ++order.current; setBusy(row.id); setError(""); setNotice("");
    try {
      const result = await decidePromise(latest.current.request, row, decision, controller.signal);
      if (controller.signal.aborted) return;
      setRows(previous => {
        const updated = previous?.map(item => item.id === row.id ? result.promise : item);
        return updated;
      });
      setNotice(promiseStatus(result.promise));
    } catch (failure) {
      if (controller.signal.aborted) return;
      setFresh(false);
      if (promiseAccessDenied(failure)) { setRows(undefined); latest.current.onPendingCount?.(0); }
      setError(promiseAccessDenied(failure) ? "Your access changed. Reopen Aiko to review your tasks." : "Could not confirm your decision. Refresh its status before deciding again; it may already be saved.");
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }
  useEffect(() => { if (rows) latest.current.onPendingCount?.(pendingPromiseCount(rows)); }, [rows]);
  return <PromiseReviewContext.Provider value={{ rows, error, notice, busy, fresh, refresh, decide }}>{children}</PromiseReviewContext.Provider>;
}

export function PromisesPanel() {
  const review = useContext(PromiseReviewContext);
  if (!review) throw Error("PromisesPanel requires the account PromisesProvider");
  const { rows, error, notice, busy, fresh, refresh, decide } = review;
  const heading = useRef<HTMLHeadingElement>(null);
  function choose(event: MouseEvent<HTMLButtonElement>, row: PromiseReview, decision: PromiseDecision) {
    const button = event.currentTarget;
    const fallback = button.closest("details")?.querySelector("summary") ?? heading.current;
    void decide(row, decision).then(() => requestAnimationFrame(() => {
      // Disabling/removing the clicked control can strand keyboard focus on body.
      // Never take it from a newer draft or return it behind an active screen.
      const target = button.isConnected ? button : fallback;
      if (document.activeElement === document.body && target?.isConnected && !target.closest("[inert],[hidden]")) target.focus();
    }));
  }
  return <section aria-label="Promises" className="secretary-work-panel">
    <h3 ref={heading} tabIndex={-1}>Promises</h3>
    <p>Review the exact task before approving. Approval starts this frozen task once, using your current permissions.</p>
    <button type="button" onClick={() => void refresh()} disabled={!!busy}>Refresh tasks</button>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!rows && !error ? <p role="status">Loading tasks…</p> : null}
    {rows?.length === 0 ? <p>No tasks to review.</p> : null}
    {rows?.map(row => {
      const pending = row.state === "pending", expired = row.expiresAt <= Date.now();
      return <article key={row.id} aria-label={row.label} style={{ marginBlock: "1rem", overflowWrap: "anywhere" }}>
        <h4>{row.label}</h4>
        <p>{promiseStatus(row)}</p>
        <p>{row.when.kind === "at" ? `Scheduled for ${new Date(row.when.at).toLocaleString()}. ` : row.when.kind === "hook" ? `Triggered by ${row.when.eventType}. ` : ""}Expires {new Date(row.expiresAt).toLocaleString()}</p>
        <details><summary>Review frozen source and final inputs</summary>
          <p>Only approve if you understand what this code will do. If the final message or destination needs a change, decline and ask Aiko to prepare a new task.</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.payload.segment.code}</pre>
          <h5>Final inputs</h5><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(row.payload.segment.values, null, 2)}</pre>
          <h5>Requested tools</h5><pre style={{ whiteSpace: "pre-wrap" }}>{Object.keys(row.payload.segment.packages).length ? JSON.stringify(row.payload.segment.packages, null, 2) : "Standard tools: search, describe, call, retain, query, bind, load, drop. Every call still requires current permission."}</pre>
        </details>
        {pending && row.when.kind === "approval" && !expired ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <button type="button" disabled={!!busy || !fresh} onClick={event => choose(event, row, "approve")}>{busy === row.id ? "Saving decision…" : "Approve this task"}</button>
          <button type="button" disabled={!!busy || !fresh} onClick={event => choose(event, row, "reject")}>Decline</button>
        </div> : null}
        {(pending && row.when.kind !== "approval" || row.state === "resolved") && !expired ? <button type="button" disabled={!!busy || !fresh} onClick={event => choose(event, row, "cancel")}>Cancel before dispatch</button> : null}
        {row.state === "unknown" ? <p>No automatic retry will be made. Check the destination app and existing receipts; do not assume the action failed.</p> : null}
      </article>;
    })}
  </section>;
}
