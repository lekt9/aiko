"use client";
import { Handle, Position } from "reactflow";

// n8n-style trigger node — rounded-left card with a lightning bolt; the JSON
// editor lives in the NDV (double-click), matching n8n's trigger UX.
export default function EntryNode({ data }: any) {
  const st = data.runState ?? "idle";
  return (
    <div className="nx-nodewrap" onDoubleClick={data.onOpen} title="double-click to edit input JSON">
      <div className={`nx-node nx-node--trigger ${st === "ok" ? "is-ok" : ""} ${st === "running" ? "is-running" : ""} ${st === "err" ? "is-err" : ""}`}>
        <span className="nx-node__icon" aria-hidden style={{ ["--nx-icon-hue" as any]: "var(--nx-primary)" }}>⚡</span>
        {st === "ok" && <span className="nx-badge ok">✓</span>}
        {st === "err" && <span className="nx-badge err">!</span>}
        {st === "running" && <span className="nx-badge run" />}
        <Handle type="source" position={Position.Right} className="nx-handle" />
      </div>
      <div className="nx-node__label">When input arrives</div>
      <div className="nx-node__sub">{Object.keys(data.membrane?.inputs ?? {}).join(", ") || "membrane.inputs"}</div>
    </div>
  );
}
