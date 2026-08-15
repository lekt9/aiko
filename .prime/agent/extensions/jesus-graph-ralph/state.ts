import { existsSync } from "node:fs";
import { join } from "node:path";

export type JesusNodeStatus = "pending" | "in_progress" | "settled" | "blocked";

export interface JesusNode {
  id: string;
  who?: string;
  what: string;
  why?: string;
  how?: string;
  where?: string;
  when?: string;
  depends_on: string[];
  reads: string[];
  writes: string[];
  produces?: string[];
  invoke_skills?: string[];
  inspire_from?: string[];
  capability_gaps?: string[];
  witness: string;
  status: JesusNodeStatus;
  milestone?: string;
  children?: JesusNode[];
}

export interface JesusGraph {
  execute?: boolean;
  who?: string;
  what?: string;
  why?: string;
  how?: string;
  where?: string;
  when?: string;
  meta?: Record<string, unknown>;
  children: JesusNode[];
  // Allow extra top-level keys like grade_min, milestones, etc.
  [k: string]: unknown;
}

export interface RalphConfig {
  /** End-to-end witness, exits 0 when done */
  check: string | null;
  /** Completion promise string (weak, overrides only if check is null) */
  promise: string | null;
  /** North star description */
  north: string;
  /** Max consecutive dry turns before we ask user (stagnation guard) */
  stagnationLimit: number;
  /** Max total turns (unbounded default = 9999) */
  maxTurns: number;
}

export interface PersistedState {
  walkPath: string;
  ralph: RalphConfig | null;
  dryTurns: number;
  totalTurns: number;
  lastFrontier: string[];
  updatedAt: number;
}

export const WALK_CANDIDATES = [
  ".claude/jesus-graph.local.json",
  ".claude/jesus-graph.json",
  "jesus-graph.local.json",
];

export function walkPathFor(cwd: string): string {
  for (const rel of WALK_CANDIDATES) {
    const p = join(cwd, rel);
    if (existsSync(p)) return p;
  }
  // default to first candidate (will be created)
  return join(cwd, WALK_CANDIDATES[0]);
}
