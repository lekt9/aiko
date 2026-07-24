#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const AIKO = process.env.AIKO_BIN || "/Users/lewis/bin/aiko";
const GROK = process.env.GROK_BIN || "/Users/lewis/.local/bin/grok";
const RUN_ROOT = process.env.TASK_BENCH_RUN_ROOT || join(ROOT, "benchmarks", "task-benchmark", "latest");
const JSON_OUT = process.env.TASK_BENCH_JSON_OUT || join(ROOT, "docs", "AIKO-VS-GROK-TASK-BENCHMARK.json");
const MD_OUT = process.env.TASK_BENCH_MD_OUT || join(ROOT, "docs", "AIKO-VS-GROK-TASK-BENCHMARK.md");

const tasks = [
  {
    id: "retry-policy",
    title: "Repair an asynchronous retry primitive",
    prompt: "Implement the missing behavior in src/retry.mjs. Preserve the documented API, use no dependencies, and run npm test. Work directly in this repository and finish only after the tests pass.",
    source: `export async function retry(operation, options = {}) {
  // TODO: implement the contract documented in README.md
  return operation();
}
`,
    readme: `# Retry policy task

Implement \`retry(operation, options)\` in \`src/retry.mjs\`.

- \`attempts\` is the maximum total calls and defaults to 3; reject non-positive integers.
- Retry only when \`shouldRetry(error, attempt)\` returns true; it defaults to true.
- Before each retry, await \`delay(attempt, error)\`; it defaults to no delay.
- Attempts passed to callbacks are one-based and describe the call that just failed.
- Return immediately on success and throw the final original error when exhausted.
`,
    publicTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { retry } from './src/retry.mjs';

test('retries once then returns', async () => {
  let calls = 0;
  const value = await retry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('again');
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(calls, 2);
});
`,
    hiddenTest: `import assert from 'node:assert/strict';
import { retry } from './src/retry.mjs';
const seen = [];
let calls = 0;
const terminal = new Error('terminal');
await assert.rejects(() => retry(async () => { calls++; throw terminal; }, {
  attempts: 2,
  shouldRetry(error, attempt) { seen.push(['should', error.message, attempt]); return true; },
  async delay(attempt, error) { seen.push(['delay', error.message, attempt]); }
}), error => error === terminal);
assert.equal(calls, 2);
assert.deepEqual(seen, [['should','terminal',1],['delay','terminal',1]]);
let stopped = 0;
await assert.rejects(() => retry(async () => { stopped++; throw new Error('stop'); }, { attempts: 4, shouldRetry: () => false }), /stop/);
assert.equal(stopped, 1);
for (const attempts of [0, -1, 1.5]) await assert.rejects(() => retry(async () => 1, { attempts }), /attempt/i);
`,
  },
  {
    id: "route-ranking",
    title: "Implement deterministic route ranking",
    prompt: "Complete rankRoutes in src/ranker.mjs according to README.md. Keep it deterministic and non-mutating, use no dependencies, and run npm test before finishing.",
    source: `export function rankRoutes(routes, context = {}) {
  return routes;
}
`,
    readme: `# Route ranking task

Implement \`rankRoutes(routes, context)\`.

Each route has \`id\`, \`tags\`, \`successRate\`, \`latencyMs\`, and \`cost\`. Context has optional \`tags\` and \`maxCost\`.

- Exclude routes whose cost exceeds maxCost (default Infinity).
- Score = tag overlap * 4 + successRate * 3 - log1p(latencyMs) / 5 - cost.
- Missing arrays/numbers behave as empty/zero, except missing latency is 1000.
- Return new objects with an added numeric \`score\`, ordered descending.
- Break equal scores by lexicographic id. Never mutate routes or context.
`,
    publicTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { rankRoutes } from './src/ranker.mjs';
test('filters and ranks routes', () => {
  const routes = [
    { id: 'slow', tags: ['mail'], successRate: 1, latencyMs: 900, cost: 1 },
    { id: 'fast', tags: ['mail'], successRate: .9, latencyMs: 20, cost: 1 },
    { id: 'pricey', tags: ['mail'], successRate: 1, latencyMs: 1, cost: 9 },
  ];
  assert.deepEqual(rankRoutes(routes, { tags: ['mail'], maxCost: 2 }).map(x => x.id), ['fast', 'slow']);
  assert.equal('score' in routes[0], false);
});
`,
    hiddenTest: `import assert from 'node:assert/strict';
import { rankRoutes } from './src/ranker.mjs';
const routes = [
 {id:'b', tags:['x'], successRate:0, latencyMs:0, cost:0},
 {id:'a', tags:['x'], successRate:0, latencyMs:0, cost:0},
 {id:'missing'},
];
const context = {tags:['x']};
const snapshot = JSON.stringify({routes,context});
const ranked = rankRoutes(routes, context);
assert.deepEqual(ranked.map(x=>x.id), ['a','b','missing']);
assert.ok(ranked.every(x => Number.isFinite(x.score)));
assert.equal(JSON.stringify({routes,context}), snapshot);
assert.deepEqual(rankRoutes([{id:'z',cost:2},{id:'y',cost:1}], {maxCost:1}).map(x=>x.id), ['y']);
`,
  },
  {
    id: "secret-redaction",
    title: "Harden recursive secret redaction",
    prompt: "Fix redactSecrets in src/redact.mjs to satisfy the documented security and data-shape contract. Do not add dependencies. Run npm test and inspect edge cases before finishing.",
    source: `const SECRET_KEY = /token|secret|password|api[-_]?key/i;

export function redactSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  const output = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : child;
  }
  return output;
}
`,
    readme: `# Secret redaction task

Implement \`redactSecrets(value)\` as a non-mutating deep transform.

- Redact values whose key contains token, secret, password, api_key, api-key, or apikey (case-insensitive).
- Traverse nested plain objects and arrays.
- Preserve Date instances and primitive values.
- Preserve shared references in the output and support cycles without throwing.
- Do not invoke getters; copy enumerable data properties only. Accessor properties must be omitted.
`,
    publicTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './src/redact.mjs';
test('deeply redacts without mutation', () => {
 const input = { user: { apiKey: 'abc', name: 'A' }, values: [{ password: 'p' }] };
 const output = redactSecrets(input);
 assert.equal(output.user.apiKey, '[REDACTED]');
 assert.equal(output.values[0].password, '[REDACTED]');
 assert.equal(input.user.apiKey, 'abc');
});
`,
    hiddenTest: `import assert from 'node:assert/strict';
import { redactSecrets } from './src/redact.mjs';
let invoked = 0;
const shared = {token:'x', ok:1};
const input = {a:shared,b:shared,date:new Date('2020-01-01T00:00:00Z')};
input.self = input;
Object.defineProperty(input, 'danger', {enumerable:true, get(){ invoked++; return 'no'; }});
const out = redactSecrets(input);
assert.equal(invoked, 0);
assert.equal('danger' in out, false);
assert.equal(out.a, out.b);
assert.equal(out.a.token, '[REDACTED]');
assert.equal(out.self, out);
assert.ok(out.date instanceof Date);
assert.equal(out.date.toISOString(), input.date.toISOString());
`,
  },
];

function command(binary, args, options = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(binary, args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    timeout: options.timeout || 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    signal: result.signal,
    elapsedMs: Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(2)),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function prepare(task, harness) {
  const dir = join(RUN_ROOT, task.id, harness);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test.mjs" } }, null, 2));
  writeFileSync(join(dir, "README.md"), task.readme);
  writeFileSync(join(dir, "src", task.id === "retry-policy" ? "retry.mjs" : task.id === "route-ranking" ? "ranker.mjs" : "redact.mjs"), task.source);
  writeFileSync(join(dir, "test.mjs"), task.publicTest);
  command("git", ["init", "-q"], { cwd: dir });
  command("git", ["add", "."], { cwd: dir });
  command("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@local", "commit", "-qm", "baseline"], { cwd: dir });
  return dir;
}

function evaluate(task, dir) {
  const publicResult = command("npm", ["test", "--silent"], { cwd: dir, timeout: 60_000 });
  const hiddenPath = join(dir, ".hidden-eval.mjs");
  writeFileSync(hiddenPath, task.hiddenTest);
  const hiddenResult = command("node", [hiddenPath], { cwd: dir, timeout: 60_000 });
  rmSync(hiddenPath, { force: true });
  const diff = command("git", ["diff", "--", "src", "test.mjs", "README.md"], { cwd: dir });
  return {
    publicPassed: publicResult.status === 0,
    hiddenPassed: hiddenResult.status === 0,
    passed: publicResult.status === 0 && hiddenResult.status === 0,
    publicExit: publicResult.status,
    hiddenExit: hiddenResult.status,
    hiddenError: hiddenResult.status === 0 ? "" : hiddenResult.stderr.slice(-4000),
    patch: diff.stdout,
    patchBytes: Buffer.byteLength(diff.stdout),
  };
}

function runTrial(task, harness) {
  const binary = harness === "aiko" ? AIKO : GROK;
  const model = harness === "aiko" ? "mimo-v2.5" : "grok-4.5";
  const dir = prepare(task, harness);
  const agent = command(binary, [
    "--single", task.prompt,
    "--cwd", dir,
    "--model", model,
    "--max-turns", "12",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--no-plan",
  ], { cwd: dir });
  const evaluation = evaluate(task, dir);
  let stopReason = null;
  let responseText = "";
  try {
    const parsed = JSON.parse(agent.stdout);
    stopReason = parsed.stopReason || null;
    responseText = parsed.text || "";
  } catch {}
  return {
    task: task.id,
    harness,
    model,
    agentExit: agent.status,
    signal: agent.signal,
    elapsedMs: agent.elapsedMs,
    stopReason,
    responseBytes: Buffer.byteLength(responseText),
    ...evaluation,
  };
}

function verify(jsonPath, markdownPath) {
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  const markdown = readFileSync(markdownPath, "utf8");
  if (data.schemaVersion !== 1 || data.trials.length !== 6) process.exit(1);
  for (const task of tasks) {
    for (const harness of ["aiko", "grok"]) {
      if (!data.trials.some((trial) => trial.task === task.id && trial.harness === harness && typeof trial.hiddenPassed === "boolean")) process.exit(1);
    }
  }
  if (!markdown.includes("Hidden evaluator") || !markdown.includes("Fairness boundary")) process.exit(1);
  process.exit(0);
}

if (process.argv[2] === "--verify") verify(process.argv[3], process.argv[4]);

rmSync(RUN_ROOT, { recursive: true, force: true });
mkdirSync(RUN_ROOT, { recursive: true });
const order = [
  [tasks[0], "aiko"], [tasks[0], "grok"],
  [tasks[1], "grok"], [tasks[1], "aiko"],
  [tasks[2], "aiko"], [tasks[2], "grok"],
];
const trials = [];
for (const [task, harness] of order) {
  console.error(`running ${task.id} with ${harness}...`);
  trials.push(runTrial(task, harness));
}
const summary = Object.fromEntries(["aiko", "grok"].map((harness) => {
  const selected = trials.filter((trial) => trial.harness === harness);
  return [harness, {
    passed: selected.filter((trial) => trial.passed).length,
    total: selected.length,
    totalElapsedMs: Number(selected.reduce((sum, trial) => sum + trial.elapsedMs, 0).toFixed(2)),
    medianElapsedMs: [...selected].sort((a, b) => a.elapsedMs - b.elapsedMs)[1].elapsedMs,
  }];
}));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  fairness: "Different accessible models: Aiko mimo-v2.5 versus Grok grok-4.5; one trial per task; alternating execution order.",
  tasks: tasks.map(({ id, title }) => ({ id, title })),
  trials,
  summary,
};
writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

const rows = trials.map((trial) => `| ${trial.task} | ${trial.harness} | ${trial.model} | ${trial.publicPassed} | ${trial.hiddenPassed} | ${(trial.elapsedMs / 1000).toFixed(2)} | ${trial.stopReason || "—"} |`).join("\n");
const md = `# Aiko versus Grok: actual task benchmark

Generated: \`${report.generatedAt}\`

## Fairness boundary

Each harness received an identical fresh Git repository, prompt, public tests, 12-turn limit, disabled memory/subagents/web search, and permission to edit and run local commands. Execution order alternated by task. Aiko used \`mimo-v2.5\`; Grok used \`grok-4.5\` because the installed products have no shared accessible model. With one trial per task, this is an end-to-end product comparison, not a statistically stable model leaderboard.

## Results

| Task | Harness | Model | Public tests | Hidden evaluator | Seconds | Stop reason |
|---|---|---|---|---|---:|---|
${rows}

| Harness | Tasks passed | Total agent seconds | Median task seconds |
|---|---:|---:|---:|
| Aiko | ${summary.aiko.passed}/${summary.aiko.total} | ${(summary.aiko.totalElapsedMs / 1000).toFixed(2)} | ${(summary.aiko.medianElapsedMs / 1000).toFixed(2)} |
| Grok | ${summary.grok.passed}/${summary.grok.total} | ${(summary.grok.totalElapsedMs / 1000).toFixed(2)} | ${(summary.grok.medianElapsedMs / 1000).toFixed(2)} |

## Interpretation

Task correctness is determined only by the public and hidden evaluators. Grok used ${(100 * (1 - summary.grok.totalElapsedMs / summary.aiko.totalElapsedMs)).toFixed(1)}% less total agent time and had a ${(100 * (1 - summary.grok.medianElapsedMs / summary.aiko.medianElapsedMs)).toFixed(1)}% lower median task time in this run. Non-zero agent exits are retained even when the resulting patch passes, because clean lifecycle completion is part of harness reliability.

## Tasks

1. Repair an asynchronous retry primitive with callback ordering, attempt limits, and error identity requirements.
2. Implement deterministic route ranking with filtering, scoring, tie-breaking, missing-data behavior, and immutability.
3. Harden recursive secret redaction for cycles, shared references, Dates, accessors, arrays, and non-mutation.

The raw JSON preserves each patch, evaluator status, agent exit status, response size, and timing. Hidden evaluator source was added only after the agent finished and removed after evaluation.
`;
writeFileSync(MD_OUT, md);
console.log(JSON.stringify({ summary, json: JSON_OUT, markdown: MD_OUT }, null, 2));
