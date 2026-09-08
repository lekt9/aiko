import { useMemo, useState } from "react";
import type { DatabaseCommandInput, DatabaseOperationResult } from "@unlock/sdk/aiko";
import type { DatabaseClient, DatabaseQueryResult } from "../lib/databases";

type Selection = NonNullable<NonNullable<DatabaseQueryResult["capabilities"]>["refresh"]>;
interface Status { busy: boolean; pending: boolean; message: string }
const empty: Status = { busy: false, pending: false, message: "" };

export function databaseRefreshMessage(operation: DatabaseOperationResult): string {
  if (operation.status === "queued") return "Source checks are still running. Check refresh before starting another.";
  const result = operation.receipt?.result;
  const receipt = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
  if (operation.status === "committed" && receipt?.coverage === "complete") return "Source checks finished. Unsaved drafts are kept.";
  const saved = typeof receipt?.committed === "number" && receipt.committed > 0 ? " Earlier saved checks are kept." : "";
  return (operation.status === "cancelled" ? "Refresh cancelled." : operation.status === "conflict" ? "A record or source changed during refresh. Review current values before refreshing again." : "Source checks could not be completed. Check your access and source settings before refreshing again.") + saved;
}

/** The artifact owns the immutable command, not the transient grid renderer. */
export function useDatabaseRefresh(client: DatabaseClient, signal: AbortSignal) {
  const session = useMemo(() => ({ input: undefined as DatabaseCommandInput | undefined, running: false }), [client, signal]);
  const [snapshot, setSnapshot] = useState({ session, status: empty });
  const status = snapshot.session === session ? snapshot.status : empty;
  const patch = (change: Partial<Status>) => {
    if (!signal.aborted) setSnapshot(previous => ({ session, status: { ...(previous.session === session ? previous.status : empty), ...change } }));
  };
  const refresh = async (selection: Selection | undefined, reload: () => Promise<void>) => {
    if (session.running || signal.aborted || !session.input && !selection) return;
    session.running = true;
    session.input ??= { idempotencyKey: crypto.randomUUID(), command: { kind: "table.refresh", ...structuredClone(selection!), mode: "all", budget: { maxRows: 100, maxCalls: 16, maxBytes: 1048576, timeoutMs: 15000 } } };
    patch({ busy: true, pending: true, message: "Checking linked sources…" });
    try {
      // A lost acknowledgement reuses the same admitted identity; never invent
      // a new refresh occurrence merely because the HTTP response was lost.
      const operation = await client.commit(session.input, signal);
      if (signal.aborted) return;
      patch({ pending: operation.status === "queued", message: databaseRefreshMessage(operation) });
      if (operation.status !== "queued") { session.input = undefined; await reload(); }
    } catch { patch({ pending: !!session.input, message: session.input ? "Refresh is not confirmed. Check refresh to recover the same operation." : "Checks finished, but the table could not be reloaded. Reload the table to see current values." }); }
    finally { session.running = false; patch({ busy: false }); }
  };
  return { ...status, refresh };
}

export function DatabaseRefreshControls({ selection, state, reload, allowed }: {
  selection?: Selection; state: ReturnType<typeof useDatabaseRefresh>; reload: () => Promise<void>; allowed: boolean;
}) {
  if (!selection && !state.pending && !state.message) return null;
  return <section className="db-refresh-controls" aria-label="Source refresh">
    {(selection || state.pending) && allowed && <button type="button" disabled={state.busy} onClick={() => void state.refresh(selection, reload)}>{state.busy ? "Checking sources…" : state.pending ? "Check refresh" : "Refresh sources"}</button>}
    {selection && <p className="db-muted">Checks linked fields for {selection.rowIds.length} loaded record{selection.rowIds.length === 1 ? "" : "s"} and their prerequisites. Limit: 16 calls, 1 MiB, 15 seconds. Does not change external services.</p>}
    {state.pending && !allowed && <p role="status">Refresh is unresolved. Restore edit access to check the same operation.</p>}
    {state.message && <p role="status">{state.message}</p>}
  </section>;
}
