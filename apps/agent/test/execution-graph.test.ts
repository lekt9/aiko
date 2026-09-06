import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Layer } from "effect";
import { actor } from "tardie";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { configureExecutionGraph, cancelExecutionGraph, invalidateExecutionGraph, executionGraphComponent, executionGraphWorker, executionGraphEventKey, executionGraphAppendAllowed, executionGraphView, executionGraphState, executionGraphReady, executionGraphDigest, executionGraphAttempt, executionGraphExternalEventAllowed, validateExecutionGraph, type ExecutionGraph, type GraphNode } from "../src/execution-graph.ts";

const node = (id: string, dependsOn: string[] = []): GraphNode => ({ id, dependsOn, reads: dependsOn.map(d => `out/${d}`), writes: [`file/${id}`], outputs: [`out/${id}`], check: { id: "artifact", version: "1" }, task: `Build ${id}` });
const graph = (): ExecutionGraph => ({ id: "build", version: "1", nodes: [node("b"), node("a"), node("c", ["a", "b"])] });

test("contracts reject cycles, missing edges, malformed declarations and conflicting writes", () => {
  const cases: ExecutionGraph[] = [];
  let g = graph(); g.nodes[0]!.dependsOn = ["absent"]; cases.push(g);
  g = graph(); g.nodes[0]!.dependsOn = ["c"]; cases.push(g);
  g = graph(); g.nodes[0]!.writes = ["file/a/nested"]; cases.push(g);
  g = graph(); g.nodes[2]!.dependsOn = ["b"]; cases.push(g);
  g = graph(); g.nodes[0]!.reads = ["file/a"]; cases.push(g);
  g = graph(); g.nodes[0]!.outputs = ["out/a"]; cases.push(g);
  g = graph(); g.nodes[0]!.writes = ["file/../a"]; cases.push(g);
  for (const bad of cases) expect(() => validateExecutionGraph(bad)).toThrow();
  expect(() => validateExecutionGraph(graph())).not.toThrow();
  expect(executionGraphReady(executionGraphState([configureExecutionGraph(graph())]))).toEqual(["a", "b"]);
  const reordered = graph(); reordered.nodes.reverse(); reordered.nodes[0]!.dependsOn.reverse();
  expect(executionGraphDigest(reordered)).toBe(executionGraphDigest(graph()));
});

async function fixture(checkPass = true, beforeCheck?: () => Promise<void>) {
  const db = new Database(":memory:");
  let alarm: number | null = null;
  const storage: AccountStorage = {
    sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
  const runs: string[] = [], checks: string[] = [];
  const parent = actor({ name: "graph-test", methods: {}, components: [executionGraphComponent({ check: async ({ node, attempt }) => {
    checks.push(attempt); await beforeCheck?.(); return { passed: checkPass && runs.includes(attempt), evidence: [`fixture:artifact/${node.id}`] };
  } })] });
  const worker = actor({ name: "graph-test", methods: {}, components: [executionGraphWorker(async (_node, attempt) => { runs.push(attempt); })] });
  const open = () => createCloudflareAccountHost({ storage, actorName: "graph-test", actorInstance: "test", ownsThread: t => t === "root" || /^execution-[a-f0-9]{64}$/.test(t), actorFor: t => t === "root" ? parent : worker, layersFor: () => Layer.empty, keyOf: executionGraphEventKey, canAppend: (_t, events, read) => executionGraphAppendAllowed(events, read) });
  return { db, open, runs, checks, host: await open() };
}

test("native actor/Router/SQLite host executes fan-out and fan-in with independent evidence; restart does not repeat work", async () => {
  const f = await fixture();
  try {
    await f.host.commitRoot(f.host.self("root"), { ...configureExecutionGraph(graph()), at: 1 });
    await f.host.drive();
    const history = await f.host.read("root"), view = executionGraphView(history);
    expect(view.complete).toBe(true);
    expect(f.runs).toHaveLength(3); expect(f.checks).toHaveLength(3);
    expect(history.filter(e => e.type === "ChildCreated")).toHaveLength(3);
    expect((await f.host.threads()).length).toBe(4);
    for (const state of Object.values(view.nodes)) {
      expect(state.receipt?.schemaVersion).toBe(1);
      expect(state.receipt?.contractDigest).toBe(executionGraphDigest(graph()));
    }
    await f.host.close(); f.host = await f.open(); await f.host.recover();
    expect(executionGraphView(await f.host.read("root"))).toEqual(view);
    expect(f.runs).toHaveLength(3);
    await f.host.commitRoot(f.host.self("root"), { ...invalidateExecutionGraph("build", "a", "retry-a"), at: 2 });
    await f.host.drive();
    expect(executionGraphView(await f.host.read("root")).complete).toBe(true);
    expect(f.runs).toHaveLength(5); // a and c rerun; b retains its receipt.
  } finally { await f.host.close(); f.db.close(); }
});

test("failed host evidence blocks descendants; cancellation survives restart", async () => {
  const f = await fixture(false);
  try {
    await f.host.commitRoot(f.host.self("root"), { ...configureExecutionGraph(graph()), at: 1 });
    await f.host.drive();
    const view = executionGraphView(await f.host.read("root"));
    expect(view.complete).toBe(false); expect(view.nodes.c?.status).toBe("pending"); expect(f.runs).toHaveLength(2);
    await f.host.commitRoot(f.host.self("root"), { ...cancelExecutionGraph("build", "stop"), at: 2 });
    await f.host.close(); f.host = await f.open(); await f.host.recover();
    expect(executionGraphView(await f.host.read("root")).cancelled).toBe(true);
    expect(f.runs).toHaveLength(2);
  } finally { await f.host.close(); f.db.close(); }
});

test("stale receipts, model assertions and cancelled appends never settle nodes", () => {
  const configured = configureExecutionGraph(graph());
  const state = executionGraphState([configured]);
  const attempt = executionGraphAttempt(state, "a");
  const returned = { type: "ExecutionGraphReturned", id: attempt, graph: "build", node: "a", attempt };
  const forged = { type: "ExecutionGraphChecked", id: attempt, graph: "build", node: "a", attempt, receipt: { passed: true } };
  expect(executionGraphState([configured, returned, forged]).nodes.a?.status).toBe("returned");
  expect(executionGraphExternalEventAllowed(forged)).toBe(false);
  const invalidated = [configured, returned, invalidateExecutionGraph("build", "a", "retry")];
  expect(executionGraphAppendAllowed([forged], () => invalidated)).toBe(false);
  expect(executionGraphState([...invalidated, forged]).nodes.a?.status).toBe("pending");
  expect(executionGraphAppendAllowed([forged], () => [configured, cancelExecutionGraph("build", "stop")])).toBe(false);
});

test("native host fences cancellation arriving while the independent check awaits I/O", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true, async () => { enter(); await blocked; });
  try {
    await f.host.commitRoot(f.host.self("root"), { ...configureExecutionGraph({ id: "build", version: "1", nodes: [node("a")] }), at: 1 });
    const driving = f.host.drive();
    await entered;
    await f.host.commitRoot(f.host.self("root"), { ...cancelExecutionGraph("build", "racing-stop"), at: 2 });
    release(); await driving;
    const events = await f.host.read("root");
    expect(executionGraphView(events).cancelled).toBe(true);
    expect(events.some(e => e.type === "ExecutionGraphChecked")).toBe(false);
  } finally { release(); await f.host.close(); f.db.close(); }
});
