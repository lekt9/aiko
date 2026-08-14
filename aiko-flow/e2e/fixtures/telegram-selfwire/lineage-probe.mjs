// CHECK D, dynamic half — does Contract lineage actually reach the worker?
//
// The bridge's worker is `<Task agent={providers.aiko}>`, and in production
// `providers.aiko` is `AikoAgent` (re-exported by smthrs; the constructor
// mapping is asserted by e2e/aiko-harness-gate.sh CHECK 0). This probe
// instantiates that REAL class and makes it spawn a child, with
// e2e/fixtures/telegram-selfwire/bin first on PATH so the child is the stub
// rather than a model turn. What is under test is the env composition in
// BaseCliAgent.runGenerateEffect:
//
//   const env = { ...(this.inheritEnv ? process.env : {}), ...this.env,
//                 ...taskContextEnv(options?.taskContext) };
//                                  packages/agents/src/BaseCliAgent/BaseCliAgent.js:944-948
//
// so a worker turn inherits AIKO_CONTRACT_PARENT_ID / ROOT_ID / DEPTH from
// whatever launched Smithers (aiko 0.2.116 exports exactly those three to its
// tool shell — tmp/witness-lineage-env.sh) and additionally receives
// SMITHERS_RUN_ID / SMITHERS_NODE_ID / SMITHERS_ITERATION for the node it is.
// The end-to-end version of this claim, with two real aiko processes either
// side of the Smithers hop, is tmp/witness-one-aiko.sh; this is the hermetic
// one that runs in a second.
//
// The lineage values below are SYNTHETIC 8-hex strings minted by the caller —
// no real contract id, no credential, nothing that has to be redacted.
//
//   bun lineage-probe.mjs <dump-path>
//
// Exits 0 printing EVIDENCE lines, or 1 printing "CHECK_D FAIL: ...".

import { existsSync, readFileSync } from "node:fs";

const dumpPath = process.argv[2];
const fail = (message) => {
  console.log(`CHECK_D FAIL: ${message}`);
  process.exit(1);
};
if (!dumpPath) fail("usage: lineage-probe.mjs <dump-path>");

const expected = {
  AIKO_CONTRACT_PARENT_ID: process.env.AIKO_CONTRACT_PARENT_ID,
  AIKO_CONTRACT_ROOT_ID: process.env.AIKO_CONTRACT_ROOT_ID,
  AIKO_CONTRACT_DEPTH: process.env.AIKO_CONTRACT_DEPTH,
};
for (const [name, value] of Object.entries(expected)) {
  if (!value) fail(`${name} is not set in the probe's own environment — nothing to thread`);
}

const smthrs = await import("smthrs");
if (typeof smthrs.AikoAgent !== "function") {
  fail("smthrs does not export AikoAgent — the bridge's worker could not be the aiko harness");
}

const agent = new smthrs.AikoAgent({});
if (agent.inheritEnv === false) {
  fail("AikoAgent was constructed with inheritEnv=false — a worker turn would start a fresh lineage root");
}

const taskContext = { runId: "selfwire-lineage-probe", nodeId: "worker", iteration: 3, attempt: 1 };
try {
  await agent.generate({
    prompt: "lineage probe — the stub never reads this",
    taskContext,
    rootDir: process.cwd(),
  });
} catch (error) {
  // A non-zero stub or a parse hiccup is not the claim; the dump file is.
  console.log(`EVIDENCE[CHECK_D/spawn]: generate() threw (${String(error).slice(0, 80)}) — the dump is the evidence`);
}

if (!existsSync(dumpPath)) {
  fail("the AikoAgent child never ran (no env dump) — cannot show lineage crosses the spawn");
}
const dump = readFileSync(dumpPath, "utf8");
const got = Object.fromEntries(
  dump
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

for (const [name, value] of Object.entries(expected)) {
  if (got[name] !== value) {
    fail(`${name} did not survive the spawn: child saw ${JSON.stringify(got[name])}, parent had ${JSON.stringify(value)}`);
  }
}
if (got.SMITHERS_RUN_ID !== taskContext.runId || got.SMITHERS_NODE_ID !== taskContext.nodeId) {
  fail(
    `taskContextEnv did not identify the node: SMITHERS_RUN_ID=${JSON.stringify(got.SMITHERS_RUN_ID)} ` +
      `SMITHERS_NODE_ID=${JSON.stringify(got.SMITHERS_NODE_ID)}`,
  );
}
if (got.SMITHERS_ITERATION !== String(taskContext.iteration)) {
  fail(`SMITHERS_ITERATION=${JSON.stringify(got.SMITHERS_ITERATION)}, expected "${taskContext.iteration}"`);
}

console.log(
  `EVIDENCE[CHECK_D/lineage]: the real AikoAgent spawned its child with ` +
    `AIKO_CONTRACT_PARENT_ID=${got.AIKO_CONTRACT_PARENT_ID} ROOT_ID=${got.AIKO_CONTRACT_ROOT_ID} ` +
    `DEPTH=${got.AIKO_CONTRACT_DEPTH} (inherited) plus SMITHERS_RUN_ID=${got.SMITHERS_RUN_ID} ` +
    `SMITHERS_NODE_ID=${got.SMITHERS_NODE_ID} SMITHERS_ITERATION=${got.SMITHERS_ITERATION} (taskContextEnv)`,
);
console.log(
  "EVIDENCE[CHECK_D/lineage]: mechanism cited — BaseCliAgent.js:944-948 env composition, " +
    "inheritEnv default true (BaseCliAgent.js:923), taskContextEnv.js:10",
);
