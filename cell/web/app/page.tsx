"use client";
import { useCallback, useEffect, useState } from "react";
import CellCanvas from "@/components/CellCanvas";
import Dashboard from "@/components/Dashboard";

type Tab = "editor" | "executions" | "dashboard";

export default function Page() {
  const [tab, setTab] = useState<Tab>("editor");
  const [active, setActive] = useState<string>("haulio-full.cell.yaml");
  const [cells, setCells] = useState<any[]>([]);
  const [firings, setFirings] = useState<any[]>([]);
  const [live, setLive] = useState(false);           // Active toggle — drives live firing polling
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [nodesOpen, setNodesOpen] = useState(false);
  const [aikoOpen, setAikoOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const loadCells = useCallback((pickDefault = false) => {
    fetch("/api/cells").then(r => r.json()).then(j => {
      const list = j.cells ?? [];
      setCells(list);
      if (pickDefault && list.length && !list.find((c: any) => c.rel === active)) {
        const preferred = list.find((c: any) => c.rel === "haulio-full.cell.yaml") ?? list.find((c: any) => !c.isLeaf) ?? list[0];
        setActive(preferred.rel);
      }
    }).catch(() => {});
  }, [active]);
  useEffect(() => { loadCells(true); }, []);

  const loadFirings = useCallback(() => {
    fetch("/api/firings").then(r => r.json()).then(j => setFirings(j.firings ?? [])).catch(() => {});
  }, []);
  useEffect(() => { loadFirings(); }, [loadFirings]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(loadFirings, 5000);
    return () => clearInterval(t);
  }, [live, loadFirings]);

  useEffect(() => {
    const onOpen = (e: any) => { if (e.detail?.cellPath) { loadCells(); setActive(e.detail.cellPath); setTab("editor"); } };
    const onAdd = () => { setNodesOpen(true); setAikoOpen(false); };
    window.addEventListener("cell:open", onOpen as any);
    window.addEventListener("nx:add-node", onAdd);
    return () => { window.removeEventListener("cell:open", onOpen as any); window.removeEventListener("nx:add-node", onAdd); };
  }, [loadCells]);

  const deleteCell = useCallback(async (rel: string) => {
    if (!window.confirm(`Delete ${rel}? The engine will refuse if another cell references it.`)) return;
    const r = await fetch("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: rel }) });
    const j = await r.json();
    if (!j.ok) { window.alert(j.error ?? "delete refused"); return; }
    loadCells();
    if (active === rel) setActive("haulio-full.cell.yaml");
  }, [active, loadCells]);

  const activeCell = cells.find((c: any) => c.rel === active);

  return (
    <div className="nx-shell">
      {/* left rail — n8n sidebar */}
      <aside className="nx-rail">
        <div className="nx-rail__logo" title="Aiko Flow">A</div>
        <button className="nx-rail__btn" aria-pressed={workflowsOpen} onClick={() => { setWorkflowsOpen(v => !v); setNodesOpen(false); setAikoOpen(false); }} title="Workflows — every cell is one">🗂️</button>
        <span className="nx-rail__label">Flows</span>
        <button className="nx-rail__btn" aria-pressed={tab === "executions"} onClick={() => setTab("executions")} title="Executions — recorded firings">☰</button>
        <span className="nx-rail__label">Execs</span>
        <button className="nx-rail__btn" aria-pressed={tab === "dashboard"} onClick={() => setTab("dashboard")} title="Dashboard — membrane.render views">📊</button>
        <span className="nx-rail__label">Views</span>
        <div style={{ flex: 1 }} />
        <button className="nx-rail__btn" aria-pressed={aikoOpen} onClick={() => { setAikoOpen(v => !v); setNodesOpen(false); setWorkflowsOpen(false); }} title="Aiko — resident agent">🤖</button>
        <span className="nx-rail__label">Aiko</span>
      </aside>

      <div style={{ minWidth: 0 }}>
        {/* top bar — workflow name, Active toggle, tabs */}
        <header className="nx-topbar">
          <span className="nx-crumb">Aiko Flow /</span>
          <span className="nx-wfname">{activeCell?.name ?? active}</span>
          <span className="nx-tag">{activeCell?.isLeaf ? "leaf" : `${activeCell?.organelles?.length ?? 0} nodes`}</span>
          <span className="nx-tag">cell.yaml</span>
          <nav className="nx-tabs" aria-label="Workspace">
            <button className="nx-tab" role="tab" aria-selected={tab === "editor"} onClick={() => setTab("editor")}>Editor</button>
            <button className="nx-tab" role="tab" aria-selected={tab === "executions"} onClick={() => setTab("executions")}>Executions <span style={{ opacity: 0.7 }}>({firings.length})</span></button>
            <button className="nx-tab" role="tab" aria-selected={tab === "dashboard"} onClick={() => setTab("dashboard")}>Dashboard</button>
          </nav>
          <div style={{ flex: 1 }} />
          <span className="nx-toggle" data-on={live} onClick={() => setLive(v => !v)} role="switch" aria-checked={live} tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setLive(v => !v); }}>
            <span className="nx-toggle__track" /> {live ? "Active" : "Inactive"}
          </span>
          <span className="nx-saved"><span className="dot ok" />Saved · cells are files on disk</span>
          <button className="nx-btn" onClick={() => { setEditOpen(v => !v); setNodesOpen(false); setAikoOpen(false); }}>✎ Edit</button>
          <button className="nx-btn" onClick={() => { setAikoOpen(v => !v); setNodesOpen(false); setEditOpen(false); }}>🤖 Aiko</button>
          <button className="nx-btn nx-btn--primary" onClick={() => { setNodesOpen(v => !v); setAikoOpen(false); setEditOpen(false); }}>+ Add node</button>
        </header>

        {tab === "editor" && (
          <CellCanvas
            active={active}
            onPickCell={(p: string) => setActive(p)}
            cells={cells}
            nodesOpen={nodesOpen}
            onCloseNodes={() => setNodesOpen(false)}
            aikoOpen={aikoOpen}
            onCloseAiko={() => setAikoOpen(false)}
            editOpen={editOpen}
            onCloseEdit={() => setEditOpen(false)}
            onFired={loadFirings}
            onCellsChanged={() => loadCells()}
          />
        )}

        {tab === "executions" && (
          <main style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8, maxWidth: 860 }}>
            <div className="nx-section">Executions — firings recorded in the DB (newest first)</div>
            {firings.length === 0 && <div className="nx-exec-row" style={{ color: "var(--nx-text-3)" }}>No firings yet — open the Editor and hit Execute workflow.</div>}
            {firings.map((f: any) => (
              <div key={f.id} className="nx-exec-row">
                <span className="dot ok" />
                <span style={{ fontWeight: 600 }}>{String(f.cell).split("/").pop()}</span>
                <span style={{ color: "var(--nx-text-3)" }}>digest {String(f.id).slice(0, 8)}</span>
                <span style={{ color: "var(--nx-text-3)" }}>{(f.ports ?? []).join(", ")}</span>
                <span style={{ marginLeft: "auto", color: "var(--nx-text-3)" }}>{f.created_at}</span>
              </div>
            ))}
          </main>
        )}

        {tab === "dashboard" && (
          <main className="view nx-dashscope" style={{ padding: 20 }}>
            <Dashboard cellPath={active} onPickCell={setActive} />
          </main>
        )}
      </div>

      {/* workflows drawer — cells are workflows */}
      {workflowsOpen && (
        <div className="nx-drawer" role="dialog" aria-label="Workflows">
          <div className="nx-drawer__head">
            <span className="nx-drawer__title">Workflows · {cells.length} cells</span>
            <button className="nx-btn" onClick={() => setWorkflowsOpen(false)}>✕</button>
          </div>
          <div className="nx-drawer__body">
            {cells.map((c: any) => (
              <div key={c.rel} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="nx-item" style={{ flex: 1, minWidth: 0 }} aria-pressed={active === c.rel} onClick={() => { setActive(c.rel); setTab("editor"); setWorkflowsOpen(false); }}>
                  <span className="nx-item__icon">{c.isLeaf ? "🐍" : "🕸️"}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="nx-item__name" style={{ display: "block" }}>{c.name}</span>
                    <span className="nx-item__sub" style={{ display: "block" }}>{c.rel}</span>
                  </span>
                </button>
                <button className="nx-btn" title={`Delete ${c.rel}`} aria-label={`Delete ${c.rel}`} onClick={() => deleteCell(c.rel)}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
