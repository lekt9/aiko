"use client";
import { useEffect, useState } from "react";
import CellCanvas from "@/components/CellCanvas";
import Dashboard from "@/components/Dashboard";

export default function Page() {
  const [tab, setTab] = useState<"graph" | "dashboard">("dashboard");
  const [active, setActive] = useState<string>("hoysan-pipeline.cell.yaml");
  const [cells, setCells] = useState<any[]>([]);
  useEffect(()=> {
    fetch("/api/cells").then(r=> r.json()).then(j=>{
      const list = j.cells ?? [];
      setCells(list);
      if (list.length && !list.find((c:any)=> c.rel===active)) {
        const preferred = list.find((c:any)=> c.rel==="hoysan-pipeline.cell.yaml") ?? list.find((c:any)=> c.rel.endsWith("hoysan-pipeline.cell.yaml")) ?? list[0];
        setActive(preferred.rel);
      }
    }).catch(()=>{});
  }, []);
  useEffect(()=> {
    const onOpen = (e: any)=> { if (e.detail?.cellPath) { setActive(e.detail.cellPath); setTab("graph"); } };
    window.addEventListener("cell:open", onOpen as any);
    return ()=> window.removeEventListener("cell:open", onOpen as any);
  }, []);
  return (
    <div className="view space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[11px] font-bold uppercase tracking-[0.18em] text-os-text">Haulio — TMS</h1>
          <p className="mt-2 max-w-[52ch] font-mono text-[11px] leading-relaxed text-os-dim">A fractal harness for haulage ops. Orders flow through a typed DAG — portal → dispatch → tracking and billing — with fleet and job-pool alongside.</p>
          <div className="mt-3 inline-flex items-center gap-1 rounded-lg-t border border-os-border bg-os-surface p-1" role="tablist" aria-label="Workspace">
            <button role="tab" aria-selected={tab==="dashboard"} onClick={()=> setTab("dashboard")} className={`whitespace-nowrap rounded-sm-t px-3 py-1.5 font-mono text-[11px] font-semibold outline-none transition-[background-color,color,border-color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 ${tab==="dashboard" ? "bg-os-accent text-os-ink" : "text-os-dim hover:text-os-text"}`}>Dashboard</button>
            <button role="tab" aria-selected={tab==="graph"} onClick={()=> setTab("graph")} className={`whitespace-nowrap rounded-sm-t px-3 py-1.5 font-mono text-[11px] font-semibold outline-none transition-[background-color,color,border-color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 ${tab==="graph" ? "bg-os-accent text-os-ink" : "text-os-dim hover:text-os-text"}`}>Graph</button>
          </div>
        </div>
        <div className="hidden items-center gap-2 font-mono text-[10px] text-os-dim md:flex" aria-hidden>
          <span className="dot ok pulse" />
          <span>live from manifest + DB</span>
        </div>
      </div>
      {tab==="graph" && cells.length > 1 && (
        <div className="flex flex-wrap gap-1" aria-label="Cell selector">
          {cells.slice(0, 8).map((c:any)=>(
            <button key={c.rel} aria-pressed={active===c.rel} onClick={()=> setActive(c.rel)} className={`whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[11px] outline-none transition-[border-color,background-color,color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 ${active===c.rel ? "border-os-accent bg-os-accent text-os-ink" : "border-os-border bg-os-surface text-os-dim hover:border-[var(--border-strong)]"}`}>{c.name}</button>
          ))}
        </div>
      )}
      {tab === "graph" ? <CellCanvas /> : <Dashboard cellPath={active} onPickCell={setActive} />}
    </div>
  );
}
