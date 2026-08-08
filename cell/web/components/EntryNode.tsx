"use client";
import { useState } from "react";
import { Handle, Position } from "reactflow";

export default function EntryNode({ data }: any) {
  const [json, setJson] = useState<string>(JSON.stringify(data.inputs ?? data.inputsRaw ?? { order: { id: "ord-demo-001", job_type: "import", pickup: "PSA", dropoff: "Jurong" } }, null, 2));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  async function fire() {
    setBusy(true); setMsg("");
    try {
      const parsed = JSON.parse(json);
      const res = await fetch("/api/run", { method: "POST", headers:{ "content-type":"application/json"}, body: JSON.stringify({ cell: data.cell, inputs: parsed })});
      const j = await res.json();
      setMsg(j.ok ? `ok \u00B7 ${j.manifest?.produced_by?.slice(0,8) ?? ""} \u00B7 ${Object.keys(j.outputs??{}).join(", ")}` : `exit ${j.code}: ${(j.stderr||j.stdout).slice(0,300)}`);
      data.onFired?.(j);
    } catch (e:any) { setMsg(String(e.message ?? e)); }
    setBusy(false);
  }
  return (
    <div className="min-w-0 rounded-lg-t border border-os-accent bg-os-surface px-3 py-3 shadow-[0_0_0_1px_var(--accent-line)]" style={{ width: 360, maxWidth: "min(360px, 86vw)" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.16em] text-os-accent">Entry \u00B7 membrane.inputs</span>
        <span className="dot ok pulse shrink-0" aria-hidden />
      </div>
      <div className="mt-1 min-w-0 truncate text-[12px] font-semibold" style={{ overflowWrap: "anywhere" }}>{data.cell}</div>
      <div className="mt-1 font-mono text-[10px] text-os-dim">{Object.keys(data.membrane?.inputs ?? {}).join(", ") || "no inputs"}</div>
      <textarea value={json} onChange={e=>setJson(e.target.value)} rows={8} className="mt-2 w-full min-h-[44px] rounded-sm-t border border-os-border bg-os-bg p-2 font-mono text-[11px] outline-none transition-[border-color] duration-[var(--dur-short)] placeholder:text-os-dim focus:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-55" spellCheck={false} />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={fire} disabled={busy} className="shrink-0 whitespace-nowrap rounded-sm-t bg-os-accent px-3 py-1.5 font-mono text-[11px] font-semibold text-os-ink outline-none transition-[opacity,border-color] duration-[var(--dur-short)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "\u2026running" : "\u25B6 Run"}</button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-os-dim">{msg}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--accent)" }} />
    </div>
  );
}
