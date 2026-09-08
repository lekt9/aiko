import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import { ArrowLeft, ArrowUpRight, RefreshCw, Table2 } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import { DatabaseLayout } from "./database-layouts";
import { DatabaseLayoutControls, useDatabaseViewSave, type DatabaseViewSave } from "./database-layout-controls";
import { DatabaseRefreshControls, useDatabaseRefresh } from "./database-refresh-controls";
import type { DatabasePresentation } from "../lib/database-layouts";
import { databaseClient, parseCellDraft, type ApprovalDetail, type DatabaseArtifactResult, type DatabaseAuthentication, type DatabaseClient, type DatabaseColumn, type DatabaseFieldResult, type DatabaseRow } from "../lib/databases";
import type { DatabaseCommandInput, DatabaseOperationResult, DatabaseQuery } from "@unlock/sdk/aiko";
import "../styles/databases.css";

export const databaseCatalog = defineCatalog(schema, { components: { DatabaseView: { props: z.object({ artifactId: z.string() }).strict(), description: "An authenticated saved database view. Data and edits come from the host client." } }, actions: {} });
const inertSpec = z.object({ root: z.literal("database"), elements: z.object({ database: z.object({ type: z.literal("DatabaseView"), props: z.object({ artifactId: z.string() }).strict(), children: z.tuple([]).default([]) }).strict() }).strict() }).strict();
export function databaseRenderSpec(data: DatabaseArtifactResult): Spec | undefined {
  if (data.artifact.renderer.kind !== "json-render" || data.artifact.renderer.catalogVersion !== "aiko-db/v1") return;
  const raw = data.artifact.spec ?? { root: "database", elements: { database: { type: "DatabaseView", props: { artifactId: data.artifact.artifactId } } } };
  const parsed = inertSpec.safeParse(raw);
  if (!parsed.success || parsed.data.elements.database.props.artifactId !== data.artifact.artifactId || !databaseCatalog.validate(parsed.data).success) return;
  return parsed.data;
}
type ViewContext = { presentation: DatabasePresentation; changePresentation: (next: DatabasePresentation) => void; saveView: DatabaseViewSave; currentQuery: DatabaseQuery; openArtifact: (id: string) => void; data: DatabaseArtifactResult; client: DatabaseClient; inline: boolean; reload: () => Promise<void>; run: (command: DatabaseCommandInput["command"], key: string) => Promise<void>; query: (change: Partial<DatabaseQuery>) => Promise<void>; signal: AbortSignal; setDirty: (value: boolean, key?: string) => void };
const View = createContext<ViewContext | null>(null);
const useView = () => { const value = useContext(View); if (!value) throw Error("Database view context missing"); return value; };
const textOf = (value: unknown) => value === null ? "Empty" : typeof value === "object" ? JSON.stringify(value) : String(value);
const draftOf = (value: unknown) => value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

function CellValue({ row, column }: { row: DatabaseRow; column: DatabaseColumn }) {
  const cell = row.cells[column.id];
  const value = !cell || cell.state === "missing" ? "Not set" : cell.state === "unavailable" ? "Unavailable" : cell.state === "error" ? "Error" : textOf(cell.value);
  return <span className={`db-cell-value ${cell?.state !== "ready" ? "db-muted" : ""}`}><span>{value}</span>{cell?.freshness === "stale" && <small className="db-stale">Stale</small>}</span>;
}
function RelationInput({ column, value, change, disabled }: { column: DatabaseColumn; value: string; change: (text: string) => void; disabled: boolean }) {
  const { client, signal } = useView();
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]), [error, setError] = useState("");
  useEffect(() => { const abort = new AbortController(); void client.query({ tableId: column.relation!.tableId, limit: 100 }, AbortSignal.any([signal, abort.signal])).then(result => {
    if (abort.signal.aborted) return;
    const label = result.columns.find(c => c.type === "text" && !c.binding)?.id;
    setOptions(result.rows.map(row => ({ id: row.id, label: label && row.cells[label]?.state === "ready" ? textOf(row.cells[label]!.value) : row.id })));
    if (result.nextCursor) setError("Showing the first 100 related records.");
  }).catch(error => { if (!abort.signal.aborted) setError(error.message); }); return () => abort.abort(); }, [client, column.relation?.tableId, signal]);
  const many = column.relation?.cardinality === "many-to-many";
  let selected: string | string[] = value;
  if (many) { try { selected = JSON.parse(value || "[]"); } catch { selected = []; } }
  return <><select aria-label={column.name} multiple={many} disabled={disabled} value={selected} onChange={event => change(many ? JSON.stringify([...event.target.selectedOptions].map(o => o.value)) : event.target.value)}>
    {!many && <option value="">Choose a record</option>}{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select>{error && <small className="db-muted">{error}</small>}</>;
}
function FieldInput({ column, value, change, disabled = false }: { column: DatabaseColumn; value: string; change: (text: string) => void; disabled?: boolean }) {
  if (column.type === "relation") return <RelationInput {...{ column, value, change, disabled }} />;
  if (column.type === "enum" || column.type === "boolean") return <select aria-label={column.name} value={value} disabled={disabled} onChange={e => change(e.target.value)}><option value="">Choose a value</option>{(column.options ?? ["true", "false"]).map(value => <option key={value}>{value}</option>)}</select>;
  if (column.type === "json") return <textarea aria-label={column.name} value={value} disabled={disabled} onChange={e => change(e.target.value)} rows={4} />;
  return <input aria-label={column.name} value={value} disabled={disabled} inputMode={column.type === "integer" || column.type === "decimal" ? "decimal" : undefined} placeholder={column.type === "timestamp" ? "2026-09-08T09:00:00Z" : undefined} onChange={e => change(e.target.value)} />;
}

function MemoryFieldEditor({ column, record, field }: { column: DatabaseColumn; record: NonNullable<DatabaseRow["records"]>[string]; field: string }) {
  const { client, signal, setDirty, reload, data } = useView(), draftId = useId();
  const writeAllowed = data.result.capabilities?.write === true;
  const controller = useRef(new AbortController());
  const submitted = useRef<DatabaseCommandInput | undefined>(undefined), initialized = useRef(false);
  const [detail, setDetail] = useState<DatabaseFieldResult>(), [value, setValue] = useState(""), [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [error, setError] = useState(""), [outcome, setOutcome] = useState<DatabaseOperationResult>();
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => { current.abort(); setDirty(false, draftId); }; }, [draftId]);
  const unresolved = !!submitted.current && (!outcome || outcome.status === "queued" || outcome.bridge?.pending === true);
  const load = async () => {
    if (busy || unresolved) return;
    const requestSignal = AbortSignal.any([signal, controller.current.signal]);
    setBusy(true); setError(""); setEditing(true); setDirty(true, draftId);
    try {
      const next = await client.field({ tableId: record.tableId, rowId: record.rowId, columnId: field }, requestSignal);
      if (requestSignal.aborted) return;
      // Keep an existing draft when reviewing a concurrent memory change.
      if (!initialized.current && next.memory) { setValue(draftOf(next.memory.current.value)); setEmpty(next.memory.current.value === null); initialized.current = true; }
      setDetail(next); submitted.current = undefined; setOutcome(undefined);
    } catch (e) { if (!requestSignal.aborted) { setDetail(undefined); setError((e as Error).message); } }
    finally { if (!requestSignal.aborted) setBusy(false); }
  };
  const save = async () => {
    if (busy || !writeAllowed || !detail?.memory?.canCorrect) return;
    const requestSignal = AbortSignal.any([signal, controller.current.signal]);
    setBusy(true); setError("");
    try {
      submitted.current ??= { idempotencyKey: crypto.randomUUID(), command: { kind: "mapping.correct", mappingId: detail.memory.mappingId, expectedMappingRevision: detail.memory.mappingRevision, expectedRowRevision: detail.rowRevision, expectedObservationId: detail.memory.observationId, values: { [field]: (empty ? null : parseCellDraft(detail.column, value)) as never } } };
      const result = await client.commit(submitted.current, requestSignal);
      if (!requestSignal.aborted) {
        setOutcome(result);
        if (result.status === "committed") { setDirty(false, draftId); await reload(); }
      }
    } catch (e) { if (!requestSignal.aborted) setError(submitted.current ? "The update could not be confirmed. Check it before editing again." : (e as Error).message); }
    finally { if (!requestSignal.aborted) setBusy(false); }
  };
  const result = outcome?.receipt?.result;
  const receipt = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
  const message = !outcome ? "" : outcome.status === "queued" || outcome.bridge?.pending ? "The memory update is still unresolved. Check update to read its status." : receipt?.appliedToMemory === true
    ? outcome.status !== "committed" || receipt.projectionUpdated !== true ? "Memory updated; the table needs reconciliation. Review latest memory before making another correction."
      : receipt.baselineUpdated === false ? "Memory and table updated. Unpublished local changes remain." : "Memory and table updated."
    : outcome.status === "conflict" ? "Memory or this record changed. Your draft is kept. Review latest memory before saving again." : "The correction was not applied. Review current values and access before trying again.";
  if (!editing) return <button type="button" disabled={busy} onClick={() => void load()}>{writeAllowed ? "Edit memory" : "View memory"}</button>;
  return <div className="db-memory-editor">
    <p className="db-muted">{writeAllowed ? "Saving changes the linked memory. Other memory fields stay as they are." : "Current value from the linked memory."}</p>
    {detail?.memory ? <>
      <p>Reviewed memory: {detail.memory.current.state === "ready" ? textOf(detail.memory.current.value) : detail.memory.current.state === "missing" ? "Not set" : "Value does not match this field’s type"}{detail.memory.current.freshness === "stale" ? " · Stale" : ""}</p>
      {writeAllowed && detail.memory.canCorrect ? <><FieldInput column={column} value={value} disabled={busy || empty || !!submitted.current} change={setValue} />
        {column.nullable && <label className="db-check"><input type="checkbox" checked={empty} disabled={busy || !!submitted.current} onChange={e => setEmpty(e.target.checked)} /> Empty memory value</label>}
        <button type="button" disabled={busy || !!submitted.current && !unresolved} onClick={() => void save()}>{busy ? "Working…" : unresolved ? "Check update" : "Save to memory"}</button>
      </> : <p>This field cannot be corrected with your current access or source settings.</p>}
    </> : !busy && !error ? <p>This field has no editable memory mapping.</p> : null}
    {busy && <p role="status">Loading memory update…</p>}{message && <p role="status">{message}</p>}{error && <p role="alert" className="db-error">{error}</p>}
    <button type="button" disabled={busy || unresolved} onClick={() => void load()}>Review latest memory</button>
  </div>;
}

function CellEditor({ row, column }: { row: DatabaseRow; column: DatabaseColumn }) {
  const { data, run, reload, setDirty } = useView(), key = useRef(crypto.randomUUID()), draftId = useId();
  useEffect(() => () => setDirty(false, draftId), [draftId]);
  const cell = row.cells[column.id], initial = draftOf(cell?.value);
  const [value, setValue] = useState(initial), [empty, setEmpty] = useState(cell?.value === null), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const parts = column.id.split("."), alias = parts.length > 1 && row.records?.[parts[0]!] ? parts[0]! : "$root";
  const record = row.records?.[alias], field = alias === "$root" ? column.id : parts.slice(1).join(".");
  const actions = data.result.capabilities?.records[row.id];
  const editable = data.artifact.dataMode === "live" && record && actions?.editFields.includes(column.id) === true;
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!editable || saving) return;
    setSaving(true); setError("");
    try { const parsed = empty ? null : parseCellDraft(column, value); await run({ kind: "rows.upsert", tableId: record.tableId, rows: [{ id: record.rowId, expectedRevision: record.revision, values: { [field]: parsed as never } }] }, key.current); setDirty(false, draftId); await reload(); }
    catch (error) { setError((error as Error).message); } finally { setSaving(false); }
  };
  const memoryEditable = data.artifact.dataMode === "live" && record && actions?.reviewMemoryFields.includes(column.id) === true;
  return <form className="db-field" onSubmit={save}><label>{column.name}</label>{editable ? <>
    <FieldInput column={column} value={value} disabled={saving || empty} change={text => { setValue(text); setDirty(true, draftId); key.current = crypto.randomUUID(); }} />
    {column.nullable && <label className="db-check"><input type="checkbox" checked={empty} disabled={saving} onChange={e => { setEmpty(e.target.checked); setDirty(true, draftId); key.current = crypto.randomUUID(); }} /> Empty value</label>}
    <button disabled={saving || value === initial && empty === (cell?.value === null)}>{saving ? "Saving…" : "Save field"}</button>
  </> : <CellValue row={row} column={column} />}
    {memoryEditable && <MemoryFieldEditor column={column} record={record} field={field} />}
    {column.binding && column.binding.kind !== "literal" && <small className="db-muted">{column.binding.kind === "request" ? "Linked to a live source" : column.binding.kind === "entity" ? "Linked to memory" : "Calculated field"}</small>}
    {cell?.checkedAt !== undefined && <small className="db-muted">Checked {new Date(cell.checkedAt).toLocaleString()}</small>}
    {error && <p role="alert" className="db-error">{error}</p>}
  </form>;
}
function ApprovalRecord({ id, close }: { id: string; close: () => void }) {
  const { client, signal, reload } = useView();
  const [detail, setDetail] = useState<ApprovalDetail>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const next = await client.approval(id, signal); if (!signal.aborted) { setDetail(next); setError(""); } } catch (e) { if (!signal.aborted) { setDetail(undefined); setError((e as Error).message); } } }, [client, id, signal]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
  const decide = async (decision: "approve" | "reject") => {
    if (!detail || !detail.canDecide || busy) return;
    setBusy(true); setError("");
    try { await client.decide(detail, decision, signal); await load(); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="db-record" aria-label="Review action"><button onClick={close}><ArrowLeft size={16} /> Back to table</button><h3>Review action</h3>
    {error && <p role="alert" className="db-error">{error}</p>}{!detail && !error && <p role="status">Loading current action…</p>}
    {detail && <><dl><dt>Operation</dt><dd>{detail.prepared.operation}</dd><dt>Connection</dt><dd>{detail.prepared.connectionId}</dd><dt>Approval</dt><dd>{detail.state}</dd><dt>Execution</dt><dd>{detail.outcome ?? "No confirmed outcome"}</dd><dt>Expires</dt><dd>{new Date(detail.prepared.expiresAt).toLocaleString()}</dd></dl>
      <h4>Exact action details</h4><pre className="db-payload">{JSON.stringify(detail.prepared.payload, null, 2)}</pre>
      <p className="db-muted">Approval allows this exact action. Execution is tracked separately.</p>
      <div className="db-actions">{detail.canDecide && <><button className="db-primary" disabled={busy || detail.prepared.expiresAt <= Date.now()} onClick={() => void decide("approve")}>Approve action</button><button disabled={busy || detail.prepared.expiresAt <= Date.now()} onClick={() => void decide("reject")}>Reject action</button></>}<button disabled={busy} onClick={() => void load()}>Reload details</button></div>
    </>}
  </section>;
}
function NewRecord({ close }: { close: () => void }) {
  const { data, run, reload, setDirty } = useView(), rowId = useRef(crypto.randomUUID()), operation = useRef(crypto.randomUUID());
  const [columns] = useState(() => data.result.columns.filter(c => data.result.capabilities?.createFields.includes(c.id)));
  const canCreate = data.result.capabilities?.createRows === true;
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); if (busy || !data.result.capabilities?.createRows) return; setBusy(true); setError(""); try {
    const values = Object.fromEntries(columns.filter(c => Object.hasOwn(drafts, c.id) || c.required).map(c => [c.id, parseCellDraft(c, drafts[c.id] ?? "")]));
    await run({ kind: "rows.upsert", tableId: data.view.query.tableId, rows: [{ id: rowId.current, expectedRevision: 0, values: values as never }] }, operation.current); setDirty(false); await reload(); close();
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <form className="db-record" onSubmit={submit}><button type="button" onClick={close}><ArrowLeft size={16} /> Back to table</button><h3>New record</h3>{columns.map(column => <div className="db-field" key={column.id}><label>{column.name}{column.required ? " *" : ""}</label><FieldInput column={column} value={drafts[column.id] ?? ""} disabled={busy || !canCreate} change={value => { setDrafts(d => ({ ...d, [column.id]: value })); setDirty(true); operation.current = crypto.randomUUID(); }} /></div>)}{error && <p role="alert" className="db-error">{error}</p>}{canCreate ? <button className="db-primary" disabled={busy}>{busy ? "Saving…" : "Add record"}</button> : <p role="status">Your draft is kept. Creating records is unavailable with current access or view fields.</p>}</form>;
}
function DatabaseGrid() {
  const { data, inline, query, setDirty, currentQuery, openArtifact, presentation, changePresentation, saveView } = useView();
  const [selected, setSelected] = useState<string>(), [adding, setAdding] = useState(false), [search, setSearch] = useState("");
  const [reviewing, setReviewing] = useState<string>();
  const [sort, setSort] = useState(data.view.query.sort);
  const row = data.result.rows.find(r => r.id === selected);
  const close = () => { setSelected(undefined); setAdding(false); setReviewing(undefined); setDirty(false); };
  const controls = <div hidden={adding || !!row}>{!inline && <DatabaseLayoutControls presentation={presentation} change={changePresentation} columns={data.result.columns} query={currentQuery} title={data.artifact.title} canSave={data.result.capabilities?.saveView === true} saveState={saveView} open={openArtifact} />}</div>;
  if (adding) return <>{controls}<NewRecord close={close} /></>;
  if (row) {
    const actions = data.result.capabilities?.records[row.id]?.actions ?? [];
    const approval = actions.find(action => action.kind === "approval.review" && (action.recordId === reviewing || Object.keys(row.records ?? {}).length === 1));
    if (approval && data.artifact.dataMode === "live") return <>{controls}<ApprovalRecord id={approval.recordId} close={close} /></>;
    return <>{controls}<section className="db-record" aria-label="Record details"><button onClick={close}><ArrowLeft size={16} /> Back to table</button><h3>Record details</h3>{actions.map(action => <button key={`${action.kind}:${action.recordId}`} onClick={() => setReviewing(action.recordId)}>{action.label}</button>)}{data.result.columns.map(column => <CellEditor key={`${row.id}:${row.revision}:${column.id}`} row={row} column={column} />)}</section></>;
  }
  const columns = inline && presentation.layout === "table" ? data.result.columns.slice(0, 4) : data.result.columns;
  const rows = inline ? data.result.rows.slice(0, 5) : data.result.rows;
  const writable = data.result.capabilities?.createRows === true;
  const searchable = data.result.columns.find(c => c.type === "text" && c.id !== "$id");
  return <>
    {controls}
    {(data.view.query.tableId === "system.approvals" || data.view.query.joins?.some(join => join.tableId === "system.approvals")) && <p className="db-empty">Includes foreground action approvals. Other approval queues are not included.</p>}
    {!inline && <div className="db-toolbar"><form onSubmit={e => { e.preventDefault(); if (searchable) void query({ cursor: undefined, filter: search ? { op: "and", filters: [...(data.view.query.filter ? [data.view.query.filter] : []), { field: searchable.id, op: "contains", value: search }] } : data.view.query.filter }); }}><input aria-label="Filter records" placeholder={searchable ? `Filter ${searchable.name.toLowerCase()}` : "Filter unavailable"} value={search} disabled={!searchable || data.artifact.dataMode === "snapshot"} onChange={e => setSearch(e.target.value)} /><button disabled={!searchable || data.artifact.dataMode === "snapshot"}>Filter</button></form>{writable && <button className="db-primary" onClick={() => setAdding(true)}>Add record</button>}</div>}
    {presentation.layout !== "table" ? <DatabaseLayout rows={rows} columns={columns} presentation={presentation} open={inline ? undefined : setSelected} /> : <div className="db-table-scroll" tabIndex={0} aria-label="Scrollable database table"><table><thead><tr>{columns.map(column => <th key={column.id} scope="col">{inline || data.artifact.dataMode === "snapshot" ? column.name : <button onClick={() => { const next: DatabaseQuery["sort"] = [{ field: column.id, direction: sort?.[0]?.field === column.id && sort[0].direction === "asc" ? "desc" : "asc" }]; setSort(next); void query({ cursor: undefined, sort: next }); }}>{column.name}</button>}</th>)}{!inline && <th scope="col"><span className="db-visually-hidden">Record details</span></th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{columns.map(column => <td key={column.id}><CellValue {...{ row, column }} /></td>)}{!inline && <td><button aria-label={`Open record ${row.cells[columns[0]?.id ?? ""]?.value ?? row.id}`} onClick={() => setSelected(row.id)}>Open</button></td>}</tr>)}</tbody></table></div>}
    {!rows.length && <p className="db-empty">No records in this view.{writable ? " Add a record to get started." : ""}</p>}
    <footer className="db-table-footer"><span>{rows.length} loaded · {data.result.matched} matched{data.result.coverage === "partial" ? " · Partial results" : ""}</span>{!inline && data.artifact.dataMode === "live" && data.result.nextCursor && <button onClick={() => void query({ cursor: data.result.nextCursor })}>Next page</button>}</footer>
  </>;
}
const { registry } = defineRegistry(databaseCatalog, { components: { DatabaseView: ({ props }) => { const { data } = useView(); return props.artifactId === data.artifact.artifactId ? <DatabaseGrid /> : <p role="alert">This view is unavailable.</p>; } } });

export function DatabaseArtifact({ artifactId, client: supplied, authentication, inline = true }: { artifactId: string; client?: DatabaseClient; authentication?: DatabaseAuthentication; inline?: boolean }) {
  const client = useMemo(() => supplied ?? databaseClient(authentication), [supplied, authentication?.bearer, authentication?.telegram]);
  const [data, setData] = useState<DatabaseArtifactResult>(), [error, setError] = useState(""), [openedArtifact, setOpenedArtifact] = useState<string>(), [busy, setBusy] = useState(false);
  const abort = useRef(new AbortController()), dirty = useRef(new Set<string>()), page = useRef<DatabaseQuery | undefined>(undefined);
  const readGeneration = useRef(0), activeQuery = useRef<number | undefined>(undefined);
  const [signal, setSignal] = useState(abort.current.signal);
  const [presentation, setPresentation] = useState<DatabasePresentation>();
  const [editorVersion, setEditorVersion] = useState(0);
  const saveView = useDatabaseViewSave(client, signal);
  const refreshSources = useDatabaseRefresh(client, signal);
  const reload = useCallback(async (requestSignal = abort.current.signal, discardDraft = false) => {
    const generation = ++readGeneration.current;
    let resolvedQuery = page.current;
    try {
      const next = await client.artifact(artifactId, requestSignal);
      if (requestSignal.aborted || generation !== readGeneration.current) return;
      if (next.artifact.dataMode === "live" && resolvedQuery && JSON.stringify(resolvedQuery) !== JSON.stringify(next.view.query)) {
        try { next.result = await client.query(resolvedQuery, requestSignal); }
        catch (e) {
          if ((e as { status?: number }).status !== 409) throw e;
          const { cursor: _cursor, ...firstPage } = resolvedQuery;
          next.result = await client.query(firstPage, requestSignal); resolvedQuery = firstPage;
        }
      }
      if (!requestSignal.aborted && generation === readGeneration.current) {
        if (discardDraft && dirty.current.size) {
          dirty.current.clear();
          setEditorVersion(version => version + 1);
        }
        if (!dirty.current.size) { setData(next); page.current = resolvedQuery ?? next.view.query; setError(""); }
        else { setData(previous => previous ? { ...previous, result: { ...previous.result, capabilities: next.result.capabilities } } : previous); setError(""); }
      }
    } catch (e) { if (!requestSignal.aborted && generation === readGeneration.current) {
      const status = (e as { status?: number }).status;
      // A transient read failure must not discard a draft. Pause edits until a fresh read
      // confirms access; explicit read denial or removal still clears displayed data.
      if (dirty.current.size && (status === undefined || status >= 500)) setData(previous => {
        if (!previous) return previous;
        const capabilities = previous.result.capabilities;
        return { ...previous, result: { ...previous.result, capabilities: capabilities ? { ...capabilities, write: false, saveView: false, createRows: false,
          records: Object.fromEntries(Object.entries(capabilities.records).map(([id, record]) => [id, { ...record, editFields: [] }])) } : undefined } };
      });
      else { dirty.current.clear(); setData(undefined); }
      setError((e as Error).message);
    } }
  }, [client, artifactId]);
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller; setSignal(controller.signal);
    dirty.current.clear(); page.current = undefined; activeQuery.current = undefined; setBusy(false); setPresentation(undefined); setData(undefined); setError("");
    let running = false;
    const poll = async () => {
      if (running || activeQuery.current !== undefined || controller.signal.aborted) return;
      running = true;
      try {
        // Access can change independently of row revisions. Reauthorize every poll.
        await reload(controller.signal);
      } finally { running = false; }
    };
    const timer = setInterval(() => void poll(), 3000); void poll();
    return () => { clearInterval(timer); controller.abort(); };
  }, [client, reload]);
  const run = async (command: DatabaseCommandInput["command"], key: string) => {
    const operation = await client.commit({ idempotencyKey: key, command }, abort.current.signal);
    if (operation.status !== "committed") throw Error(operation.status === "conflict" ? "This record changed. Reload it before saving again." : operation.status === "queued" ? "The update is still queued. Check its status before changing this record again." : "The update was rejected. Check the field values and your access.");
  };
  const query = async (change: Partial<DatabaseQuery>) => {
    if (!data || data.artifact.dataMode === "snapshot") return; setBusy(true);
    const requestSignal = abort.current.signal;
    const generation = ++readGeneration.current; activeQuery.current = generation;
    try {
      const next = { ...(page.current ?? data.view.query), ...change };
      for (const key of Object.keys(next) as (keyof DatabaseQuery)[]) if (next[key] === undefined) delete next[key];
      const result = await client.query(next, requestSignal);
      if (!requestSignal.aborted && generation === readGeneration.current) { page.current = next; setData({ ...data, result }); setError(""); }
    } catch (e) {
      if (!requestSignal.aborted && generation === readGeneration.current) { dirty.current.clear(); setData(undefined); setError((e as Error).message); }
    } finally { if (!requestSignal.aborted && activeQuery.current === generation) { activeQuery.current = undefined; setBusy(false); } }
  };
  const spec = data && databaseRenderSpec(data), title = useId();
  return <article className={`db-artifact ${inline ? "db-inline" : "db-expanded"}`} aria-labelledby={title} aria-busy={busy}>
    <header className="db-artifact-header"><Table2 size={20} aria-hidden="true" /><div><h2 id={title}>{data?.artifact.title ?? "Database"}</h2><p>{data?.artifact.dataMode === "snapshot" ? "Frozen snapshot" : "Live view"}</p></div><button aria-label="Reload table" onClick={() => { if (!dirty.current.size || window.confirm("Discard unsaved changes and reload this table?")) void reload(undefined, true); }}><RefreshCw size={17} /></button>{inline && <button onClick={() => setOpenedArtifact(artifactId)}>Open <ArrowUpRight size={16} /></button>}</header>
    {error && <><p className="db-error" role="alert">{error}</p><button onClick={() => void reload()}>Retry refresh</button></>}{!data && !error && <p className="db-empty" role="status">Loading your table…</p>}
    {data && !spec && <p role="alert" className="db-error">This view format is unavailable.</p>}
    {!inline && data && spec && data.artifact.dataMode === "live" && <DatabaseRefreshControls selection={data.result.capabilities?.refresh} state={refreshSources} reload={reload} allowed={!error && data.result.capabilities?.write === true} />}
    {data && spec && <View.Provider key={editorVersion} value={{ data, client, inline, reload, run, query, signal, saveView, presentation: presentation ?? { layout: data.view.layout, ...(data.view.titleField ? { titleField: data.view.titleField } : {}), ...(data.view.groupField ? { groupField: data.view.groupField } : {}), ...(data.view.dateField ? { dateField: data.view.dateField } : {}), ...(data.view.valueField ? { valueField: data.view.valueField } : {}) }, changePresentation: setPresentation, currentQuery: page.current ?? data.view.query, openArtifact: setOpenedArtifact, setDirty: (value, key = "record") => { if (value) dirty.current.add(key); else if (key === "record") dirty.current.clear(); else dirty.current.delete(key); } }}><JSONUIProvider registry={registry} initialState={{}} handlers={{}}><Renderer spec={spec} registry={registry} /></JSONUIProvider></View.Provider>}
    {openedArtifact && <MiniAppScreen title={openedArtifact === artifactId ? data?.artifact.title ?? "Database" : "Saved view"} close={() => setOpenedArtifact(undefined)}><DatabaseArtifact artifactId={openedArtifact} client={client} inline={false} /></MiniAppScreen>}
  </article>;
}
