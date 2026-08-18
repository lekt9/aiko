"use client";
import { useMemo, useState } from "react";

const LEAF_TEMPLATES = [
  { kind: "python", icon: "🐍", label: "Python leaf", sub: "run.kind: python · neurons/<name>.py" },
  { kind: "exec", icon: "⚙️", label: "Exec leaf", sub: "run.kind: exec · command[]" },
  { kind: "http", icon: "🌐", label: "HTTP leaf", sub: "run.kind: http · method + url" },
] as const;

// n8n signature — right-side nodes panel with search; cells are the node catalog.
// Leaf generation goes through the engine's `run.py draft` verb via /api/draft —
// the panel never re-implements templates.
export default function NodesPanel({ cells, active, onPick, onClose }: { cells: any[]; active: string; onPick: (p: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [proposal, setProposal] = useState<{ text: string; error?: boolean } | null>(null);
  async function draft(kind: string) {
    try {
      const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: `new ${kind} leaf step`, kind }) });
      const j = await r.json();
      if (j.ok) {
        const p = j.proposal;
        setProposal({ text: `# ${p.name} · proposal ${String(p.proposal_digest).slice(0, 8)}\n${p.files?.[`${p.name}.cell.yaml`] ?? ""}` });
      } else setProposal({ text: `engine refused: ${j.error}`, error: true });
    } catch (e: any) {
      setProposal({ text: `draft failed: ${String(e.message ?? e)}`, error: true });
    }
  }
  const filtered = useMemo(() => cells.filter((c: any) => !q || `${c.name} ${c.rel} ${c.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [cells, q]);
  return (
    <div className="nx-drawer" role="dialog" aria-label="Nodes panel">
      <div className="nx-drawer__head">
        <span className="nx-drawer__title">What happens next?</span>
        <button className="nx-btn" onClick={onClose}>✕</button>
      </div>
      <div className="nx-drawer__body">
        <input className="nx-search" placeholder="Search nodes…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
        <div className="nx-section">Cells · open as workflow</div>
        {filtered.map((c: any) => (
          <button key={c.rel} className="nx-item" aria-pressed={active === c.rel} onClick={() => onPick(c.rel)}>
            <span className="nx-item__icon">{c.isLeaf ? (c.run?.kind === "http" ? "🌐" : c.run?.kind === "exec" ? "⚙️" : "🐍") : "🕸️"}</span>
            <span style={{ minWidth: 0 }}>
              <span className="nx-item__name" style={{ display: "block" }}>{c.name}</span>
              <span className="nx-item__sub" style={{ display: "block" }}>{c.isLeaf ? `leaf · ${c.run?.kind}` : `${c.organelles?.length ?? 0} organelles`} · {c.rel}</span>
            </span>
          </button>
        ))}
        <div className="nx-section">Generate a new leaf · inert until admitted</div>
        {LEAF_TEMPLATES.map(t => (
          <button key={t.kind} className="nx-item" onClick={() => draft(t.kind)}>
            <span className="nx-item__icon">{t.icon}</span>
            <span style={{ minWidth: 0 }}>
              <span className="nx-item__name" style={{ display: "block" }}>{t.label}</span>
              <span className="nx-item__sub" style={{ display: "block" }}>{t.sub}</span>
            </span>
          </button>
        ))}
        {proposal && (
          <div>
            <div className="nx-section">Engine proposal — write inert → admit by digest → attach</div>
            <pre className="nx-pre" style={{ maxHeight: 220, ...(proposal.error ? { color: "var(--nx-error)" } : {}) }}>{proposal.text}</pre>
            <div className="nx-item__sub" style={{ marginTop: 6 }}>Nothing is auto-attached: build + check must pass before this cell exists.</div>
          </div>
        )}
      </div>
    </div>
  );
}
