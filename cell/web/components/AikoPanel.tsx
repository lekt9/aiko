"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { who: "user" | "aiko"; text: string; code?: string; goal?: string };

// Aiko lives in the editor — n8n's assistant slot, backed by what is real here:
// the firings DB, the discovered cells, and inert-until-admitted proposals.
// The chat does NOT run a model; drafting is the engine's own `run.py draft`
// verb (gated by cell/tests/gates/draft-verb.sh). Agent turns stay at the edge.
export default function AikoPanel({ activeCell, onClose, onCreated }: { activeCell: string; onClose: () => void; onCreated?: (rel: string) => void }) {
  const [firings, setFirings] = useState<any[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([{
    who: "aiko",
    text: "I'm resident in this editor. Every workflow here is a *.cell.yaml I can fire, watch, and extend. Describe a step and I'll draft the cell via the engine's draft verb — deterministic, and inert until admitted by digest.",
  }]);
  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => fetch("/api/firings").then(r => r.json()).then(j => setFirings(j.firings ?? [])).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMsgs(m => [...m, { who: "user", text }]);
    try {
      const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: text, kind: "python" }) });
      const j = await r.json();
      if (j.ok) {
        const p = j.proposal;
        setMsgs(m => [...m, {
          who: "aiko",
          text: `Engine draft "${p.name}" · proposal ${String(p.proposal_digest).slice(0, 8)} — ${p.admission}. The stub refuses to run until implemented, so nothing is retained on compilation alone.`,
          code: p.files?.[`${p.name}.cell.yaml`],
          goal: text,
        }]);
      } else {
        setMsgs(m => [...m, { who: "aiko", text: `The engine refused this draft: ${j.error}` }]);
      }
    } catch (e: any) {
      setMsgs(m => [...m, { who: "aiko", text: `Draft failed: ${String(e.message ?? e)}` }]);
    }
  }

  return (
    <div className="nx-drawer" role="dialog" aria-label="Aiko">
      <div className="nx-drawer__head">
        <span className="nx-drawer__title">🤖 Aiko · resident agent</span>
        <span className="nx-tag">{activeCell}</span>
        <button className="nx-btn" onClick={onClose}>✕</button>
      </div>
      <div className="nx-drawer__body" ref={bodyRef}>
        <div className="nx-section">Drop-in harness · what is live vs designed</div>
        <div className="nx-exec-row" style={{ display: "block", lineHeight: 1.6 }}>
          <div><span className="dot ok" /> <b>Proven:</b> deterministic cell firing (this canvas), staffing refuses shortfall, escalation terminates, redrive → CompensationGap.</div>
          <div><span className="dot ok" /> <b>Proven (aiko-flow):</b> telegram-aiko-bridge — poll cursor → typing indicator (4s refresh) → typed reply union.</div>
          <div><span className="dot warn" /> <b>Designed:</b> live customer channels (WhatsApp/PSA/Sheets) — no production token wired here.</div>
        </div>
        <div className="nx-section">Recent firings ({firings.length})</div>
        {firings.slice(0, 5).map((f: any) => (
          <div key={f.id} className="nx-exec-row">
            <span className="dot ok" />
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(f.cell).split("/").pop()}</span>
            <span style={{ marginLeft: "auto", color: "var(--nx-text-3)", whiteSpace: "nowrap" }}>{String(f.id).slice(0, 8)}</span>
          </div>
        ))}
        <div className="nx-section">Chat</div>
        {msgs.map((m, i) => (
          <div key={i} className={`nx-chatmsg ${m.who === "user" ? "nx-chatmsg--user" : "nx-chatmsg--aiko"}`}>
            {m.text}
            {m.code && <pre>{m.code}</pre>}
            {m.goal && (
              <button className="nx-btn nx-btn--primary" style={{ marginTop: 8 }} onClick={async () => {
                const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: m.goal, kind: "python", write: true }) });
                const j = await r.json();
                if (j.ok && j.written) {
                  setMsgs(ms => [...ms, { who: "aiko", text: `Created ${j.written} (inert). Opening it — implement the neuron, then build + check to admit.` }]);
                  onCreated?.(j.written);
                } else {
                  setMsgs(ms => [...ms, { who: "aiko", text: `The engine refused to write: ${j.error}` }]);
                }
              }}>Create workflow</button>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--nx-hairline)" }}>
        <input className="nx-search" placeholder="Describe a step… (drafts an inert cell)" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") send(); }} />
        <button className="nx-btn nx-btn--primary" onClick={send}>Send</button>
      </div>
    </div>
  );
}
