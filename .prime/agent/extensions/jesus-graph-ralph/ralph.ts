import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);

export interface WitnessResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  truncated: boolean;
}

export async function runWitness(command: string, cwd: string, timeoutMs = 300_000): Promise<WitnessResult> {
  if (!command || !command.trim()) {
    return { command, exitCode: 2, stdout: "", stderr: "empty witness — no gate pinned (self-asserted, weak)", ok: false, truncated: false };
  }
  try {
    const { stdout, stderr } = await exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    return { command, exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "", ok: true, truncated: false };
  } catch (e: any) {
    const stdout: string = e?.stdout ?? "";
    const stderr: string = e?.stderr ?? e?.message ?? String(e);
    const code: number = typeof e?.code === "number" ? e.code : 1;
    const truncated = /maxBuffer exceeded/i.test(stderr + stdout);
    return { command, exitCode: code || 1, stdout, stderr, ok: false, truncated };
  }
}

export function witnessOneLiner(r: WitnessResult): string {
  const icon = r.ok ? "✓" : "✗";
  const head = `${icon} witness \`${r.command}\` → exit ${r.exitCode}`;
  if (r.ok) return head;
  const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-20).join("\n");
  return head + (tail ? `\n${tail}` : "");
}
