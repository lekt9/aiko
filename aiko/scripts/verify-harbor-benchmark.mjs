#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const report = JSON.parse(readFileSync(resolve(root, "docs", "AIKO-VS-GROK-HARBOR.json"), "utf8"));
if (report.methodology !== "host-executed-harbor-task-verifier-compatibility") throw new Error("Unexpected methodology");
if (report.officialHarborRun !== false) throw new Error("Compatibility run must not claim official Harbor status");
if (!report.source?.commit || !Array.isArray(report.results) || report.results.length === 0) throw new Error("Missing benchmark evidence");
for (const taskId of new Set(report.results.map((row) => row.taskId))) {
  const agents = report.results.filter((row) => row.taskId === taskId).map((row) => row.agent.id).sort();
  if (agents.join(",") !== "aiko,grok") throw new Error(`Unbalanced task ${taskId}: ${agents}`);
}
for (const row of report.results) {
  if (typeof row.passed !== "boolean" || typeof row.verifier?.exitCode !== "number") throw new Error(`Invalid evidence for ${row.taskId}/${row.agent.id}`);
}
console.log(`Verified ${report.results.length} balanced Harbor task runs (${new Set(report.results.map((r) => r.taskId)).size} tasks).`);
