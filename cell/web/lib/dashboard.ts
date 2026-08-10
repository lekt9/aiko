/**
 * Notion-entity dashboard model.
 *
 * Goal: related items link like Notion entities, a list whose rows expand
 * into details based on deps (wiring). Design decisions:
 *
 * - One Entity per membrane *port* that has data, plus one Entity per array
 *   row for list-like schemas (haulage-job-pool.recommended_jobs, haulage-fleet.assets,
 *   haulage-invoice.line_items, haulage-tracking.hcs_updates if desired).
 *   Row-entities carry parentId + relation keys so they can link to their parent block
 *   AND across blocks (e.g. asset -> order_id -> invoice).
 * - Deps come from the cell wiring (membrane -> organelles -> membrane). We build a
 *   port-level adjacency so clicking a list row can expand into related detail blocks
 *   that are downstream/upstream via deps rather than just co-located.
 * - Visual schema still respected: `membrane.<port>.render` overrides inferred view.
 *   Each entity's presentation kind is derived from that view (dont invent new kinds).
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type PortRender = { view: any; via: "explicit" | "inferred"; raw?: any };
export type Entity = {
  id: string;           // stable key for selection/expansion
  blockId: string;      // parent block (membrane port) id, e.g. haulio-full.cell.yaml:outputs:invoice
  port: string;         // "invoice" / "job_pool" / "fleet" ...
  direction: "input"|"output";
  label: string;        // human row title (Job 123 / PM-... / Inv-...)
  subtitle: string | null;
  tone: string | null;  // maps to dot/badge color (status)
  schemaTitle: string | null;
  renderVia: "explicit"|"inferred";
  relationKeys: string[];   // keys this entity participates in (order_id, trip_id, ...)
  relations: Record<string,string>; // e.g. { order_id: "ord-demo-001" }
  parentId: string | null;  // for row-entities, id of the block entity
  raw: any;                 // the underlying object (order / invoice / one asset row / one job row)
  view: any;                // the block's yaml render view (for detail shape)
};
export type BusinessLogic = { organelle: string; neuronPath: string; summary: string; steps: { id: string; text: string }[]; raw: string };
export type Block = {
  id: string;
  port: string;
  direction: "input"|"output";
  schemaPath: string; schema: any;
  render: PortRender;
  data: any;
  wiring: { from: string; to: string }[];
  relationKeys: string[];
  entities: Entity[];
  businessLogic: BusinessLogic | null;
};
export type DashboardModel = {
  cell: any; blocks: Block[]; entities: Entity[]; links: any[]; deps: any; manifest: any; outputs: Record<string,any>;
};

function cellRoot(){ return path.resolve(process.cwd(),".."); }
function tryReadJson(p:string): any|null{ try{ return JSON.parse(fs.readFileSync(p,"utf-8")); }catch{ return null; } }
function inferRenderLocal(schema:any): any{
  if(!schema||typeof schema!=="object") return { type:"raw", schema };
  const t=schema.type;
  if(t==="array"){
    const item=schema.items??{};
    if(item?.type==="object"){ const cols=Object.keys(item.properties??{}).slice(0,8); return { type:"table", columns:(cols.length?cols:["value"]).map((k:string)=>({key:k})) }; }
    return { type:"list", item };
  }
  if(t==="object") return { type:"form", fields:Object.keys(schema.properties??{}).map((k)=>({key:k, required:!!(schema.required??[]).includes(k)})) };
  if(["string","integer","number","boolean"].includes(t)) return { type:"field", fieldType:t };
  if(schema.properties) return { type:"form", fields:Object.keys(schema.properties).map((k:string)=>({key:k})) };
  return { type:"raw", schema };
}

export function collectBlocks(params:{cellPath?:string}={}): DashboardModel{
  const root=cellRoot();
  const cellPath=params.cellPath??"haulio-full.cell.yaml";
  const absCell=path.isAbsolute(cellPath)?cellPath:path.join(root,cellPath);
  if(!fs.existsSync(absCell)) return { cell:null, blocks:[], entities:[], links:[], deps:null, manifest:null, outputs:{} } as any;
  const yamlDoc:any=(():any=>{ try{ return parseYaml(fs.readFileSync(absCell,"utf-8"))??{}; }catch{ return {}; }})();
  const membrane=yamlDoc?.spec?.membrane??{};
  const wiring: {from:string,to:string}[]=yamlDoc?.spec?.wiring??[];
  const meta=yamlDoc?.metadata??{};
  const base=path.basename(cellPath,".cell.yaml");

  let manifest:any=null;
  for(const p of [path.join(root,`out/${base}/manifest.json`), path.join(root,"out/manifest.json"), path.join(root,"out/haulio-full/manifest.json")]){
    if(fs.existsSync(p)){ manifest=tryReadJson(p); break; }
  }
  const outputs:Record<string,any>={};
  for(const b of [path.join(root,`out/${base}`), path.join(root,"out")]){
    if(!fs.existsSync(b)) continue;
    for(const f of fs.readdirSync(b)) if(f.endsWith(".json")&&f!=="manifest.json"){
      const v=tryReadJson(path.join(b,f)); if(v!==null) outputs[path.basename(f,".json")]=v;
    }
    if(Object.keys(outputs).length) break;
  }
  let initialInputs:Record<string,any>={};
  for(const cand of [path.join(root,"haulio-inputs.json"), path.join(root,"example/inputs.json")]){
    const j=tryReadJson(cand); if(j){ initialInputs=j.order?{order:j.order, ...j}:j; break; }
  }

  // organelle → neuron file mapping + business-logic extraction from comments
  const organelleToLogic = buildBusinessLogicIndex(root, yamlDoc, wiring);

  const blocks:Block[]=[];
  for(const dir of ["inputs","outputs"] as const){
    const ports:Record<string,any>=membrane[dir]??{};
    for(const [port, specDecl] of Object.entries(ports as Record<string,any>)){
      const decl:any=specDecl??{};
      const schemaRef:string=typeof decl==="string"?decl:(decl.schema??"string");
      const explicitRender=decl.render??null;
      let schema:any=null; let schemaPath=schemaRef;
      if(schemaRef==="string") schema={type:"string", title:port};
      else if(typeof schemaRef==="string"){
        const maybePath=path.isAbsolute(schemaRef)?schemaRef:path.join(path.dirname(absCell),schemaRef);
        if(fs.existsSync(maybePath)) schema=tryReadJson(maybePath);
        else if(fs.existsSync(path.join(root,schemaRef))) schema=tryReadJson(path.join(root,schemaRef));
        else schema={ title:schemaRef, type:"object", properties:{} };
        schemaPath=fs.existsSync(maybePath)?maybePath:schemaRef;
      } else if(typeof schemaRef==="object") schema=schemaRef;

      let view:any; let via:"explicit"|"inferred"="inferred";
      if(explicitRender!=null){ via="explicit";
        if(typeof explicitRender==="string" && explicitRender.endsWith(".json")){
          const rp=path.isAbsolute(explicitRender)?explicitRender:path.join(path.dirname(absCell),explicitRender);
          view=tryReadJson(rp)??explicitRender;
        } else if(typeof explicitRender==="object") view=explicitRender;
        else if(typeof explicitRender==="string"){ try{ view=JSON.parse(explicitRender);}catch{ view={type:"raw", value:explicitRender}; } }
        else view=explicitRender;
      } else view=inferRenderLocal(schema);

      const firstOutputKey=Object.keys(outputs)[0];
      const dirIsOutput=dir==="outputs";
      let data:any=dirIsOutput ? (outputs[port] ?? (firstOutputKey===port?outputs[firstOutputKey]:null)) : ((initialInputs[port] ?? (initialInputs["order"] && port==="order"?initialInputs["order"]:null)) as any);
      if(data===null && dirIsOutput && Object.keys(outputs).length){
        const title=(schema?.title??port).toLowerCase();
        for(const [k,v] of Object.entries(outputs)) if(k.toLowerCase().includes(title.split("-")[0])||title.includes(k.toLowerCase())){ data=v; break; }
        if(data===null){ const first=Object.values(outputs)[0] as any; if(first && typeof first==="object" && (first as any)[port]!==undefined) data=(first as any)[port]; }
      }
      if(data===null && !dirIsOutput) data=initialInputs[port]??null;

      const relationKeys=extractRelationKeys(schema, data);
      const id=`${cellPath}:${dir}:${port}`;
      const entities=entitiesForBlock({ id, port, direction: (dirIsOutput?"output":"input"), schema, data, relationKeys, renderVia:via, view });
      const businessLogic = organelleToLogic.get(port) ?? organelleToLogic.get(`${dir}:${port}`) ?? null;
      blocks.push({ id, port, direction:(dirIsOutput?"output":"input"), schemaPath:String(schemaPath), schema, render:{view, via, raw:explicitRender??null}, data, wiring, relationKeys, entities, businessLogic });
    }
  }

  // deps graph: orient edges at port granularity as declared in wiring.
  // We keep the raw wiring plus a derived adjacency from -> to for expansion.
  const deps={ wiring, adjacency: buildAdj(wiring), byPort: Object.fromEntries(blocks.map(b=>[b.port, b.id])) };

  const entities:Entity[]=[]; for(const b of blocks) for(const e of b.entities) entities.push(e);

  // cross-entity links: two entities (possibly from different blocks) that share a relation key/value
  // Example: invoice(order_id=ord-demo-001) ↔ job_pool(order_id=ord-demo-001)
  const links=buildEntityLinks(entities);

  const cell={ path:cellPath, name:meta.name??base, description:meta.description??"", wiring, membrane };
  return { cell, blocks, entities, links, deps, manifest, outputs };
}

function entitiesForBlock(args:{id:string,port:string,direction:"input"|"output",schema:any,data:any,relationKeys:string[],renderVia:"explicit"|"inferred",view:any}): Entity[]{
  const { id:blockId, port, direction, schema, data, relationKeys, renderVia, view }=args;
  const schemaTitle=schema?.title??null;
  const out:Entity[]=[];
  // Check if data contains an array of items that should become child row-entities.
  // Heuristic: if schema says the membrane port is an object and data has an array property with item objects,
  // or if data itself is array, we explode into row entities that still link via relation keys.
  const dataArr = (()=>{ if(Array.isArray(data)) return { key:"_root", rows:data }; if(data && typeof data==="object"){
    for(const [k,v] of Object.entries(data)) if(Array.isArray(v) && v.length && typeof (v as any)[0]==="object") return { key:k, rows:v as any[] };
  } return null; })();

  const blockEntity: Entity={
    id: blockId, blockId, port, direction, label: labelForPort(port, data, schemaTitle), subtitle: subtitleForPort(port, data, schemaTitle),
    tone: toneForPort(port, data), schemaTitle, renderVia, relationKeys, relations: pickRelations(data, args.relationKeys), parentId:null, raw:data, view,
  };
  out.push(blockEntity);

  if(dataArr){
    // Identify per-row relation keys by sampling the first row.
    const rowRelationCandidates=["order_id","trip_id","invoice_id","asset_id","job_id","id","container_no"] as const;
    for(const row of dataArr.rows as any[]){
      const rk:string[]=[];
      for(const k of rowRelationCandidates) if(row && typeof row==="object" && (row as any)[k]!=null) rk.push(k);
      // each row inherits the parent block's order-level relations as well, so cross-block linking works even when
      // row object doesn't repeat order_id (some schemas don't); we fill missing from blockEntity.relations.
      const inherited:Record<string,string>={};
      for(const k of args.relationKeys){ const v=(row as any)[k]??(blockEntity.relations as any)[k]; if(v!=null) inherited[k]=String(v); }
      const rowRk= rk.length? rk : Object.keys(inherited);
      const label= rowLabel(port, dataArr.key, row);
      const entityId=`${blockId}::${dataArr.key}::${String((row as any).id ?? (row as any).job_id ?? (row as any).asset_id ?? (row as any).invoice_id ?? label).replace(/[^a-zA-Z0-9_-]/g,"_")}`;
      out.push({
        id: entityId, blockId, port, direction, label, subtitle: rowSubtitle(port, dataArr.key, row), tone: toneForRow(port, row),
        schemaTitle, renderVia, relationKeys: rowRk, relations: inherited, parentId: blockId, raw: row, view,
      });
    }
  }
  return out;
}

function labelForPort(port:string, data:any, schemaTitle:string|null): string{
  if(!data) return port;
  if(port==="order" || schemaTitle==="haulage-order.v1") return String((data as any).id ?? port);
  if(port==="invoice") return String((data as any).invoice_id ?? "Invoice");
  if(port==="tracking") return String((data as any).trip_id ?? "Tracking");
  if(port==="job_pool") return `Job Pool · ${String((data as any).order_id ?? "")}`.trim();
  if(port==="fleet") return `Fleet · ${String((data as any).order_id ?? "")}`.trim();
  return port;
}
function subtitleForPort(port:string, data:any, _schemaTitle:string|null): string|null{
  if(!data) return null;
  if(port==="order") return `${(data as any).pickup ?? ""} → ${(data as any).dropoff ?? ""}`.trim() || String((data as any).job_type ?? "");
  if(port==="invoice") return (data as any).order_id ? `Order ${(data as any).order_id}` : null;
  if(port==="tracking") return String((data as any).gps_status ?? "");
  if(port==="job_pool") return ((data as any).pool_status?String((data as any).pool_status):null);
  if(port==="fleet") return (data as any).availability ? String((data as any).availability).slice(0,60) : null;
  return null;
}
function toneForPort(port:string, data:any): string|null{
  if(!data) return null;
  const s=(data as any).status ?? (data as any).pool_status ?? (data as any).gps_status ?? null;
  if(!s) return null;
  const str=String(s);
  if(["issued","paid","completed","available","en_route","recommended"].some(k=> str===k || str.includes(k))) return "ok";
  if(["draft","pending"].includes(str)) return "warn";
  return null;
}
function rowLabel(port:string, key:string, row:any): string{
  if(row.invoice_id) return String(row.invoice_id);
  if(row.job_id) return String(row.job_id);
  if(row.asset_id) return String(row.asset_id);
  if(row.id) return String(row.id);
  if(key==="line_items") return String(row.description ?? "item");
  if(key==="hcs_updates") return String(row.message ?? "event").slice(0,40);
  return String(row.asset_id ?? row.job_id ?? row.id ?? "item");
}
function rowSubtitle(port:string, key:string, row:any): string|null{
  if(key==="recommended_jobs") return String(row.route ?? "");
  if(key==="assets") return `${String(row.kind ?? "")} · ${String(row.status ?? "")}`.trim();
  if(key==="line_items") return `SGD ${String(row.amount ?? "")}`.trim();
  if(key==="hcs_updates") return String(row.at ?? "");
  return null;
}
function toneForRow(port:string, row:any): string|null{
  const s=row.status; if(!s) return null;
  if(["available","assigned","en_route","issued"].includes(String(s))) return "ok";
  return null;
}
function pickRelations(data:any, keys:string[]): Record<string,string>{
  const out:Record<string,string>={}; if(!data||typeof data!=="object") return out;
  if(Array.isArray(data)) return out;
  for(const k of keys){ const v=(data as any)[k]; if(v!=null) out[k]=String(v); }
  // also peek one level into arrays for linking (order_id from job_pool etc. already on object; this is for portability)
  return out;
}
function extractRelationKeys(schema:any, data:any): string[]{
  const candidates=["order_id","trip_id","invoice_id","asset_id","job_id","id","container_no"];
  const out:string[]=[]; const props=schema?.properties?Object.keys(schema.properties):[];
  const dataKeys=data && typeof data==="object" && !Array.isArray(data)?Object.keys(data):[];
  const arrItemProps=schema?.type==="array" && schema?.items?.properties? Object.keys(schema.items.properties):[];
  const all=new Set([...props, ...dataKeys, ...arrItemProps]);
  for(const k of candidates) if(all.has(k)) out.push(k);
  // also infer from data arrays (e.g. recommended_jobs items have job_id)
  if(data && typeof data==="object" && !Array.isArray(data)){
    for(const v of Object.values(data)) if(Array.isArray(v) && (v as any)[0] && typeof (v as any)[0]==="object"){
      const sampleKeys=Object.keys((v as any)[0]);
      for(const k of candidates) if(sampleKeys.includes(k) && !out.includes(k)) out.push(k);
    }
  }
  return out;
}
function buildAdj(wiring:{from:string,to:string}[]): Record<string,string[]>{
  const m:Record<string,string[]>={}; for(const w of wiring){ (m[w.from]??=[]).push(w.to); } return m;
}
function buildBusinessLogicIndex(root: string, yamlDoc: any, wiring: {from:string,to:string}[]): Map<string, BusinessLogic>{
  const byPort = new Map<string, BusinessLogic>();
  const organelles: {name:string, cell?:string}[] = yamlDoc?.spec?.organelles ?? [];
  // Map organelle name → neuron file via its cell.yaml entry
  const orgToNeuronFile = new Map<string, string>();
  const cellDir = path.dirname(path.join(root, "haulio-full.cell.yaml"));
  for(const org of organelles){
    const cellRef: string | undefined = org.cell;
    if(!cellRef) continue;
    const candidates = [
      path.join(root, cellRef.replace(/^\.\//,"")),
      path.join(root, "haulio", path.basename(cellRef)),
      path.join(cellDir, cellRef.replace(/^\.\//,"")),
      path.join(cellDir.replace(/haulio$/,"").replace(/\/$/,""), cellRef.replace(/^\.\//, "")),
    ];
    for(const cand of candidates){
      if(!fs.existsSync(cand)) continue;
      try{
        const txt=fs.readFileSync(cand,"utf-8");
        const entry = txt.match(/entry:\s*([^\s]+)/)?.[1]?.trim();
        if(entry){
          const base = path.dirname(path.resolve(cand));
          const neuronAbs = path.isAbsolute(entry) ? entry : path.join(base, entry);
          if(fs.existsSync(neuronAbs)){ orgToNeuronFile.set(org.name, neuronAbs); break; }
        }
      }catch{}
    }
  }
  // Parse each organelle's neuron file — source of truth for business logic
  const orgLogic = new Map<string, BusinessLogic>();
  for(const [name, neuronPath] of orgToNeuronFile){
    const logic = parseBusinessLogic(name, neuronPath);
    if(logic) orgLogic.set(name, logic);
  }
  // Map inputs: membrane.order → portal.order → portal's logic (white-label intake)
  for(const w of wiring){
    if(w.from.startsWith("membrane.")){
      const memPort = w.from.split(".")[1];
      const dstOrg = w.to.split(".")[0];
      if(byPort.has(memPort)) continue; // keep first consumer for fan-out (portal wins for order)
      const logic = orgLogic.get(dstOrg);
      if(logic) byPort.set(memPort, logic);
    }
  }
  // Map outputs: billing.invoice → membrane.invoice → billing's logic
  for(const w of wiring){
    if(!w.to.startsWith("membrane.")) continue;
    const membranePort = w.to.split(".")[1];
    const srcOrg = w.from.split(".")[0];
    const logic = orgLogic.get(srcOrg);
    if(logic) byPort.set(membranePort, logic);
  }
  // Also index by organelle name itself so sub-cells (haulio/billing.cell.yaml etc.) work
  for(const [name, logic] of orgLogic) byPort.set(name, logic);
  // Expose a merged index for direct haulio-full lookup and sub-cell lookup
  return byPort;
}
function parseBusinessLogic(organelle: string, filePath: string): BusinessLogic | null{
  try{
    const text=fs.readFileSync(filePath,"utf-8");
    // Extract leading Business Logic docstring: """ ... """ or ''' ... ''' at top of file.
    const m = text.match(/\"\"\"([\s\S]*?)\"\"\"/);
    if(!m) return null;
    const raw = m[1].trim();
    // Summary = first non-empty line; remaining numbered/bulleted lines become steps.
    const lines = raw.split("\n").map(s=> s.trim()).filter(s=> s.length>0);
    const summary = (lines[0] ?? "").replace(/^Business Logic\s*[—-]\s*/i, "").trim();
    const steps: {id:string,text:string}[] = [];
    for(const line of lines.slice(1)){
      // Accept forms: "1. ...", "2) ...", "- ...", "• ...", "(1) ..."
      const stepMatch = line.match(/^(?:\d+[\.\)]\s*|[-•]\s*)(.+)$/);
      if(stepMatch) steps.push({ id: String(steps.length+1), text: stepMatch[1].trim() });
      else if(steps.length) steps[steps.length-1].text += " " + line;
    }
    // Fallback: if no numbered steps found, treat each non-empty line after summary as a step
    if(steps.length===0 && lines.length>1) {
      for(const l of lines.slice(1)) steps.push({ id: String(steps.length+1), text: l });
    }
    return { organelle, neuronPath: path.relative(path.join(path.resolve(process.cwd(),"..")), filePath), summary, steps, raw };
  }catch{ return null; }
}

function buildEntityLinks(entities:Entity[]): any[]{
  // Build map from (key,value) -> entity ids that carry that relation.
  const idx:Map<string, string[]> = new Map();
  for(const e of entities){ for(const [k,v] of Object.entries(e.relations)) if(v!=null){ const key=`${k}::${String(v)}`; if(!idx.has(key)) idx.set(key, []); idx.get(key)!.push(e.id); } }
  // For legacy: also handle row entities where relations map may miss but raw carries the key
  const links:any[]=[];
  for(const [compound, ids] of idx.entries()){
    if(ids.length<2) continue;
    const [k, v]=compound.split("::"); // first occurrence grouping
    // Emit pairwise (star) between blocks — but link rows to block parents as well so lists relate across types
    const uniq=[...new Set(ids)];
    for(let i=0;i<uniq.length;i++) for(let j=i+1;j<uniq.length;j++){
      // avoid linking two rows of the same block to each other purely on order_id (too noisy); only cross-block
      const a=uniq[i], b=uniq[j];
      const aBlock=a.split("::")[0], bBlock=b.split("::")[0];
      if(aBlock===bBlock) continue;
      links.push({ from:a, to:b, key:k, value:v });
    }
  }
  return links;
}
