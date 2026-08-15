/**
 * Side Workbench terminal spawn helpers — user $SHELL as login+interactive.
 * Pure: no DOM / Tauri side effects.
 */

export type TerminalSpawnPlan = {
  /** Absolute path to the shell binary (or shell name). */
  shell: string;
  /** Args for login + interactive (e.g. ["-l", "-i"]). */
  args: string[];
  /** Working directory: project path when present, else home. */
  cwd: string;
  /** True when SHELL came from the environment. */
  fromEnv: boolean;
};

/**
 * Resolve the user's login shell and cwd for an embedded terminal tab.
 * Prefer `env.SHELL`; fall back to `/bin/zsh` (mac) or `/bin/bash`.
 */
export function resolveTerminalSpawnPlan(opts: {
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
  projectPath?: string | null;
  home?: string | null;
  platform?: string;
}): TerminalSpawnPlan {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const shellRaw = (env.SHELL || "").trim();
  const fromEnv = !!shellRaw;
  let shell = shellRaw;
  if (!shell) {
    const plat = (opts.platform || "").toLowerCase();
    // Note: "darwin" contains "win" — match win32/windows only.
    const isWin = /\bwin/.test(plat) || plat === "win32" || plat.startsWith("windows");
    shell = isWin
      ? "powershell.exe"
      : plat.includes("linux")
        ? "/bin/bash"
        : "/bin/zsh";
  }

  const home =
    (opts.home || env.HOME || env.USERPROFILE || "").trim() ||
    (typeof process !== "undefined" ? process.env.HOME : "") ||
    ".";
  const project = (opts.projectPath || "").trim();
  const cwd = project || home || ".";

  // login (-l) + interactive (-i) so rc / oh-my-zsh load.
  // Windows PowerShell does not use -l/-i; keep empty args.
  const isWindows =
    shell.toLowerCase().includes("powershell") ||
    shell.toLowerCase().endsWith("cmd.exe");
  const args = isWindows ? [] : ["-l", "-i"];

  return { shell, args, cwd, fromEnv };
}

/** Command line string for diagnostics / logging (no secrets). */
export function formatTerminalCommand(plan: TerminalSpawnPlan): string {
  const parts = [plan.shell, ...plan.args];
  return parts.join(" ");
}
