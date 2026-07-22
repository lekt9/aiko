// store.ts — dependency-free /contract neuron store for aiko-cli.
//
// Rips the load-bearing primitives from the substrate design into pure TS:
//   • content-addressed declare (id = first 8 hex of sha256)
//   • append-only JSONL ledger (declared / iterated / satisfied)
//   • parent_id nesting (turn → tool → subagent DAG)
//   • settle with base64-JSON proof
//   • plan / frontier / seek as local agency levers (no libcontract required)
//
// No native deps. Optional FFI dual-write lives in native.ts — this module never
// imports bun:ffi or libcontract.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userDir } from "../utils/paths";

// ── row shape (contract-aligned, minimal) ────────────────────────────────────

export type StoreEvent = "declared" | "iterated" | "satisfied" | "died";

export interface StoreRow {
  event: StoreEvent;
  id: string;
  plan?: string;
  action?: string;
  parent_id?: string | null;
  agent?: string | null;
  proof?: string;
  wave?: number;
  exit_code?: number;
  result?: string;
  /** Cross-link to the signed zig substrate's contract id — set ONLY in fallback
   * (store) mode, when the anchor bridge spawned a substrate row (see anchor.ts).
   * In native mode there is one signed ledger and no cross-link is needed, so
   * this is absent. A reference, never a merge. */
  anchor_id?: string | null;
  ts: string;
}

export interface PlanJson {
  goal: string;
  count: number;
  levers: Array<{ id: string; label: string; plan?: string }>;
}

// ── backends ─────────────────────────────────────────────────────────────────

interface Backend {
  append(row: StoreRow): void;
  readAll(): StoreRow[];
}

/** In-memory backend — tests / AIKO_CONTRACT_MEMORY=1. */
class MemoryBackend implements Backend {
  rows: StoreRow[] = [];
  append(row: StoreRow): void {
    this.rows.push(row);
  }
  readAll(): StoreRow[] {
    return this.rows.slice();
  }
}

/** Append-only JSONL file under the user dir (or AIKO_CONTRACT_LEDGER path). */
class FileBackend implements Backend {
  constructor(private readonly path: string) {}
  append(row: StoreRow): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, "utf8");
  }
  readAll(): StoreRow[] {
    if (!existsSync(this.path)) return [];
    const out: StoreRow[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as StoreRow);
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }
}

// ── singleton store ──────────────────────────────────────────────────────────

let backend: Backend | null = null;
let disabled = false;
let disabledReason: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

/** Content-addressed 8-hex id — same plan+action+parent → same neuron (idempotent). */
export function contentId(plan: string, action: string, parentId: string | null | undefined): string {
  const h = createHash("sha256")
    .update(`declare|${plan}|${action}|${parentId ?? ""}`)
    .digest("hex");
  return h.slice(0, 8);
}

function resolveLedgerPath(): string {
  if (process.env.AIKO_CONTRACT_LEDGER) return process.env.AIKO_CONTRACT_LEDGER;
  // This store is the FALLBACK ledger (used when the dylib isn't live). Its rows
  // stay separate from the signed zig ledger by design; native mode bypasses this
  // path entirely and writes the one signed ledger through FFI (see native.ts).
  const cwd = process.cwd();
  const project = join(cwd, ".claude", "contracts.aiko.jsonl");
  if (existsSync(join(cwd, ".claude")) || existsSync(join(cwd, ".git"))) {
    return project;
  }
  return join(userDir(), "contracts.aiko.jsonl");
}

/** The resolved ledger path. aiko-cli deliberately keeps its rows in
 * `contracts.aiko.jsonl`, SEPARATE from the zig substrate's `contracts.jsonl`
 * (the divergence is by design, not drift). Exposed so the separation is
 * assertable and the SDK can surface it. */
export function ledgerPath(): string {
  return resolveLedgerPath();
}

function ensureBackend(): Backend | null {
  if (process.env.AIKO_CONTRACT_DISABLED === "1") {
    disabled = true;
    disabledReason = "AIKO_CONTRACT_DISABLED=1";
    return null;
  }
  // Re-enable if env was cleared after a prior disable.
  if (disabled && process.env.AIKO_CONTRACT_DISABLED !== "1") {
    disabled = false;
    disabledReason = null;
  }
  if (disabled) return null;
  if (backend) return backend;

  // Hermetic by default under tests unless an explicit ledger path is set.
  const forceMemory =
    process.env.AIKO_CONTRACT_MEMORY === "1" ||
    ((process.env.VITEST || process.env.NODE_ENV === "test") && !process.env.AIKO_CONTRACT_LEDGER);

  backend = forceMemory ? new MemoryBackend() : new FileBackend(resolveLedgerPath());
  return backend;
}

/** Test/reset hook. */
export function _resetStoreForTests(opts?: { memory?: boolean; path?: string }): void {
  disabled = false;
  disabledReason = null;
  backend = null;
  if (process.env.AIKO_CONTRACT_DISABLED === "1") {
    disabled = true;
    disabledReason = "AIKO_CONTRACT_DISABLED=1";
    return;
  }
  if (opts?.memory || process.env.AIKO_CONTRACT_MEMORY === "1") {
    backend = new MemoryBackend();
  } else if (opts?.path) {
    backend = new FileBackend(opts.path);
  }
}

export function storeAvailable(): boolean {
  return ensureBackend() !== null;
}

export function storeUnavailableReason(): string | null {
  ensureBackend();
  return disabled ? disabledReason : null;
}

export function declare(
  plan: string,
  action = "claim",
  parentId?: string | null,
  agent?: string | null,
  anchorId?: string | null,
): string | null {
  const b = ensureBackend();
  if (!b) return null;
  const id = contentId(plan, action, parentId);
  // Idempotent: re-declare same content is the same id; still append a declared row
  // only when this id has never been declared (pointers-over-volume).
  const rows = b.readAll();
  const already = rows.some((r) => r.id === id && r.event === "declared");
  if (!already) {
    b.append({
      event: "declared",
      id,
      plan,
      action,
      parent_id: parentId ?? null,
      agent: agent ?? null,
      ...(anchorId ? { anchor_id: anchorId } : {}),
      ts: nowIso(),
    });
  }
  return id;
}

export function get(cid: string): string | null {
  const b = ensureBackend();
  if (!b) return null;
  const lines = b
    .readAll()
    .filter((r) => r.id === cid)
    .map((r) => JSON.stringify(r));
  return lines.length ? lines.join("\n") : null;
}

export function markSatisfied(cid: string, proof: string, wave = 1): number {
  const b = ensureBackend();
  if (!b) return -1;
  b.append({ event: "satisfied", id: cid, proof, wave, ts: nowIso() });
  return 0;
}

export function fire(cid: string, exitCode = 0, result = "", wave = 1): number {
  const b = ensureBackend();
  if (!b) return -1;
  const event: StoreEvent = exitCode === 0 ? "iterated" : "died";
  b.append({
    event,
    id: cid,
    exit_code: exitCode,
    result,
    wave,
    ts: nowIso(),
  });
  return 0;
}

// ── agency primitives (local, no dylib) ──────────────────────────────────────

const ALGORITHM_LEVERS = [
  { key: "question", label: "question — challenge every requirement" },
  { key: "delete", label: "delete — remove what fails the question" },
  { key: "simplify", label: "simplify — unify what remains" },
  { key: "accelerate", label: "accelerate — shorten the feedback loop" },
  { key: "automate", label: "automate — last; never automate junk" },
] as const;

function isTerminal(rows: StoreRow[], id: string): boolean {
  // Latest terminal event wins.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.id !== id) continue;
    if (r.event === "satisfied" || r.event === "died") return true;
  }
  return false;
}

function declaredMeta(rows: StoreRow[], id: string): StoreRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].id === id && rows[i].event === "declared") return rows[i];
  }
  return undefined;
}

/** Algorithm checklist + clause split of the goal into actionable levers. */
export function planGoal(goal: string): string | null {
  if (!ensureBackend()) return null;
  const levers: PlanJson["levers"] = [];

  // 1) Always surface the five algorithm steps for ship-shaped work.
  if (/\b(ship|done|finish|release|deploy|preflight|algorithm)\b/i.test(goal) || goal.length > 0) {
    for (const step of ALGORITHM_LEVERS) {
      levers.push({
        id: contentId(`algo:${step.key}:${goal}`, "lever", null),
        label: step.label,
        plan: `algorithm:${step.key} — ${goal}`,
      });
    }
  }

  // 2) Split on ; / and / then — coarse multi-step goals.
  const clauses = goal
    .split(/\s*(?:;|\band then\b|\bthen\b|\band\b)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && s.length < 200);
  for (const clause of clauses.slice(0, 6)) {
    if (clauses.length === 1) break; // single clause already covered by algorithm
    levers.push({
      id: contentId(`clause:${clause}`, "lever", null),
      label: clause,
      plan: clause,
    });
  }

  // 3) If still empty, one lever = the goal itself.
  if (levers.length === 0) {
    levers.push({
      id: contentId(`goal:${goal}`, "goal", null),
      label: goal.slice(0, 120),
      plan: `goal:${goal}`,
    });
  }

  const plan: PlanJson = { goal, count: levers.length, levers };
  return JSON.stringify(plan);
}

/**
 * Frontier = open (declared, not terminal) neurons whose plan/goal relates to `goal`,
 * plus unsatisfied algorithm levers for that goal. This is the local form of
 * plan.unresolvedFrontier without the zig binary.
 */
export function frontier(goal: string, _skillPath?: string | null): string | null {
  const b = ensureBackend();
  if (!b) return null;
  const rows = b.readAll();
  const levers: PlanJson["levers"] = [];
  const seen = new Set<string>();

  const goalNeedle = goal.slice(0, 80).toLowerCase();

  // Open declared rows that mention the goal (or are children of a matching goal).
  const openIds = new Set<string>();
  for (const r of rows) {
    if (r.event !== "declared" || !r.id) continue;
    if (isTerminal(rows, r.id)) continue;
    openIds.add(r.id);
  }

  for (const id of openIds) {
    const meta = declaredMeta(rows, id);
    if (!meta?.plan) continue;
    const planText = meta.plan.toLowerCase();
    if (goalNeedle && !planText.includes(goalNeedle) && !planText.includes("goal:") && meta.action !== "goal") {
      // keep algorithm / lever rows for this goal
      if (!planText.includes("algorithm:") && !planText.startsWith("lever:")) continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    levers.push({
      id,
      label: (meta.plan ?? id).replace(/^goal:/i, "").slice(0, 160),
      plan: meta.plan,
    });
    if (levers.length >= 12) break;
  }

  // If nothing open, fall back to a fresh plan (the substrate always has a next step).
  if (levers.length === 0) {
    return planGoal(goal);
  }

  return JSON.stringify({ goal, count: levers.length, levers } satisfies PlanJson);
}

/** Seek = plan with a "compile" flavor — same levers, labeled for expansion. */
export function seekCompile(goal: string): string | null {
  const raw = planGoal(goal);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PlanJson;
    p.levers = p.levers.map((l) => ({
      ...l,
      label: l.label.startsWith("seek:") ? l.label : `seek: ${l.label}`,
    }));
    p.count = p.levers.length;
    return JSON.stringify(p);
  } catch {
    return raw;
  }
}

/** All rows (debug / diagnostics). */
export function dumpRows(): StoreRow[] {
  return ensureBackend()?.readAll() ?? [];
}
