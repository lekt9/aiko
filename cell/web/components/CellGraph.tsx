"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import EntryNode from "./EntryNode";

type Api = { cell:string; name?:string; description?:string; membrane:any; organelles:any[]; wiring:any[]; manifest:any; outputs:any; inputs:any; inputsRaw:any; nodes:any[]; edges:any[]; isLeaf?:boolean };

function OrganelleNode({ data }: any) {
  const s = data.status ?? "idle";
  const tone = s === "issued" || s === "en_route" || s === "recommended" ? "ok" : s === "assigned" ? "accent" : "dim";
  const isComposite = !!data.isComposite;
  return (
    <div className={`rounded-md-t border bg-os-surface px-3 py-2 min-w-[170px] hoverable ${isComposite ? "border-os-accent shadow-[0_0_0_1px_var(--accent-line)]" : "border-os-border"}`} onDoubleClick={data.onExpand}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--border-strong)" }} />
      <div className="flex items-center gap-2">
        <span className={`dot ${tone === "ok" ? "ok pulse" : tone === "accent" ? "ok" : "off"}`} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-os-dim truncate">{data.cellLabel}</span>
        {isComposite && <span className="rounded-sm-t border border-os-accent bg-os-accent px-1 py-0 font-mono text-[9px] font-bold text-os-ink">AGENT</span>}
      </div>
      <div className="mt-1 text-[13px] font-semibold">{data.label}</div>
      {data.sub && <div className="mt-1 font-mono text-[10px] text-os-dim truncate max-w-[180px]">{data.sub}</div>}
      {isComposite && <div className="mt-1 font-mono text-[10px] text-os-accent">double-click to expand subgraph →</div>}
      <Handle type="source" position={Position.Right} style={{ background: "var(--border-strong)" }} />
    </div>
  );
}
const nodeTypes: any = { organelle: OrganelleNode, entry: EntryNode };

function autoLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  // dagre-free topological layout — columns by depth
  const indeg: Record<string,number> = {};
  nodes.forEach(n=> indeg[n.id]=0);
  edges.forEach(e=> { if (indeg[e.target]!==undefined) indeg[e.target]++; });
  const depth: Record<string,number> = {};
  const q = Object.keys(indeg).filter(k=>indeg[k]===0);
  q.forEach(k=> depth[k]=0);
  const adj: Record<string,string[]> = {};
  edges.forEach(e=> { (adj[e.source]??=[]).push(e.target); });
  const visited = new Set<string>();
  const queue = [...q];
  while(queue.length){
    const u = queue.shift()!;
    if(visited.has(u)) continue; visited.add(u);
    for(const v of adj[u]??[]){
      depth[v]=Math.max(depth[v]??0, (depth[u]??0)+1);
      indeg[v]--;
      if(indeg[v]===0) queue.push(v);
    }
  }
  const cols: Record<number, Node[]> = {};
  nodes.forEach(n=>{ const d=depth[n.id]??0; (cols[d]??=[]).push(n); });
  const out: Node[] = [];
  Object.keys(cols).sort((a,b)=>Number(a)-Number(b)).forEach(colStr=>{
    const col = Number(colStr);
    const arr = cols[col];
    arr.forEach((n,i)=> out.push({ ...n, position:{ x: 260 + col*260, y: 40 + i*110 }}));
  });
  return { nodes: out, edges };
}

export default function CellGraph({ cellPath, onPickCell }: { cellPath: string; onPickCell?: (p:string)=>void }) {
  const [api, setApi] = useState<Api | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [subapi, setSubapi] = useState<Api | null>(null);

  const load = useCallback(async (cp = cellPath) => {
    const r = await fetch(`/api/cell?path=${encodeURIComponent(cp)}`, { cache: "no-store" });
    const j = await r.json();
    if (j.error) { setApi(j); return; }
    setApi(j);
    // entry node
    const entryNode: Node = {
      id: "__entry",
      type: "entry",
      position: { x: 10, y: 40 },
      data: { cell: cp, membrane: j.membrane, inputs: j.inputs, inputsRaw: j.inputsRaw, onFired: (res:any)=>{ setApi((prev:any)=> prev ? { ...prev, manifest: res.manifest, outputs: res.outputs } : prev); } },
    };
    const organelleNodes: Node[] = (j.nodes as any[]).map((nd) => {
      const out = j.outputs?.[nd.id] ?? j.outputs?.[nd.id === "billing" ? "invoice" : nd.id] ?? j.outputs?.[Object.keys(j.outputs??{})[0]];
      let sub = "";
      if (j.outputs?.invoice && nd.id==="billing") sub = `${j.outputs.invoice.invoice_id} · SGD ${j.outputs.invoice.amount}`;
      else if (j.outputs?.tracking && nd.id==="tracking") sub = `${j.outputs.tracking.trip_id} · ${j.outputs.tracking.gps_status}`;
      else if (j.outputs?.job_pool && nd.id==="job_pool") sub = j.outputs.job_pool.recommended_jobs?.map((x:any)=>x.job_id).join(", ");
      else if (j.outputs?.fleet && nd.id==="fleet") sub = j.outputs.fleet.assets?.map((a:any)=>a.asset_id).join(", ");
      // composite = subgraph-as-agent (fractal)
      const isComposite = !!(nd.cell && nd.cell.endsWith(".cell.yaml"));
      return {
        id: nd.id, type: "organelle",
        position: { x: 0, y: 0 },
        data: {
          label: nd.label, cellLabel: nd.id, sub,
          status: (j.outputs?.[nd.id]?.status ?? j.outputs?.invoice?.status ?? j.outputs?.tracking?.gps_status ?? "idle"),
          isComposite, cellPath: nd.cell,
          onExpand: isComposite ? ()=>{ setExpanded(nd.cell); onPickCell?.(nd.cell); } : undefined,
        },
      };
    });
    let n: Node[] = [entryNode, ...organelleNodes];
    let e: Edge[] = (j.edges as any[]).map((ed:any)=>({
      id: ed.id, source: ed.source, target: ed.target,
      label: `${String(ed.from).split(".").pop()}→${String(ed.to).split(".").pop()}`, animated: true,
      style: { stroke: "var(--border-strong)" }, labelStyle: { fontSize: 9, fill: "var(--text-3)" } as any,
    }));
    // membrane → first organelles
    const entryEdges: Edge[] = (j.wiring as any[]).filter((w:any)=>w.from.startsWith("membrane.")).map((w:any,i:number)=>{
      const target = w.to.split(".")[0];
      return { id:`entry->${target}-${i}`, source:"__entry", target, style:{ stroke:"var(--accent)", strokeDasharray: "6 3" }, label: w.from.split(".").pop()??"order", animated: true } as Edge;
    });
    e = [...entryEdges, ...e];
    const laid = autoLayout(n, e);
    setNodes(laid.nodes); setEdges(laid.edges);
  }, [cellPath, setNodes, setEdges]);

  useEffect(()=>{ load(cellPath); }, [load, cellPath]);

  // fetch sub-cell when expanded
  useEffect(()=>{
    if(!expanded) { setSubapi(null); return; }
    fetch(`/api/cell?path=${encodeURIComponent(expanded)}`, { cache:"no-store" }).then(r=>r.json()).then(setSubapi);
  }, [expanded]);

  const generateProposal = useMemo(()=> {
    if(!api?.inputs) return null;
    const text = JSON.stringify(api.inputs).slice(0,80);
    return { hint: `Generate from entry: ${text}…`, suggestions: ["add validator", "fork scorer", "branch maintenance check"] };
  }, [api]);

  return (
    <div className="rounded-lg-t border border-os-border bg-os-surface overflow-hidden">
      <div className="flex items-center justify-between border-b border-os-hairline px-3.5 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-os-dim">Cell DAG · {api?.manifest ? `digest ${String(api.manifest.produced_by).slice(0,8)}` : api?.cell ?? cellPath} · {api?.name ?? ""}</span>
        <span className="font-mono text-[10px] text-os-dim">{api?.organelles ? `${api.organelles.length} organelles · ${api.wiring?.length ?? 0} edges` : ""}</span>
      </div>
      <div style={{ height: 560 }}>
        <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.25 }} proOptions={{ hideAttribution: true }}>
          <Background gap={24} size={1} color="var(--grid)" />
          <MiniMap style={{ background: "var(--surface)", border: "1px solid var(--border)" }} maskColor="rgba(0,0,0,0.35)" />
          <Controls />
        </ReactFlow>
      </div>
      {expanded && (
        <div className="border-t border-os-border bg-os-bg p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-semibold">Subgraph · {expanded} {subapi?.isLeaf ? "(leaf)" : "(composite → agent)"}</span>
            <button onClick={()=>setExpanded(null)} className="rounded-sm-t border border-os-border px-2 py-1 font-mono text-[10px]">close</button>
          </div>
          {subapi && <pre className="mt-2 overflow-auto rounded-sm-t border border-os-border bg-os-surface p-2 font-mono text-[11px]">{JSON.stringify({ membrane: subapi.membrane, organelles: subapi.organelles, wiring: subapi.wiring, outputs: subapi.outputs }, null, 2)}</pre>}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-os-hairline p-3">
        {generateProposal?.suggestions.map(s=>(
          <span key={s} className="rounded-full border border-dashed border-os-border px-2.5 py-1 font-mono text-[10px] text-os-dim">{s}</span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-os-dim">{generateProposal?.hint}</span>
      </div>
      {api && (
        <div className="grid grid-cols-2 gap-3 border-t border-os-hairline p-3 max-[900px]:grid-cols-1">
          <pre className="overflow-auto rounded-sm-t border border-os-border bg-os-bg p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(api.outputs, null, 2)}</pre>
          <pre className="overflow-auto rounded-sm-t border border-os-border bg-os-bg p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(api.manifest, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
