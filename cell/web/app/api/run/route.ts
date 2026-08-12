import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
export const dynamic = "force-dynamic";

function cellRoot(){ return path.resolve(process.cwd(),".."); }

export async function POST(req: Request) {
  const body = await req.json().catch(()=>({}));
  const cellPath: string = body.cell ?? "hoysan-pipeline.cell.yaml";
  const inputs: any = body.inputs ?? null;
  const root = cellRoot();
  const absCell = path.isAbsolute(cellPath) ? cellPath : path.join(root, cellPath);

  // write temp inputs file if provided
  let inputsFile: string | null = null;
  if (inputs) {
    const tmp = path.join(root, `out/_web_inputs_${Date.now()}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(inputs, null, 2), "utf-8");
    inputsFile = tmp;
  } else {
    // try conventional inputs
    for (const cand of [path.join(root,"haulio-inputs.json"), path.join(path.dirname(absCell),"inputs.json")]) {
      if (fs.existsSync(cand)) { inputsFile = cand; break; }
    }
  }

  const outDir = path.join(root, `out/${path.basename(cellPath, ".cell.yaml")}`);
  const args = ["run.py", "run", absCell, ...(inputsFile ? ["--inputs", inputsFile] : []), "--out", outDir];
  const result: any = await new Promise((resolve) => {
    const p = spawn("python3", args, { cwd: root });
    let stdout="", stderr="";
    p.stdout.on("data", d=> stdout+=d);
    p.stderr.on("data", d=> stderr+=d);
    p.on("close", code=> resolve({ code, stdout, stderr }));
    p.on("error", e=> resolve({ code: 127, stdout, stderr: String(e) }));
    setTimeout(()=>{ try{ p.kill(); }catch{}; resolve({ code: 124, stdout, stderr: stderr+"\n[timeout]" }); }, 20000);
  });

  // read outputs
  let outputs: Record<string,any> = {};
  let manifest: any = null;
  try {
    for (const f of fs.readdirSync(outDir)) if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(outDir,f),"utf-8"));
        if (f==="manifest.json") manifest=j; else outputs[path.basename(f,".json")]=j;
      } catch {}
    }
  } catch {}

  return NextResponse.json({
    cell: cellPath, outDir: outDir.replace(root+"/",""),
    code: result.code,
    stdout: result.stdout.slice(0, 8000),
    stderr: result.stderr.slice(0, 4000),
    manifest, outputs,
    ok: result.code===0,
  });
}
