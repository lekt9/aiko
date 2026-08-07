// graph-plan-ffi-check.ts — prove the frontend graph bindings against the
// REAL signed dylib, not a mock. Part 1: same six-node fixture as the C ABI
// boundary test in contract/libcontract/src/c_abi.zig, asserted field by
// field. Part 2: a full expandGraph → executeNeuronWaves round trip with stub
// workers (AIKO_BIN=/bin/echo — no model invoked). Hermetic: the process
// chdirs into a scratch dir carrying its own .claude/ so ledger rows land
// there (ledger.zig resolvePath prefers <cwd>/.claude/contracts.jsonl), never
// in the operator's ledger. Run under bun: `bun scripts/graph-plan-ffi-check.ts`.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as native from "../src/contract/native";
import { executeNeuronWaves, partitionWaveByCollisions, planNeuronWaves } from "../src/contract/neurons";

const scratch = mkdtempSync(join(tmpdir(), "graph-plan-ffi-"));
mkdirSync(join(scratch, ".claude"), { recursive: true });
process.chdir(scratch);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!native.isNative()) {
  const status = native.ffiMirrorStatus();
  fail(`libcontract not loaded: ${status.reason ?? "unknown"}`);
}

const verdict = native.graphPlan([
  { id: "a", plan: "root", depends_on: [], status: "pending", writes: ["src/"] },
  { id: "b", plan: "left", depends_on: ["a"], status: "pending", writes: ["src/ui.ts"] },
  { id: "c", plan: "right", depends_on: ["a"], status: "pending", writes: ["docs/"] },
  { id: "d", plan: "fanout-a", depends_on: ["c"], status: "pending" },
  { id: "e", plan: "fanout-b", depends_on: ["c"], status: "pending" },
  { id: "f", plan: "fanout-c", depends_on: ["c"], status: "pending" },
]);

if (!verdict) fail("graphPlan returned null over a live dylib");
// One ready root — a single frontier node is a chain regardless of later fan-out
// (graph_plan.zig: graph requires >1 independent group AND >1 ready node).
if (verdict.kind !== "chain") fail(`kind=${verdict.kind}, expected chain`);
if (JSON.stringify(verdict.waves) !== JSON.stringify([["a"], ["b", "c"], ["d", "e", "f"]])) {
  fail(`waves=${JSON.stringify(verdict.waves)}`);
}
if (verdict.cycles.length !== 0) fail(`cycles=${JSON.stringify(verdict.cycles)}`);
if (verdict.total_agents !== 6) fail(`total_agents=${verdict.total_agents}`);
if (
  JSON.stringify(verdict.write_collisions) !==
  JSON.stringify([{ a: "a", b: "b", shared: ["src/ <-> src/ui.ts"] }])
) {
  fail(`write_collisions=${JSON.stringify(verdict.write_collisions)}`);
}
const tiers = new Map(verdict.model_tiers.map((t) => [t.id, t.tier]));
if (tiers.get("c") !== "judgement") fail(`tier(c)=${tiers.get("c")}`);
if (tiers.get("a") !== "mechanical") fail(`tier(a)=${tiers.get("a")}`);

// The executor helper must serialize the pair the substrate named.
const batches = partitionWaveByCollisions(["a", "b"], verdict.write_collisions);
if (JSON.stringify(batches) !== JSON.stringify([["a"], ["b"]])) {
  fail(`partition=${JSON.stringify(batches)}`);
}

// Two independent ready roots ARE a graph.
const independent = native.graphPlan([
  { id: "x", plan: "left", depends_on: [], status: "pending" },
  { id: "y", plan: "right", depends_on: [], status: "pending" },
]);
if (!independent) fail("graphPlan returned null for independent roots");
if (independent.kind !== "graph") fail(`independent kind=${independent.kind}, expected graph`);
if (independent.peak_parallelism < 2) fail(`peak_parallelism=${independent.peak_parallelism}`);

// Part 2 — the runtime path the telegram bridge takes: expand a typed-neuron
// DAG in the substrate, then execute it wave by wave with the collision
// partition engaged. Two children declare overlapping write scopes; the run
// must still ground (they execute serialized, not abreast).
const children: native.ContractGraphChild[] = [
  { key: "w1", plan: "smoke: writer one", writes: ["out/report.md"], evidence: ["result"] },
  { key: "w2", plan: "smoke: writer two", writes: ["out/"], evidence: ["result"] },
  { key: "reader", plan: "smoke: reader", writes: [], reads: ["out/"], evidence: ["result"], effect_scope: "read_only", read_only: true, reversible: false },
];
const expansion = native.expandGraph({
  plan: "smoke: graph-frontier frontend round trip",
  action: "smoke",
  agent: "graph-plan-ffi-check",
  cwd: scratch,
  children,
});
if (!expansion) fail("expandGraph returned null — typed-neuron child contract not satisfied");
if (expansion.children.length !== 3) fail(`expanded ${expansion.children.length} children`);
if (expansion.waves.length !== 1 || expansion.waves[0].length !== 3) {
  fail(`waves=${JSON.stringify(expansion.waves)}, expected one wave of three`);
}

const runtimeVerdict = planNeuronWaves(expansion, children);
if (!runtimeVerdict) fail("planNeuronWaves returned null over a live expansion");
if (runtimeVerdict.write_collisions.length !== 1) {
  fail(`runtime write_collisions=${JSON.stringify(runtimeVerdict.write_collisions)}`);
}
const runtimeBatches = partitionWaveByCollisions(expansion.waves[0], runtimeVerdict.write_collisions);
if (runtimeBatches.length !== 2) fail(`runtime partition=${JSON.stringify(runtimeBatches)}`);

const grounded = await executeNeuronWaves(expansion, children, {
  cwd: scratch,
  timeoutMs: 30_000,
  env: { AIKO_BIN: "/bin/echo" },
});
if (!grounded) fail("executeNeuronWaves did not ground with stub workers");

console.log("graph-plan FFI: PASS (analysis + typed-neuron round trip)");
