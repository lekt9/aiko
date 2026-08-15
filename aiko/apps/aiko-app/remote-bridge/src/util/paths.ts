import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRODUCT = "aiko-app";

/**
 * Data directory for the in-app Remote Bridge.
 * Prefer AIKO_REMOTE_BRIDGE_HOME, then AIKO_APP_HOME, then ~/.aiko-app/remote/bridge-data.
 */
export function defaultDataDir(): string {
  if (process.env.AIKO_REMOTE_BRIDGE_HOME) {
    return process.env.AIKO_REMOTE_BRIDGE_HOME;
  }
  if (process.env.AIKO_APP_HOME) {
    return path.join(process.env.AIKO_APP_HOME, "remote", "bridge-data");
  }
  return path.join(os.homedir(), `.${PRODUCT}`, "remote", "bridge-data");
}

/** Oldest legacy data directory: ~/.lark-grok */
export function legacyDataDir(): string {
  return path.join(os.homedir(), ".lark-grok");
}

/** External agent-connect data dir (import only; never spawn that CLI). */
export function agentConnectDataDir(): string {
  return path.join(os.homedir(), ".agent-connect");
}

export function defaultConfigPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "config.toml");
}

export function sessionsDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "data", "sessions");
}

/** Runtime state: PID, locks */
export function runDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "run");
}

export function defaultPidPath(dataDir = defaultDataDir()): string {
  return path.join(runDir(dataDir), "remote-bridge.pid");
}

export function logsDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "logs");
}

export function defaultLogFilePath(dataDir = defaultDataDir()): string {
  return path.join(logsDir(dataDir), "remote-bridge.log");
}

/** Generated service artifacts (WinSW xml, printed units, etc.) */
export function serviceDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "service");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolve the Aiko binary: explicit path, PATH, then ~/.aiko/bin/aiko. */
export function resolveGrokBinary(command = "aiko"): string {
  const trimmed = (command || "aiko").trim() || "aiko";
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    return trimmed;
  }
  // Relative path that exists from cwd
  if (trimmed.includes(path.sep) && fs.existsSync(path.resolve(trimmed))) {
    return path.resolve(trimmed);
  }
  // PATH search
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, trimmed);
    if (fs.existsSync(candidate)) return candidate;
  }
  // ~/.aiko/bin/aiko fallback
  const homeFallback = path.join(
    os.homedir(),
    ".aiko",
    "bin",
    process.platform === "win32" ? "aiko.exe" : "aiko",
  );
  if (fs.existsSync(homeFallback)) return homeFallback;
  return trimmed;
}

export function grokAuthExists(): boolean {
  return fs.existsSync(path.join(os.homedir(), ".aiko", "auth.json"));
}

export const PRODUCT_NAME = "aiko-remote-bridge";
export const CLI_NAME = "aiko-remote-bridge";
