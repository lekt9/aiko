#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const [aikoPath, grokPath, jsonOut, mdOut] = process.argv.slice(2).map((path) => path && resolve(path));
if (!mdOut) {
  throw new Error("usage: merge-harbor-reports.mjs <aiko.json> <grok.json> <out.json> <out.md>");
}

const aiko = JSON.parse(readFileSync(aikoPath, "utf8"));
const grok = JSON.parse(readFileSync(grokPath, "utf8"));
const aikoRows = aiko.results.filter((row) => row.agent.id === "aiko");
const grokRows = grok.results.filter((row) => row.agent.id === "grok");
const taskIds = [...new Set([...aikoRows, ...grokRows].map((row) => row.taskId))].sort();
for (const taskId of taskIds) {
  if (aikoRows.filter((row) => row.taskId === taskId).length !== 1 || grokRows.filter((row) => row.taskId === taskId).length !== 1) {
    throw new Error(`Expected one isolated result per agent for ${taskId}`);
  }
}

const results = [...aikoRows, ...grokRows].sort((left, right) =>
  left.taskId.localeCompare(right.taskId) || left.agent.id.localeCompare(right.agent.id),
);
const summary = Object.fromEntries(["aiko", "grok"].map((id) => {
  const rows = results.filter((row) => row.agent.id === id && !row.infrastructureFailure);
  const passed = rows.filter((row) => row.passed).length;
  return [id, { eligible: rows.length, passed, passRate: rows.length ? passed / rows.length : null }];
}));
const report = {
  ...aiko,
  generatedAt: new Date().toISOString(),
  methodology: "merged-isolated-host-executed-harbor-task-verifier-compatibility",
  versions: { ...aiko.versions, ...grok.versions },
  summary,
  results,
  isolatedSources: [aikoPath, grokPath],
};
writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");

const score = (id) => `${summary[id].passed}/${summary[id].eligible} (${(summary[id].passRate * 100).toFixed(0)}%)`;
const rows = results.map((row) =>
  `| ${row.taskId} | ${row.agent.id} | ${row.agent.model} | ${row.passed ? "PASS" : "FAIL"} | ${(row.agent.durationMs / 1000).toFixed(1)}s |`,
).join("\n");
writeFileSync(mdOut, `# Aiko vs Grok: isolated Harbor rerun\n\nGenerated: ${report.generatedAt}\n\n- Aiko: ${score("aiko")}\n- Grok: ${score("grok")}\n\n| Task | Harness | Model | Verifier | Agent time |\n|---|---|---|---|---|\n${rows}\n\nEach harness ran in a separate preserved workspace root. This is a host-executed Harbor compatibility run, not an official container-isolated leaderboard submission. Hidden verifiers were materialized only after the selected harness completed each task.\n\nMachine-readable evidence: [${basename(jsonOut)}](./${basename(jsonOut)}).\n`);

console.log(`Merged ${results.length} verified rows into ${basename(jsonOut)}`);
