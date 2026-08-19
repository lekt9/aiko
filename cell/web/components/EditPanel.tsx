"use client";
import { useEffect, useState } from "react";

// Edit the active cell's YAML. Saving goes through the engine's `save` verb
// (validator-bound, root-jailed) — a cell the engine would refuse to fire is
// refused here with the engine's own error text.
export default function EditPanel({ cellPath, onClose, onSaved }: { cellPath: string; onClose: () => void; onSaved?: () => void }) {
  const [text, setText] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/cell?path=${encodeURIComponent(cellPath)}`, { cache: "no-store" })
      .then(r => r.json())
      .then(j => setText(j.source ?? ""))
      .catch(() => setMsg("could not load source"));
  }, [cellPath]);

  async function save() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: cellPath, content: text }) });
      const j = await r.json();
      if (j.ok) {
        setMsg(`✓ saved · digest ${String(j.digest).slice(0, 8)}`);
        onSaved?.();
      } else {
        setMsg(String(j.error ?? "save failed"));
      }
    } catch (e: any) {
      setMsg(String(e.message ?? e));
    }
    setBusy(false);
  }

  return (
    <div className="nx-drawer" role="dialog" aria-label="Edit cell" style={{ width: "min(560px, 94vw)" }}>
      <div className="nx-drawer__head">
        <span className="nx-drawer__title">Edit · {cellPath}</span>
        <button className="nx-btn nx-btn--primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button className="nx-btn" onClick={onClose}>✕</button>
      </div>
      <div className="nx-drawer__body" style={{ gap: 8 }}>
        <textarea className="nx-jsonedit" style={{ minHeight: "60vh" }} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        {msg && <pre className="nx-pre" style={{ flex: "none", maxHeight: 160, ...(msg.startsWith("✓") ? {} : { color: "var(--nx-error)" }) }}>{msg}</pre>}
        <div className="nx-item__sub">The engine validates before writing — an invalid cell is refused, not saved broken.</div>
      </div>
    </div>
  );
}
