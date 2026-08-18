import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
export const dynamic = "force-dynamic";

function cellRoot() { return path.resolve(process.cwd(), ".."); }

// Projection of the engine's `save` verb — validator-bound, root-jailed,
// atomic. The UI never writes cell files itself.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const rel = String(body.path ?? "").trim();
  const content = String(body.content ?? "");
  if (!rel) return NextResponse.json({ ok: false, error: "path required" });
  const result: any = await new Promise((resolve) => {
    const p = spawn("python3", ["run.py", "save", rel], { cwd: cellRoot() });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => resolve({ code, stdout, stderr }));
    p.on("error", e => resolve({ code: 127, stdout, stderr: String(e) }));
    p.stdin.write(content);
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch {} resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" }); }, 10000);
  });
  if (result.code !== 0) return NextResponse.json({ ok: false, error: String(result.stderr).slice(0, 2000) });
  try {
    return NextResponse.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return NextResponse.json({ ok: false, error: "unparseable engine output" });
  }
}
