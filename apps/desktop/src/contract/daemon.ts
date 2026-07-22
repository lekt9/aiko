// daemon.ts — the contract-native autonomic loop.
//
// The "spinal reflex" layer. The scheduler (scheduler.zig) already knows when
// things are due. This daemon is the bridge between the scheduler's tick and
// the agent's execution. It:
//
//   1. Ticks the scheduler → gets due claims
//   2. Gates each claim through the substrate
//   3. If a learned pattern exists (recommend score > threshold) → auto-execute
//   4. Otherwise → queue for agent deliberation
//   5. Settles the outcome → mark satisfied/retry/died
//   6. Sleeps until next_wake_unix
//
// This is the autonomic nervous system of the contract. It handles learned
// patterns without conscious thought (the agent), but the agent can always
// override. Biology: spinal reflex handles withdrawal from pain; the brain
// can countermand it if needed.
//
// The daemon runs in the same process as the Telegram bridge — it's a
// lightweight polling loop, not a separate service.

import { channelGate, resolveChannel } from "./channels";
import { createFractalEBM, type FractalEBM } from "./fractal-ebm";
import * as contract from "./native";

// ── types ─────────────────────────────────────────────────────────────────

export interface DaemonConfig {
  /** Owner id — scopes tick claims to this owner */
  owner: string;
  /** Working directory for claim execution */
  cwd?: string;
  /** Max claims per tick */
  maxItems?: number;
  /** How long to lease a claim (seconds) — prevents double-execution */
  leaseSeconds?: number;
  /** Minimum recommend score to auto-execute (0-1). Below this, defer to agent. */
  autoExecuteThreshold?: number;
  /** Called when a claim is ready for agent deliberation */
  onAgentClaim?: (claim: contract.Claim) => Promise<void>;
  /** Called when a claim is auto-executed */
  onAutoExecute?: (claim: contract.Claim, result: string) => void;
  /** Fractal EBM for routing — if not provided, a fresh one is created */
  fractalEBM?: FractalEBM;
  /** Log function */
  log?: (message: string) => void;
}

export interface DaemonState {
  running: boolean;
  lastTick: number | null;
  nextWake: number | null;
  claimsProcessed: number;
  autoExecuted: number;
  agentQueued: number;
}

// ── daemon ────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.85;

export function createDaemon(config: DaemonConfig) {
  const log = config.log ?? (() => {});
  const autoExecuteThreshold = config.autoExecuteThreshold ?? DEFAULT_THRESHOLD;
  const ebm = config.fractalEBM ?? createFractalEBM();

  const state: DaemonState = {
    running: false,
    lastTick: null,
    nextWake: null,
    claimsProcessed: 0,
    autoExecuted: 0,
    agentQueued: 0,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function processClaim(claim: contract.Claim): Promise<void> {
    state.claimsProcessed++;

    // Step 1: resolve the channel for this claim
    const channel = resolveChannel(claim.prompt);
    const scope = channel?.id ?? "unknown";

    log(`[daemon] claim ${claim.contractId.slice(0, 8)}: "${claim.prompt.slice(0, 80)}" [channel=${scope}]`);

    // Step 2: gate through the substrate
    const gateResult = channelGate(scope, "execute", JSON.stringify({ prompt: claim.prompt, cwd: claim.cwd }));

    if (!gateResult.allowed) {
      log(`[daemon] claim ${claim.contractId.slice(0, 8)}: denied — ${gateResult.reason}`);
      contract.settleExecution(
        config.owner,
        claim.contractId,
        claim.occurrence,
        "died",
        `gate denied: ${gateResult.reason}`,
      );
      return;
    }

    if (gateResult.requiresApproval) {
      log(`[daemon] claim ${claim.contractId.slice(0, 8)}: requires approval — queue for agent`);
      state.agentQueued++;
      if (config.onAgentClaim) {
        await config.onAgentClaim(claim);
      }
      // Don't settle yet — agent will settle after deliberation
      return;
    }

    // Step 3: use the fractal EBM to route this claim through the
    // energy landscape. The tree walk goes: system → local/network/exec
    // → specific channel. If the routed node is hot (well-trained),
    // auto-execute. If cold, queue for agent.
    //
    // We call contract.recommend() for fine-grained routing within
    // the channel — it uses the substrate's EBM (ebm.zig) trained
    // on past ledger rows.
    const substrateRec = contract.recommend(claim.prompt);
    const substrateScore = substrateRec?.score ?? 0;

    // Fire the fractal EBM to record this claim (weight-only; no vector yet)
    ebm.fire(scope, claim.prompt, 0, null);

    // Route through the tree to find the right channel
    // (without vectors, we use the channel scope directly)
    const node = ebm.list().find((n) => n.channelId.endsWith(scope));

    if (node && node.weight > autoExecuteThreshold && substrateScore >= autoExecuteThreshold) {
      // Step 4: spinal reflex — auto-execute based on fractal routing
      log(
        `[daemon] claim ${claim.contractId.slice(0, 8)}: auto-execute ` +
          `[${node.channelId}] (tree_w=${node.weight.toFixed(1)}, substrate_score=${substrateScore.toFixed(3)})`,
      );
      state.autoExecuted++;

      if (config.onAutoExecute) {
        config.onAutoExecute(claim, `channel=${node.channelId}`);
      }

      contract.settleExecution(
        config.owner,
        claim.contractId,
        claim.occurrence,
        "satisfied",
        `auto-executed via fractal route: ${node.channelId}`,
      );

      // Train: satisfied fire
      ebm.fire(scope, claim.prompt, 1.0, null);
    } else {
      // Step 5: novel situation — queue for agent deliberation
      const treeW = node ? node.weight.toFixed(1) : "no_node";
      log(
        `[daemon] claim ${claim.contractId.slice(0, 8)}: queue for agent ` +
          `(tree_w=${treeW}, substrate_score=${substrateScore.toFixed(3)}, threshold=${autoExecuteThreshold})`,
      );
      state.agentQueued++;
      if (config.onAgentClaim) {
        await config.onAgentClaim(claim);
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;

    const now = Math.floor(Date.now() / 1000);
    state.lastTick = now;

    const result = contract.tick({
      owner: config.owner,
      cwd: config.cwd,
      nowUnix: now,
      maxItems: config.maxItems,
      leaseSeconds: config.leaseSeconds,
    });

    if (!result) {
      log("[daemon] tick failed — substrate unavailable?");
      state.nextWake = now + 60; // retry in 60s
      scheduleNext();
      return;
    }

    state.nextWake = result.nextWakeUnix;

    if (result.claims.length > 0) {
      log(
        `[daemon] tick: ${result.claims.length} claims due, ` +
          `next wake ${result.nextWakeUnix ? new Date(result.nextWakeUnix * 1000).toISOString() : "none"}`,
      );

      for (const claim of result.claims) {
        await processClaim(claim);
      }
    }

    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) return;

    const now = Math.floor(Date.now() / 1000);
    // Sleep until next_wake, or 30s minimum, or 5min maximum
    const wakeTarget = state.nextWake ?? now + 30;
    const delayMs = Math.max(
      30_000,
      Math.min(
        (wakeTarget - now) * 1000,
        300_000, // max 5 minutes
      ),
    );

    log(`[daemon] next tick in ${(delayMs / 1000).toFixed(0)}s`);

    timer = setTimeout(tick, delayMs);
  }

  function start(): DaemonState {
    if (state.running) return state;
    if (!contract.isNative()) {
      log("[daemon] substrate not available — daemon idle");
      return state;
    }
    state.running = true;
    stopped = false;
    log("[daemon] starting autonomic loop");
    // First tick immediately
    tick();
    return state;
  }

  function stop(): void {
    stopped = true;
    state.running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    log(
      `[daemon] stopped (processed=${state.claimsProcessed}, auto=${state.autoExecuted}, queued=${state.agentQueued})`,
    );
  }

  /** Manually tick — useful for testing or external triggers */
  async function tickNow(): Promise<void> {
    await tick();
  }

  /** Settle a claim from the agent after deliberation */
  function settleAgentClaim(contractId: string, occurrence: string, satisfied: boolean, detail: string): boolean {
    return contract.settleExecution(config.owner, contractId, occurrence, satisfied ? "satisfied" : "retry", detail);
  }

  return { start, stop, tickNow, settleAgentClaim, getState: () => ({ ...state }) };
}
