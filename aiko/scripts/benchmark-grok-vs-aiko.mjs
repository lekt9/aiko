#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { statSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, loadavg } from "node:os";

const AIKO = process.env.AIKO_BIN || "/Users/lewis/bin/aiko";
const GROK = process.env.GROK_BIN || "/Users/lewis/.local/bin/grok";
const JSON_OUT = "docs/GROK-VS-AIKO-BENCHMARK.json";
const MD_OUT = "docs/GROK-VS-AIKO-BENCHMARK.md";
const RUNS = Number(process.env.BENCH_RUNS || 15);

function run(binary, args, timeout = 30_000) {
  const start = process.hrtime.bigint();
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    elapsedMs,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function summarize(samples) {
  const times = samples.map((sample) => sample.elapsedMs);
  return {
    runs: samples.length,
    success: samples.filter((sample) => sample.status === 0).length,
    medianMs: Number(percentile(times, 0.5).toFixed(2)),
    p95Ms: Number(percentile(times, 0.95).toFixed(2)),
    minMs: Number(Math.min(...times).toFixed(2)),
    maxMs: Number(Math.max(...times).toFixed(2)),
  };
}

/// Paired, interleaved sampling.
///
/// A block design (all of Aiko's reps, then all of Grok's) measures the two arms
/// at different wall-clock moments, so any drift in machine load lands entirely
/// on one of them. On a busy host that dwarfs the effect being measured and can
/// invert the result. Interleaving puts both arms under the same instantaneous
/// load; the pairwise differences then cancel the shared load term.
function benchmarkPaired(args) {
  run(AIKO, args); // warm-ups, excluded
  run(GROK, args);
  const aiko = [];
  const grok = [];
  for (let index = 0; index < RUNS; index += 1) {
    // Alternate who moves first so neither arm systematically owns the
    // colder slot inside a pair.
    if (index % 2 === 0) {
      aiko.push(run(AIKO, args));
      grok.push(run(GROK, args));
    } else {
      grok.push(run(GROK, args));
      aiko.push(run(AIKO, args));
    }
  }
  return { aiko: summarize(aiko), grok: summarize(grok), paired: pairedStats(aiko, grok) };
}

/// Per-rep differences, which is the only comparison that survives a loaded box.
/// `aikoSlowerReps` near half of `reps` means the two are indistinguishable no
/// matter what the medians say.
function pairedStats(aikoSamples, grokSamples) {
  const deltas = aikoSamples.map((sample, index) => sample.elapsedMs - grokSamples[index].elapsedMs);
  const aikoSlowerReps = deltas.filter((delta) => delta > 0).length;
  return {
    reps: deltas.length,
    medianDeltaMs: Number(percentile(deltas, 0.5).toFixed(2)),
    aikoSlowerReps,
    // A near-even split is noise, not a finding. Only call a winner when one
    // arm wins the clear majority of paired reps.
    resolvable: aikoSlowerReps <= deltas.length * 0.25 || aikoSlowerReps >= deltas.length * 0.75,
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function identity(binary) {
  const version = run(binary, ["--version"]);
  const help = run(binary, ["--help"]);
  const models = run(binary, ["models"]);
  const commandBlock = help.stdout.split("Commands:")[1] || "";
  const commands = commandBlock
    .split("\n")
    .map((line) => line.match(/^  ([a-z][a-z-]*)\s/)?.[1])
    .filter(Boolean);
  return {
    binary,
    version: version.stdout.trim(),
    sha256: sha256(binary),
    bytes: statSync(binary).size,
    commands,
    modelInventory: models.stdout.trim(),
    authenticated: !/not authenticated/i.test(`${models.stdout}\n${models.stderr}`),
  };
}

function liveReadiness(binary, model, marker) {
  const result = run(
    binary,
    [
      "--single",
      `Reply with exactly: ${marker}`,
      "--max-turns",
      "1",
      "--output-format",
      "json",
      "--model",
      model,
      "--no-memory",
      "--no-subagents",
      "--disable-web-search",
    ],
    120_000,
  );
  let exact = false;
  try {
    const parsed = JSON.parse(result.stdout);
    exact = parsed.text === marker && parsed.stopReason === "EndTurn";
  } catch {}
  return {
    model,
    elapsedMs: Number(result.elapsedMs.toFixed(2)),
    exitStatus: result.status,
    exactResponse: exact,
    classification:
      result.status === 0 && exact
        ? "ready"
        : /not authenticated|login/i.test(`${result.stdout}\n${result.stderr}`)
          ? "blocked-authentication"
          : "failed",
  };
}

function verify(jsonPath, markdownPath) {
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  const markdown = readFileSync(markdownPath, "utf8");
  const cases = ["version", "help", "inspect", "completions", "sessions"];
  if (data.schemaVersion !== 1 || !data.aiko?.version || !data.grok?.version) process.exit(1);
  for (const name of cases) {
    const local = data.local[name];
    if (local.aiko.runs < 5 || local.grok.runs < 5) process.exit(1);
    // Paired stats must exist and cover every rep: without them the report has
    // no defence against comparing two arms measured under different load.
    if (!local.paired || local.paired.reps !== local.aiko.runs) process.exit(1);
    if (typeof local.paired.medianDeltaMs !== "number") process.exit(1);
  }
  if (!data.liveReadiness?.aiko || !data.liveReadiness?.grok) process.exit(1);
  if (!data.host || typeof data.host.cores !== "number") process.exit(1);
  if (!/Interleaved and paired/.test(data.methodology?.localOrder || "")) process.exit(1);
  if (!markdown.includes("Fairness boundary") || !markdown.includes("Local harness latency")) process.exit(1);
  // The old report hardcoded a conclusion ("effectively tied") that its own
  // table could contradict. Guard against that sentence ever returning.
  if (markdown.includes("effectively tied")) process.exit(1);
  if (!markdown.includes("Paired verdict")) process.exit(1);
  process.exit(0);
}

if (process.argv[2] === "--verify") verify(process.argv[3], process.argv[4]);

const cases = {
  version: ["--version"],
  help: ["--help"],
  inspect: ["inspect", "--json"],
  completions: ["completions", "zsh"],
  sessions: ["sessions", "list", "--limit", "2"],
};

const loadBefore = loadavg()[0];
const local = Object.fromEntries(
  Object.entries(cases).map(([name, args]) => [name, benchmarkPaired(args)]),
);
const loadAfter = loadavg()[0];
// Latency numbers taken while the host is oversubscribed are not comparable to
// numbers taken on an idle one. Record it so a reader can never mistake a busy
// box for a product regression.
const host = {
  cores: cpus().length,
  load1Before: Number(loadBefore.toFixed(2)),
  load1After: Number(loadAfter.toFixed(2)),
  saturated: Math.max(loadBefore, loadAfter) > cpus().length,
};
const marker = `harness-benchmark-${Date.now()}`;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  methodology: {
    runsPerLocalCase: RUNS,
    warmupsPerLocalCase: 1,
    localOrder:
      "Interleaved and paired per case, alternating which binary runs first; each command is a fresh process",
    liveTrials: 1,
  },
  host,
  aiko: identity(AIKO),
  grok: identity(GROK),
  local,
  liveReadiness: {
    aiko: liveReadiness(AIKO, "mimo-v2.5", marker),
    grok: liveReadiness(GROK, "grok-4.5", marker),
  },
};

writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

const rows = Object.entries(local)
  .map(([name, value]) => {
    const ratio = value.grok.medianMs / value.aiko.medianMs;
    const { medianDeltaMs, aikoSlowerReps, reps, resolvable } = value.paired;
    const verdict = !resolvable
      ? "tie (noise)"
      : medianDeltaMs > 0
        ? "Grok faster"
        : "Aiko faster";
    return `| ${name} | ${value.aiko.medianMs.toFixed(2)} | ${value.grok.medianMs.toFixed(2)} | ${ratio.toFixed(2)}× | ${medianDeltaMs > 0 ? "+" : ""}${medianDeltaMs.toFixed(2)} | ${aikoSlowerReps}/${reps} | ${verdict} |`;
  })
  .join("\n");

/// Describe only what the paired data actually supports. Cases that do not clear
/// the paired-majority bar are reported as ties rather than narrated as wins —
/// a hardcoded conclusion here is how a report ends up contradicting its own table.
const resolved = Object.entries(local).filter(([, value]) => value.paired.resolvable);
const unresolved = Object.entries(local).filter(([, value]) => !value.paired.resolvable);
const describe = ([name, value]) => {
  const faster = value.paired.medianDeltaMs > 0 ? "Grok" : "Aiko";
  const slow = Math.max(value.aiko.medianMs, value.grok.medianMs);
  const fast = Math.min(value.aiko.medianMs, value.grok.medianMs);
  return `\`${name}\` (${faster} faster by ${(100 * (1 - fast / slow)).toFixed(1)}%, winning ${
    faster === "Aiko" ? value.paired.reps - value.paired.aikoSlowerReps : value.paired.aikoSlowerReps
  }/${value.paired.reps} paired reps)`;
};
const interpretation = [
  resolved.length
    ? `Differences the paired data supports: ${resolved.map(describe).join("; ")}.`
    : "No local latency difference cleared the paired-majority bar in this run.",
  unresolved.length
    ? `Indistinguishable under load (near-even paired split, reported as ties): ${unresolved
        .map(([name]) => `\`${name}\``)
        .join(", ")}.`
    : "",
  host.saturated
    ? `**This host was oversubscribed during the run** (${host.cores} cores, 1-minute load ${host.load1Before}→${host.load1After}). Absolute milliseconds are inflated for both harnesses and must not be compared against numbers from an idle machine; only the paired columns are meaningful here.`
    : `Host load stayed under core count during the run (${host.cores} cores, 1-minute load ${host.load1Before}→${host.load1After}).`,
  "Local command latency measures CLI startup and command plumbing, not model quality.",
  `Live readiness: Aiko ${report.liveReadiness.aiko.classification}, Grok ${report.liveReadiness.grok.classification}. A fair model-quality benchmark still requires a backend/model combination accessible to both harnesses and multiple randomized task trials.`,
]
  .filter(Boolean)
  .join(" ");
const md = `# Grok versus Aiko benchmark

Generated: \`${report.generatedAt}\`

## Fairness boundary

This compares the two installed CLI harnesses, not the intelligence of two models. Both were authenticated during the measured run, but their accessible model catalogs do not overlap: Aiko was explicitly pinned to \`mimo-v2.5\` and Grok to its only advertised model, \`grok-4.5\`. The live figures are therefore readiness observations, not a model-quality or apples-to-apples latency race. No credentials or login state were copied.

## Builds

| Harness | Version | Binary size | Authenticated | Commands |
|---|---|---:|---|---:|
| Aiko | ${report.aiko.version} | ${(report.aiko.bytes / 1024 / 1024).toFixed(1)} MiB | ${report.aiko.authenticated} | ${report.aiko.commands.length} |
| Grok | ${report.grok.version} | ${(report.grok.bytes / 1024 / 1024).toFixed(1)} MiB | ${report.grok.authenticated} | ${report.grok.commands.length} |

Aiko adds the \`background\`, \`native\`, and \`tasks\` command surfaces for its Contract runtime. Its installed binary is ${((report.aiko.bytes / report.grok.bytes - 1) * 100).toFixed(1)}% larger.

## Local harness latency

Each cell is a fresh process. One warm-up was discarded, followed by ${RUNS} measured runs **interleaved and paired** between the two harnesses, alternating which one runs first. Lower is better.

Read the paired columns, not the medians: \`Δ median\` is the median of per-rep differences (positive = Aiko slower), and \`Aiko slower\` counts the paired reps Aiko lost. A near-even split means the two are indistinguishable regardless of the medians.

Host: ${host.cores} cores, 1-minute load ${host.load1Before}→${host.load1After}${host.saturated ? " — **oversubscribed, absolute times inflated**" : ""}.

| Command | Aiko median ms | Grok median ms | Grok/Aiko | Δ median ms | Aiko slower | Paired verdict |
|---|---:|---:|---:|---:|---:|---|
${rows}

## Live readiness

| Harness | Model | Result | Exact response | Elapsed ms |
|---|---|---|---|---:|
| Aiko | ${report.liveReadiness.aiko.model} | ${report.liveReadiness.aiko.classification} | ${report.liveReadiness.aiko.exactResponse} | ${report.liveReadiness.aiko.elapsedMs.toFixed(2)} |
| Grok | ${report.liveReadiness.grok.model} | ${report.liveReadiness.grok.classification} | ${report.liveReadiness.grok.exactResponse} | ${report.liveReadiness.grok.elapsedMs.toFixed(2)} |

## Interpretation

${interpretation}
`;
writeFileSync(MD_OUT, md);
console.log(JSON.stringify({ json: JSON_OUT, markdown: MD_OUT, report }, null, 2));
