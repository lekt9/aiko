// neurons.ts — run aiko operations as /contract neurons (binding store).
//
// Each operation declares a content-addressed neuron, threads its parent (so the
// turn→tool→subagent call graph folds into the contract DAG), and settles with its
// result as a base64-JSON proof. The store is pure TS and always-on unless
// AIKO_CONTRACT_DISABLED=1.
//
// RECALL is OPT-IN and PURE-only — impure ops always re-run (no false-green gates).
import { AsyncLocalStorage } from "node:async_hooks";
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
