"use client";
import { useEffect, useState } from "react";
import CellCanvas from "@/components/CellCanvas";
import Dashboard from "@/components/Dashboard";

export default function Page() {
  const [tab, setTab] = useState<"graph" | "dashboard">("dashboard");
  const [active, setActive] = useState<string>("haulio-full.cell.yaml");
  const [cells, setCells] = useState<any[]>([]);
  useEffect(()=> { fetch("/api/cells").then(r=> r.json()).then(j=> setCells(j.cells ?? [])).catch(()=>{}); }, []);
  useEffect(()=> {
    const onOpen = (e: any)=> { if (e.detail?.cellPath) { setActive(e.detail.cellPath); setTab("graph"); } };
    window.addEventListener("cell:open", onOpen as any);
    return ()=> window.removeEventListener("cell:open", onOpen as any);
  }, []);
  return (
    <div>
      {/* Workbench: functional header above the list/detail + DAG — no marketing hero */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-lg-t border border-os-border bg-os-surface p-1">
          <button onClick={()=> setTab("graph")} className={`whitespace-nowrap rounded-sm-t px-3 py-1.5 font-mono text-[11px] font-semibold outline-none transition-[background-color,color,border-color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 disabled:opacity-50 ${tab==="graph" ? "bg-os-accent text-os-ink" : "text-os-dim hover:text-os-text"}`}>Graph</button>
          <button onClick={()=> setTab("dashboard")} className={`whitespace-nowrap rounded-sm-t px-3 py-1.5 font-mono text-[11px] font-semibold outline-none transition-[background-color,color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 disabled:opacity-50 ${tab==="dashboard" ? "bg-os-accent text-os-ink" : "text-os-dim hover:text-os-text"}`}>Dashboard</button>
        </div>
        {tab==="dashboard" && <span className="hidden font-mono text-[11px] text-os-dim sm:inline whitespace-nowrap">\u2014 orders, invoices & tracking</span>}
      </div>
      {tab==="graph" && cells.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {cells.slice(0, 8).map((c:any)=>(
            <button key={c.rel} onClick={()=> setActive(c.rel)} className={`whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[11px] outline-none transition-[border-color,background-color,color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 disabled:opacity-50 ${active===c.rel ? "border-os-accent bg-os-accent text-os-ink" : "border-os-border bg-os-surface text-os-dim hover:border-[var(--border-strong)]"}`}>{c.name}</button>
          ))}
        </div>
      )}
      {tab === "graph" ? <CellCanvas /> : <Dashboard cellPath={active} onPickCell={setActive} />}
    </div>
  );
}
