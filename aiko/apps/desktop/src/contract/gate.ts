// gate.ts — tool authorization, with ONE authority: the signed substrate.
//
// There is no TS reimplementation of the policy (that mirror was a second source of
// truth and it drifted — a write whose CONTENT merely mentioned "deploy" was refused
// as if it were a deploy). The gate now asks the signed `contract_gate` and nothing
// else. When the signed substrate isn't loaded, calls are ALLOWED: the gate is an
// optional safety check on real command execution, never a hard blocker for ordinary
// work. tool-neurons.ts only consults it for command-executing tools.

import * as native from "./native";
import { currentNeuronId } from "./neurons";

export type GateDecision = "allow" | "confirm" | "deny";

export interface GateResult {
  decision: GateDecision;
  risk: string;
  reason: string;
}

const ALLOW: GateResult = { decision: "allow", risk: "none", reason: "" };

// ── runtime confirmation ────────────────────────────────────────────────
//
// The signed substrate returns "confirm" for destructive/outward operations
// (bash:exec with network_mutation, payment:send, deploy:prod). The env-var
// AIKO_GATE_AUTOCONFIRM=1 is the permanent bypass — set at process start.
//
// But the contract also needs a RUNTIME confirmation pathway: the user (via
// Telegram) or the daemon (via auto-execute of a learned pattern) says "yes"
// and the next gate confirm is waived. This is the "wire it yes" from the
// contract context — a one-shot confirmation token through the substrate.

let confirmationsRemaining = 0;

/** Grant N one-shot confirmations. The next N confirm-gated operations auto-pass. */
export function grantConfirmations(n: number): void {
  confirmationsRemaining += Math.max(0, n);
}

/** True when a confirmation is available to consume. */
export function consumeConfirmation(): boolean {
  if (confirmationsRemaining > 0) {
    confirmationsRemaining--;
    return true;
  }
  return false;
}

/** How many confirmations are still available. */
export function pendingConfirmations(): number {
  return confirmationsRemaining;
}

function parseDecision(raw: string | null): GateResult | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<GateResult>;
    if (d.decision === "allow" || d.decision === "confirm" || d.decision === "deny") {
      return { decision: d.decision, risk: d.risk ?? "unknown", reason: d.reason ?? "" };
    }
  } catch {
    /* fall through to allow */
  }
  return null;
}

/**
 * Authorize a command. Returns the signed substrate's decision, or `allow` when the
 * substrate isn't loaded (no reimplemented policy stands in for it). `scope` defaults
 * to the open neuron; an absent scope does NOT block (that was friction, not safety).
 */
export function contractGate(tool: string, argsJson: string, scope?: string | null): GateResult {
  const sc = scope ?? currentNeuronId();
  if (!sc) return ALLOW;
  return parseDecision(native.gate(sc, tool, argsJson)) ?? ALLOW;
}
