import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const args = process.argv.slice(2), report = args[args.indexOf("--report") + 1], nonce = args[args.indexOf("--nonce") + 1];
assert(report && nonce && process.env.SELF_COMPOSING_EVIDENCE_DIR === dirname(report));
const dir = dirname(report), fixture = resolve(import.meta.dir, "fixtures/self-composing-projection.ts");
for (const mode of ["prepare", "recover"]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture, mode, dir, nonce], { cwd: resolve(import.meta.dir, ".."), env: { PATH: process.env.PATH ?? "", TMPDIR: "/tmp" }, stdout: Bun.file(join(dir, `${mode}.stdout`)), stderr: Bun.file(join(dir, `${mode}.stderr`)), timeout: 20000 });
  assert.equal(await child.exited, 0, `${mode} failed; inspect retained stderr`);
}
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const before = read("prepare.json"), after = read("recover.json");
assert.equal(before.nonce, nonce); assert.equal(after.nonce, nonce); assert.notEqual(before.pid, after.pid);
assert.deepEqual(after.projection, before.projection); assert.deepEqual(after.skills, before.skills); assert.deepEqual(after.resources, before.resources);
assert.deepEqual(read("recover-trace.json"), read("prepare-trace.json"));
assert.equal(existsSync(join(dir, "disposable-projection.json")), false);
const observed = { differentProcesses: before.pid !== after.pid, projectionDeleted: true, identicalEntriesAndHeads: true, exactSkills: true, exactResources: true, unchangedNativeTrace: true, candidateCount: after.projection.candidates.length, activeHeadCount: after.projection.active.length, skillCount: Object.keys(after.skills).length, generation: after.projection.active[0].generation, replay: after.counts, positiveControls: { model: before.counts.model > 0, build: before.counts.build > 0, effect: before.counts.effect > 0, code: before.counts.code > 0, documentation: before.counts.documentWrites === 2, derivation: before.counts.derivation, sandboxReceipts: before.receiptCount }, native: after.native };
writeFileSync(join(dir, "observed.json"), JSON.stringify(observed, null, 2));
const artifacts = Object.fromEntries(["observed.json", "prepare.json", "recover.json", "prepare-trace.json", "recover-trace.json", "sandbox-receipts.json"].map(p => [p, createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")]));
writeFileSync(report, JSON.stringify({ schemaVersion: 1, nonce, checks: { "S03.C01": { status: "satisfied", operationId: nonce, traceRef: "recover-trace.json" }, "S08.C03": { status: "satisfied", operationId: nonce, traceRef: "recover-trace.json" } }, artifacts }, null, 2));
