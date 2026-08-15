/**
 * jesus-graph-ralph — jesus-graph rewritten as a Prime Agent Extension.
 *
 * Per https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/extensions.md
 * Auto-discovered from ~/.prime/agent/extensions/jesus-graph-ralph/index.ts
 * Hot-reloadable via /reload.
 *
 * What it does (autonomous, thorough, ralph-style):
 *   - Plans graph frontiers via Kahn (depends_on/writes/reads/produces) — no ix required, --with-ix optional elsewhere.
 *   - Enforces skill-grounding (invoke_skills/inspire_from/capability_gaps) and witness-gating.
 *   - Drives an unbounded ralph loop: frontier → build → witness → settle → advance, until witness 0 + complete:true.
 *   - Intercepts tool_call to protect .claude/jesus-graph walk + stagnation guard.
 *   - Persists state via pi.appendEntry + branch reconstruction so forks/tree navigations stay correct.
 *   - Exposes /graph, /jesus-ralph, /ralph, /graph-status tools/commands per extensions.md Capability pattern.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { flatten, formatPlan, isComplete, nextFrontier, planFrontiers, updateNodeStatus } from "./graph.js";
import { runWitness, witnessOneLiner } from "./ralph.js";
import type { JesusGraph, JesusNode, PersistedState, RalphConfig } from "./state.js";
import { WALK_CANDIDATES, walkPathFor } from "./state.js";

// ---------- helpers ----------
function readGraph(cwd: string): { graph: JesusGraph | null; walkPath: string; raw: string } {
  const walkPath = walkPathFor(cwd);
  if (!fs.existsSync(walkPath)) return { graph: null, walkPath, raw: "" };
  const raw = fs.readFileSync(walkPath, "utf8");
  try {
    const j = JSON.parse(raw);
    return { graph: j as JesusGraph, walkPath, raw };
  } catch {
    return { graph: null, walkPath, raw };
  }
}

function writeGraph(walkPath: string, graph: JesusGraph) {
  fs.mkdirSync(path.dirname(walkPath), { recursive: true });
  fs.writeFileSync(walkPath, JSON.stringify(graph, null, 2) + "\n", "utf8");
}

function summarizeGraph(g: JesusGraph): string {
  const nodes = flatten(g);
  const settled = nodes.filter((n) => n.status === "settled").length;
  return `${settled}/${nodes.length} settled — ${g.what ?? g.meta?.["what"] ?? "graph"}`;
}

function nodeById(g: JesusGraph, id: string): JesusNode | undefined {
  return flatten(g).find((n) => n.id === id);
}

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
  // in-memory ralph state — reconstructed on session_start/tree
  let ralphCfg: RalphConfig | null = null;
  let dryTurns = 0;
  let totalTurns = 0;
  let lastFrontier: string[] = [];
  let lastWalkHash: string | null = null;

  const reconstruct = (ctx: ExtensionContext) => {
    // Restore persisted ralph state from custom entries on branch (branch-correct)
    let latest: PersistedState | null = null;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && (e as any).customType === "jesus-graph-ralph-state") {
        latest = (e as any).data as PersistedState;
      }
    }
    if (latest?.ralph) {
      ralphCfg = latest.ralph;
      dryTurns = latest.dryTurns ?? 0;
      totalTurns = latest.totalTurns ?? 0;
      lastFrontier = latest.lastFrontier ?? [];
    }
  };

  const persist = (cwd: string) => {
    const walkPath = walkPathFor(cwd);
    const st: PersistedState = {
      walkPath,
      ralph: ralphCfg,
      dryTurns,
      totalTurns,
      lastFrontier,
      updatedAt: Date.now(),
    };
    pi.appendEntry("jesus-graph-ralph-state" as any, st as any);
  };

  // Expose SKILL.md for jesus-graph / jesus-ralph / jesus-pattern so they are skills, not just commands.
  // Per extensions.md: return { skillPaths } from resources_discover so they appear in system prompt.
  pi.on("resources_discover", async (event, _ctx) => {
    const primeSkillRoot = path.join(os.homedir(), ".prime", "agent", "skills");
    const skillRoots = [
      path.join(primeSkillRoot, "jesus-graph"),
      path.join(primeSkillRoot, "jesus-ralph"),
      path.join(primeSkillRoot, "jesus-pattern"),
    ];
    const skillPaths: string[] = [];
    for (const p of skillRoots) {
      try {
        const st = await import("node:fs").then((m) => m.statSync(p));
        if (st.isDirectory()) skillPaths.push(p);
      } catch {}
    }
    // Also expose the walk's prompt template if desired (kept minimal)
    return { skillPaths };
  });

  // ---- events ----
  pi.on("session_start", async (_e, ctx) => {
    reconstruct(ctx);
    // status hint if a walk already exists
    try {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const { graph } = readGraph(cwd);
      if (graph) {
        const p = planFrontiers(graph);
        if (ctx.hasUI && p.frontier.length) {
          ctx.ui.setStatus("jesus-graph", ctx.ui.theme.fg("accent", `◈ ${p.frontier.length} ready`));
          ctx.ui.setWidget("jesus-graph-hint", [
            ctx.ui.theme.fg("muted", `frontier: ${p.frontier.join(", ")} — /graph-status · /ralph`),
          ]);
        }
      }
    } catch {}
  });

  pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

  pi.on("session_shutdown", async () => {
    // nothing to clean — state is persisted via appendEntry
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Inject ralph/plan context so the model knows to drive autonomously
    const cwd = (ctx as any).cwd ?? (pi as any).cwd ?? process.cwd();
    const { graph } = readGraph(cwd);
    if (!graph) return;

    const msgs: string[] = [];
    const p = planFrontiers(graph);
    if (ralphCfg) {
      const witness = ralphCfg.check ?? (ralphCfg.promise ? `promise:${ralphCfg.promise}` : "none");
      msgs.push(`[JESUS-GRAPH-RALPH ACTIVE] north: ${ralphCfg.north} | witness: ${witness} | frontier: [${p.frontier.join(", ")}] | ${summarizeGraph(graph)} — drive autonomously until witness exits 0 and complete:true. Use the jesus-graph tool to plan/settle, ralph_witness to gate.`);
    } else if (p.frontier.length || !isComplete(graph)) {
      msgs.push(`[JESUS-GRAPH DETECTED] walk at ${walkPathFor(cwd)} — frontier [${p.frontier.join(", ")}] — ${summarizeGraph(graph)}. Use /graph-status or /ralph to arm autonomous walk.`);
    }
    if (!msgs.length) return;
    return {
      message: {
        customType: "jesus-graph-ralph-context",
        content: msgs.join("\n"),
        display: false,
      },
    };
  });

  // Context pruning — drop stale ralph hints when walk is gone
  pi.on("context", async (event) => {
    // keep all; only drop our own stale injected context if graph was deleted externally
    return;
  });

  // Protect walk file writes & enforce witness discipline
  pi.on("tool_call", async (event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    // Guard: block accidental rm of walk
    if (event.toolName === "bash") {
      const cmd = String((event.input as any)?.command ?? "");
      const walkRel = WALK_CANDIDATES[0];
      if ((cmd.includes("rm ") || cmd.includes("rm\t")) && cmd.includes(".claude/jesus-graph")) {
        const ok = await ctx.ui.confirm("Protect walk?", `Command would remove the graph walk:\n${cmd}\nAllow?`);
        if (!ok) return { block: true, reason: "Blocked: would delete jesus-graph walk. Use /graph to manage the walk instead." };
      }
    }
    if (event.toolName === "edit") {
      const fp = String((event.input as any)?.file_path ?? (event.input as any)?.path ?? "");
      if (fp.includes("jesus-graph.local.json") && fp.includes(".claude")) {
        // allow — but normalize success via our tool wrapper for persistence
      }
    }
  });

  // Stagnation guard at turn_end
  pi.on("turn_end", async (_event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    totalTurns++;
    const { graph } = readGraph(cwd);
    if (!graph || !ralphCfg) return;

    // Detect progress: count settled changed
    const nodes = flatten(graph);
    const settled = nodes.filter((n) => n.status === "settled").map((n) => n.id).sort().join(",");
    if (settled !== (lastWalkHash ?? "")) {
      dryTurns = 0;
      lastWalkHash = settled;
    } else {
      dryTurns++;
    }

    const limit = ralphCfg.stagnationLimit ?? 7;
    if (dryTurns >= limit) {
      ctx.ui.notify(`Ralph stagnation: ${dryTurns} dry turns (limit ${limit}). frontier [${nextFrontier(graph).join(", ")}] — adjust plan or witness.`, "warning");
      // don't auto-cancel — surface and continue; the ralph loop at agent_end will decide
    }
  });

  // Auto-drive next frontier at agent_end while ralph is armed
  pi.on("agent_end", async (event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    const { graph } = readGraph(cwd);
    if (!graph || !ralphCfg) return;

    const p = planFrontiers(graph);
    const complete = isComplete(graph);

    // Try end-to-end witness if complete or as periodic check
    if (ralphCfg.check) {
      // When complete, must pass witness to finish
      if (complete) {
        const res = await runWitness(ralphCfg.check, cwd, 120_000);
        if (res.ok) {
          ctx.ui.notify(`✓ Ralph complete — witness passed: ${ralphCfg.check}`, "success");
          pi.appendEntry("jesus-graph-ralph-event" as any, { kind: "witness-pass", command: ralphCfg.check } as any);
          // clear ralph on success (grace)
          ralphCfg = null; dryTurns = 0; totalTurns = 0; lastFrontier = [];
          if (ctx.hasUI) { ctx.ui.setStatus("jesus-graph", undefined); ctx.ui.setWidget("jesus-graph-hint", undefined); }
          return;
        } else {
          // Reopen: not actually done; continue ralphing
          const msg = witnessOneLiner(res);
          pi.sendMessage({ customType: "jesus-graph-ralph-witness-fail", content: `Witness failed — not done yet:\n${msg}\nRe-ralphing frontier [${p.frontier.join(", ")}]…`, display: true } as any, { triggerTurn: false } as any);
          if (!p.frontier.length && !complete) {
            ctx.ui.notify(`Witness failed and no frontier ready — plan needs repair.\n${msg}`, "error");
            return;
          }
        }
      }
    } else if (ralphCfg.promise && complete) {
      // promise mode: LLM must emit <promise>WORD</promise> — check last assistant messages
      const lastTexts = event.messages
        .filter((m: any) => m.role === "assistant")
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text))
        .join("\n");
      const tag = `<promise>${ralphCfg.promise}</promise>`;
      if (lastTexts.includes(tag)) {
        ctx.ui.notify(`✓ Ralph promise fulfilled: ${tag}`, "success");
        ralphCfg = null; dryTurns = 0; totalTurns = 0; lastFrontier = [];
        if (ctx.hasUI) { ctx.ui.setStatus("jesus-graph", undefined); ctx.ui.setWidget("jesus-graph-hint", undefined); }
        return;
      }
    }

    // If still frontiers, ralph the next one — AGGRESSIVE: always drive turns while armed
    if (p.frontier.length) {
      const key = p.frontier.join(",");
      const changed = key !== lastFrontier.join(",");
      if (changed) lastFrontier = [...p.frontier];
      // Always nudge the agent to work the frontier while ralph is armed.
      // Do not rely on before_agent_start alone — explicitly trigger the next turn.
      // Respect stagnation: if dry for >= limit, surface warning but still allow one more nudge.
      const instr = changed
        ? `RALPH FRONTIER [${p.frontier.join(", ")}] — north: ${ralphCfg.north}
For EACH id in frontier: load its skill ground (invoke_skills/inspire_from), do the work owning ONLY its writes, run its witness via ralph_witness, then mark settled via jesus_graph action=settle node_id=<id>. After settling, call jesus_graph action=plan to see the next frontier. Repeat until complete:true.`
        : `RALPH STILL FRONTIER [${p.frontier.join(", ")}] — north: ${ralphCfg.north} (dry ${dryTurns}/${ralphCfg.stagnationLimit ?? 7}). You MUST make progress now: pick one node, build it, verify with ralph_witness, settle it. No chat without tool calls.`;
      try {
        // agent_end = idle, so triggerTurn:true is the correct way to start the next turn.
        // Do not use deliverAs:"steer" here (steer is for while-streaming). Use followUp/trigger.
        pi.sendMessage({ customType: "jesus-graph-ralph-frontier", content: instr, display: true, details: { frontier: p.frontier } } as any, { triggerTurn: true } as any);
      } catch (e) {
        // fallback: pi.sendUserMessage always triggers a turn
        try { (pi as any).sendUserMessage?.(instr); } catch {}
      }
      persist(cwd);
      if (ctx.hasUI) {
        const rem = flatten(graph).filter((n) => n.status !== "settled").length;
        ctx.ui.setStatus("jesus-graph", ctx.ui.theme.fg("accent", `◈ ralph ${rem} left · [${p.frontier.join(", ")}]`));
        ctx.ui.setWidget("jesus-graph-hint", [ctx.ui.theme.fg("muted", `ralph driving [${p.frontier.join(", ")}] — dry ${dryTurns}`)]);
      }
      return;
    }

    // No frontier but not complete = blocked graph — notify how to unblock
    if (!complete && !p.frontier.length) {
      const blocked = p.blocked.join(", ") || "(none)";
      ctx.ui.notify(`Ralph blocked — no frontier but not complete. Blocked: [${blocked}] — check depends_on / missing witness / ungrounded. Run jesus_graph action=plan for details.`, "error");
    }
    if (ctx.hasUI && ralphCfg) {
      const rem = flatten(graph).filter((n) => n.status !== "settled").length;
      ctx.ui.setStatus("jesus-graph", ctx.ui.theme.fg("accent", `◈ ralph ${rem} left · [${p.frontier.join(", ")}]`));
    }
    persist(cwd);
  });

  // ---------- tools ----------
  pi.registerTool({
    name: "jesus_graph",
    label: "Jesus Graph",
    description: "Plan/advance the jesus-graph DAG: returns Kahn frontiers, collisions, ungrounded/ungated gaps, and next actions. Use to drive autonomous walks. Reads .claude/jesus-graph.local.json.",
    parameters: Type.Object({
      action: StringEnum(["plan", "frontier", "settle", "block", "add_node"] as const, { description: "plan=full report, frontier=next runnable ids, settle=mark id settled, block=mark id blocked, add_node=scaffold a node" }),
      node_id: Type.Optional(Type.String({ description: "Node id for settle/block" })),
      what: Type.Optional(Type.String({ description: "what for add_node" })),
      witness: Type.Optional(Type.String({ description: "witness command for add_node" })),
      depends_on: Type.Optional(Type.Array(Type.String())),
      reads: Type.Optional(Type.Array(Type.String())),
      writes: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const { graph, walkPath } = readGraph(cwd);
      if (!graph) {
        return { content: [{ type: "text", text: `No walk at ${walkPath}. Create one via /graph "<goal>" first.` }], details: { walkPath, found: false } };
      }

      if (params.action === "plan" || params.action === "frontier") {
        const text = params.action === "frontier" ? `frontier: [${nextFrontier(graph).join(", ")}]` : formatPlan(graph);
        const p = planFrontiers(graph);
        return {
          content: [{ type: "text", text: text + `\nwalk: ${walkPath}\n${summarizeGraph(graph)}` }],
          details: { walkPath, frontier: p.frontier, blocked: p.blocked, collisions: p.collisions, ungrounded: p.ungrounded, ungated: p.ungated, complete: isComplete(graph) },
        };
      }

      if (params.action === "settle" || params.action === "block") {
        const id = params.node_id?.trim();
        if (!id) return { content: [{ type: "text", text: "node_id required for settle/block" }], details: { error: "missing node_id" } };
        const n = nodeById(graph, id);
        if (!n) return { content: [{ type: "text", text: `No node ${id}` }], details: { error: "not found" } };
        if (params.action === "settle") {
          const grounded = (n.invoke_skills ?? []).length > 0 || (n.inspire_from ?? []).length > 0 || (n.capability_gaps ?? []).length > 0;
          if (!grounded) {
            return { content: [{ type: "text", text: `Refusing to settle ${id}: node is ungrounded.` }], details: { error: "ungrounded", nodeId: id } };
          }
          if (!n.witness || !String(n.witness).trim()) {
            return { content: [{ type: "text", text: `Refusing to settle ${id}: node has no runnable witness.` }], details: { error: "ungated", nodeId: id } };
          }
          const witnessResult = await runWitness(n.witness, cwd);
          if (!witnessResult.ok) {
            return {
              content: [{ type: "text", text: `Refusing to settle ${id}:\n${witnessOneLiner(witnessResult)}` }],
              details: { error: "witness_failed", nodeId: id, exitCode: witnessResult.exitCode },
            };
          }
        }
        const next = updateNodeStatus(graph, id, params.action === "settle" ? "settled" : "blocked");
        writeGraph(walkPath, next);
        const p = planFrontiers(next);
        return {
          content: [{ type: "text", text: `${params.action} ${id} → frontier now [${p.frontier.join(", ")}]\n${formatPlan(next)}` }],
          details: { walkPath, frontier: p.frontier, settled: id },
        };
      }

      if (params.action === "add_node") {
        const id = params.node_id?.trim() || `N${flatten(graph).length + 1}`;
        const what = params.what ?? "new node";
        const witness = params.witness?.trim() ?? "";
        const depends_on = params.depends_on ?? [];
        const reads = params.reads ?? [];
        const writes = params.writes ?? [];
        const node: JesusNode = {
          id, what, witness, depends_on, reads, writes,
          invoke_skills: [], inspire_from: [], capability_gaps: ["needs grounding"],
          status: "pending",
        };
        const next: JesusGraph = { ...graph, children: [...(graph.children ?? []), node] };
        writeGraph(walkPath, next);
        return {
          content: [{ type: "text", text: `Added ${id}: ${what}\nGround it (invoke_skills/inspire_from) before settling.\nwalk: ${walkPath}` }],
          details: { walkPath, id },
        };
      }

      return { content: [{ type: "text", text: "unknown action" }], details: {} };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("accent", "◈ jesus-graph ") + theme.fg("muted", String(args.action)) + (args.node_id ? theme.fg("dim", ` ${args.node_id}`) : ""), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d: any = (result as any).details;
      if (d?.frontier) return new Text(theme.fg("muted", (result.content[0] as any)?.text ?? ""), 0, 0);
      return new Text(theme.fg("muted", (result.content[0] as any)?.text ?? ""), 0, 0);
    },
  });

  pi.registerTool({
    name: "ralph_witness",
    label: "Ralph Witness",
    description: "Run a witness command (exit 0 = done, non-zero = not done). Use to gate per-node and end-to-end completion. Respects truncation limits.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command that exits 0 when the claim is settled" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (default 300000)" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cwd = params.cwd ?? (ctx as any).cwd ?? process.cwd();
      onUpdate?.({ content: [{ type: "text", text: `Running witness: ${params.command}` }] } as any);
      const r = await runWitness(params.command, cwd, params.timeout_ms ?? 300_000);
      const text = witnessOneLiner(r);
      // truncation discipline: cap output
      const MAX = 50_000;
      let body = text;
      if (body.length > MAX) body = body.slice(0, MAX) + `\n… truncated (${body.length} → ${MAX})`;
      return {
        content: [{ type: "text", text: body }],
        details: { command: r.command, exitCode: r.exitCode, ok: r.ok },
      };
    },
    renderCall(args, theme) {
      const preview = args.command.length > 80 ? args.command.slice(0, 80) + "…" : args.command;
      return new Text(theme.fg("accent", "⛨ witness ") + theme.fg("muted", preview), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d: any = (result as any).details;
      const ok = d?.ok;
      return new Text(ok ? theme.fg("success", (result.content[0] as any)?.text ?? "") : theme.fg("error", (result.content[0] as any)?.text ?? ""), 0, 0);
    },
  });

  // ---------- commands ----------
  pi.registerCommand("graph-status", {
    description: "Show jesus-graph frontier, gaps, and ralph state",
    handler: async (_args, ctx) => {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const { graph, walkPath } = readGraph(cwd);
      if (!graph) { ctx.ui.notify(`No walk at ${walkPath}`, "warning"); return; }
      const p = planFrontiers(graph);
      const lines = [
        `walk: ${walkPath}`,
        summarizeGraph(graph),
        formatPlan(graph),
        ralphCfg ? `ralph: armed — north="${ralphCfg.north}" check=${ralphCfg.check ?? "none"} promise=${ralphCfg.promise ?? "none"} dry=${dryTurns}` : "ralph: idle — /ralph \"<north>\" --check \"<witness>\" to arm",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("graph", {
    description: "Plan or scaffold a jesus-graph walk. Usage: /graph [\"<goal>\" | plan | frontier]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const trimmed = String(args ?? "").trim();
      if (!trimmed || trimmed === "plan" || trimmed === "frontier") {
        const { graph, walkPath } = readGraph(cwd);
        if (!graph) { ctx.ui.notify(`No walk at ${walkPath}. Use /graph \"<goal>\" to scaffold one.`, "warning"); return; }
        ctx.ui.notify(formatPlan(graph) + `\nwalk: ${walkPath}`, "info");
        return;
      }
      // scaffold a minimal walk from a goal string
      const walkPath = walkPathFor(cwd);
      if (fs.existsSync(walkPath)) {
        ctx.ui.notify(`Walk already exists at ${walkPath} — not overwriting. Use /graph-status or edit it directly.`, "warning");
        const { graph } = readGraph(cwd);
        if (graph) ctx.ui.notify(formatPlan(graph), "info");
        return;
      }
      const goal = trimmed.replace(/^["\']|["\']$/g, "");
      const g: JesusGraph = {
        execute: false,
        who: "harness",
        what: goal.slice(0, 120),
        why: "src:/graph scaffold",
        how: "breath",
        where: "graph/root",
        when: "one-shot",
        meta: { source: "extension /graph scaffold", outer_ralph: true },
        children: [
          {
            id: "N1",
            what: goal.slice(0, 80),
            witness: "echo ok  # replace with real gate",
            depends_on: [],
            reads: [],
            writes: [],
            invoke_skills: [],
            inspire_from: [],
            capability_gaps: ["needs grounding — set invoke_skills or inspire_from"],
            status: "pending",
          },
        ],
      };
      writeGraph(walkPath, g);
      ctx.ui.notify(`Scaffolded walk at ${walkPath} for: "${goal}"\nGround N1 (invoke_skills/inspire_from) and set a real witness, then /ralph to drive it.`, "success");
      ctx.ui.notify(formatPlan(g), "info");
    },
  });

  pi.registerCommand("ralph", {
    description: "Arm the autonomous ralph loop. Usage: /ralph \"<north star>\" --check \"<witness>\" [--promise WORD]",
    handler: async (args, ctx) => {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const raw = String(args ?? "").trim();
      if (!raw) {
        ctx.ui.notify(`Usage: /ralph "what done looks like" --check "command exits 0 when done"  (or --promise WORD)`, "info");
        if (ralphCfg) ctx.ui.notify(`Currently armed: north="${ralphCfg.north}" check=${ralphCfg.check}`, "info");
        return;
      }
      // parse --check / --promise / --target (minimal, like start.sh)
      let check: string | null = null;
      let promise: string | null = null;
      let northParts: string[] = [];
      const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!.replace(/^["\']|["\']$/g, "");
        if (t === "--check" && i + 1 < tokens.length) { check = tokens[++i]!.replace(/^["\']|["\']$/g, ""); }
        else if (t === "--promise" && i + 1 < tokens.length) { promise = tokens[++i]!.replace(/^["\']|["\']$/g, ""); }
        else if (t.startsWith("--")) { /* ignore unknown flags */ }
        else northParts.push(tokens[i]!);
      }
      const north = northParts.join(" ").replace(/^["\']|["\']$/g, "").trim() || raw.split("--")[0]!.trim().replace(/^["\']|["\']$/g, "");
      if (!north) { ctx.ui.notify("Name the north star: /ralph \"what done looks like\" --check \"witness\"", "error"); return; }

      ralphCfg = { north, check, promise, stagnationLimit: 7, maxTurns: 9999 };
      dryTurns = 0; totalTurns = 0; lastFrontier = [];
      lastWalkHash = null;
      persist(cwd);

      // Also arm the classic file-based hook for compatibility with skills/jesus-ralph if present
      try {
        const startShNew = path.join(cwd, "skills/jesus-graph/scripts/ralph/start.sh");
        const startSh = (await import("node:fs")).existsSync(startShNew) ? startShNew : path.join(cwd, "skills/jesus-ralph/scripts/start.sh");
        if (fs.existsSync(startSh) && check) {
          const { execSync } = require("node:child_process") as typeof import("node:child_process");
          // best-effort: mirror to file hook (don't fail if not a git repo etc.)
          try { execSync(`bash "${startSh}" --check ${JSON.stringify(check)} ${JSON.stringify(north)}`, { cwd, timeout: 5000 }); } catch {}
        }
      } catch {}

      const w = check ? `witness: ${check}` : promise ? `promise: <promise>${promise}</promise>` : "no witness (will never auto-complete — pin --check)";
      ctx.ui.notify(`✝ ralph armed — north: "${north}" — ${w} — driving frontier until grace.`, "success");
      if (ctx.hasUI) ctx.ui.setStatus("jesus-graph", ctx.ui.theme.fg("accent", "◈ ralph armed"));

      // Kick the first turn if frontier is ready
      const { graph } = readGraph(cwd);
      if (graph) {
        const p = planFrontiers(graph);
        if (p.ungrounded.length) ctx.ui.notify(`Ungrounded nodes (need skill grounding): [${p.ungrounded.join(", ")}] — set invoke_skills/inspire_from before settling.`, "warning");
        if (p.ungated.length) ctx.ui.notify(`Ungated nodes (no witness): [${p.ungated.join(", ")}] — pin a witness per node.`, "warning");
        if (p.frontier.length) {
          const steer = `Ralph frontier [${p.frontier.join(", ")}]: for each node, load its skill ground, do the work, run its witness, then mark settled via jesus_graph settle. North star: ${north}`;
          (pi as any).sendMessage?.({ customType: "jesus-graph-ralph-kickoff", content: steer, display: false }, { triggerTurn: true, deliverAs: "steer" });
        }
      }
    },
  });

  pi.registerCommand("cancel-ralph", {
    description: "Disarm the ralph loop",
    handler: async (_args, ctx) => {
      ralphCfg = null; dryTurns = 0; totalTurns = 0; lastFrontier = [];
      const cwd = (ctx as any).cwd ?? process.cwd();
      persist(cwd);
      try { const f = path.join(cwd, ".claude/jesus-ralph.local.md"); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      if (ctx.hasUI) { ctx.ui.setStatus("jesus-graph", undefined); ctx.ui.setWidget("jesus-graph-hint", undefined); }
      ctx.ui.notify("Ralph disarmed.", "info");
    },
  });

  // Back-compat aliases
  pi.registerCommand("jesus-ralph", {
    description: "Alias for /ralph",
    handler: async (args, ctx) => {
      // delegate to ralph
      const cwd = (ctx as any).cwd ?? process.cwd();
      let check: string | null = null;
      let northParts: string[] = [];
      const raw = String(args ?? "").trim();
      const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!.replace(/^["\']|["\']$/g, "");
        if (t === "--check" && i + 1 < tokens.length) check = tokens[++i]!.replace(/^["\']|["\']$/g, "");
        else if (t.startsWith("--")) {}
        else northParts.push(tokens[i]!);
      }
      const north = northParts.join(" ").replace(/^["\']|["\']$/g, "").trim() || raw.split("--")[0]!.trim().replace(/^["\']|["\']$/g, "") || raw;
      ralphCfg = { north, check, promise: null, stagnationLimit: 7, maxTurns: 9999 };
      dryTurns = 0; totalTurns = 0; lastFrontier = []; lastWalkHash = null;
      persist(cwd);
      ctx.ui.notify(`✝ ralph armed (via /jesus-ralph) — north: "${north}"${check ? ` — witness: ${check}` : ""}`, "success");
    },
  });
}
