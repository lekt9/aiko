// agency.ts — the public API that wraps the /contract binding to act with agency.
//
// The binding store (store.ts via native.ts) is the ENGINE: given a goal it plans, exposes
// a frontier of actionable "levers", and settles neurons until the goal is satisfied.
// Dependency-free by default; optional FFI dual-write when libcontract is present.
// This module is the thin, typed, bounded surface — the ONE thing a caller imports.
// It does NOT know how a step is executed — that is an injected `Executor` (drive()).

import * as native from "./native";
import { runNeuron } from "./neurons";

/** One actionable step the substrate surfaces for a goal. Shape is substrate-defined; we
 * keep the raw record and pull the fields a driver needs. */
export interface Lever {
  id?: string;
  label?: string;
  [k: string]: unknown;
}

/** The substrate's answer for a goal: the goal, how many levers, and the levers themselves. */
export interface Plan {
  goal: string;
  count: number;
  levers: Lever[];
}

/** Whether the agency engine is actually backed by the substrate right now. */
export function isEngaged(): boolean {
  return native.isAvailable();
}

function parsePlan(goal: string, raw: string | null): Plan {
  if (!raw) return { goal, count: 0, levers: [] };
  try {
    const j = JSON.parse(raw) as Partial<Plan>;
    const levers = Array.isArray(j.levers) ? (j.levers as Lever[]) : [];
    return { goal: typeof j.goal === "string" ? j.goal : goal, count: levers.length, levers };
  } catch {
    return { goal, count: 0, levers: [] };
  }
}

/** Declare a goal as a neuron; returns its content-addressed id (or null when the
 * signed substrate isn't loaded — the binding is then simply off). */
export function declareGoal(goal: string): string | null {
  return native.declare(`goal:${goal}`, "goal", null, "aiko-agency");
}

/**
 * Train the router AND self-document usage: record that `command` succeeded for `goal`
 * — a satisfied contract (plan = goal, action = the full command). recommend() folds it
 * into the prototype of the command's binary (its first token) for selection, and
 * retrieves the exact command as the proven exemplar. The closed loop: real successful
 * runs sharpen the instinct and become the usage docs. Best-effort; no-op when the
 * substrate is off. Never throws.
 */
export function learnRoute(goal: string, command: string): void {
  if (!goal || !command) return;
  try {
    const id = native.declare(goal.slice(0, 200), command.slice(0, 400), null, "aiko-route");
    if (id) native.markSatisfied(id, "goal achieved with this command");
  } catch {
    // enhancement-only
  }
}

/** Plan a goal — the substrate's decomposition into actionable levers. */
export function plan(goal: string): Plan {
  return parsePlan(goal, native.planGoal(goal));
}

/** The current frontier of actionable levers for a goal (what to act on next). */
export function frontier(goal: string, skillPath?: string | null): Plan {
  return parsePlan(goal, native.frontier(goal, skillPath));
}

/** Goal-seeking compile: expand a goal into levers (a richer plan). */
export function seek(goal: string): Plan {
  return parsePlan(goal, native.seekCompile(goal));
}

// ── the drive loop: pursue a goal with agency, within a fence ──────────────────

/** What a caller's executor reports back after running one lever. */
export interface StepResult {
  ok: boolean;
  output?: unknown;
  /** Tokens/credits this step spent (counts against Bounds.budget). */
  spent?: number;
}

/** The injected effector: HOW a lever is actually carried out (LLM call, tool, …). */
export type Executor = (lever: Lever, ctx: { step: number; goal: string }) => Promise<StepResult>;

/** The injected safety gate. `confirm` pauses the loop unless autoConfirm is set. */
export type RiskPolicy = (lever: Lever) => "allow" | "confirm" | "deny";

/** The fence. The loop halts the moment any bound is crossed — termination is
 * guaranteed by these, NOT by trusting the substrate's frontier to empty. */
export interface Bounds {
  /** Hard cap on executed steps. Required — the ultimate stop. */
  maxSteps: number;
  /** Stop after this many consecutive no-progress steps (default 3). */
  noProgressLimit?: number;
  /** Stop once total `spent` reaches this (tokens/credits). */
  budget?: number;
}

export type DriveStatus = "settled" | "exhausted" | "no-progress" | "blocked" | "denied";

export interface Outcome {
  status: DriveStatus;
  steps: number;
  spent: number;
  results: StepResult[];
  /** The lever that blocked/was denied, when status is "blocked" or "denied". */
  stoppedOn?: Lever;
}

function leverKey(l: Lever, i: number): string {
  return String(l.id ?? l.label ?? JSON.stringify(l) ?? `lever#${i}`);
}

export interface DriveOptions {
  bounds: Bounds;
  /** Gate risky levers. Default: allow everything (caller opted into autonomy). */
  risk?: RiskPolicy;
  /** Proceed past a `confirm` decision without pausing (explicit opt-in). */
  autoConfirm?: boolean;
  /** Observe each step (for a UI / logging). */
  onStep?: (info: { step: number; lever: Lever; result: StepResult }) => void;
  /**
   * Override frontier lookup (e.g. game-legal moves). Default: substrate frontier(goal).
   * Lets harnesses inject domain levers while still using the same bounded drive loop.
   */
  frontierOf?: (goal: string) => Plan;
}

/**
 * Pursue `goal` autonomously: repeatedly take the next unacted frontier lever, gate it,
 * run it via the injected `executor` (settled as a child neuron of the goal), until the
 * goal's frontier is exhausted (settled) OR a bound/guardrail stops it.
 *
 * Termination is guaranteed three ways: a maxSteps hard cap, a `seen` set so each lever is
 * acted on at most once (an unchanging frontier cannot loop forever), and a no-progress
 * counter. Risky levers pause (blocked) or stop (denied) per the injected RiskPolicy.
 */
export async function drive(goal: string, executor: Executor, opts: DriveOptions): Promise<Outcome> {
  const goalCid = declareGoal(goal);
  const risk = opts.risk ?? (() => "allow" as const);
  const noProgressLimit = opts.bounds.noProgressLimit ?? 3;
  const seen = new Set<string>();
  const results: StepResult[] = [];
  let steps = 0;
  let spent = 0;
  let noProgress = 0;

  while (steps < opts.bounds.maxSteps) {
    const f = opts.frontierOf ? opts.frontierOf(goal) : frontier(goal);
    // Next lever we have NOT already acted on. An unchanging frontier => none left => settled.
    let lever: Lever | undefined;
    for (let i = 0; i < f.levers.length; i++) {
      if (!seen.has(leverKey(f.levers[i], i))) {
        lever = f.levers[i];
        break;
      }
    }
    if (!lever) return { status: "settled", steps, spent, results };

    const decision = risk(lever);
    if (decision === "deny") return { status: "denied", steps, spent, results, stoppedOn: lever };
    if (decision === "confirm" && !opts.autoConfirm) {
      return { status: "blocked", steps, spent, results, stoppedOn: lever };
    }

    seen.add(leverKey(lever, steps));
    const result = await runNeuron(
      `lever:${goal}:${leverKey(lever, steps)}`,
      { action: "lever", parent: goalCid ?? undefined, agent: "aiko-agency" },
      () => executor(lever as Lever, { step: steps, goal }),
    );
    steps++;
    spent += result.spent ?? 0;
    results.push(result);
    opts.onStep?.({ step: steps, lever, result });

    if (opts.bounds.budget !== undefined && spent >= opts.bounds.budget) {
      return { status: "exhausted", steps, spent, results };
    }
    noProgress = result.ok ? 0 : noProgress + 1;
    if (noProgress >= noProgressLimit) return { status: "no-progress", steps, spent, results };
  }
  return { status: "exhausted", steps, spent, results };
}
