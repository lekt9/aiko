"use client";
import { useEffect, useState } from "react";

const LEAF_TEMPLATES: Record<string, any> = {
  exec: { kind: "exec", command: ["python3", "neurons/new.py"] },
  python: { kind: "python", entry: "neurons/new.py" },
  http: { kind: "http", http: { method: "GET", url: "https://api.example.com/v1/data" } },
};

export default function Palette({ onAdd }: { onAdd: (name:string, cellYaml:string)=>void }) {
  const [cells, setCells] = useState<any[]>([]);
  const [name, setName] = useState("my-leaf");
  const [kind, setKind] = useState<"exec"|"python"|"http">("python");
  useEffect(()=>{ fetch("/api/cells").then(r=>r.json()).then(j=>setCells(j.cells??[])); }, []);
  function generate() {
    const yaml = `apiVersion: cell/v0\nkind: Cell\nmetadata:\n  name: ${name}\n  description: generated leaf \u2014 ${kind}\nspec:\n  membrane:\n    inputs:\n      data: { schema: string }\n    outputs:\n      result: { schema: string }\n  run:\n    kind: ${kind}\n` + (kind==="exec" ? `    command: ["python3", "neurons/${name}.py"]\n` : kind==="python" ? `    entry: neurons/${name}.py\n` : `    http:\n      method: GET\n      url: https://api.example.com/v1/data\n`);
    onAdd(name, yaml);
  }
  return (
    <div className="rounded-lg-t border border-os-border bg-os-surface p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-os-dim">Palette \u2014 n8n style \u00B7 self-generating</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="name" className="h-7 min-h-[28px] whitespace-nowrap rounded-sm-t border border-os-border bg-os-bg px-2 py-1 font-mono text-[11px] outline-none transition-[border-color] focus:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-55" />
        <select value={kind} onChange={e=>setKind(e.target.value as any)} className="h-7 min-h-[28px] whitespace-nowrap rounded-sm-t border border-os-border bg-os-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2">
          <option value="python">python</option><option value="exec">exec</option><option value="http">http</option>
        </select>
        <button onClick={generate} className="h-7 shrink-0 whitespace-nowrap rounded-sm-t bg-os-accent px-3 py-1 font-mono text-[11px] font-semibold text-os-ink outline-none transition-[opacity] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80">+ Generate</button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 max-[700px]:grid-cols-[minmax(0,1fr)]">
        {cells.slice(0,8).map((c:any)=>(
          <div key={c.rel} className="min-w-0 rounded-sm-t border border-os-hairline bg-os-bg px-2.5 py-2">
            <div className="truncate font-mono text-[11px] font-semibold">{c.name}</div>
            <div className="truncate font-mono text-[10px] text-os-dim">{c.rel}</div>
            <div className="mt-1 whitespace-nowrap font-mono text-[10px] tabular-nums text-os-dim">{c.isLeaf ? `leaf \u00B7 ${c.run?.kind}` : `${c.organelles?.length??0} organelles`}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 font-mono text-[10px] text-os-dim">Entry-node proposal (from membrane.inputs): <span className="text-os-accent">Generates next organelle from inserted data</span> \u2014 deterministic harness, agentic proposal at the edge.</div>
    </div>
  );
}
