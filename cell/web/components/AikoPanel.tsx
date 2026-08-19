"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { who: "user" | "aiko"; text: string; code?: string; goal?: string };

// Aiko lives in the editor — n8n's assistant slot. Chat is a REAL agent turn
// through THE daemon (run.py daemon → aiko CLI over stdio). When the daemon is
// down, the panel says so and falls back to the engine's deterministic draft
// verb — never silently pretending a model answered.
export default function AikoPanel({ activeCell, onClose, onCreated }: { activeCell: string; onClose: () => void; onCreated?: (rel: string) => void }) {
  const [firings, setFirings] = useState<any[]>([]);
  const [daemon, setDaemon] = useState<{ up: boolean; agent?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{
    who: "aiko",
    text: "I'm resident in this editor. With the daemon running, this chat is a real aiko turn over stdio; without it, I fall back to the engine's deterministic draft verb — inert until admitted by digest either way.",
  }]);
  const [input, setInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => fetch("/api/firings").then(r => r.json()).then(j => setFirings(j.firings ?? [])).catch(() => {});
    const pollDaemon = () => fetch("/api/aiko").then(r => r.json()).then(j => setDaemon({ up: !!(j.daemon && j.ok), agent: j.agent_bin })).catch(() => setDaemon({ up: false }));
    load(); pollDaemon();
    const t = setInterval(() => { load(); pollDaemon(); }, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [msgs]);

  async function draftFallback(text: string, prefix: string) {
    const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: text, kind: "python" }) });
    const j = await r.json();
    if (j.ok) {
      const p = j.proposal;
      setMsgs(m => [...m, {
        who: "aiko",
        text: `${prefix}Engine draft "${p.name}" · proposal ${String(p.proposal_digest).slice(0, 8)} — ${p.admission}. The stub refuses to run until implemented.`,
        code: p.files?.[`${p.name}.cell.yaml`],
        goal: text,
      }]);
    } else {
      setMsgs(m => [...m, { who: "aiko", text: `${prefix}The engine refused this draft: ${j.error}` }]);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs(m => [...m, { who: "user", text }]);
    setBusy(true);
    try {
      const r = await fetch("/api/aiko", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: `You are Aiko, resident in the cell workflow editor. Active workflow: ${activeCell}. The user says: ${text}` }) });
      const j = await r.json();
      if (j.daemon === false) {
        await draftFallback(text, "Daemon offline (start: python3 cell/run.py daemon) — falling back to the deterministic engine draft. ");
      } else if (j.ok) {
        setMsgs(m => [...m, { who: "aiko", text: j.output || "(empty reply)" }]);
      } else {
        setMsgs(m => [...m, { who: "aiko", text: `Agent turn failed: ${j.error}` }]);
      }
    } catch (e: any) {
      setMsgs(m => [...m, { who: "aiko", text: `Agent turn failed: ${String(e.message ?? e)}` }]);
    }
    setBusy(false);
  }

  return (
    <div className="nx-drawer" role="dialog" aria-label="Aiko">
      <div className="nx-drawer__head">
        <span className="nx-drawer__title">🤖 Aiko · resident agent</span>
        <span className="nx-tag" title={daemon?.up ? `daemon up · agent ${daemon.agent}` : "daemon down — chat falls back to engine drafts"}>
          <span className={`dot ${daemon?.up ? "ok" : "off"}`} style={{ marginRight: 4 }} />daemon {daemon?.up ? "on" : "off"}
        </span>
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
        <input className="nx-search" placeholder={daemon?.up ? "Ask Aiko… (real agent turn via daemon)" : "Describe a step… (daemon off — engine draft)"} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") send(); }} disabled={busy} />
        <button className="nx-btn nx-btn--primary" onClick={send} disabled={busy}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}
