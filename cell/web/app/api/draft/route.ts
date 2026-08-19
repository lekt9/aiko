import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
export const dynamic = "force-dynamic";

function cellRoot() { return path.resolve(process.cwd(), ".."); }

// Thin projection of the engine's `draft` verb — the UI never re-implements
// drafting; python3 run.py draft is the single deterministic path.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const goal = String(body.goal ?? "").trim();
  const kind = String(body.kind ?? "python");
  const args = ["run.py", "draft", goal, "--kind", kind];
  if (body.name) args.push("--name", String(body.name));
  if (body.write) args.push("--write", "drafts");   // materialize inert under cell/drafts/
  const root = cellRoot();
  const result: any = await new Promise((resolve) => {
    const p = spawn("python3", args, { cwd: root });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => resolve({ code, stdout, stderr }));
    p.on("error", e => resolve({ code: 127, stdout, stderr: String(e) }));
    setTimeout(() => { try { p.kill(); } catch {} resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" }); }, 10000);
  });
  if (result.code !== 0) {
    return NextResponse.json({ ok: false, code: result.code, error: String(result.stderr).slice(0, 2000) });
  }
  try {
    const proposal = JSON.parse(result.stdout);
    return NextResponse.json({ ok: true, proposal, written: body.write ? `drafts/${proposal.name}.cell.yaml` : null });
  } catch {
    return NextResponse.json({ ok: false, code: 0, error: "unparseable engine output" });
  }
}
