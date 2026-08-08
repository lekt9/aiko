"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Renderer,
  StateProvider,
  VisibilityProvider,
  ValidationProvider,
  ActionProvider,
} from "@json-render/react";
import { registry } from "@/lib/registry";

type Entity = {
  id: string; blockId: string; port: string; direction: "input"|"output";
  label: string; subtitle: string | null; tone: string | null;
  schemaTitle: string | null; renderVia: string;
  relationKeys: string[]; relations: Record<string,string>;
  parentId: string | null; raw: any; view: any;
};
type Block = { id: string; port: string; direction: "input"|"output"; schema: any; render: any; data: any; relationKeys: string[]; entities: Entity[] };
type DashboardModel = { cell: any; blocks: Block[]; entities: Entity[]; links: any[]; deps: any; manifest: any };

function titleForPort(port: string) {
  if (port === "order") return "Order";
  if (port === "invoice") return "Invoice";
  if (port === "tracking") return "Tracking";
  if (port === "job_pool") return "Job Pool";
  if (port === "fleet") return "Fleet";
  return port.replaceAll("_", " ").replace(/\b\w/g, c=> c.toUpperCase());
}

function specForEntity(entity: Entity, opts?: { compact?: boolean }): any {
  const raw = entity.raw;
  const isRow = entity.parentId != null;
  const compact = opts?.compact ?? isRow;
  // Row detail: headerless — list row already shows label/subtitle, don't repeat as BlockHeader.
  if (compact) {
    // Exclude keys already shown as label/subtitle to avoid duplication.
    const labelSet = new Set([String(entity.label), String(entity.subtitle ?? "")]);
    const kvs = Object.entries(raw ?? {})
      .filter(([k, v]) => v != null && typeof v !== "object" && !labelSet.has(String(v)) && k !== "id" && k !== "job_id" && k !== "asset_id")
      .slice(0, 4)
      .map(([k, v]) => ({ k, v: String(v) }));
    // If nothing left beyond what the row already shows, don't render a card at all — caller can skip.
    if (!kvs.length) return null;
    return {
      root: "root",
      elements: {
        root: { type: "Block", props: {}, children: ["grid"] },
        grid: { type: "KVGrid", props: { pairs: kvs }, children: [] },
      },
    };
  }
  const flatPairs = Object.entries(raw ?? {})
    .filter(([_, v]) => v != null && typeof v !== "object")
    .slice(0, 6)
    .map(([k, v]) => ({ k, v: String(v) }));
  const rows: any[] =
    entity.port === "fleet" && Array.isArray(raw?.assets) ? raw.assets :
    entity.port === "job_pool" && Array.isArray(raw?.recommended_jobs) ? raw.recommended_jobs :
    entity.port === "invoice" && Array.isArray(raw?.line_items) ? raw.line_items :
    entity.port === "tracking" && Array.isArray(raw?.hcs_updates) ? raw.hcs_updates : [];
  if (rows.length === 0) {
    // De-dupe header fields from grid: id already in title.
    const filtered = flatPairs.filter(p => p.v !== entity.label && p.k.toLowerCase() !== "id");
    return {
      root: "root",
      elements: {
        root: { type: "Block", props: {}, children: ["hdr", "grid"] },
        hdr: { type: "BlockHeader", props: { title: entity.label, subtitle: entity.subtitle, tone: (entity.tone as any) ?? "neutral" }, children: [] },
        grid: { type: "KVGrid", props: { pairs: filtered.length ? filtered : flatPairs.slice(0, 4) }, children: [] },
      },
    };
  }
  const cols =
    entity.port === "fleet" ? [{ key: "asset_id", label: "Asset" }, { key: "kind", label: "Kind" }, { key: "status", label: "Status" }] :
    entity.port === "job_pool" ? [{ key: "job_id", label: "Job" }, { key: "route", label: "Route" }, { key: "price", label: "Price" }] :
    entity.port === "invoice" ? [{ key: "description", label: "Item" }, { key: "amount", label: "Amount" }] :
    [{ key: "at", label: "At" }, { key: "message", label: "Event" }];
  return {
    root: "root",
    elements: {
      root: { type: "Block", props: {}, children: ["hdr", "tbl"] },
      hdr: { type: "BlockHeader", props: { title: entity.label, subtitle: entity.subtitle, tone: (entity.tone as any) ?? "neutral" }, children: [] },
      tbl: { type: "MiniTable", props: { columns: cols, rows }, children: [] },
    },
  };
}

export default function Dashboard({ cellPath }: { cellPath: string; onPickCell?: (p:string)=>void }) {
  const [model, setModel] = useState<DashboardModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePort, setActivePort] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/cell?path=${encodeURIComponent(cellPath)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.error) { setErr(j.error); setLoading(false); return; }
      const d = j.dashboard; if (!d) { setErr("no dashboard payload"); setLoading(false); return; }
      setModel(d);
      setActivePort((prev) => prev ?? d.blocks?.[0]?.port ?? null);
      setLoading(false);
    } catch (e: any) { setErr(String(e.message ?? e)); setLoading(false); }
  }, [cellPath]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = (e: any) => {
      const { key, value } = e.detail ?? {};
      if (!key || !value || !model) return;
      const hit =
        model.entities.find((en) => en.relations?.[key] === String(value) && !en.parentId) ??
        model.entities.find((en) => en.relations?.[key] === String(value)) ?? null;
      if (!hit) return;
      setActivePort(hit.port);
      setSelectedId(hit.id);
    };
    window.addEventListener("dashboard:relation", h as any);
    return () => window.removeEventListener("dashboard:relation", h as any);
  }, [model]);

  const blockEntities = useMemo(() => (model?.entities ?? []).filter((e) => !e.parentId), [model]);
  const rowEntities = useMemo(() => (model?.entities ?? []).filter((e) => !!e.parentId), [model]);

  // rows/items for the active tab — these are the "list" in list-detail
  const rowsForActive = useMemo(() => {
    if (!model || !activePort) return [] as Entity[];
    const blockId = model.blocks.find((b) => b.port === activePort)?.id ?? null;
    if (!blockId) return [];
    const rows = rowEntities.filter((e) => e.blockId === blockId);
    // if the block has no exploded rows (e.g. Order is a single object), the list is the block itself
    if (rows.length === 0) {
      const block = blockEntities.find((e) => e.port === activePort);
      return block ? [block] : [];
    }
    return rows;
  }, [model, activePort, rowEntities, blockEntities]);

  const selected = useMemo(() => {
    if (!rowsForActive.length) return null;
    if (selectedId && rowsForActive.some((r) => r.id === selectedId)) return rowsForActive.find((r) => r.id === selectedId) ?? null;
    return rowsForActive[0] ?? null;
  }, [rowsForActive, selectedId]);

  // when switching tabs, auto-select first item
  useEffect(() => {
    if (!activePort) return;
    if (!rowsForActive.length) { setSelectedId(null); return; }
    if (!selectedId || !rowsForActive.some((r) => r.id === selectedId)) {
      setSelectedId(rowsForActive[0]?.id ?? null);
    }
  }, [activePort, rowsForActive, selectedId]);

  if (loading) return <div className="rounded-lg-t border border-os-border bg-os-surface p-6 font-mono text-[11px] text-os-dim">Loading…</div>;
  if (err) return <div className="rounded-lg-t border border-os-border bg-os-surface p-6 font-mono text-[11px] text-os-dim">Error: {err}</div>;
  if (!model) return null;

  const ports = [...new Set(blockEntities.map((e) => e.port))];
  const rowCount = (p: string) => {
    const bid = model.blocks.find((b) => b.port === p)?.id;
    const rows = rowEntities.filter((e) => e.blockId === bid).length;
    return rows || 1;
  };

  return (
    <StateProvider initialState={{}}>
      <VisibilityProvider>
        <ValidationProvider>
          <ActionProvider>
            <div className="space-y-3">
              {/* tabs — notion DB views */}
              <div className="flex flex-wrap items-center gap-1 rounded-lg-t border border-os-border bg-os-surface p-1">
                {ports.map((p) => {
                  const active = p === activePort;
                  return (
                    <button
                      key={p}
                      onClick={() => setActivePort(p)}
                      className={`whitespace-nowrap rounded-sm-t px-3 py-1.5 font-mono text-[11px] font-semibold outline-none transition-[background-color,color,border-color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 disabled:opacity-50 ${active ? "bg-os-accent text-os-ink" : "text-os-dim hover:text-os-text"}`}
                    >
                      {titleForPort(p)} <span className={`ml-1.5 font-mono text-[10px] tabular-nums ${active ? "opacity-90 text-os-ink/90" : "text-os-dim"}`}>{rowCount(p)}</span>
                    </button>
                  );
                })}
              </div>

              {/* list — detail (notion page peek). single selection, no double panels. */}
              <div className="grid grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-3 max-[900px]:grid-cols-[minmax(0,1fr)]">
                {/* list */}
                <div className="min-w-0 overflow-hidden rounded-lg-t border border-os-border bg-os-surface">
                  <div className="flex items-center justify-between gap-2 border-b border-os-hairline px-3 py-2">
                    <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">{activePort ? titleForPort(activePort) : "Records"}</span>
                    <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-os-dim">{rowsForActive.length} {rowsForActive.length === 1 ? "item" : "items"}</span>
                  </div>
                  <div className="max-h-[62vh] divide-y divide-os-hairline overflow-auto max-[900px]:max-h-none">
                    {rowsForActive.map((row) => {
                      const active = selected?.id === row.id;
                      return (
                        <button
                          key={row.id}
                          onClick={() => setSelectedId(row.id)}
                          className={`flex w-full items-center gap-3 px-3 py-3 text-left outline-none transition-[background-color,color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-[-2px] active:opacity-90 ${active ? "bg-os-accent text-os-ink" : "hover:bg-os-surface2"}`}
                        >
                          <span className={`dot shrink-0 ${active ? "bg-os-ink" : row.tone === "ok" ? "ok" : row.tone === "warn" ? "warn" : "off"}`} />
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[13px] font-medium ${active ? "text-os-ink" : ""}`}>{row.label}</span>
                            {row.subtitle && <span className={`block truncate font-mono text-[11px] ${active ? "text-os-ink/90" : "text-os-dim"}`}>{row.subtitle}</span>}
                          </span>
                          <span className={`shrink-0 font-mono text-[10px] ${active ? "text-os-ink/90" : "text-os-dim"}`} aria-hidden>&rsaquo;</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* detail */}
                <div className="min-w-0">
                  {!selected ? (
                    <div className="rounded-lg-t border border-dashed border-os-border bg-os-surface p-8 text-center font-mono text-[11px] text-os-dim">
                      Select a record to view details.
                    </div>
                  ) : (
                    <div>
                      <Renderer spec={specForEntity(selected, { compact: false })} registry={registry} />
                      {(() => {
                        const k = selected.relationKeys[0]; const v = k ? selected.relations[k] : null;
                        if (!k || !v) return null;
                        const related = blockEntities.filter((e) => e.relations[k] === String(v) && e.id !== selected.blockId && e.port !== selected.port);
                        if (!related.length) return null;
                        return (
                          <div className="mt-3 rounded-lg-t border border-os-border bg-os-surface p-3">
                            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">Related</div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {related.map((r) => (
                                <button
                                  key={r.id}
                                  onClick={() => { setActivePort(r.port); setSelectedId(r.id); }}
                                  className="whitespace-nowrap rounded-full border border-os-border bg-os-bg px-2.5 py-1 font-mono text-[11px] outline-none transition-[border-color,color] duration-[var(--dur-short)] hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80"
                                >
                                  {r.label} <span className="opacity-60">\u00B7 {titleForPort(r.port)}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </ActionProvider>
        </ValidationProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}
