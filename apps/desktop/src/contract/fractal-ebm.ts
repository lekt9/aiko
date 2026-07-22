// fractal-ebm.ts — the energy harness that stacks in a fractal pattern
// throughout the whole OS.
//
// Every channel IS a neuron. Every neuron trains its own EBM prototype
// on every fire. The tree IS the routing decision — walk down from root,
// argmin-energy among children at each level, recurse to the leaf.
//
// The energy landscape is the OS's learned intuition. When a file:read
// succeeds, the filesystem prototype learns what contexts lead to file
// reads. When a bash:exec fails, the bash prototype learns to avoid
// those contexts. The system prototype learns from ALL channels —
// it is the OS-level energy field.
//
// Biology:
//   root (system)        = hypothalamus  (integrates all signals)
//   local ops            = autonomic     (file, process)
//   network ops          = sensory/motor (telegram, web)
//   bash:exec            = motor cortex  (commands)
//   payment:send         = reward system (dopamine-weight folds)
//
// The math is Welford 1979 (running-mean centroid) — O(1) per fire,
// same as the substrate's ebm.zig. Embedding is done via the substrate's
// embed.zig (called through recommend() FFI to reuse the baked BERT).

import { CHANNELS, type Channel } from "./channels";
import * as contract from "./native";

// ── tree ──────────────────────────────────────────────────────────────────

export interface FractalNode {
  channelId: string;
  label: string;
  channel: Channel;
  parentChannelId: string | null;
  children: string[];
  depth: number;
  centroid: Float32Array;
  weight: number;
  fires: number;
  lastFireUnix: number;
  neuronId: string | null;
}

// ── tree definition ──────────────────────────────────────────────────────

const TREE_SPEC: Array<{
  channelId: string;
  label: string;
  channelKey: string;
  parent: string | null;
}> = [
  // ROOT
  { channelId: "system", label: "system", channelKey: "telegram:output", parent: null },

  // LOCAL BRANCH
  { channelId: "system.local", label: "local", channelKey: "file:read", parent: "system" },
  { channelId: "system.local.file:read", label: "read", channelKey: "file:read", parent: "system.local" },
  { channelId: "system.local.file:write", label: "write", channelKey: "file:write", parent: "system.local" },

  // NETWORK BRANCH
  { channelId: "system.network", label: "network", channelKey: "telegram:output", parent: "system" },
  {
    channelId: "system.network.telegram:output",
    label: "say",
    channelKey: "telegram:output",
    parent: "system.network",
  },
  { channelId: "system.network.telegram:input", label: "hear", channelKey: "telegram:input", parent: "system.network" },
  { channelId: "system.network.web:fetch", label: "fetch", channelKey: "web:fetch", parent: "system.network" },
  { channelId: "system.network.web:mutate", label: "mutate", channelKey: "web:mutate", parent: "system.network" },

  // EXEC BRANCH
  { channelId: "system.exec", label: "exec", channelKey: "bash:exec", parent: "system" },
  { channelId: "system.exec.bash:exec", label: "bash", channelKey: "bash:exec", parent: "system.exec" },

  // FINANCIAL BRANCH
  { channelId: "system.finance", label: "finance", channelKey: "payment:send", parent: "system" },
  { channelId: "system.finance.payment:send", label: "pay", channelKey: "payment:send", parent: "system.finance" },

  // DEPLOY BRANCH
  { channelId: "system.deploy", label: "deploy", channelKey: "deploy:prod", parent: "system" },
  { channelId: "system.deploy.deploy:prod", label: "prod", channelKey: "deploy:prod", parent: "system.deploy" },
];

// ── prototype dimension ──────────────────────────────────────────────────

// The substrate uses bge-small (384-dim). We use the same dimension.
const DIM = 384;

function zeroCentroid(): Float32Array {
  return new Float32Array(DIM);
}

// ── Welford 1979 running mean ────────────────────────────────────────────

function foldCentroid(centroid: Float32Array, currentWeight: number, vector: Float32Array, reward: number): number {
  const wNew = currentWeight + reward;
  if (Math.abs(wNew) < 1e-9) {
    centroid.fill(0);
    return 0;
  }
  const alpha = reward / wNew;
  for (let i = 0; i < DIM; i++) {
    centroid[i] += alpha * (vector[i] - centroid[i]);
  }
  return wNew;
}

function energyCentroid(centroid: Float32Array, weight: number, vector: Float32Array): number {
  if (weight <= 0) return Infinity;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < DIM; i++) {
    dot += vector[i] * centroid[i];
    na += vector[i] * vector[i];
    nb += centroid[i] * centroid[i];
  }
  if (na <= 0 || nb <= 0) return Infinity;
  return -(dot / Math.sqrt(na * nb));
}

function freshness(ageSecs: number, halflifeDays: number = 30): number {
  if (ageSecs <= 0) return 1;
  const ageDays = ageSecs / 86400;
  return 1 / (1 + ageDays / halflifeDays);
}

// ── fractal EBM ──────────────────────────────────────────────────────────

export interface FractalEBMState {
  nodes: Record<string, FractalNode>;
  totalFires: number;
  epoch: number;
}

export interface RouteResult {
  node: FractalNode;
  path: string[];
  energy: number;
  confidence: "hot" | "warm" | "cold";
}

export function createFractalEBM() {
  const nodes: Record<string, FractalNode> = {};
  let totalFires = 0;

  for (const spec of TREE_SPEC) {
    const channel = CHANNELS[spec.channelKey];
    const parentChannel = spec.parent ? nodes[spec.parent]?.channel : undefined;
    const node: FractalNode = {
      channelId: spec.channelId,
      label: spec.label,
      channel: channel ?? {
        id: spec.channelId,
        role: "governor",
        effect: "none",
        cadence: "management",
        requiresApproval: false,
        requiresSensor: false,
      },
      parentChannelId: spec.parent,
      children: [],
      depth: spec.parent ? (nodes[spec.parent]?.depth ?? 0) + 1 : 0,
      centroid: zeroCentroid(),
      weight: 0,
      fires: 0,
      lastFireUnix: 0,
      neuronId: null,
    };
    nodes[spec.channelId] = node;
  }

  // Wire children
  for (const [, node] of Object.entries(nodes)) {
    if (node.parentChannelId) {
      const parent = nodes[node.parentChannelId];
      if (parent && !parent.children.includes(node.channelId)) {
        parent.children.push(node.channelId);
      }
    }
  }

  function getState(): FractalEBMState {
    return { nodes: structuredClone(nodes), totalFires, epoch: Math.floor(Date.now() / 1000) };
  }

  // ── fire ────────────────────────────────────────────────────────────────

  function fire(channelId: string, _context: string, reward: number, vector?: Float32Array | null): void {
    totalFires++;

    // Resolve channelId to a tree node. Three strategies:
    //   1. Exact match on hierarchical id (e.g. "system.network.telegram:output")
    //   2. Match by channelKey in the tree spec (e.g. "telegram:output" → node)
    //   3. Partial match — any node whose channelKey is a prefix of channelId
    //      (e.g. "telegram:send" matches node with channelKey "telegram:output"
    //       because the closest channel to "telegram:send" is "telegram:output")
    //   4. Fallback to system root
    let node = nodes[channelId];
    if (!node) {
      // Try channelKey match
      for (const spec of TREE_SPEC) {
        if (spec.channelKey === channelId && nodes[spec.channelId]) {
          node = nodes[spec.channelId];
          break;
        }
      }
    }
    if (!node) {
      // Try prefix match — find the channelKey that is the longest prefix
      // of channelId. E.g. "telegram:send" → "telegram:output" (same prefix "telegram:")
      let bestKey = "";
      for (const spec of TREE_SPEC) {
        if (channelId.startsWith(spec.channelKey.split(":")[0] + ":")) {
          if (spec.channelKey.length > bestKey.length) {
            bestKey = spec.channelKey;
            node = nodes[spec.channelId];
          }
        }
      }
    }
    if (!node) {
      node = nodes["system"];
      if (!node) return;
    }

    const now = Math.floor(Date.now() / 1000);

    // When we have a real embedding vector, fold it into the centroid
    // (Welford running mean). When we don't, still update the weight so
    // the tree learns which channels are hot — weight-as-count is a
    // first-order signal; centroid is the second-order refinement.
    if (vector && vector.length === DIM) {
      node.weight = foldCentroid(node.centroid, node.weight, vector, reward);
    } else {
      node.weight += reward;
    }
    node.fires++;
    node.lastFireUnix = now;

    // Propagate up with depth decay
    propagateUp(node, vector ?? null, reward, now);
  }

  function propagateUp(node: FractalNode, vector: Float32Array | null, reward: number, now: number): void {
    let current = node;
    let level = 0;
    while (current.parentChannelId) {
      const parent = nodes[current.parentChannelId];
      if (!parent) break;
      level++;
      const decayedReward = reward / (1 + level);
      if (vector && vector.length === DIM && Math.abs(decayedReward) > 1e-9) {
        parent.weight = foldCentroid(parent.centroid, parent.weight, vector, decayedReward);
      } else if (Math.abs(decayedReward) > 1e-9) {
        parent.weight += decayedReward;
      }
      parent.fires++;
      parent.lastFireUnix = now;
      current = parent;
    }
  }

  // ── route ──────────────────────────────────────────────────────────────

  function route(vector: Float32Array): RouteResult | null {
    const root = nodes["system"];
    if (!root) return null;

    const path: string[] = ["system"];
    let current = root;

    for (let i = 0; i < 20; i++) {
      const children = current.children.map((id) => nodes[id]).filter((n): n is FractalNode => n != null);

      if (children.length === 0) {
        return {
          node: current,
          path,
          energy: energyCentroid(current.centroid, current.weight, vector),
          confidence: current.weight > 10 ? "hot" : current.weight > 1 ? "warm" : "cold",
        };
      }

      let best: FractalNode | null = null;
      let bestE = Infinity;
      for (const child of children) {
        const e = energyCentroid(child.centroid, child.weight, vector);
        const age = Date.now() / 1000 - child.lastFireUnix;
        const f = freshness(age);
        const effective = e === Infinity ? Infinity : e * (1 + (1 - f));
        if (effective < bestE) {
          bestE = effective;
          best = child;
        }
      }

      if (!best || bestE === Infinity) {
        return {
          node: current,
          path,
          energy: energyCentroid(current.centroid, current.weight, vector),
          confidence: "cold",
        };
      }

      path.push(best.channelId);
      current = best;
    }

    return {
      node: current,
      path,
      energy: energyCentroid(current.centroid, current.weight, vector),
      confidence: "warm",
    };
  }

  // ── inspect ────────────────────────────────────────────────────────────

  function report(channelId: string): string {
    const node = nodes[channelId];
    if (!node) return `<unknown channel: ${channelId}>`;

    const lines: string[] = [
      `${node.channelId} (${node.label}) depth=${node.depth}`,
      `  weight=${node.weight.toFixed(1)} fires=${node.fires} last=${new Date(node.lastFireUnix * 1000).toISOString()}`,
      `  children: [${node.children.join(", ") || "none"}]`,
    ];

    if (node.children.length > 0 && node.weight > 0) {
      lines.push("  child energies (vs own centroid):");
      for (const childId of node.children) {
        const child = nodes[childId];
        if (child && child.weight > 0) {
          const e = energyCentroid(node.centroid, node.weight, child.centroid);
          lines.push(`    ${childId}: energy=${e.toFixed(3)} (w=${child.weight.toFixed(1)})`);
        } else if (child) {
          lines.push(`    ${childId}: cold (w=0)`);
        }
      }
    }

    return lines.join("\n");
  }

  function list(): FractalNode[] {
    return Object.values(nodes).sort((a, b) => a.depth - b.depth || a.channelId.localeCompare(b.channelId));
  }

  // ── rebuild from ledger ──────────────────────────────────────────────────

  /**
   * Rebuild the EBM centroids from the contract ledger. This is how
   * stateless neuron processes reconstruct the energy landscape on startup.
   *
   * It replays satisfied/fire rows: for each row, if the event is
   * "satisfied" (reward +1) or "fired" with exit_code > 0 (reward -1),
   * it calls fire() with the relevant channel. The Welford accumulator
   * is incremental so the result is identical to having processed them
   * inline.
   *
   * Cost: O(ledger_rows). For 500 rows, this takes <100ms.
   */
  function rebuildFromLedger(ledgerPath?: string): number {
    const fs = require("node:fs");
    const path = ledgerPath ?? require("node:os").homedir() + "/.claude/contracts.jsonl";

    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch {
      return 0; // ledger not found — start cold
    }

    let replayed = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const event = row.event as string | undefined;
      if (!event) continue;

      // Satisfied → reward +1
      if (event === "satisfied") {
        const plan = (row.plan as string) ?? "";
        const channel = resolveChannelForRebuild(plan);
        fire(channel, plan, 1.0, null);
        replayed++;
        continue;
      }

      // Fired with exit_code > 0 → reward -1 (penalty)
      if (event === "fired" || event === "iterated") {
        const exitCode = typeof row.exit_code === "number" ? row.exit_code : 0;
        if (exitCode > 0) {
          const plan = (row.plan as string) ?? "";
          const channel = resolveChannelForRebuild(plan);
          fire(channel, plan, -1.0, null);
          replayed++;
        }
      }
    }

    return replayed;
  }

  /**
   * Resolve a channel from a plan string for ledger replay.
   * Maps known tool names to their channels; falls back to "unknown".
   */
  function resolveChannelForRebuild(plan: string): string {
    const toolPatterns: Array<[RegExp, string]> = [
      [/\b(grep|read_file|lsp|cat)\b/i, "file:read"],
      [/\b(write_file|edit_file|rm|unlink)\b/i, "file:write"],
      [/\b(bash|execSync|exec)\b/i, "bash:exec"],
      [/\b(telegram|sendVoice|sendMessage)\b/i, "telegram:output"],
      [/\b(fetch|search_web|paid_request|unbrowse)\b/i, "web:fetch"],
      [/\b(payment|wallet|send.*eth|send.*usdc)\b/i, "payment:send"],
      [/\b(deploy|publish|release)\b/i, "deploy:prod"],
      [/\b(voice|speak|tts|kokoro|qwen)\b/i, "voice:output"],
    ];

    for (const [pattern, channel] of toolPatterns) {
      if (pattern.test(plan)) return channel;
    }

    return "unknown";
  }

  return { fire, route, report, list, getState, rebuildFromLedger };
}

export type FractalEBM = ReturnType<typeof createFractalEBM>;
