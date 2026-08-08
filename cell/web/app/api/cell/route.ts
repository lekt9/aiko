import { NextResponse } from "next/server";
import { getCellByPath, discoverCells, latestManifest, latestOutputs } from "@/lib/cell";
import { collectBlocks } from "@/lib/dashboard";
import fs from "node:fs";
import path from "node:path";
export const dynamic = "force-dynamic";
function cellRoot(){ return path.resolve(process.cwd(),".."); }
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rel = url.searchParams.get("path") ?? "haulio-full.cell.yaml";
  const cell = getCellByPath(rel);
  if (!cell) {
    const all = discoverCells();
    return NextResponse.json({ error: `cell not found: ${rel}`, available: all.map(c=>c.path.replace(cellRoot()+"/","")) }, { status: 404 });
  }
  const manifest = latestManifest(rel);
  const outputs = latestOutputs(rel);
  // inputs: try conventional haulio-inputs.json or example/inputs.json near cell
  let inputs: any = null;
  for (const cand of [path.join(cellRoot(),"haulio-inputs.json"), path.join(path.dirname(path.join(cellRoot(),rel)), "inputs.json"), path.join(cellRoot(),"example/inputs.json")]) {
    if (fs.existsSync(cand)) { try { const j = JSON.parse(fs.readFileSync(cand,"utf-8")); inputs = j.order ? j.order : j; if (j.order) inputs = j; else inputs = j; break; } catch {} }
  }
  // read raw inputs file for editor
  let inputsRaw: any = inputs;
  try {
    const rawPath = path.join(cellRoot(),"haulio-inputs.json");
    if (fs.existsSync(rawPath)) inputsRaw = JSON.parse(fs.readFileSync(rawPath,"utf-8"));
  } catch {}
  const nodes = cell.organelles.map((o,i)=>({ id:o.name, label:o.name, cell:o.cell, isLeaf: !o.cell?.endsWith(".cell.yaml") ? false : undefined }));
  const edges = cell.wiring.filter(w=>!w.from.startsWith("membrane.")&&!w.to.startsWith("membrane.")).map(w=>{
    const s=w.from.split(".")[0]; const t=w.to.split(".")[0];
    return { id:`${s}->${t}`, source:s, target:t, from:w.from, to:w.to };
  });
  // dashboard blocks — notion-like, each block determined by yaml render schema (/core /react)
  let dashboard: any = null;
  try { dashboard = collectBlocks({ cellPath: rel }); } catch {}

  return NextResponse.json({
    cell: rel, name: cell.name, description: cell.description,
    membrane: cell.membrane, organelles: cell.organelles, wiring: cell.wiring,
    isLeaf: cell.isLeaf, run: cell.run,
    manifest, outputs, inputs, inputsRaw,
    nodes, edges,
    dashboard,
  });
}
