// native.ts — the ONE binding to the /contract substrate inside aiko-cli.
//
// SOURCE OF TRUTH (the only one): the signed libcontract.dylib via bun:ffi. It runs
// declare / get / mark_satisfied / iterate / gate in-process (µs after warmup, no
// subprocess), landing rows in the one signed ledger with signed Zig ids
// (inputs_hash_v2 lineage). isNative() is true when it's loaded.
//
// There is NO TS reimplementation of these primitives. When the dylib isn't loaded
// the binding is simply OFF: declare/get return null, settle/fire are no-ops, the
// gate allows. (The pure-TS mirror that used to shadow the signed primitives was a
// second source of truth and it drifted — it's gone.)
//
// plan/frontier/seekCompile are NOT substrate primitives — they're aiko's own
// planning engine (store.ts), which has no Zig counterpart, so they stay in TS.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as store from "./store";

// ── FFI to the signed dylib ──────────────────────────────────────────────────

type Sym = {
  contract_declare: (plan: number, action: number, parent: number, agent: number) => number;
  contract_get: (cid: number) => number;
  contract_mark_satisfied: (cid: number, wave: number, proof: number) => number;
  contract_iterate: (cid: number, wave: number, exitCode: number, result: number) => number;
  contract_gate: (scope: number, tool: number, argsJson: number) => number;
  contract_recommend: (context: number) => number;
  contract_list: () => number;
  contract_list_scheduled_json: () => number;
  contract_tick_json: (requestJson: number) => number;
  contract_settle_execution_json: (requestJson: number) => number;
  contract_declare_scheduled: (
    prompt: number,
    cwd: number,
    interval: number,
    recurring: number,
    firstDue: number,
  ) => number;
  contract_free: (p: number) => void;
};

let ffi: Sym | null = null;
let ffiTried = false;
let ffiError: string | null = null;

function candidatePaths(): string[] {
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const lib = `libcontract.${ext}`;
  const out: string[] = [];
  const env = process.env.LIBCONTRACT_PATH;
  if (env) out.push(env);
  const home = process.env.CONTRACT_HOME;
  if (home) {
    out.push(join(home, "libcontract", "zig-out", "lib", lib)); // canonical build output
    out.push(join(home, "libcontract", lib));
  }
  const repo = join(homedir(), "Unbrowse", "contract", "libcontract");
  out.push(join(repo, "zig-out", "lib", lib)); // canonical build output
  out.push(join(repo, lib));
  out.push(join(homedir(), ".config", "contract", "lib", lib));
  return out;
}

function tryLoadFfi(): void {
  if (ffiTried) return;
  ffiTried = true;
  // Only an explicit opt-out disables FFI. Tests set AIKO_CONTRACT_FFI=0 via the
  // vitest setup file — production carries no "am I under a test runner?" branch.
  if (process.env.AIKO_CONTRACT_FFI === "0") {
    ffiError = "ffi disabled (AIKO_CONTRACT_FFI=0)";
    return;
  }
  let libPath = "";
  for (const c of candidatePaths()) {
    if (c && existsSync(c)) {
      libPath = c;
      break;
    }
  }
  if (!libPath) {
    ffiError = "libcontract not found (binding off — no TS fallback)";
    return;
  }
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    const { symbols } = dlopen(libPath, {
      contract_declare: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
        returns: FFIType.ptr,
      },
      contract_get: { args: [FFIType.cstring], returns: FFIType.ptr },
      contract_mark_satisfied: { args: [FFIType.cstring, FFIType.u32, FFIType.cstring], returns: FFIType.i32 },
      contract_iterate: { args: [FFIType.cstring, FFIType.u32, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
      contract_gate: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
      contract_recommend: { args: [FFIType.cstring], returns: FFIType.ptr },
      contract_list: { args: [], returns: FFIType.ptr },
      contract_list_scheduled_json: { args: [], returns: FFIType.ptr },
      contract_tick_json: { args: [FFIType.cstring], returns: FFIType.ptr },
      contract_settle_execution_json: { args: [FFIType.cstring], returns: FFIType.i32 },
      contract_declare_scheduled: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.u64, FFIType.i32, FFIType.i64],
        returns: FFIType.ptr,
      },
      contract_free: { args: [FFIType.ptr], returns: FFIType.void },
    });
    ffi = symbols as Sym;
  } catch (err) {
    ffiError = err instanceof Error ? err.message : String(err);
  }
}

function cstr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const { ptr } = require("bun:ffi");
  return ptr(Buffer.from(`${s}\0`, "utf8"));
}

function readFree(p: number): string | null {
  if (!p || !ffi) return null;
  const { CString } = require("bun:ffi");
  const s = new CString(p).toString();
  ffi.contract_free(p);
  return s;
}

// ── FFI primitive calls (signed truth; null when the dylib isn't live) ────────

function ffiDeclare(plan: string, action: string, parentId?: string | null, agent?: string | null): string | null {
  if (!ffi) return null;
  try {
    const p = cstr(plan);
    if (p == null) return null;
    const id = readFree(
      ffi.contract_declare(p, cstr(action) ?? 0, cstr(parentId ?? null) ?? 0, cstr(agent ?? null) ?? 0),
    );
    return id && /^[0-9a-f]{8}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function ffiGet(cid: string): string | null {
  if (!ffi) return null;
  try {
    const c = cstr(cid);
    if (c == null) return null;
    return readFree(ffi.contract_get(c));
  } catch {
    return null;
  }
}

function ffiMarkSatisfied(cid: string, proof: string, wave: number): number | null {
  if (!ffi) return null;
  try {
    const c = cstr(cid);
    if (c == null) return null;
    return ffi.contract_mark_satisfied(c, wave, cstr(proof) ?? 0);
  } catch {
    return null;
  }
}

function ffiIterate(cid: string, exitCode: number, result: string, wave: number): number | null {
  if (!ffi) return null;
  try {
    const c = cstr(cid);
    if (c == null) return null;
    return ffi.contract_iterate(c, wave, exitCode, cstr(result) ?? 0);
  } catch {
    return null;
  }
}

// ── public binding API (the signed dylib is the only source of truth) ─────────

/** True when the signed dylib is live (the one source of truth). */
export function isAvailable(): boolean {
  return isNative();
}

/** Why the binding is unavailable, or null when engaged. */
export function unavailableReason(): string | null {
  return isNative() ? null : "signed substrate (libcontract) not loaded";
}

/** Whether the signed dylib is loaded — when false the binding is simply off. */
export function isNative(): boolean {
  tryLoadFfi();
  return ffi !== null;
}

/** Diagnostics: did the FFI load, and if not, why. */
export function ffiMirrorStatus(): { loaded: boolean; reason: string | null } {
  tryLoadFfi();
  return { loaded: ffi !== null, reason: ffi ? null : ffiError };
}

// The primitives are served by the signed dylib ONLY. With no dylib the contract
// binding is simply OFF (a no-op) — it never falls back to a TS reimplementation of
// the substrate (that mirror was a second source of truth and it drifted).
export function declare(
  plan: string,
  action = "claim",
  parentId?: string | null,
  agent?: string | null,
): string | null {
  return isNative() ? ffiDeclare(plan, action, parentId, agent) : null;
}

export function get(cid: string): string | null {
  return isNative() ? ffiGet(cid) : null;
}

export function markSatisfied(cid: string, proof: string, wave = 1): number {
  return isNative() ? (ffiMarkSatisfied(cid, proof, wave) ?? 1) : 0;
}

export function fire(cid: string, exitCode = 0, result = "", wave = 1): number {
  return isNative() ? (ffiIterate(cid, exitCode, result, wave) ?? 1) : 0;
}

/**
 * The LEARNED energy router: given a goal, the signed substrate returns the binary
 * its past successes say fits best — argmin energy, no LLM. null when the dylib
 * isn't loaded or nothing's been learned yet. This is aiko's instinct: it improves
 * as the ledger accumulates satisfied runs.
 */
/** The learned recommendation for `context`: the tool to try AND the nearest PROVEN
 * command for it (self-documented from past satisfied runs), plus a similarity score.
 * null when nothing has been learned yet. */
export function recommend(context: string): { binary: string; example: string; score: number } | null {
  if (!isNative() || !ffi) return null;
  try {
    const c = cstr(context);
    if (c == null) return null;
    const r = readFree(ffi.contract_recommend(c));
    if (!r || r.length === 0) return null;
    const j = JSON.parse(r) as { binary?: string; example?: string; score?: number };
    if (!j.binary) return null;
    return { binary: j.binary, example: j.example ?? "", score: j.score ?? 0 };
  } catch {
    return null;
  }
}

// plan/frontier/seekCompile are aiko's own algorithm-shaped planner — there is
// no Zig primitive to delegate to, so they stay TS in both modes.
export function planGoal(goal: string): string | null {
  return store.planGoal(goal);
}

export function frontier(goal: string, skillPath?: string | null): string | null {
  return store.frontier(goal, skillPath);
}

export function seekCompile(goal: string): string | null {
  return store.seekCompile(goal);
}

/**
 * Ask the signed substrate to authorize a tool call — the tool authority IS
 * signed code (gate.zig via contract_gate). Returns raw JSON
 * {"decision","risk","reason"}, or null when the dylib isn't live (gate.ts then
 * falls back to its byte-identical TS policy mirror). Never throws.
 */
export function gate(scope: string, tool: string, argsJson: string): string | null {
  tryLoadFfi();
  if (!ffi) return null;
  try {
    const sc = cstr(scope ?? "");
    const tn = cstr(tool ?? "");
    const aj = cstr(argsJson ?? "");
    if (sc == null || tn == null || aj == null) return null;
    return readFree(ffi.contract_gate(sc, tn, aj));
  } catch {
    return null;
  }
}

/** List all declared contract ids as `id\tplan\n` lines. */
export function listAll(): string | null {
  tryLoadFfi();
  if (!ffi) return null;
  try {
    return readFree(ffi.contract_list());
  } catch {
    return null;
  }
}

/** List native durable schedules as JSON. */
export function listScheduledJson(): string | null {
  tryLoadFfi();
  if (!ffi) return null;
  try {
    return readFree(ffi.contract_list_scheduled_json());
  } catch {
    return null;
  }
}

// ── daemon loop: tick → claim → execute → settle ───────────────────────────

export interface TickRequest {
  owner: string;
  cwd?: string;
  nowUnix?: number;
  maxItems?: number;
  leaseSeconds?: number;
}

export interface Claim {
  contractId: string;
  occurrence: string;
  prompt: string;
  cwd: string;
  dueUnix: number;
  leaseUntilUnix: number;
}

export interface TickResult {
  abiVersion: number;
  nowUnix: number;
  nextWakeUnix: number | null;
  claims: Claim[];
}

/** Tick the scheduler: what's due now? */
export function tick(req: TickRequest): TickResult | null {
  tryLoadFfi();
  if (!ffi) return null;
  try {
    const requestJson = JSON.stringify({
      owner: req.owner,
      cwd: req.cwd ?? process.cwd(),
      now_unix: req.nowUnix,
      max_items: req.maxItems ?? 32,
      lease_seconds: req.leaseSeconds ?? 300,
    });
    const raw = readFree(ffi.contract_tick_json(cstr(requestJson)!));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      abi_version: number;
      now_unix: number;
      next_wake_unix: number | null;
      claims: Array<{
        contract_id: string;
        occurrence: string;
        prompt: string;
        cwd: string;
        due_unix: number;
        lease_until_unix: number;
      }>;
    };
    return {
      abiVersion: parsed.abi_version,
      nowUnix: parsed.now_unix,
      nextWakeUnix: parsed.next_wake_unix,
      claims: parsed.claims.map((c) => ({
        contractId: c.contract_id,
        occurrence: c.occurrence,
        prompt: c.prompt,
        cwd: c.cwd,
        dueUnix: c.due_unix,
        leaseUntilUnix: c.lease_until_unix,
      })),
    };
  } catch {
    return null;
  }
}

export type SettleOutcome = "satisfied" | "retry" | "died";

/** Settle a claim: tell the scheduler the outcome. */
export function settleExecution(
  owner: string,
  contractId: string,
  occurrence: string,
  outcome: SettleOutcome,
  detail?: string,
): boolean {
  tryLoadFfi();
  if (!ffi) return false;
  try {
    const requestJson = JSON.stringify({
      owner,
      contract_id: contractId,
      occurrence,
      outcome,
      detail: detail ?? "",
    });
    const rc = ffi.contract_settle_execution_json(cstr(requestJson)!);
    return rc === 0;
  } catch {
    return false;
  }
}

/** Declare a scheduled contract neuron. Returns the neuron id. */
export function declareScheduled(
  prompt: string,
  cwd: string,
  intervalSeconds: number,
  recurring: boolean,
  firstDueUnix: number,
): string | null {
  tryLoadFfi();
  if (!ffi) return null;
  try {
    const p = cstr(prompt);
    const d = cstr(cwd ?? "");
    if (p == null || d == null) return null;
    const recurringInt: number = recurring ? 1 : 0;
    const raw = readFree(ffi.contract_declare_scheduled(p, d, intervalSeconds, recurringInt, firstDueUnix));
    return raw && /^[0-9a-f]{8}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
