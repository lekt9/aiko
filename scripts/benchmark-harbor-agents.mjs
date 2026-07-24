#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SUITE = join(ROOT, "benchmarks", "harbor", "terminal-bench", "original-tasks");
const RUN_ROOT = process.env.HARBOR_RUN_ROOT || join(ROOT, "benchmarks", "harbor", "latest");
const JSON_OUT = process.env.HARBOR_JSON_OUT || join(ROOT, "docs", "AIKO-VS-GROK-HARBOR.json");
const MD_OUT = process.env.HARBOR_MD_OUT || join(ROOT, "docs", "AIKO-VS-GROK-HARBOR.md");
const AIKO = process.env.AIKO_BIN || "/Users/lewis/bin/aiko";
const GROK = process.env.GROK_BIN || "/Users/lewis/.local/bin/grok";

const taskIds = (process.env.HARBOR_TASKS || "heterogeneous-dates,regex-log,jsonl-aggregator,log-summary,log-summary-date-ranges,count-call-stack,organization-json-generator").split(",");
const agentCatalog = [
  { id: "aiko", bin: AIKO, model: process.env.AIKO_MODEL || "mimo-v2.5" },
  { id: "grok", bin: GROK, model: process.env.GROK_MODEL || "grok-4.5" },
];
const requestedAgents = new Set((process.env.HARBOR_AGENTS || "aiko,grok").split(","));
const agents = agentCatalog.filter(({ id }) => requestedAgents.has(id));
if (agents.length === 0) throw new Error("HARBOR_AGENTS selected no known agents");

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 900_000,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
  };
}

function instructionFor(taskDir) {
  const yaml = readFileSync(join(taskDir, "task.yaml"), "utf8");
  const match = yaml.match(/^instruction:\s*\|[-+]?\n([\s\S]*?)(?=^[a-zA-Z_]+:)/m);
  if (!match) throw new Error(`Cannot parse instruction from ${taskDir}`);
  return match[1].split("\n").map((line) => line.replace(/^  /, "")).join("\n").trim();
}

function stageTask(taskId, destination) {
  const source = join(SUITE, taskId);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  if (taskId === "heterogeneous-dates") {
    cpSync(join(source, "task-deps", "daily_temp_sf_high.csv"), join(destination, "daily_temp_sf_high.csv"));
    cpSync(join(source, "task-deps", "daily_temp_sf_low.csv"), join(destination, "daily_temp_sf_low.csv"));
  } else if (taskId === "jsonl-aggregator") {
    cpSync(join(source, "task-deps", "generate_records.py"), join(destination, "generate_records.py"));
    const generated = run("python3", ["generate_records.py"], { cwd: destination, timeout: 300_000 });
    if (generated.exitCode !== 0) throw new Error(`Fixture generation failed: ${generated.stderr}`);
    rmSync(join(destination, "generate_records.py"));
  } else if (taskId === "log-summary") {
    cpSync(join(source, "logs"), join(destination, "logs"), { recursive: true });
  } else if (taskId === "log-summary-date-ranges") {
    writeFileSync(
      join(destination, "log_generator_deterministic.py"),
      readFileSync(join(source, "log_generator_deterministic.py"), "utf8").replaceAll("/app", destination),
    );
    const generated = run("python3", ["log_generator_deterministic.py"], { cwd: destination });
    if (generated.exitCode !== 0) throw new Error(`Fixture generation failed: ${generated.stderr}`);
    rmSync(join(destination, "log_generator_deterministic.py"));
  } else if (taskId === "count-call-stack") {
    cpSync(join(source, "log.stack.zip"), join(destination, "log.stack.zip"));
    const extracted = run("unzip", ["-q", "log.stack.zip"], { cwd: destination });
    if (extracted.exitCode !== 0) throw new Error(`Fixture extraction failed: ${extracted.stderr}`);
    rmSync(join(destination, "log.stack.zip"));
  } else if (taskId === "organization-json-generator") {
    mkdirSync(join(destination, "data"), { recursive: true });
    for (const file of ["departments.csv", "employees.csv", "projects.csv"]) {
      cpSync(join(source, file), join(destination, "data", file));
    }
    cpSync(join(source, "schema.json"), join(destination, "schema.json"));
  } else if (taskId !== "regex-log") {
    throw new Error(`No portable staging adapter for ${taskId}`);
  }
  const original = instructionFor(source);
  const adapted = original.replaceAll("/app", destination);
  writeFileSync(join(destination, "HARBOR_TASK.md"), `${adapted}\n`);
  return { original, adapted };
}

function verify(taskId, workspace) {
  const originalTest = join(SUITE, taskId, "tests", "test_outputs.py");
  const verifier = join(workspace, "harbor_test_outputs.py");
  const testSource = join(SUITE, taskId, "tests");
  writeFileSync(verifier, readFileSync(originalTest, "utf8").replaceAll("/app", workspace).replaceAll("/tests", testSource));
  return run("uv", ["run", "--with", "pytest", "--with", "jsonschema", "python", "-m", "pytest", "-q", verifier], { cwd: workspace, timeout: 180_000 });
}

function classify(agentRun) {
  const text = `${agentRun.stdout}\n${agentRun.stderr}`.toLowerCase();
  if (text.includes("not authenticated") || text.includes("login") && text.includes("authenticate")) return "authentication";
  if (text.includes("weekly limit") || text.includes("usage limit") || text.includes("rate limit")) return "quota";
  if (agentRun.error || agentRun.signal) return "runtime";
  return null;
}

mkdirSync(RUN_ROOT, { recursive: true });
mkdirSync(join(ROOT, "docs"), { recursive: true });
const sourceCommit = run("git", ["-C", join(ROOT, "benchmarks", "harbor", "terminal-bench"), "rev-parse", "HEAD"]).stdout.trim();
const versions = Object.fromEntries(agents.map((agent) => [agent.id, run(agent.bin, ["--version"]).stdout.trim()]));
const results = [];

for (const taskId of taskIds) {
  const template = join(RUN_ROOT, `${taskId}-template`);
  const task = stageTask(taskId, template);
  const taskRuns = [];
  for (const agent of agents) {
    const workspace = join(RUN_ROOT, `${taskId}-${agent.id}-workspace`);
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    cpSync(template, workspace, { recursive: true });
    const prompt = task.adapted.replaceAll(template, workspace) + "\n\nWork directly in the current directory. Complete the task and verify your output before finishing.";
    const agentArgs = [
      "--single", prompt,
      "--cwd", workspace,
      "--model", agent.model,
      "--max-turns", process.env.HARBOR_MAX_TURNS || "15",
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--no-memory", "--no-subagents", "--disable-web-search", "--no-plan",
    ];
    const extraRules = agent.id === "aiko" ? process.env.AIKO_RULES : process.env.GROK_RULES;
    if (extraRules) agentArgs.push("--rules", extraRules);
    const agentRun = run(agent.bin, agentArgs, { cwd: workspace });
    taskRuns.push({
      taskId,
      agent: agent.id,
      model: agent.model,
      workspace,
      agent: { id: agent.id, model: agent.model, ...agentRun },
    });
    console.log(`${agent.id.padEnd(5)} ${taskId.padEnd(22)} agent finished`);
  }
  // Materialize verifier code only after both agents have finished, preventing
  // the second harness from discovering the first harness's hidden assertions.
  for (const taskRun of taskRuns) {
    const infrastructureFailure = classify(taskRun.agent);
    const verifier = verify(taskId, taskRun.workspace);
    const row = {
      ...taskRun,
      passed: verifier.exitCode === 0,
      infrastructureFailure,
      verifier: { exitCode: verifier.exitCode, durationMs: verifier.durationMs, stdout: verifier.stdout, stderr: verifier.stderr },
    };
    results.push(row);
    console.log(`${taskRun.agent.id.padEnd(5)} ${taskId.padEnd(22)} ${row.passed ? "PASS" : "FAIL"}${infrastructureFailure ? ` (${infrastructureFailure})` : ""}`);
  }
}

const scored = results.filter((r) => !r.infrastructureFailure);
const summary = Object.fromEntries(agents.map(({ id }) => {
  const rows = scored.filter((r) => r.agent.id === id);
  return [id, { eligible: rows.length, passed: rows.filter((r) => r.passed).length, passRate: rows.length ? rows.filter((r) => r.passed).length / rows.length : null }];
}));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  methodology: "host-executed-harbor-task-verifier-compatibility",
  officialHarborRun: false,
  source: { repository: "https://github.com/harbor-framework/terminal-bench", commit: sourceCommit },
  adaptation: "Original task instructions and pytest assertions; /app rewritten to an isolated absolute macOS workspace. Fixtures reproduced from each task Dockerfile.",
  versions,
  summary,
  results,
};
writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + "\n");

const rows = results.map((r) => `| ${r.taskId} | ${r.agent.id} | ${r.model} | ${r.passed ? "PASS" : "FAIL"} | ${r.infrastructureFailure || "—"} | ${(r.agent.durationMs / 1000).toFixed(1)}s |`).join("\n");
const scoreLines = agents.map(({ id }) => {
  const s = summary[id];
  return `- ${id}: ${s.eligible ? `${s.passed}/${s.eligible} (${(s.passRate * 100).toFixed(0)}%)` : "not scoreable"}`;
}).join("\n");
const modelPins = agents.map(({ id, model }) => `${id} is pinned to \`${model}\``).join("; ");
writeFileSync(MD_OUT, `# Harbor task benchmark\n\nGenerated: ${report.generatedAt}\n\n## Outcome\n\n${scoreLines}\n\n| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |\n|---|---|---|---|---|---|\n${rows}\n\n## Methodology\n\nThis is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit \`${sourceCommit}\`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path \`/app\` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after every selected harness finishes a task, preventing cross-run leakage.\n\n${modelPins}. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication, quota, and runtime failures are reported separately and excluded from pass-rate denominators.\n\n## Reproduce\n\n\`node scripts/benchmark-harbor-agents.mjs\`\n\nMachine-readable evidence: [${basename(JSON_OUT)}](./${basename(JSON_OUT)}).\n`);

console.log(`\nWrote ${basename(MD_OUT)} and ${basename(JSON_OUT)}`);
