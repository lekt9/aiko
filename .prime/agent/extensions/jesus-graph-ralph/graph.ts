import { JesusGraph, JesusNode } from "./state.js";

export interface PlanLayer {
  frontier: string[];
  blocked: string[];
  collisions: [string, string][];
  ungrounded: string[];
  ungated: string[];
  missing_contract: string[];
  unresolved_dependency: string[];
  cycles: string[][];
}

function missingFields(n: JesusNode): string[] {
  const m: string[] = [];
  if (!Array.isArray(n.depends_on)) m.push("depends_on");
  if (!Array.isArray(n.reads)) m.push("reads");
  if (!Array.isArray(n.writes)) m.push("writes");
  if (!n.witness || !String(n.witness).trim()) m.push("witness");
  return m;
}

function isGrounded(n: JesusNode): boolean {
  const a = (n.invoke_skills ?? []).length > 0;
  const b = (n.inspire_from ?? []).length > 0;
  const c = (n.capability_gaps ?? []).length > 0;
  return a || b || c;
}

/** Flatten children recursively (walk is a tree: root.children is the graph) */
export function flatten(graph: JesusGraph): JesusNode[] {
  const out: JesusNode[] = [];
  function walk(nodes: JesusNode[]) {
    for (const n of nodes) {
      out.push(n);
      if (n.children && n.children.length) walk(n.children);
    }
  }
  walk(graph.children ?? []);
  return out;
}

export function planFrontiers(graph: JesusGraph): PlanLayer {
  const nodes = flatten(graph);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const settled = new Set(nodes.filter((n) => n.status === "settled").map((n) => n.id));

  const missing_contract: string[] = [];
  const ungrounded: string[] = [];
  const ungated: string[] = [];
  const unresolved_dependency: string[] = [];

  for (const n of nodes) {
    if (n.status === "settled") continue;
    const miss = missingFields(n);
    if (miss.length) missing_contract.push(`${n.id} (missing ${miss.join(", ")})`);
    if (!isGrounded(n)) ungrounded.push(n.id);
    if (!n.witness || !String(n.witness).trim()) ungated.push(n.id);
    for (const dep of Array.isArray(n.depends_on) ? n.depends_on : []) {
      if (!byId.has(dep)) unresolved_dependency.push(`${n.id}->${dep}`);
    }
  }

  // pending nodes whose dependencies are all settled
  const pending = nodes.filter((n) => n.status !== "settled");
  const frontier = pending
    .filter((n) => Array.isArray(n.depends_on))
    .filter((n) => n.depends_on.every((d) => byId.has(d) && settled.has(d)))
    .map((n) => n.id);
  const blocked = pending.filter((n) => !frontier.includes(n.id)).map((n) => n.id);

  // write collisions among frontier
  const collisions: [string, string][] = [];
  for (let i = 0; i < frontier.length; i++) {
    for (let j = i + 1; j < frontier.length; j++) {
      const a = byId.get(frontier[i])!;
      const b = byId.get(frontier[j])!;
      const aw = new Set(a.writes ?? []);
      const bw = new Set(b.writes ?? []);
      for (const w of aw) if (bw.has(w)) { collisions.push([a.id, b.id]); break; }
    }
  }

  // cycle detection (simple DFS on pending dependency graph)
  const cycles: string[][] = [];
  const vis = new Map<string, number>(); // 0=unvisited 1=visiting 2=done
  const stack: string[] = [];
  function dfs(id: string) {
    vis.set(id, 1); stack.push(id);
    const n = byId.get(id);
    if (n) {
      for (const dep of Array.isArray(n.depends_on) ? n.depends_on : []) {
        if (!byId.has(dep)) continue;
        const s = vis.get(dep) ?? 0;
        if (s === 1) {
          const idx = stack.indexOf(dep);
          cycles.push([...stack.slice(idx), dep]);
        } else if (s === 0) dfs(dep);
      }
    }
    stack.pop(); vis.set(id, 2);
  }
  for (const n of pending) if ((vis.get(n.id) ?? 0) === 0) dfs(n.id);

  return { frontier, blocked, collisions, ungrounded, ungated, missing_contract, unresolved_dependency, cycles };
}

export function nextFrontier(graph: JesusGraph): string[] {
  return planFrontiers(graph).frontier;
}

export function isComplete(graph: JesusGraph): boolean {
  return flatten(graph).every((n) => n.status === "settled");
}

export function updateNodeStatus(graph: JesusGraph, id: string, status: JesusNode["status"]): JesusGraph {
  function walk(nodes: JesusNode[]): JesusNode[] {
    return nodes.map((n) => {
      if (n.id === id) return { ...n, status };
      if (n.children && n.children.length) return { ...n, children: walk(n.children) };
      return n;
    });
  }
  return { ...graph, children: walk(graph.children ?? []) };
}

export function formatPlan(graph: JesusGraph): string {
  const p = planFrontiers(graph);
  const lines: string[] = [];
  lines.push(`frontier: [${p.frontier.join(", ")}]`);
  lines.push(`blocked: [${p.blocked.join(", ")}]`);
  if (p.collisions.length) lines.push(`collisions: ${p.collisions.map(([a,b])=>a+"<>"+b).join(", ")}`);
  if (p.ungrounded.length) lines.push(`ungrounded: [${p.ungrounded.join(", ")}]`);
  if (p.ungated.length) lines.push(`ungated: [${p.ungated.join(", ")}]`);
  if (p.missing_contract.length) lines.push(`missing_contract: ${p.missing_contract.join("; ")}`);
  if (p.unresolved_dependency.length) lines.push(`unresolved_dependency: ${p.unresolved_dependency.join("; ")}`);
  if (p.cycles.length) lines.push(`cycles: ${p.cycles.map(c=>c.join("->")).join("; ")}`);
  lines.push(isComplete(graph) ? "complete: true" : `complete: false (${flatten(graph).filter(n=>n.status!=="settled").length} remaining)`);
  return lines.join("\n");
}
