"use client";
import { useCallback, useEffect, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import EntryNode from "./EntryNode";

type Api = { cell: string; name?: string; description?: string; membrane: any; organelles: any[]; wiring: any[]; manifest: any; outputs: any; inputs: any; inputsRaw: any; nodes: any[]; edges: any[]; isLeaf?: boolean; error?: string };
type RunState = "idle" | "running" | "ok" | "err";

// icon reads the node's JOB; composite-ness is the AGENT badge's job, not the icon's
function iconFor(id: string) {
  if (/http|api|portal|webhook|hook/.test(id)) return "🌐";
  if (/bill|invoice|pay/.test(id)) return "🧾";
  if (/track|gps/.test(id)) return "📡";
  if (/fleet|truck|vehicle/.test(id)) return "🚚";
  if (/dispatch|route|assign/.test(id)) return "🗂️";
  if (/pool|queue|job/.test(id)) return "📥";
  if (/roster|staff|worker|gang|draft/.test(id)) return "📋";
  if (/render|dashboard|page|view/.test(id)) return "🖥️";
  if (/valid|check|confirm/.test(id)) return "✅";
  if (/escalat|remind|notify|message/.test(id)) return "📣";
  return "⚙️";
}
// stable per-node tint for the icon tile — same id, same hue, no hash randomness
function hueFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `oklch(70% 0.12 ${h})`;
}

// n8n-style node: square icon card, label BELOW the card, status ring, ✓ badge
function OrganelleNode({ data }: any) {
  const st: RunState = data.runState ?? "idle";
  return (
    <div className="nx-nodewrap" onDoubleClick={data.onOpen} title="double-click to open">
      <div className={`nx-node ${st === "ok" ? "is-ok" : ""} ${st === "running" ? "is-running" : ""} ${st === "err" ? "is-err" : ""}`}>
        <Handle type="target" position={Position.Left} className="nx-handle" />
        <span className="nx-node__icon" aria-hidden style={{ ["--nx-icon-hue" as any]: data.hue }}>{data.icon}</span>
        {st === "ok" && <span className="nx-badge ok">✓</span>}
        {st === "err" && <span className="nx-badge err">!</span>}
        {st === "running" && <span className="nx-badge run" />}
        {data.isComposite && <span className="nx-badge agent">AGENT</span>}
        {/* A node that reaches a system does so through a harness, and the canvas
            says which system — otherwise a value from a live API and a value from
            a stub look identical on screen. */}
        {data.harness && (
          <span className="nx-badge harness" title={`harness · ${data.harness.surface} · ${data.harness.system} · ${(data.harness.tools ?? []).join(", ")}`}>
            🔌
          </span>
        )}
        {data.witness && <span className="nx-badge witness" title={`settles on: ${data.witness}`}>⊨</span>}
        <Handle type="source" position={Position.Right} className="nx-handle" />
      </div>
      <div className="nx-node__label">{data.label}</div>
      {data.sub && <div className="nx-node__sub">{data.sub}</div>}
    </div>
  );
}
const nodeTypes: any = { organelle: OrganelleNode, entry: EntryNode };

function autoLayout(nodes: Node[], edges: Edge[]): Node[] {
  // dagre-free topological layout — columns by depth
  const indeg: Record<string, number> = {};
  nodes.forEach(n => indeg[n.id] = 0);
  edges.forEach(e => { if (indeg[e.target] !== undefined) indeg[e.target]++; });
  const depth: Record<string, number> = {};
  const q = Object.keys(indeg).filter(k => indeg[k] === 0);
  q.forEach(k => depth[k] = 0);
  const adj: Record<string, string[]> = {};
  edges.forEach(e => { (adj[e.source] ??= []).push(e.target); });
  const visited = new Set<string>();
  const queue = [...q];
  while (queue.length) {
    const u = queue.shift()!;
    if (visited.has(u)) continue; visited.add(u);
    for (const v of adj[u] ?? []) {
      depth[v] = Math.max(depth[v] ?? 0, (depth[u] ?? 0) + 1);
      indeg[v]--;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  const cols: Record<number, Node[]> = {};
  nodes.forEach(n => { const d = depth[n.id] ?? 0; (cols[d] ??= []).push(n); });
  const out: Node[] = [];
  Object.keys(cols).sort((a, b) => Number(a) - Number(b)).forEach(colStr => {
    const col = Number(colStr);
    cols[col].forEach((n, i) => out.push({ ...n, position: { x: 80 + col * 230, y: 90 + i * 160 } }));
  });
  return out;
}

export default function CellGraph({ cellPath, onPickCell, onFired }: { cellPath: string; onPickCell?: (p: string) => void; onFired?: () => void }) {
  const [api, setApi] = useState<Api | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [entryJson, setEntryJson] = useState<string>("{}");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runMsg, setRunMsg] = useState<string>("");
  const [ndv, setNdv] = useState<string | null>(null); // node id or "__entry"

  const rebuild = useCallback((j: Api, rs: RunState) => {
    const entryNode: Node = {
      id: "__entry", type: "entry", position: { x: 0, y: 0 },
      data: { cell: j.cell ?? cellPath, membrane: j.membrane, runState: rs, onOpen: () => setNdv("__entry") },
    };
    const organelleNodes: Node[] = (j.nodes as any[] ?? []).map((nd) => {
      let sub = "";
      if (j.outputs?.invoice && nd.id === "billing") sub = `${j.outputs.invoice.invoice_id} · SGD ${j.outputs.invoice.amount}`;
      else if (j.outputs?.tracking && nd.id === "tracking") sub = `${j.outputs.tracking.trip_id} · ${j.outputs.tracking.gps_status}`;
      else if (j.outputs?.job_pool && nd.id === "job_pool") sub = j.outputs.job_pool.recommended_jobs?.map((x: any) => x.job_id).join(", ");
      else if (j.outputs?.fleet && nd.id === "fleet") sub = j.outputs.fleet.assets?.map((a: any) => a.asset_id).join(", ");
      const isComposite = !!(nd.cell && nd.cell.endsWith(".cell.yaml"));
      const hasOutput = !!j.outputs && (nd.id in (j.outputs ?? {}));
      return {
        id: nd.id, type: "organelle", position: { x: 0, y: 0 },
        data: {
          label: nd.label ?? nd.id, sub, icon: iconFor(String(nd.id)), hue: hueFor(String(nd.id)), isComposite, cellPath: nd.cell,
          harness: nd.harness ?? null, witness: nd.witness ?? null, writes: nd.writes ?? [],
          runState: rs === "running" ? "running" : (rs === "ok" ? "ok" : (hasOutput ? "ok" : "idle")),
          onOpen: () => { if (isComposite && nd.cell) { onPickCell?.(nd.cell); } else { setNdv(nd.id); } },
        },
      };
    });
    const ran = rs === "ok" || !!(j.outputs && Object.keys(j.outputs).length);
    let e: Edge[] = (j.edges as any[] ?? []).map((ed: any) => ({
      id: ed.id, source: ed.source, target: ed.target,
      label: ran ? "1 item" : `${String(ed.from).split(".").pop()}→${String(ed.to).split(".").pop()}`,
      animated: rs === "running",
      style: { stroke: ran ? "var(--nx-success)" : "var(--nx-edge)" },
      labelStyle: { fontSize: 9, fill: ran ? "var(--nx-success)" : "var(--nx-text-3)" } as any,
    }));
    const entryEdges: Edge[] = (j.wiring as any[] ?? []).filter((w: any) => w.from.startsWith("membrane.")).map((w: any, i: number) => {
      const target = w.to.split(".")[0];
      return {
        id: `entry->${target}-${i}`, source: "__entry", target,
        label: w.from.split(".").pop() ?? "input", animated: rs === "running",
        style: { stroke: ran ? "var(--nx-success)" : "var(--nx-edge)" },
        labelStyle: { fontSize: 9, fill: ran ? "var(--nx-success)" : "var(--nx-text-3)" } as any,
      } as Edge;
    });
    e = [...entryEdges, ...e];
    setNodes(autoLayout([entryNode, ...organelleNodes], e));
    setEdges(e);
  }, [cellPath, onPickCell, setNodes, setEdges]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/cell?path=${encodeURIComponent(cellPath)}`, { cache: "no-store" });
    const j: Api = await r.json();
    setApi(j);
    if (j.error) return;
    setEntryJson(JSON.stringify(j.inputs ?? j.inputsRaw ?? {}, null, 2));
    setRunState("idle"); setRunMsg("");
    rebuild(j, "idle");
  }, [cellPath, rebuild]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!ndv) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNdv(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ndv]);

  const execute = useCallback(async () => {
    if (!api || runState === "running") return;
    setRunState("running"); setRunMsg(""); rebuild(api, "running");
    try {
      const parsed = JSON.parse(entryJson);
      const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cell: api.cell ?? cellPath, inputs: parsed }) });
      const j = await res.json();
      if (j.ok) {
        const next = { ...api, manifest: j.manifest, outputs: j.outputs };
        setApi(next); setRunState("ok");
        setRunMsg(`✓ digest ${String(j.manifest?.produced_by ?? "").slice(0, 8)} · ${Object.keys(j.outputs ?? {}).join(", ")}`);
        rebuild(next, "ok");
        onFired?.();
      } else {
        setRunState("err"); setRunMsg(`exit ${j.code}: ${(j.stderr || j.stdout || "").slice(0, 240)}`);
        rebuild(api, "err");
      }
    } catch (e: any) {
      setRunState("err"); setRunMsg(String(e.message ?? e)); rebuild(api, "err");
    }
  }, [api, cellPath, entryJson, onFired, rebuild, runState]);

  const ndvNode = ndv && ndv !== "__entry" ? (api?.nodes as any[] ?? []).find((n: any) => n.id === ndv) : null;

  return (
    <div className="nx-canvas">
      <div className="nx-chip" style={{ top: 14, left: 14 }}>
        {api?.name ?? cellPath} · {api?.manifest ? `digest ${String(api.manifest.produced_by).slice(0, 8)}` : "not yet fired"} · {(api?.organelles?.length ?? 0)} nodes · {(api?.wiring?.length ?? 0)} edges
      </div>
      <button className="nx-addnode" title="Open nodes panel" onClick={() => window.dispatchEvent(new CustomEvent("nx:add-node"))}>+</button>

      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3 }} proOptions={{ hideAttribution: true }}>
        <Background gap={20} size={1.4} color="var(--nx-dot)" />
        <MiniMap style={{ background: "var(--nx-panel)", border: "1px solid var(--nx-border)" }} maskColor="rgba(0,0,0,0.4)" pannable zoomable />
        <Controls />
      </ReactFlow>

      {/* n8n signature — Execute pill, bottom-center */}
      <div className="nx-exec">
        <button className="nx-exec__btn" onClick={execute} disabled={runState === "running"}>
          {runState === "running" ? "◌ Executing…" : "▶ Execute workflow"}
        </button>
        {runMsg && <span className="nx-exec__msg" style={runState === "err" ? { color: "var(--nx-error)" } : undefined}>{runMsg}</span>}
      </div>

      {/* NDV — input | parameters | output */}
      {ndv && (
        <div className="nx-ndv-overlay" onClick={() => setNdv(null)}>
          <div className="nx-ndv" onClick={e => e.stopPropagation()}>
            <div className="nx-ndv__head">
              <span style={{ fontSize: 20 }}>{ndv === "__entry" ? "⚡" : iconFor(ndv)}</span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{ndv === "__entry" ? "When input arrives · membrane.inputs" : (ndvNode?.label ?? ndv)}</span>
              <span className="nx-tag">{ndv === "__entry" ? "trigger" : (ndvNode?.cell ? "sub-cell" : "node")}</span>
              <div style={{ flex: 1 }} />
              {ndv === "__entry" && <button className="nx-btn nx-btn--primary" onClick={execute} disabled={runState === "running"}>{runState === "running" ? "◌ Running…" : "▶ Run workflow"}</button>}
              <button className="nx-btn" onClick={() => setNdv(null)}>✕</button>
            </div>
            <div className="nx-ndv__grid">
              <div className="nx-ndv__pane">
                <div className="nx-ndv__panetitle">Input</div>
                {ndv === "__entry"
                  ? <pre className="nx-pre">{`membrane.inputs — ${Object.keys(api?.membrane?.inputs ?? {}).join(", ") || "none"}\n\nEdit the JSON in Parameters, then Run.\nSame pinned bytes → byte-identical outputs (deterministic harness).`}</pre>
                  : <pre className="nx-pre">{JSON.stringify(api?.inputs ?? {}, null, 2)}</pre>}
              </div>
              <div className="nx-ndv__pane">
                <div className="nx-ndv__panetitle">Parameters</div>
                {ndv === "__entry"
                  ? <textarea className="nx-jsonedit" value={entryJson} onChange={e => setEntryJson(e.target.value)} spellCheck={false} />
                  : <pre className="nx-pre">{JSON.stringify(ndvNode ?? {}, null, 2)}</pre>}
              </div>
              <div className="nx-ndv__pane">
                <div className="nx-ndv__panetitle">Output</div>
                <pre className="nx-pre">{ndv === "__entry"
                  ? (api?.manifest ? JSON.stringify(api.manifest, null, 2) : "Execute the workflow to see the manifest.")
                  : (api?.outputs?.[ndv] !== undefined ? JSON.stringify(api.outputs[ndv], null, 2) : (api?.outputs && Object.keys(api.outputs).length ? JSON.stringify(api.outputs, null, 2) : "Execute the workflow to see output."))}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
