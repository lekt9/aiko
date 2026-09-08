import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AikoMessages } from "@unlock/sdk/aiko";
import { DatabaseArtifact } from "./database-artifact";
import { artifactLaunchId, databaseClient, type DatabaseCatalog, type DatabaseClient } from "../lib/databases";

export function databaseLaunch(search: string) {
  return new URLSearchParams(search).has("artifact") || new URLSearchParams(search).get("screen") === "databases";
}

/** Credentials stay in memory; artifact URLs contain only stable object identifiers. */
export function DatabaseWorkspace({ search }: { search: string }) {
  const [bearer, setBearer] = useState(""), [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(() => artifactLaunchId(search));
  const client = useMemo(() => databaseClient(bearer ? { bearer, telegram: false } : undefined), [bearer]);
  const invalid = new URLSearchParams(search).has("artifact") && !artifactLaunchId(search);
  const authenticate = (event: FormEvent) => { event.preventDefault(); setBearer(draft.trim()); setDraft(""); };
  return <section className="db-workspace" aria-label="Databases">
    <header><h1>Databases</h1><a href="/connect">Connections</a></header>
    <details><summary>Use an account access token</summary><form className="db-auth" onSubmit={authenticate}>
      <input type="password" aria-label="Account access token" autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={!draft.trim()}>Connect</button>
      {bearer && <button type="button" onClick={() => setBearer("")}>Clear token</button>}
    </form></details>
    {invalid ? <p role="alert">This table link is invalid.</p> : selected ? <>
      <button onClick={() => setSelected(undefined)}>All databases</button>
      <DatabaseArtifact key={`${selected}:${bearer ? "token" : "session"}`} artifactId={selected} client={client} inline={false} />
    </> : <DatabaseLibrary key={bearer ? "token" : "session"} client={client} open={setSelected} />}
  </section>;
}

function DatabaseLibrary({ client, open }: { client: DatabaseClient; open: (id: string) => void }) {
  const [catalog, setCatalog] = useState<DatabaseCatalog>(), [messages, setMessages] = useState<AikoMessages>();
  const [tab, setTab] = useState<"tables" | "conversation">("tables"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const signal = useRef(new AbortController());
  useEffect(() => {
    const abort = new AbortController(); signal.current = abort; let running = false;
    const load = async () => {
      if (running) return; running = true;
      try {
        const [nextCatalog, nextMessages] = await Promise.all([client.catalog(abort.signal), client.messages(abort.signal)]);
        if (!abort.signal.aborted) { setCatalog(nextCatalog); setMessages(nextMessages); setError(""); }
      } catch (e) { if (!abort.signal.aborted) { setCatalog(undefined); setMessages(undefined); setError((e as Error).message); } }
      finally { running = false; }
    };
    setCatalog(undefined); setMessages(undefined); void load(); const timer = setInterval(() => void load(), 3000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [client]);
  const openTable = async (tableId: string, title: string) => {
    if (busy) return; setBusy(true); setError("");
    try {
      const existingView = catalog?.views.find(view => view.value.query.tableId === tableId && view.value.layout === "table");
      // Opening a table creates a saved view and a reusable artifact through native commands.
      const viewId = existingView?.id ?? `view.${crypto.randomUUID()}`;
      if (!existingView) {
        const result = await client.commit({ idempotencyKey: viewId, command: { kind: "view.save", expectedRevision: 0, view: { id: viewId, title, layout: "table", query: { tableId, limit: 50 } } } }, signal.current.signal);
        if (result.status !== "committed") throw Error(`The view is ${result.status}. Reload the library to check its status.`);
      }
      const artifactId = `artifact.${crypto.randomUUID()}`;
      const result = await client.commit({ idempotencyKey: artifactId, command: { kind: "artifact.create", artifactId, viewId, viewRevision: existingView?.revision ?? 1, title, dataMode: "live" } }, signal.current.signal);
      if (result.status !== "committed") throw Error(`The table view is ${result.status}. Reload the library to check its status.`);
      open(artifactId);
    } catch (e) { if (!signal.current.signal.aborted) setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <nav className="db-actions" aria-label="Database views"><button aria-pressed={tab === "tables"} onClick={() => setTab("tables")}>Tables</button><button aria-pressed={tab === "conversation"} onClick={() => setTab("conversation")}>Conversation artifacts</button></nav>
    {error && <p role="alert">{error}</p>}{!catalog && !error && <p role="status">Loading your databases…</p>}
    {tab === "tables" && catalog && <>
      <h2>Saved artifacts</h2><div className="db-catalog-list">{catalog.artifacts.map(artifact => <button key={artifact.artifactId} onClick={() => open(artifact.artifactId)}>{artifact.title}{artifact.dataMode === "snapshot" ? " · Snapshot" : " · Live"}</button>)}</div>
      {!catalog.artifacts.length && <p>No saved artifacts yet. Open a table below, or ask Aiko to create one.</p>}
      <h2>Tables</h2><div className="db-catalog-list">{catalog.tables.map(table => <button key={table.id} disabled={busy} onClick={() => void openTable(table.id, table.value.name)}>{table.value.name}{table.value.mode === "domain" ? " · Live system view" : ""}</button>)}</div>
    </>}
    {tab === "conversation" && messages && <div className="db-conversation">
      {messages.messages.filter(message => message.artifacts?.length).map(message => <section key={message.id} aria-label="Conversation reply"><p>{message.text}</p>{message.artifacts!.map(artifact => artifact.state === "available" ? <DatabaseArtifact key={artifact.artifactId} artifactId={artifact.artifactId} client={client} /> : <p key={artifact.artifactId}>This table is no longer available.</p>)}</section>)}
      {!messages.messages.some(message => message.artifacts?.length) && <p>Tables attached to Aiko’s replies will appear here.</p>}
    </div>}
  </>;
}
