"use client";
import { useEffect, useState } from "react";
import CellGraph from "./CellGraph";
import Palette from "./Palette";

export default function CellCanvas() {
  const [cells, setCells] = useState<any[]>([]);
  const [active, setActive] = useState<string>("hoysan-pipeline.cell.yaml");
  const [genMsg, setGenMsg] = useState<string>("");

  useEffect(()=>{
    fetch("/api/cells").then(r=>r.json()).then(j=>{
      setCells(j.cells ?? []);
      if (j.cells?.length && !j.cells.find((c:any)=>c.rel===active)) setActive(j.cells[0].rel);
    });
  }, [active]);

  async function handleAdd(name:string, yaml:string){
    setGenMsg(`Would write ${name}.cell.yaml \u2014 ${yaml.slice(0,80)}\u2026 (inert until admitted)`);
    // In a real n8n-self-generating flow: write inert \u2192 admit by digest \u2192 attach \u2192 run.
    // For now we surface as proposal; the harness requires build + check.
  }

  return (
    <div className="view">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-os-dim">// generic renderer \u2014 any *.cell.yaml as DAG \u00B7 entry-reactive \u00B7 subgraph = agent \u00B7 self-generating</div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 whitespace-nowrap text-[22px] font-semibold leading-none tracking-[-0.02em]" style={{ overflowWrap: "anywhere" }}>Cell Renderer <span className="whitespace-nowrap text-os-dim">\u00B7 n8n but self-generating</span> <span className="caret-blink" aria-hidden /></h1>
        <span className="ml-2 shrink-0 whitespace-nowrap rounded-full border border-os-border px-2 py-0.5 font-mono text-[10px] tabular-nums text-os-dim">{cells.length} cells discovered</span>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,320px)_minmax(0,1fr)] gap-3 max-[1000px]:grid-cols-[minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div className="rounded-lg-t border border-os-border bg-os-surface p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-os-dim">Cells</div>
            <div className="mt-2 flex max-h-[420px] flex-col gap-1 overflow-auto">
              {cells.map((c:any)=>(
                <button key={c.rel} onClick={()=>setActive(c.rel)} className={`whitespace-nowrap rounded-sm-t border px-2.5 py-2 text-left outline-none transition-[border-color,background-color,color] duration-[var(--dur-short)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 ${active===c.rel ? "border-os-accent bg-os-accent text-os-ink" : "border-os-hairline bg-os-bg hover:border-[var(--border-strong)]"}`}>
                  <div className="truncate font-mono text-[11px] font-semibold">{c.name}</div>
                  <div className={`truncate font-mono text-[10px] ${active===c.rel ? "text-os-ink/90" : "text-os-dim"}`}>{c.rel}</div>
                </button>
              ))}
            </div>
          </div>
          <Palette onAdd={handleAdd} />
          {genMsg && <div className="rounded-sm-t border border-dashed border-os-border bg-os-bg p-2 font-mono text-[11px] text-os-dim">{genMsg}</div>}
        </div>

        <div className="min-w-0">
          <CellGraph cellPath={active} onPickCell={setActive} />
        </div>
      </div>

      <div className="mt-4 rounded-lg-t border border-os-border bg-os-surface p-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-os-dim">How this is n8n but self-generating</div>
        <ul className="mt-2 list-disc space-y-1 pl-4 font-mono text-[11px] leading-relaxed text-os-muted">
          <li><b className="text-os-text">Entry node</b> = reactive membrane.inputs \u2014 edit JSON \u2192 <code className="rounded-sm-t border border-os-border bg-os-bg px-1 py-0.5">\u25B6 Run</code> fires <code>python3 run.py run</code> and downstream nodes self-build from the output (deterministic).</li>
          <li><b className="text-os-text">Cell group = subgraph = agent</b> \u2014 every composite <code>*.cell.yaml</code> is one agent; double-click expands its wiring as a nested graph (fractal).</li>
          <li><b className="text-os-text">Generic renderer</b> \u2014 any <code>*.cell.yaml</code> renders as a DAG; domain examples are just seed data.</li>
          <li><b className="text-os-text">Self-generating</b> \u2014 Palette proposes next organelle from entry data; generation stays <em>inert until admitted by digest</em> (never auto-attached).</li>
        </ul>
      </div>
    </div>
  );
}
