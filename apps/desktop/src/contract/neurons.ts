// neurons.ts — run aiko operations as /contract neurons (binding store).
//
// Each operation declares a content-addressed neuron, threads its parent (so the
// turn→tool→subagent call graph folds into the contract DAG), and settles with its
// result as a base64-JSON proof. The store is pure TS and always-on unless
// AIKO_CONTRACT_DISABLED=1.
//
// RECALL is OPT-IN and PURE-only — impure ops always re-run (no false-green gates).
//
// SPAWN MODE: spawnNeuron() forks a separate process per neuron, making Aiko
// stateless — each contract run IS an Aiko instance. The contract DAG becomes
// a process tree. This is the fractal execution model.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import * as native from "./native";

const parentStore = new AsyncLocalStorage<string | null>();

function currentParent(): string | null {
  return parentStore.getStore() ?? null;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? null)).toString("base64");
}

function decode(proof: string): unknown {
  return JSON.parse(Buffer.from(proof, "base64").toString("utf8"));
}

/** Scan a neuron's JSONL rows for the last decodable proof. */
function recallProof(rows: string | null): { found: boolean; value: unknown } {
  if (!rows) return { found: false, value: null };
  let found = false;
  let value: unknown = null;
  for (const line of rows.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { proof?: string };
      if (row.proof) {
        try {
          value = decode(row.proof);
          found = true;
        } catch {
          /* skip unparseable proof */
        }
      }
    } catch {
      /* skip foreign line */
    }
  }
  return { found, value };
}

export interface NeuronOptions {
  /** Recall a prior settled proof instead of running fn. PURE operations only. */
  recall?: boolean;
  /** Ledger action label (declare kind). Default "claim". */
  action?: string;
  /** Which agent/persona owns this neuron. */
  agent?: string;
  /** Explicit parent neuron id — overrides the AsyncLocalStorage parent (used by drive()). */
  parent?: string;
}

/**
 * Run `fn` as a contract neuron. Declares `plan` (content-addressed), threads the parent
 * so nested neurons auto-nest in the DAG, and settles with fn's result as the proof.
 *
 * If opts.recall is set and a prior proof exists, returns it WITHOUT running fn. When the
 * substrate is unavailable, this is a transparent pass-through — fn runs and its value is
 * returned, nothing recorded.
 */
export async function runNeuron<T>(plan: string, opts: NeuronOptions, fn: () => T | Promise<T>): Promise<T> {
  if (!native.isAvailable()) return await fn();

  const parent = opts.parent ?? currentParent();
  const cid = native.declare(plan, opts.action ?? "claim", parent, opts.agent ?? null);
  if (!cid) return await fn();

  if (opts.recall) {
    const { found, value } = recallProof(native.get(cid));
    if (found) return value as T;
  }

  return await parentStore.run(cid, async () => {
    try {
      const out = await fn();
      native.markSatisfied(cid, encode(out));
      return out;
    } catch (err) {
      native.fire(cid, 1, String(err));
      throw err;
    }
  });
}

/**
 * Open a long-lived neuron scope for the current async context (e.g. an async-generator
 * turn) via enterWith, so tool/subagent neurons spawned during it auto-nest as children.
 * Returns the neuron id (settle it later with settleScope) or null if disabled.
 */
export function openScope(plan: string, opts: NeuronOptions = {}): string | null {
  if (!native.isAvailable()) return null;
  const parent = currentParent();
  const cid = native.declare(plan, opts.action ?? "turn", parent, opts.agent ?? null);
  if (cid) parentStore.enterWith(cid);
  return cid;
}

/** Settle a scope opened with openScope (no-op if null/disabled). */
export function settleScope(cid: string | null, proof: unknown, ok = true): void {
  if (!cid || !native.isAvailable()) return;
  if (ok) native.markSatisfied(cid, encode(proof));
  else native.fire(cid, 1, encode(proof));
}

/** Record a mid-flight witness under the currently open neuron (no-op if none / disabled). */
export function witness(label: string, value?: unknown): void {
  const cid = currentParent();
  if (!cid || !native.isAvailable()) return;
  const payload = value !== undefined ? { label, value } : { label };
  native.fire(cid, 0, encode(payload));
}

/** The id of the currently open neuron, if any (for linking into other subsystems). */
export function currentNeuronId(): string | null {
  return currentParent();
}

// ── spawn mode — fractal process tree ──────────────────────────────────────

export interface SpawnOptions {
  /** Parent neuron id — this spawn becomes a child in the DAG. */
  parent?: string | null;
  /** Action label (declare kind). Default "spawn". */
  action?: string;
  /** Which agent/persona owns this neuron. */
  agent?: string;
  /** Max tool rounds for the spawned process. Default 200. */
  maxToolRounds?: number;
  /** Working directory. Default cwd. */
  cwd?: string;
  /** Timeout in ms. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** If true, don't wait for the child — fire and forget. */
  detach?: boolean;
  /** Extra env vars to pass to the child. */
  env?: Record<string, string>;
}

export interface SpawnResult {
  /** The declared neuron id (content-addressed). */
  neuronId: string;
  /** Child process pid. */
  pid: number;
  /** Promise that resolves with exit code when the child finishes (null if detached). */
  done: Promise<number> | null;
  /** Kill the child process. */
  kill: () => void;
}

export function buildSpawnCommand(plan: string, opts: SpawnOptions, parentId: string | null): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const command = opts.env?.AIKO_BIN ?? process.env.AIKO_BIN ?? "aiko";
  const args = [
    "-p",
    plan,
    "--output-format",
    "json",
    "--permission-mode",
    "auto",
    "--max-turns",
    String(opts.maxToolRounds ?? 200),
    "--no-memory",
    "--rules",
    "You are one isolated Contract worker. Load relevant skills, expand independent work into bounded child contracts, run safe siblings in parallel, and ground completion in observed child outcomes.",
  ];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  return {
    command,
    args,
    env: {
      ...process.env,
      ...opts.env,
      AIKO_CONTRACT_PARENT_ID: parentId ?? "",
    },
  };
}

/**
 * Spawn a neuron as a separate Aiko process. Each spawn IS a self-contained
 * `node dist/index.js --neuron-id <id> --prompt "..."` run. The child declares
 * itself in the contract ledger, executes the plan, and marks satisfied on exit.
 *
 * This is the fractal execution model: the contract DAG becomes a process tree.
 * Parents spawn children; children spawn grandchildren. The ledger is the only
 * shared state — every process is stateless beyond what it reads from the DAG.
 */
export function spawnNeuron(
  plan: string,
  opts: SpawnOptions = {},
): SpawnResult | null {
  if (!native.isAvailable()) return null;

  const parentId = opts.parent ?? currentParent();

  // The native declaration is the identity. Never invent an unrelated process
  // id in TypeScript: lineage and execution must point at the same contract.
  const cid = native.declare(plan, opts.action ?? "spawn", parentId, opts.agent ?? null);
  if (!cid) return null;

  const maxRounds = opts.maxToolRounds ?? 200;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const invocation = buildSpawnCommand(plan, { ...opts, maxToolRounds: maxRounds }, parentId);
  const child = spawn(invocation.command, invocation.args, {
    cwd: opts.cwd ?? process.cwd(),
    env: invocation.env,
    stdio: "pipe",
    timeout: timeoutMs,
  });

  let _killed = false;
  const kill = () => {
    _killed = true;
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
  };

  if (opts.detach) {
    child.unref();
    // Fire and forget — don't even collect output
    child.stdout?.resume();
    child.stderr?.resume();
    return { neuronId: cid, pid: child.pid ?? -1, done: null, kill };
  }

  // Collect stderr for diagnostics (stdout is the agent output, we discard it)
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const done = new Promise<number>((resolve, reject) => {
    child.on("close", (code) => {
      if (_killed) { resolve(143); return; }
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      if (_killed) { resolve(143); return; }
      reject(err);
    });
    setTimeout(() => {
      if (!_killed) {
        kill();
        resolve(124); // timeout
      }
    }, timeoutMs);
  });

  return { neuronId: cid, pid: child.pid ?? -1, done, kill };
}

/** Spawn one dependency-safe wave. Every plan becomes an isolated Aiko
 * process and all siblings begin immediately; callers await the wave barrier
 * before spawning dependent children. */
export function spawnNeuronWave(plans: readonly string[], opts: SpawnOptions = {}): SpawnResult[] {
  return plans
    .slice(0, 16)
    .map((plan) => spawnNeuron(plan, opts))
    .filter((result): result is SpawnResult => result !== null);
}
