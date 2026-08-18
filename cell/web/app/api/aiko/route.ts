import { NextResponse } from "next/server";
import net from "node:net";
import path from "node:path";
export const dynamic = "force-dynamic";

function sockPath() {
  return process.env.CELL_DAEMON_SOCK ?? path.join(path.resolve(process.cwd(), ".."), "out", "daemon.sock");
}

// Projection of THE daemon (run.py daemon) — one long-running listener owns
// agent turns and workflow events; this route is just a socket client.
function daemonRequest(payload: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath());
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, daemon: false, error: "daemon timed out" }); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        try { resolve({ daemon: true, ...JSON.parse(buf.slice(0, nl)) }); }
        catch { resolve({ ok: false, daemon: true, error: "unparseable daemon reply" }); }
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, daemon: false, error: "daemon not running — start it with: python3 cell/run.py daemon" });
    });
  });
}

export async function GET() {
  return NextResponse.json(await daemonRequest({ op: "status" }, 3000));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ ok: false, error: "prompt required" });
  return NextResponse.json(await daemonRequest({ op: "agent", prompt, timeout_s: 120 }, 130000));
}
