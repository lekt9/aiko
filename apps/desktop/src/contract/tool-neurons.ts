// tool-neurons.ts — the contract-native tool chokepoint.
//
// Every aiko tool call runs as a content-addressed neuron nested under the open turn
// neuron (so the call graph folds into the contract DAG). Command-EXECUTING tools
// (bash / sandbox_exec) are additionally authorized by the signed substrate before
// they run — a catastrophic command is denied, a destructive/outward one asks for
// confirmation. File and read tools are NOT risk-gated: writing a file that merely
// mentions "deploy" is not a deploy, and gating tool ARGS as if they were shell
// commands was a false-positive that blocked legitimate edits.
//
// RECALL (return a prior proof instead of re-running) is enabled ONLY for pure read-only
// tools, and even then it is invalidated by a mutation "epoch": any write/bash/edit bumps
// the epoch, folded into pure-read neuron ids, so a read never recalls a stale proof.
import type { ToolSet } from "ai";
import { boundToolValue } from "../agent/tool-result-bounds";
import { consumeConfirmation, contractGate, type GateResult } from "./gate";
import { currentNeuronId, runNeuron, witness } from "./neurons";

// Read-only, side-effect-free tools whose output is safe to recall within a mutation epoch.
const PURE_READ = new Set(["read_file", "grep", "lsp"]);
// Tools that change the filesystem/world — after one runs, prior pure-read proofs are stale.
const MUTATORS = new Set(["bash", "write_file", "edit_file", "sandbox_exec"]);
// Tools that EXECUTE a command — the only ones the safety gate authorizes. Their args
// really are a command; a write's args are file content and must never be risk-matched.
const COMMAND_TOOLS = new Set(["bash", "sandbox_exec"]);

let mutationEpoch = 0;

/** Reset the epoch (test hook). */
export function resetMutationEpoch(): void {
  mutationEpoch = 0;
}

// Full COMMANDS run by SUCCESSFUL command tools this turn — the agent drains this at
// turn end to train the router AND self-document usage (goal → the exact command that
// satisfied). Module-level so the collection point (a tool wrapper) and the drain point
// (the agent) meet. The router still keys on the binary (the command's first token).
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

/** The full command line to record as a proven usage — only when it's a real binary
 * invocation (not a bare cd/sudo), capped so a giant heredoc doesn't bloat the ledger. */
function commandLine(args: unknown): string | null {
  const cmd = (args as { command?: unknown })?.command;
  if (typeof cmd !== "string" || !commandBinary(args)) return null;
  return cmd.trim().slice(0, 400);
}

/**
 * Whether the safety gate enforces. Default on; set AIKO_CONTRACT_GATE=0 to disable.
 * No test-runner sniffing lives in production — under tests the signed substrate isn't
 * loaded, so the gate simply allows (see gate.ts). The neuron wrapping is always applied.
 */
function gateEnforced(): boolean {
  return process.env.AIKO_CONTRACT_GATE !== "0";
}

/** A destructive/outward call is pre-authorized (skip the confirm refusal). */
function autoConfirmed(): boolean {
  return process.env.AIKO_GATE_AUTOCONFIRM === "1";
}

/** Deterministic stringify (sorted keys) so identical args content-address to one neuron. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** The tool result returned when the gate refuses a call (deny) or holds it (confirm). */
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

type ExecFn = (args: unknown, opts: unknown) => unknown;

/**
 * Marker the lock test asserts on: every tool with an execute must carry a gated
 * wrapper. A tool reaching the model with a non-gated execute is a bypass.
 */
export const GATED = Symbol.for("aiko.contractGated");

/**
 * Gate + neuronize every tool. Each execute is replaced by a wrapper that authorizes
 * the call through the contract substrate (fail-closed) before running it as a neuron.
 * Pure reads recall within the current mutation epoch; mutators bump the epoch after they
 * run. When the substrate store is unavailable the gate DENIES (no tools off-contract).
 */
export function neuronizeTools(tools: ToolSet, agent?: string): ToolSet {
  for (const [name, tool] of Object.entries(tools)) {
    const orig = (tool as { execute?: ExecFn }).execute;
    if (typeof orig !== "function") continue;
    const pure = PURE_READ.has(name);
    const mutates = MUTATORS.has(name);

    const gatedExec: ExecFn = (args: unknown, opts: unknown) => {
      // Only real command execution is authorized — file/read tools run freely.
      if (gateEnforced() && COMMAND_TOOLS.has(name)) {
        const scope = currentNeuronId();
        const decision = contractGate(name, stable(args), scope);
        if (decision.decision === "deny") {
          witness("gate:deny", { tool: name, risk: decision.risk });
          return gateRefusal(name, decision);
        }
        if (decision.decision === "confirm" && !autoConfirmed() && !consumeConfirmation()) {
          witness("gate:confirm", { tool: name, risk: decision.risk });
          return gateRefusal(name, decision);
        }
      }
      const plan = `tool:${name}:${stable(args)}${pure ? `@e${mutationEpoch}` : ""}`;
      return runNeuron(plan, { recall: pure, action: "tool", agent }, async () => {
        const out = await orig(args, opts);
        if (mutates) mutationEpoch++;
        // Router training + usage self-doc: a command tool that SUCCEEDED → remember the
        // exact command (the router keys on its first token, the binary).
        if (COMMAND_TOOLS.has(name) && (out as { success?: boolean })?.success === true) {
          const cmd = commandLine(args);
          if (cmd) turnCommands.add(cmd);
        }
        // Hard-cap tool dumps BEFORE they re-enter the multi-step model context
        // (streamText mid-turn) or the transcript. Spill overflow to disk.
        const bound = boundToolValue(out, undefined, name);
        return bound.value;
      });
    };
    (gatedExec as { [GATED]?: boolean })[GATED] = true;
    (tool as { execute: ExecFn }).execute = gatedExec;
  }
  return tools;
}

/** True when every tool with an execute carries the gated wrapper (bypass detection). */
export function allToolsGated(tools: ToolSet): boolean {
  for (const tool of Object.values(tools)) {
    const fn = (tool as { execute?: { [GATED]?: boolean } }).execute;
    if (typeof fn === "function" && fn[GATED] !== true) return false;
  }
  return true;
}
