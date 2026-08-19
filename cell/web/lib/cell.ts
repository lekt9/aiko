import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { spawnSync } from "child_process";

/** Generic Cell parser — not haulio-specific. Any *.cell.yaml becomes a DAG. */
export type CellMembrane = { inputs: Record<string,{schema:string}>; outputs: Record<string,{schema:string}>; caps?: any };
export type OrganelleRef = { name: string; cell?: string; cellInline?: any };
export type WiringEdge = { from: string; to: string };
export type ParsedCell = {
  path: string; name: string; description: string;
  membrane: CellMembrane; organelles: OrganelleRef[]; wiring: WiringEdge[];
  isLeaf: boolean; run?: any; digest?: string;
};

function cellRoot(): string { return path.resolve(process.cwd(), ".."); }
function readJson(p: string): any { return JSON.parse(fs.readFileSync(p, "utf-8")); }

function parseYamlCell(filePath: string): ParsedCell {
  const txt = fs.readFileSync(filePath, "utf-8");
  // lightweight YAML — we only need membrane/organelles/wiring/run
  const name = (txt.match(/name:\s*([^\n]+)/)?.[1] ?? path.basename(filePath)).trim();
  const description = (txt.match(/description:\s*([^\n]+)/)?.[1] ?? "").trim();
  const isLeaf = /^\s*run:/m.test(txt);
  let run: any = undefined;
  if (isLeaf) {
    const kind = txt.match(/kind:\s*(\S+)/)?.[1] ?? "python";
    run = { kind };
  }
  // membrane inputs/outputs
  const membrane: CellMembrane = { inputs: {}, outputs: {} };
  const inputsBlock = txt.match(/inputs:\s*\n((?:[ \t]+[^\n]*\n?)*)/)?.[1] ?? "";
  for (const m of inputsBlock.matchAll(/^\s+(\w+):\s*\{\s*schema:\s*([^\}]+)\}/gm)) membrane.inputs[m[1]] = { schema: m[2].trim() };
  // fallback: extract from spec.membrane section generically
  if (Object.keys(membrane.inputs).length === 0) {
    for (const m of txt.matchAll(/(\w+):\s*\{\s*schema:\s*([^\}]+)\}/g)) {
      // heuristic: first occurrence under inputs
      if (!membrane.inputs[m[1]] && txt.indexOf(m[0]) < txt.indexOf("outputs:")) membrane.inputs[m[1]] = { schema: m[2].trim() };
    }
  }
  const outputsBlock = txt.match(/outputs:\s*\n((?:[ \t]+[^\n]*\n?)*)/)?.[1] ?? "";
  for (const m of outputsBlock.matchAll(/^\s+(\w+):\s*\{\s*schema:\s*([^\}]+)\}/gm)) membrane.outputs[m[1]] = { schema: m[2].trim() };

  const organelles: OrganelleRef[] = [];
  let pending: string | null = null;
  for (const line of txt.split("\n")) {
    const nm = line.match(/-\s*name:\s*(\S+)/);
    if (nm) pending = nm[1];
    const cl = line.match(/cell:\s*(\S+)/);
    if (cl && pending) { organelles.push({ name: pending, cell: cl[1] }); pending = null; }
  }
  const wiring: WiringEdge[] = [];
  let pendFrom: string | null = null;
  for (const line of txt.split("\n")) {
    const fm = line.match(/from:\s*(\S+)/);
    if (fm) { pendFrom = fm[1]; continue; }
    const tm = line.match(/to:\s*(\S+)/);
    if (tm && pendFrom) { wiring.push({ from: pendFrom, to: tm[1] }); pendFrom = null; }
    const both = line.match(/from:\s*(\S+).*to:\s*(\S+)/);
    if (both && !fm) wiring.push({ from: both[1], to: both[2] });
  }
  return { path: filePath, name, description, membrane, organelles, wiring, isLeaf, run };
}

// The node contract (writes / witness / harness) is read from the engine, never
// re-parsed here. A second parser is a second answer to "what does this node
// declare", and the two drift the moment the spec grows a field.
export function inspectCell(relOrAbs: string): any | null {
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cellRoot(), relOrAbs);
  const r = spawnSync("python3", [path.join(cellRoot(), "run.py"), "inspect", abs], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export function discoverCells(): ParsedCell[] {
  const root = cellRoot();
  const out: ParsedCell[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "out" || ent.name === ".cell-cas" || ent.name === "web") continue;
        walk(p);
      } else if (ent.name.endsWith(".cell.yaml")) {
        try { out.push(parseYamlCell(p)); } catch {}
      }
    }
  }
  walk(root);
  return out;
}

export function getCellByPath(relOrAbs: string): ParsedCell | null {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cellRoot(), relOrAbs);
  if (!fs.existsSync(p)) return null;
  return parseYamlCell(p);
}

export function wiringFromYaml(cellPath = "haulio-full.cell.yaml"): WiringEdge[] {
  const c = getCellByPath(cellPath);
  return c?.wiring ?? [];
}
export function organellesFromYaml(cellPath = "haulio-full.cell.yaml"): OrganelleRef[] {
  const c = getCellByPath(cellPath);
  return c?.organelles ?? [];
}

// --- legacy haulio-specific helpers (kept for compat) ---
export const HaulageOrderSchema = z.object({
  id: z.string(), container_no: z.string().optional(),
  job_type: z.enum(["import","export","shifting","triangulation"]),
  pickup: z.string(), dropoff: z.string(), customer: z.string().optional(),
  portal_ack: z.boolean().optional(), portal: z.string().optional(),
});
export type HaulageOrder = z.infer<typeof HaulageOrderSchema>;

export function latestManifest(cellPath = "haulio-full.cell.yaml"): any | null {
  try {
    const base = path.basename(cellPath, ".cell.yaml");
    const candidates = [
      path.join(cellRoot(), `out/${base}/manifest.json`),
      path.join(cellRoot(), "out/manifest.json"),
      path.join(cellRoot(), "out/haulio-full/manifest.json"),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return readJson(p);
    return null;
  } catch { return null; }
}
export function latestOutputs(cellPath = "haulio-full.cell.yaml"): Record<string, any> {
  const baseName = path.basename(cellPath, ".cell.yaml");
  const bases = [path.join(cellRoot(), `out/${baseName}`), path.join(cellRoot(), "out")];
  for (const base of bases) {
    const out: Record<string, any> = {};
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base)) if (f.endsWith(".json") && f !== "manifest.json") {
      try { out[path.basename(f, ".json")] = readJson(path.join(base, f)); } catch {}
    }
    if (Object.keys(out).length) return out;
  }
  return {};
}
export function organelles(cellPath = "haulio-full.cell.yaml"): OrganelleRef[] { return organellesFromYaml(cellPath); }
export function inputs(cellPath = "haulio-inputs.json"): HaulageOrder | null {
  try {
    const j = readJson(path.join(cellRoot(), cellPath));
    return (j.order ?? j) as HaulageOrder;
  } catch { return null; }
}