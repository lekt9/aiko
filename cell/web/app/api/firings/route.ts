import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
export const dynamic = "force-dynamic";

function cellRoot() { return path.resolve(process.cwd(), ".."); }

// The ledger is engine truth: run.py journals every firing (UI, CLI, agent
// alike) and this route only projects `run.py firings`. No web-side sqlite.
export async function GET() {
  const result: any = await new Promise((resolve) => {
    const p = spawn("python3", ["run.py", "firings", "--limit", "50"], { cwd: cellRoot() });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => resolve({ code, stdout, stderr }));
    p.on("error", e => resolve({ code: 127, stdout, stderr: String(e) }));
    setTimeout(() => { try { p.kill(); } catch {} resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" }); }, 10000);
  });
  if (result.code !== 0) return NextResponse.json({ firings: [], error: String(result.stderr).slice(0, 500) });
  try {
    return NextResponse.json(JSON.parse(result.stdout));
  } catch {
    return NextResponse.json({ firings: [], error: "unparseable engine output" });
  }
}
