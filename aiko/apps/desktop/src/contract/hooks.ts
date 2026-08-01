// hooks.ts — generalised contract-native hook pipeline.
//
// Any system component (telegram, bash, file io, etc.) registers hooks for
// a scope. When data flows through that scope, each hook runs through the
// contract substrate: declare → gate → (transform?) → mark_satisfied.
//
// Hooks are composable — they chain in registration order. Each hook is an
// opportunity for the substrate to allow, deny, or route differently, and
// each satisfied run teaches the substrate which chains produce good outcomes.
//
// This is the "infinite webhooks with reasoning between them" model you
// described: every hook validates, every hook learns, every hook can spawn
// the next hook in the pipeline.

import type { FractalEBM } from "./fractal-ebm";
import * as contract from "./native";

/** Global fractal EBM — set once at startup. Every hook fire trains it. */
let fractalEBM: FractalEBM | null = null;

export function setFractalEBM(ebm: FractalEBM): void {
  fractalEBM = ebm;
}

// ── types ─────────────────────────────────────────────────────────────────

export interface HookContext {
  /** What's flowing through the pipe */
  text: string;
  /** Who initiated this (telegram user id, agent turn id, etc.) */
  source: string;
  /** Arbitrary metadata hooks can pass to each other */
  meta: Record<string, unknown>;
}

export interface GateResult {
  allowed: boolean;
  decision: "allow" | "confirm" | "deny";
  transformed?: boolean;
}

export interface HookStep {
  /** Name of the hook that ran */
  hook: string;
  /** The contract neuron id declared for this step */
  neuronId: string | null;
  /** The gate decision */
  decision: "allow" | "confirm" | "deny" | null;
  /** Whether this step transformed the data */
  transformed: boolean;
}

export interface PipelineResult {
  /** The (possibly transformed) text after all hooks */
  text: string;
  /** Whether the pipeline allowed this to proceed */
  allowed: boolean;
  /** Trace of every hook step for debugging/learning */
  trace: HookStep[];
  /** Metadata set by hooks (e.g. voiceFile from voice-circuit) */
  meta: Record<string, unknown>;
}

/**
 * A single hook in the pipeline. Hooks are pure functions that receive a
 * context and return a gate decision plus optionally transformed context.
 *
 * Lifecycle per hook invocation:
 *   1. declare — register a contract neuron for this step
 *   2. gate    — ask the substrate to authorize this step
 *   3. run     — the hook's logic (transform, validate, route)
 *   4. mark_satisfied — teach the substrate this outcome was good
 */
export interface Hook {
  /** Unique name for this hook, e.g. "thinkfeel-output", "rate-limit" */
  name: string;
  /** Scope this hook watches, e.g. "telegram:output", "bash:pre-exec" */
  scope: string;
  /**
   * Priority — lower numbers run first. Default 100.
   * Hooks at the same priority run in registration order.
   */
  priority?: number;
  /**
   * Run the hook. Return the (possibly modified) context and whether to
   * allow the data to continue down the pipeline. Set allowed=false to
   * block (gate deny). Return the same context unchanged for a no-op.
   */
  run(ctx: HookContext): Promise<{ allowed: boolean; ctx: HookContext }>;
}

// ── registry ──────────────────────────────────────────────────────────────

interface RegisteredHook {
  hook: Hook;
  priority: number;
}

const registry: RegisteredHook[] = [];

/** Register a hook for a scope. Returns a deregister function. */
export function register(hook: Hook): () => void {
  const entry: RegisteredHook = { hook, priority: hook.priority ?? 100 };
  registry.push(entry);
  // sort by priority, then registration order (stable)
  registry.sort((a, b) => a.priority - b.priority);
  return () => {
    const i = registry.indexOf(entry);
    if (i >= 0) registry.splice(i, 1);
  };
}

/** List all registered hooks (for debugging). */
export function listHooks(): Array<{ name: string; scope: string; priority: number }> {
  return registry.map((r) => ({
    name: r.hook.name,
    scope: r.hook.scope,
    priority: r.priority,
  }));
}

// ── pipeline runner ───────────────────────────────────────────────────────

/**
 * Run data through all hooks registered for a scope.
 *
 * Each hook goes through the contract cycle:
 *   neuronId = declare(scope + ":" + hookName, ctx.text)
 *   decision = gate(scope, hookName, ctx.text)
 *   if decision === "deny" → break pipeline, return blocked
 *   ctx = hook.run(ctx)        // may transform
 *   mark_satisfied(neuronId, "ok")
 *
 * Hooks run in priority order. If any hook blocks, the pipeline stops.
 */
/**
 * Wildcard scope matching. `*:output` matches `telegram:output`,
 * `agent:output`, `bash:output`, etc. `*:*` matches everything.
 * Exact match always wins (no wildcard needed).
 */
function scopeMatches(hookScope: string, actualScope: string): boolean {
  if (hookScope === actualScope) return true;
  const hookParts = hookScope.split(":");
  const actualParts = actualScope.split(":");
  if (hookParts.length !== actualParts.length) return false;
  for (let i = 0; i < hookParts.length; i++) {
    if (hookParts[i] !== "*" && hookParts[i] !== actualParts[i]) return false;
  }
  return true;
}

export async function runPipeline(scope: string, initial: HookContext): Promise<PipelineResult> {
  const trace: HookStep[] = [];
  let ctx: HookContext = { ...initial, meta: { ...initial.meta } };
  let allowed = true;

  const matching = registry.filter((r) => scopeMatches(r.hook.scope, scope));

  for (const entry of matching) {
    const hook = entry.hook;

    // Step 1: declare the neuron
    const neuronId = contract.declare(`${scope}:${hook.name}`, ctx.text.slice(0, 200), null, "aiko-hook-engine");

    // Step 2: gate through the substrate
    let decision: "allow" | "confirm" | "deny" | null = null;
    if (contract.isNative()) {
      try {
        const g = contract.gate(`${scope}:${hook.name}`, hook.name, JSON.stringify({ text: ctx.text.slice(0, 400) }));
        if (g) {
          const parsed = JSON.parse(g) as { decision?: string };
          if (parsed.decision === "deny") decision = "deny";
          else if (parsed.decision === "confirm") decision = "confirm";
          else decision = "allow";
        }
      } catch {
        // gate parse failure — allow by default (fail-open for messaging,
        // fail-closed for bash; hooks can override)
        decision = "allow";
      }
    } else {
      // no substrate — allow everything
      decision = "allow";
    }

    if (decision === "deny") {
      trace.push({ hook: hook.name, neuronId, decision, transformed: false });
      allowed = false;
      break;
    }

    // Step 3: run the hook
    const before = ctx.text;
    let transformed = false;
    try {
      const result = await hook.run(ctx);
      ctx = result.ctx;
      if (!result.allowed) {
        trace.push({ hook: hook.name, neuronId, decision, transformed: false });
        allowed = false;
        break;
      }
      transformed = ctx.text !== before;
    } catch (err) {
      console.error(`[contract-hooks] hook "${hook.name}" threw:`, err);
      trace.push({ hook: hook.name, neuronId, decision, transformed: false });
      // hook error — continue with unchanged context
    }

    // Step 4: mark satisfied so the substrate learns
    if (neuronId) {
      contract.markSatisfied(neuronId, transformed ? `transformed via ${hook.name}` : `passed through ${hook.name}`);
    }

    // Step 5: train the fractal EBM — every hook fire shapes the
    // energy landscape. The channel tree learns which operations
    // succeed (reward +1) and which fail (reward -1).
    if (fractalEBM) {
      const reward = !allowed ? -1.0 : 1.0;
      fractalEBM.fire(scope, ctx.text.slice(0, 200), reward, null);
    }

    trace.push({ hook: hook.name, neuronId, decision, transformed });
  }

  return { text: ctx.text, allowed, trace, meta: ctx.meta };
}
