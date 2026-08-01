// channels.ts — contract-native channel mapping.
//
// Maps I/O channels (telegram, bash, file, web) to the contract's agency type
// system (NodeRole + EffectScope + CadenceClass). Each channel gets its own
// verb mapping — the contract substrate's gate policy varies by channel, and
// recommend() learns per-channel patterns from the shared ledger.
//
// The contract ledger IS the self-context: every declare/gate/satisfy row
// records which channel it operated on. recommend() reads this history to
// route future decisions per-channel.
//
// EffectScope (from agency.zig):
//   - local_read:          reading files — safe, no approval needed
//   - local_write:         writing files — needs scope, no approval
//   - network_read:        fetching URLs — needs approval
//   - network_mutation:    POST/PUT/DELETE — needs approval + sensor
//   - message:             telegram, email — needs approval + sensor
//   - payment:             financial — needs approval + sensor
//   - deployment:          prod changes — needs approval + sensor
//   - onchain:             blockchain — needs approval + sensor
//   - human_impact:        affects humans — needs approval + sensor
//
// NodeRole (from agency.zig):
//   - purpose:             top-level goal
//   - sensor:              reads/observes
//   - action:              does something
//   - evaluator:           checks results
//   - governor:            approves/rejects

import * as contract from "./native";

// ── channel definitions ────────────────────────────────────────────────────

export interface Channel {
  /** Channel identifier — the scope prefix, e.g. "telegram:output" */
  id: string;
  /** The agency role this channel plays */
  role: "purpose" | "sensor" | "action" | "evaluator" | "governor" | "development";
  /** The effect scope — what part of the world this touches */
  effect:
    | "none"
    | "local_read"
    | "local_write"
    | "network_read"
    | "network_mutation"
    | "deployment"
    | "message"
    | "payment"
    | "onchain"
    | "human_impact";
  /** How urgent this channel is */
  cadence: "immediate" | "operational" | "management" | "audit" | "purpose";
  /** Whether this channel needs human approval before acting */
  requiresApproval: boolean;
  /** Whether this channel needs a sensor watching the result */
  requiresSensor: boolean;
}

/** Pre-defined channels matching the I/O surfaces. */
export const CHANNELS: Record<string, Channel> = {
  "telegram:output": {
    id: "telegram:output",
    role: "action",
    effect: "message",
    cadence: "immediate",
    requiresApproval: true,
    requiresSensor: true,
  },
  "telegram:input": {
    id: "telegram:input",
    role: "sensor",
    effect: "message",
    cadence: "immediate",
    requiresApproval: false,
    requiresSensor: false,
  },
  "bash:exec": {
    id: "bash:exec",
    role: "action",
    effect: "local_write",
    cadence: "immediate",
    requiresApproval: false, // gate.zig handles catastrophic separately
    requiresSensor: true,
  },
  "file:read": {
    id: "file:read",
    role: "sensor",
    effect: "local_read",
    cadence: "immediate",
    requiresApproval: false,
    requiresSensor: false,
  },
  "file:write": {
    id: "file:write",
    role: "action",
    effect: "local_write",
    cadence: "immediate",
    requiresApproval: false,
    requiresSensor: false,
  },
  "web:fetch": {
    id: "web:fetch",
    role: "sensor",
    effect: "network_read",
    cadence: "immediate",
    requiresApproval: true,
    requiresSensor: false,
  },
  "web:mutate": {
    id: "web:mutate",
    role: "action",
    effect: "network_mutation",
    cadence: "immediate",
    requiresApproval: true,
    requiresSensor: true,
  },
  "payment:send": {
    id: "payment:send",
    role: "action",
    effect: "payment",
    cadence: "management",
    requiresApproval: true,
    requiresSensor: true,
  },
  "deploy:prod": {
    id: "deploy:prod",
    role: "action",
    effect: "deployment",
    cadence: "management",
    requiresApproval: true,
    requiresSensor: true,
  },
};

/**
 * Resolve a scope string (e.g. "telegram:output") to its channel definition.
 * Matches prefix — "telegram:output:thinkfeel-persona" resolves to "telegram:output".
 */
export function resolveChannel(scope: string): Channel | null {
  // Exact match first
  if (CHANNELS[scope]) return CHANNELS[scope];
  // Prefix match — longest first
  const keys = Object.keys(CHANNELS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (scope.startsWith(key + ":") || scope === key) {
      return CHANNELS[key];
    }
  }
  return null;
}

// ── contract-native channel wrapping ───────────────────────────────────────

/**
 * Declare a channel-aware neuron. The channel determines the agency envelope
 * (role, effect_scope, cadence), which the substrate uses for channel-specific
 * gating and routing.
 */
export function declareChannelNeuron(channelId: string, action: string, parentId?: string | null): string | null {
  const channel = resolveChannel(channelId);
  if (!channel) return contract.declare(channelId, action, parentId, "aiko-channels");

  // Encode the channel metadata into the plan string so the substrate
  // can route by channel type. The plan becomes:
  //   channel:<id> role:<role> effect:<effect> cadence:<cadence> action:<action>
  const plan = [
    `channel:${channel.id}`,
    `role:${channel.role}`,
    `effect:${channel.effect}`,
    `cadence:${channel.cadence}`,
    action,
  ].join(" ");

  return contract.declare(plan, action, parentId, "aiko-channels");
}

/**
 * Gate through the substrate with channel-aware metadata.
 * The gate decision considers the channel's effect scope.
 */
export function gateChannel(channelId: string, tool: string, argsJson: string): string | null {
  const channel = resolveChannel(channelId);
  const scope = channel ? `${channel.id} role:${channel.role} effect:${channel.effect}` : channelId;
  return contract.gate(scope, tool, argsJson);
}

// ── channel-aware gate policy ──────────────────────────────────────────────

export interface ChannelGateDecision {
  allowed: boolean;
  requiresApproval: boolean;
  requiresSensor: boolean;
  channel: Channel | null;
  reason: string;
}

/**
 * Channel-aware gate: combines the substrate's string-pattern gate with
 * channel-specific policy (requiresApproval, requiresSensor).
 *
 * This is the "wrap" — the contract mediates differently depending on
 * which channel the data flows through.
 */
export function channelGate(scope: string, tool: string, argsJson: string): ChannelGateDecision {
  const channel = resolveChannel(scope);
  const substrateResult = contract.gate(scope, tool, argsJson);

  // Parse the substrate decision
  let substrateAllowed = true;
  let substrateConfirm = false;
  let substrateReason = "channel gate passed";

  if (substrateResult) {
    try {
      const g = JSON.parse(substrateResult) as {
        decision?: string;
        risk?: string;
        reason?: string;
      };
      if (g.decision === "deny") {
        substrateAllowed = false;
        substrateReason = g.reason ?? "substrate denied";
      } else if (g.decision === "confirm") {
        substrateConfirm = true;
        substrateReason = g.reason ?? "substrate requires confirmation";
      }
    } catch {
      // parse error — allow
    }
  }

  // Build the channel-aware decision
  const reasons: string[] = [];

  if (!substrateAllowed) {
    reasons.push(substrateReason);
  }

  if (channel && channel.requiresApproval) {
    if (substrateConfirm) {
      reasons.push(`channel ${channel.id} requires explicit approval (effect=${channel.effect})`);
    }
  }

  const reason = reasons.length > 0 ? reasons.join("; ") : "allowed";

  return {
    allowed: substrateAllowed,
    requiresApproval: channel?.requiresApproval ?? false,
    requiresSensor: channel?.requiresSensor ?? false,
    channel,
    reason,
  };
}

// ── cross-channel context ──────────────────────────────────────────────────

/**
 * Query the ledger for all activity on a specific channel.
 * Returns rows matching a channel prefix — this IS the contract's
 * self-context for that channel.
 */
export function channelHistory(channelId: string): string | null {
  // contract.iterate() returns the row for a specific neuron id.
  // For cross-channel context, we would need a ledger scan — currently
  // not exposed via FFI. The recommend() function IS the learned summary
  // of all channel history.
  return contract.recommend(channelId) ? JSON.stringify(contract.recommend(channelId)) : null;
}

/**
 * Recommend for a channel: given a context on this channel, what does
 * the substrate's learned energy landscape suggest?
 */
export function channelRecommend(channelId: string): {
  binary: string;
  example: string;
  score: number;
} | null {
  const channel = resolveChannel(channelId);
  const context = channel ? `channel:${channel.id} role:${channel.role} effect:${channel.effect}` : channelId;
  return contract.recommend(context);
}
