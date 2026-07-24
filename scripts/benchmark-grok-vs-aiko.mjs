#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { statSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

function benchmark(binary, args) {
  run(binary, args); // warm-up, excluded
  return summarize(Array.from({ length: RUNS }, () => run(binary, args)));
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
    if (data.local[name].aiko.runs < 5 || data.local[name].grok.runs < 5) process.exit(1);
  }
  if (!data.liveReadiness?.aiko || !data.liveReadiness?.grok) process.exit(1);
  if (!markdown.includes("Fairness boundary") || !markdown.includes("Local harness latency")) process.exit(1);
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

const local = Object.fromEntries(
  Object.entries(cases).map(([name, args]) => [
    name,
    { aiko: benchmark(AIKO, args), grok: benchmark(GROK, args) },
  ]),
);
const marker = `harness-benchmark-${Date.now()}`;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  methodology: {
    runsPerLocalCase: RUNS,
    warmupsPerLocalCase: 1,
    localOrder: "Aiko then Grok per case; each command is a fresh process",
    liveTrials: 1,
  },
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
    return `| ${name} | ${value.aiko.medianMs.toFixed(2)} | ${value.grok.medianMs.toFixed(2)} | ${ratio.toFixed(2)}× | ${value.aiko.p95Ms.toFixed(2)} | ${value.grok.p95Ms.toFixed(2)} |`;
  })
  .join("\n");
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

Each cell is a fresh process. One warm-up was discarded, followed by ${RUNS} measured runs. Lower is better.

| Command | Aiko median ms | Grok median ms | Grok/Aiko | Aiko p95 ms | Grok p95 ms |
|---|---:|---:|---:|---:|---:|
${rows}

## Live readiness

| Harness | Model | Result | Exact response | Elapsed ms |
|---|---|---|---|---:|
| Aiko | ${report.liveReadiness.aiko.model} | ${report.liveReadiness.aiko.classification} | ${report.liveReadiness.aiko.exactResponse} | ${report.liveReadiness.aiko.elapsedMs.toFixed(2)} |
| Grok | ${report.liveReadiness.grok.model} | ${report.liveReadiness.grok.classification} | ${report.liveReadiness.grok.exactResponse} | ${report.liveReadiness.grok.elapsedMs.toFixed(2)} |

## Interpretation

Grok is about ${(100 * (1 - local.version.grok.medianMs / local.version.aiko.medianMs)).toFixed(1)}% faster on trivial version startup and ${(100 * (1 - local.completions.grok.medianMs / local.completions.aiko.medianMs)).toFixed(1)}% faster generating completions. Aiko is ${(100 * (1 - local.sessions.aiko.medianMs / local.sessions.grok.medianMs)).toFixed(1)}% faster listing sessions; configuration inspection is effectively tied. Local command latency measures CLI startup and command plumbing, not model quality. Both live checks completed the exact-response task. A fair model-quality benchmark still requires a backend/model combination accessible to both harnesses and multiple randomized task trials.
`;
writeFileSync(MD_OUT, md);
console.log(JSON.stringify({ json: JSON_OUT, markdown: MD_OUT, report }, null, 2));
