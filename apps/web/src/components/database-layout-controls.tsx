import { useMemo, useState } from "react";
import type { DatabaseCommandInput, DatabaseQuery } from "@unlock/sdk/aiko";
import type { DatabaseClient, DatabaseColumn } from "../lib/databases";
import { groupTypes, layoutNames, presentationError, type DatabasePresentation } from "../lib/database-layouts";

interface Props {
  presentation: DatabasePresentation;
  change: (presentation: DatabasePresentation) => void;
  columns: DatabaseColumn[];
  query: DatabaseQuery;
  title: string;
  canSave: boolean;
  saveState: DatabaseViewSave;
  open: (artifactId: string) => void;
}
interface SavePlan { view: DatabaseCommandInput; artifact: DatabaseCommandInput; artifactId: string }
interface SaveStatus { saving: boolean; pending: boolean; message: string; saved?: string }
const emptyStatus: SaveStatus = { saving: false, pending: false, message: "" };
/** Owned by DatabaseArtifact so transient query/render failures cannot discard an admitted save. */
export function useDatabaseViewSave(client: DatabaseClient, signal: AbortSignal) {
  const session = useMemo(() => ({ plan: undefined as SavePlan | undefined, running: false }), [client, signal]);
  const [snapshot, setSnapshot] = useState({ session, status: emptyStatus });
  const status = snapshot.session === session ? snapshot.status : emptyStatus;
  const patch = (change: Partial<SaveStatus>) => {
    if (!signal.aborted) setSnapshot(previous => ({ session, status: { ...(previous.session === session ? previous.status : emptyStatus), ...change } }));
  };
  const save = async ({ presentation, columns, query, title }: Pick<Props, "presentation" | "columns" | "query" | "title">) => {
    if (session.running || signal.aborted) return;
    session.running = true; patch({ saving: true, message: "" });
    try {
      if (!session.plan) {
        const error = presentationError(presentation, columns); if (error) throw Error(error);
        const id = crypto.randomUUID(), viewId = `view.${id}`, artifactId = `artifact.${id}`;
        const name = `${title} · ${layoutNames[presentation.layout]}`;
        const { cursor: _cursor, ...savedQuery } = query;
        // Freeze both stages at the click; uncertain replies reuse these commands and keys.
        session.plan = structuredClone({
          view: { idempotencyKey: viewId, command: { kind: "view.save", expectedRevision: 0, view: { id: viewId, title: name, query: savedQuery, ...presentation } } },
          artifact: { idempotencyKey: artifactId, command: { kind: "artifact.create", artifactId, viewId, viewRevision: 1, title: name, dataMode: "live" } }, artifactId,
        });
        patch({ pending: true });
      }
      for (const [stage, command] of [["view", session.plan.view], ["artifact", session.plan.artifact]] as const) {
        const result = await client.commit(command, signal);
        if (signal.aborted) return;
        if (result.status !== "committed") {
          if (["rejected", "conflict", "cancelled"].includes(result.status)) { session.plan = undefined; patch({ pending: false }); }
          throw Error(result.status === "queued" ? "Saving is still queued. Check save before starting another." : stage === "artifact" ? "The view was saved, but its artifact could not be created. Check your access before trying again." : "The view could not be saved. Check its fields and your access.");
        }
      }
      patch({ saved: session.plan.artifactId, pending: false, message: "Saved as a new live view of the same records." }); session.plan = undefined;
    } catch (error) { if (!signal.aborted) patch({ message: session.plan ? "Save is not confirmed yet. Check save to continue the same operation." : (error as Error).message }); }
    finally { session.running = false; patch({ saving: false }); }
  };
  return { ...status, save, clear: () => { if (!session.plan && !session.running) patch({ message: "", saved: undefined }); } };
}
export type DatabaseViewSave = ReturnType<typeof useDatabaseViewSave>;
export function DatabaseLayoutControls({ presentation, change, columns, query, title, canSave, saveState, open }: Props) {
  const { saving, pending, saved, message } = saveState;
  const update = (next: DatabasePresentation) => { change(next); saveState.clear(); };
  const layout = (layout: DatabasePresentation["layout"]) => update({
    layout,
    ...(presentation.titleField ? { titleField: presentation.titleField } : {}),
    ...(layout === "board" ? { groupField: presentation.groupField ?? columns.find(column => column.type === "enum")?.id ?? columns.find(column => groupTypes.has(column.type))?.id } : {}),
    ...(layout === "calendar" ? { dateField: presentation.dateField ?? columns.find(column => column.type === "timestamp")?.id } : {}),
    ...(layout === "chart" ? { valueField: presentation.valueField ?? columns.find(column => ["decimal", "integer"].includes(column.type))?.id } : {}),
  });
  const selector = (key: "titleField" | "groupField" | "dateField" | "valueField", label: string, eligible: DatabaseColumn[]) => <label>{label}<select aria-label={label} value={presentation[key] ?? ""} disabled={saving || pending} onChange={event => {
    const next = { ...presentation }; if (event.target.value) next[key] = event.target.value; else delete next[key]; update(next);
  }}><option value="">{key === "titleField" ? "Automatic" : "Choose a field"}</option>{eligible.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>;
  return <section className="db-layout-controls" aria-label="View layout">
    <label>Layout<select aria-label="Layout" value={presentation.layout} disabled={saving || pending} onChange={event => layout(event.target.value as DatabasePresentation["layout"])}>{Object.entries(layoutNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    {presentation.layout !== "table" && selector("titleField", "Record title", columns)}
    {presentation.layout === "board" && selector("groupField", "Group by", columns.filter(column => groupTypes.has(column.type)))}
    {presentation.layout === "calendar" && selector("dateField", "Date field", columns.filter(column => column.type === "timestamp"))}
    {presentation.layout === "chart" && selector("valueField", "Value field", columns.filter(column => ["integer", "decimal"].includes(column.type)))}
    {canSave && <button disabled={saving || !!saved} onClick={() => void saveState.save({ presentation, columns, query, title })}>{saving ? "Saving…" : pending ? "Check save" : "Save as new view"}</button>}
    {!canSave && pending && <p role="status">This save is unresolved. Edit access is needed to continue checking it.</p>}
    {saved && <button onClick={() => open(saved)}>Open saved view</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
