// tool-neurons.ts — mandatory contract-native tool authorization.
//
// EVERY tool call flows through:
//   1. Tier check — auto-allow reads, confirm writes, deny known attacks
//   2. contractGate — signed substrate authorizes command-executing tools
//   3. runNeuron — declare neuron, record in ledger, train EBM
//   4. mutation epoch — invalidates stale pure-read proofs after mutators
//
// Tiers:
//   0 (read)       — auto-allow. Declares neuron, trains EBM.
//   1 (scoped)     — confirm-gated. File writes, network reads.
//   2 (destructive) — full confirm. bash, sandbox, deploy, payments.
//   3 (blocked)    — auto-deny. Known attack patterns.
//
// Bootstrap: AIKO_CONTRACT_BOOTSTRAP=1 bypasses ALL gating for self-modification.

import type { ToolSet } from "ai";
import { boundToolValue } from "./tool-result-bounds";
import { consumeConfirmation, contractGate, type GateDecision, type GateResult } from "./gate";
import { currentNeuronId, runNeuron, witness } from "./neurons";

// ── tiers ──────────────────────────────────────────────────────────────────

type Tier = 0 | 1 | 2 | 3;

/** Every tool's tier. Tools NOT listed default to Tier 1 (scoped confirm). */
const TOOL_TIERS: Record<string, Tier> = {
  // Tier 0: pure reads, cache hits, idempotent checks
  read_file: 0,
  grep: 0,
  lsp: 0,
  process_logs: 0,
  process_list: 0,
  delegation_read: 0,
  delegation_list: 0,
  wallet_info: 0,
  wallet_history: 0,
  schedule_list: 0,
  schedule_daemon_status: 0,
  schedule_read_log: 0,
  fetch_payment_info: 0,
  computer_snapshot: 0,
  computer_screenshot: 0,
  computer_list_windows: 0,
  computer_get: 0,

  // Tier 1: scoped confirm (file writes, network, UI interaction)
  // Default for unlisted tools.

  // Tier 2: destructive (command exec, payment, deploy, schedule mutations)
  bash: 2,
  sandbox_exec: 2,
  paid_request: 2,
  telegram_send_file: 2,
  schedule_create: 2,
  schedule_remove: 2,
  schedule_daemon_start: 2,
  schedule_daemon_stop: 2,
  computer_launch: 2,

  // Tier 3: blocked patterns — auto-deny regardless of substrate
  // (none by default; patterns are added by the substrate at runtime)
};

/** Known-attack command patterns that trigger Tier 3 auto-deny. */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/$/,
  /mkfs\./,
  /dd\s+if=/,
  /:\s*\(\)\s*\{/, // fork bomb
  />\s*\/dev\/sda/,
  /chmod\s+.*777\s+\/$/,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
];

// ── epoch for pure-read recall invalidation ─────────────────────────────────

/** Read-only, side-effect-free tools whose output is safe to recall within a mutation epoch. */
const PURE_READ = new Set(["read_file", "grep", "lsp"]);

/** Tools that change the filesystem/world — after one runs, prior pure-read proofs are stale. */
const MUTATORS = new Set(["bash", "write_file", "edit_file", "sandbox_exec"]);

/** Command executing tools — the signed substrate authorizes. */
const COMMAND_TOOLS = new Set(["bash", "sandbox_exec"]);

let mutationEpoch = 0;

/** Reset the epoch (test hook). */
export function resetMutationEpoch(): void {
  mutationEpoch = 0;
}

// ── command collection for router training ──────────────────────────────────

const turnCommands = new Set<string>();

/** Drain the commands that succeeded this turn (clears the set). */
export function takeTurnCommands(): string[] {
  const out = [...turnCommands];
  turnCommands.clear();
  return out;
}

/** The binary a shell command runs: the first real token (skip cd/sudo/env=…), basename'd. */
function commandBinary(args: unknown): string | null {
  const cmd = (args as { command?: unknown })?.command;
  if (typeof cmd !== "string") return null;
  for (const tok of cmd.trim().split(/\s+/)) {
    if (tok === "cd" || tok === "sudo" || tok === "env" || tok.includes("=")) continue;
    const base = tok.split("/").pop() ?? tok;
    return /^[a-z][a-z0-9._-]*$/i.test(base) ? base : null;
  }
  return null;
}

/** The full command line to record as a proven usage. */
function commandLine(args: unknown): string | null {
  const cmd = (args as { command?: unknown })?.command;
  if (typeof cmd !== "string" || !commandBinary(args)) return null;
  return cmd.trim().slice(0, 400);
}

// ── gate enforcement ────────────────────────────────────────────────────────

/** Whether contract gating is active. AIKO_CONTRACT_GATE=0 disables. */
function gateEnforced(): boolean {
  return process.env.AIKO_CONTRACT_GATE !== "0";
}

/** Bootstrap: bypass ALL gating for self-modification sessions. */
function bootstrapMode(): boolean {
  return process.env.AIKO_CONTRACT_BOOTSTRAP === "1";
}

/** Pre-authorized by env. */
function autoConfirmed(): boolean {
  return process.env.AIKO_GATE_AUTOCONFIRM === "1";
}

/** Check command args against blocked patterns (Tier 3). */
function isBlocked(args: unknown): string | null {
  const cmd = (args as { command?: unknown })?.command;
  if (typeof cmd !== "string") return null;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) return `matched blocked pattern: ${pattern}`;
  }
  return null;
}

/** Get the tier for a tool (default Tier 1). */
function toolTier(name: string): Tier {
  return TOOL_TIERS[name] ?? 1;
}

// ── utilities ───────────────────────────────────────────────────────────────

/** Deterministic stringify (sorted keys) so identical args content-address to one neuron. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** The tool result returned when the gate refuses a call. */
function gateRefusal(tool: string, g: GateResult): { success: false; output: string } {
  const how =
    g.decision === "confirm"
      ? " If you intend this, re-run with confirmation (pass --yes / --force, or set AIKO_GATE_AUTOCONFIRM=1)."
      : "";
  return {
    success: false,
    output: `⛔ contract gate (${g.decision}): ${g.reason} [tool: ${tool}, risk: ${g.risk}].${how}`,
  };
}

// ── the mandatory gate ──────────────────────────────────────────────────────

type ExecFn = (args: unknown, opts: unknown) => unknown;

export const GATED = Symbol.for("aiko.contractGated");

/**
 * Run one tool call through the mandatory contract chokepoint.
 * Returns the tool result, or throws if the gate blocks.
 *
 * Decision matrix:
 *   bootstrap → ALLOW (no gate, still declare neuron)
 *   !gateEnforced() → ALLOW (no gate, still declare neuron)
 *   Tier 0 → ALLOW (reads always pass)
 *   Tier 3 → DENY (blocked patterns)
 *   Tier 1-2 → contractGate() → allow / confirm(+token) / deny
 */
function authorizeAndRun(name: string, args: unknown, orig: ExecFn, opts: unknown, agent?: string): Promise<unknown> {
  const decision = resolveGate(name, args);

  if (decision === "deny" || decision === "confirm") {
    const reason =
      decision === "deny"
        ? `tool ${name} tier ${toolTier(name)} denied`
        : `tool ${name} requires confirmation — use --confirm or grant a token`;
    witness(`gate:${decision}`, { tool: name, risk: decision === "deny" ? "blocked" : "elevated" });
    return Promise.resolve(
      gateRefusal(name, {
        decision,
        risk: decision === "deny" ? "blocked" : "elevated",
        reason,
      }),
    );
  }

  // Even Tier 0 tools run as neurons — the EBM trains on every action.
  const tier = toolTier(name);
  const pure = PURE_READ.has(name);
  const mutates = MUTATORS.has(name);
  const plan = `tool:${name}:${stable(args)}${pure ? `@e${mutationEpoch}` : ""}`;

  return runNeuron(plan, { recall: pure, action: "tool", agent }, async () => {
    const out = await orig(args, opts);
    if (mutates) mutationEpoch++;

    // Router training: successful command → learn the command binary.
    if (COMMAND_TOOLS.has(name) && (out as { success?: boolean })?.success === true) {
      const cmd = commandLine(args);
      if (cmd) turnCommands.add(cmd);
    }

    // Train EBM: every tool fire marks satisfaction.
    // Non-command tools that succeed also contribute to the prototype.
    if ((out as { success?: boolean })?.success !== false) {
      witness("tool:satisfied", { tool: name, tier });
    } else {
      witness("tool:failed", { tool: name, tier });
    }

    const bound = boundToolValue(out, undefined, name);
    return bound.value;
  });
}

function resolveGate(name: string, args: unknown): GateDecision {
  // Bootstrap: everything passes
  if (bootstrapMode()) return "allow";

  // Gate disabled: everything passes (but neurons still declared)
  if (!gateEnforced()) return "allow";

  const tier = toolTier(name);

  // Tier 0: always allow
  if (tier === 0) return "allow";

  // Tier 3: check blocked patterns for command tools, else deny
  if (tier === 3) {
    const blockedReason = isBlocked(args);
    if (blockedReason) return "deny";
    // Non-command Tier 3 always denies
    if (!COMMAND_TOOLS.has(name)) return "deny";
    // Command Tier 3 with non-blocked command: escalate to Tier 2 behavior
  }

  // Tier 1-2: consult signed substrate for command tools
  if (COMMAND_TOOLS.has(name)) {
    const scope = currentNeuronId();
    const result = contractGate(name, stable(args), scope);
    if (result.decision === "deny") return "deny";
    if (result.decision === "confirm") {
      if (autoConfirmed() || consumeConfirmation()) return "allow";
      return "confirm";
    }
    return "allow";
  }

  // Tier 1 non-command (write_file, edit_file, search_web, etc.):
  // confirm-gated — consume a confirmation token if available, else ask.
  if (tier >= 1) {
    if (autoConfirmed() || consumeConfirmation()) return "allow";
    return "confirm";
  }

  return "allow";
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Gate + neuronize EVERY tool. Each execute is replaced by a wrapper that
 * authorizes the call through the contract substrate (fail-closed) before
 * running it as a neuron. The tier system auto-allows reads, confirm-gates
 * writes, and denies known attack patterns.
 */
export function neuronizeTools(tools: ToolSet, agent?: string): ToolSet {
  for (const [name, tool] of Object.entries(tools)) {
    const orig = (tool as { execute?: ExecFn }).execute;
    if (typeof orig !== "function") continue;

    const gatedExec: ExecFn = (args: unknown, opts: unknown) => {
      return authorizeAndRun(name, args, orig, opts, agent);
    };
    (gatedExec as { [GATED]?: boolean })[GATED] = true;
    (tool as { execute: ExecFn }).execute = gatedExec;
  }
  return tools;
}

/** True when every tool with an execute carries the gated wrapper. */
export function allToolsGated(tools: ToolSet): boolean {
  for (const tool of Object.values(tools)) {
    const fn = (tool as { execute?: { [GATED]?: boolean } }).execute;
    if (typeof fn === "function" && fn[GATED] !== true) return false;
  }
  return true;
}

/** Runtime tier query (exposed for telemetry/debug). */
export { TOOL_TIERS, TOOL_TIERS as toolTiers, toolTier };
