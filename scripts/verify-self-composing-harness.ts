import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, mkdtempSync, rmSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Engineering verifier protocol only. This is not a Tardigrade runtime API.
 * Trust boundary: independently reviewed requirements, entrypoints, fixture and
 * implementation pins. An arbitrary candidate-controlled verifier is not proof.
 */
const ROOT = resolve(import.meta.dir, "..");
const MANIFEST = "scripts/self-composing-harness-requirements.json";
const REQUIREMENTS_SHA256 = "e831c2928e7b6327577ad44f925b76bdb5f6e1ee380dca8e441a427f8fb46452";
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
type Check = { id: string; outcome: string; kind: string; verifier: string | null; gap: string };
type Requirement = { id: string; section: number; title: string; sourceLine: number; sourceSha256: string; sourceText: string; mandatory: boolean; reuseCandidates: string[]; checks: Check[] };
type Assertion = { id: string; artifact: string; pointer: string; expected: unknown };
type Registration = {
  entry: string;
  entrySha256: string;
  runtimeSha256?: string;
  dependencyTrees?: Record<string, string>;
  graphEntrypoints?: string[];
  inputDigests: Record<string, string>;
  review: { identity: string; rationale: string };
  timeoutMs: number;
  checks: Record<string, { assertions: Assertion[]; nativeTrace: string }>;
};
type Manifest = { schemaVersion: number; plan: string; planSha256: string; requirements: Requirement[]; verifiers: Record<string, Registration>; conditionalClaims: unknown[]; examples: unknown[] };
type Result = { id: string; status: "satisfied" | "blocked"; reason: string };
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function within(root: string, path: string) {
  need(typeof path === "string" && path.length > 0 && !isAbsolute(path), "relative path required");
  const full = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), full);
  need(rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "path escaped evidence/repository root");
  need(statSync(full).isFile(), "expected a regular file");
  return full;
}
function bytes(root: string, path: string, max = 16 * 1024 * 1024) {
  const file = within(root, path);
  need(statSync(file).size <= max, "artifact exceeds size bound");
  return readFileSync(file);
}
// Full installed package trees cover runtime-loaded exports and dynamic loaders
// that bundler tree-shaking may omit. Inventory changes invalidate the witness.
function treeDigest(root: string, path: string) {
  need(path && !isAbsolute(path), "relative dependency tree required");
  const base = realpathSync(resolve(root, path)), rel = relative(realpathSync(root), base);
  need(rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel), "dependency tree escaped root");
  const rows: [string, string][] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), stat = lstatSync(full);
      need(!stat.isSymbolicLink(), "dependency tree contains an unpinned symlink");
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) rows.push([relative(base, full), sha(readFileSync(full))]);
    }
  };
  visit(base); need(rows.length, "empty dependency tree");
  return sha(JSON.stringify(rows));
}
async function fenceDependencies(root: string, v: Registration) {
  if (v.runtimeSha256) need(sha(readFileSync(process.execPath)) === v.runtimeSha256, "Bun runtime digest changed");
  for (const [p, d] of Object.entries(v.dependencyTrees ?? {})) need(treeDigest(root, p) === d, `dependency tree changed: ${p}`);
  if (v.graphEntrypoints) {
    const result = await Bun.build({ entrypoints: v.graphEntrypoints.map(p => within(root, p)), target: "bun", metafile: true });
    need(result.success && result.metafile, "transitive verifier graph failed to resolve");
    for (const p of Object.keys(result.metafile.inputs)) {
      const path = relative(root, resolve(p));
      need(path === v.entry || Object.hasOwn(v.inputDigests, path), `unpinned transitive source: ${path}`);
    }
  }
}
function requirementsPin(m: Manifest) {
  return sha(JSON.stringify({ plan: m.plan, planSha256: m.planSha256,
    requirements: m.requirements.map(r => ({ ...r, checks: r.checks.map(({ verifier, gap, ...c }) => c) })),
    conditionalClaims: m.conditionalClaims, examples: m.examples }));
}
function validate(m: Manifest, root: string, pin = REQUIREMENTS_SHA256) {
  need(m.schemaVersion === 1 && object(m.verifiers) && Array.isArray(m.requirements), "invalid manifest schema");
  need(requirementsPin(m) === pin, "requirements changed: independent coverage review and gate pin update required");
  const plan = bytes(root, m.plan).toString();
  need(sha(plan) === m.planSha256, "plan changed: requirement map must be reviewed");
  const heads = [...plan.matchAll(/^\*\*(\d+)\. (.+?)\*\*$/gm)];
  need(heads.length === 25 && m.requirements.length === heads.length, "all 25 numbered sections are required");
  const ids = new Set<string>();
  for (const [i, r] of m.requirements.entries()) {
    const body = plan.slice(heads[i].index, heads[i + 1]?.index ?? plan.length);
    need(r.section === i + 1 && r.id === `S${String(i + 1).padStart(2, "0")}` && r.mandatory === true, "invalid section identity/applicability");
    need(body === r.sourceText && sha(body) === r.sourceSha256, `source coverage changed: ${r.id}`);
    need(r.checks.some(c => c.id === `${r.id}.P` && c.kind === "parent-runtime-witness") && r.checks.length > 1, `missing independent parent/children: ${r.id}`);
    for (const c of r.checks) {
      need(!ids.has(c.id) && c.id.startsWith(`${r.id}.`) && c.outcome.trim(), "duplicate or invalid check"); ids.add(c.id);
      need(c.verifier === null || typeof c.verifier === "string", "invalid verifier reference");
    }
  }
  for (const [id, v] of Object.entries(m.verifiers)) {
    need(digest(v.runtimeSha256) && object(v.dependencyTrees) && Object.keys(v.dependencyTrees).length > 0 && Array.isArray(v.graphEntrypoints) && v.graphEntrypoints.length > 0, "registration must pin runtime, full dependency trees and transitive graph roots");
    for (const d of Object.values(v.dependencyTrees!)) need(digest(d), "invalid dependency tree digest");
    need(object(v) && digest(v.entrySha256) && object(v.inputDigests) && object(v.checks), `invalid registration: ${id}`);
    need(typeof v.review?.identity === "string" && v.review.identity.trim() && typeof v.review.rationale === "string" && v.review.rationale.trim(), `independent registration review missing: ${id}`);
    need(Number.isSafeInteger(v.timeoutMs) && v.timeoutMs > 0 && v.timeoutMs <= 60_000, "verifier timeout must be 1..60000 ms");
    need(Object.keys(v.inputDigests).some(p => /^(apps|packages)\//.test(p)), "registration must pin exercised implementation files");
    need(Object.keys(v.inputDigests).some(p => /(^|\/)(test|tests|fixtures)(\/|\.)/.test(p)), "registration must pin independent fixtures/tests");
    for (const [p, d] of Object.entries(v.inputDigests)) need(digest(d) && p !== v.entry, "invalid or duplicated input pin");
    need(Object.keys(v.checks).length > 0, "empty verifier registration");
    for (const [cid, check] of Object.entries(v.checks)) {
      need(ids.has(cid) && typeof check.nativeTrace === "string" && check.nativeTrace.length > 0, "check requires native trace evidence");
      need(Array.isArray(check.assertions) && check.assertions.length > 0, "check requires fixed semantic assertions");
      const assertionIds = new Set<string>();
      for (const a of check.assertions) {
        need(typeof a.id === "string" && a.id.trim() && !assertionIds.has(a.id), "invalid/duplicate assertion"); assertionIds.add(a.id);
        need(typeof a.artifact === "string" && typeof a.pointer === "string" && a.pointer.startsWith("/") && Object.hasOwn(a, "expected"), "assertion needs pinned artifact, JSON pointer and expected value");
      }
    }
  }
}
function pointer(value: any, path: string): unknown {
  for (const part of path.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    need(value !== null && typeof value === "object" && Object.hasOwn(value, part), `missing observation: ${path}`);
    value = value[part];
  }
  return value;
}
function checkReport(report: any, dir: string, nonce: string, check: Check, registration: Registration) {
  need(object(report) && report.schemaVersion === 1 && report.nonce === nonce, "missing, stale or malformed runtime report");
  need(object(report.checks) && object(report.artifacts), "missing runtime checks/artifacts");
  const fixed = registration.checks[check.id], result = report.checks[check.id];
  need(fixed && object(result) && result.status === "satisfied", "runtime witness unknown, missing, failed or blocked");
  need(typeof result.operationId === "string" && result.operationId.trim() && typeof result.traceRef === "string" && result.traceRef.trim(), "runtime witness requires operation identity and trace reference");
  const evidence = (path: string) => {
    need(digest(report.artifacts[path]), `missing evidence digest: ${path}`);
    const data = bytes(dir, path);
    need(data.length > 0 && sha(data) === report.artifacts[path], `empty or altered evidence: ${path}`);
    return data;
  };
  // Interpretation of native trace formats belongs to the pinned independent
  // verifier; this gate does not invent an event schema for different tdg versions.
  need(result.traceRef === fixed.nativeTrace, "runtime trace reference differs from registered trace");
  evidence(fixed.nativeTrace);
  for (const a of fixed.assertions) {
    const observed = pointer(JSON.parse(evidence(a.artifact).toString()), a.pointer);
    need(isDeepStrictEqual(observed, a.expected), `semantic assertion failed: ${a.id}`);
  }
}
async function execute(root: string, v: Registration, checks: Check[], evidenceRoot: string): Promise<Result[]> {
  const dir = mkdtempSync(join(evidenceRoot, "run-"));
  try {
    need(sha(bytes(root, v.entry)) === v.entrySha256, "verifier entry digest changed");
    for (const [p, d] of Object.entries(v.inputDigests)) need(sha(bytes(root, p)) === d, `implementation/fixture digest changed: ${p}`);
    await fenceDependencies(root, v);
    const nonce = randomUUID(), reportPath = join(dir, "report.json");
    const proc = Bun.spawn([process.execPath, "--no-env-file", within(root, v.entry), "--report", reportPath, "--nonce", nonce], {
      cwd: root, env: { PATH: process.env.PATH ?? "", TMPDIR: "/tmp", SELF_COMPOSING_EVIDENCE_DIR: dir },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
      timeout: v.timeoutMs,
    });
    need(await proc.exited === 0, "runtime verifier failed or timed out (exit alone is never a pass)");
    // Fence edits during execution as well as before it.
    need(sha(bytes(root, v.entry)) === v.entrySha256, "verifier changed during execution");
    for (const [p, d] of Object.entries(v.inputDigests)) need(sha(bytes(root, p)) === d, `input changed during execution: ${p}`);
    await fenceDependencies(root, v);
    const report = JSON.parse(bytes(dir, "report.json", 1024 * 1024).toString());
    return checks.map(c => {
      try { checkReport(report, dir, nonce, c, v); return { id: c.id, status: "satisfied", reason: `Fresh independent witness; retained evidence ${dir}` }; }
      catch (e) { return { id: c.id, status: "blocked", reason: String(e) }; }
    });
  } catch (e) { return checks.map(c => ({ id: c.id, status: "blocked", reason: String(e) })); }
}
async function run(m: Manifest, root: string, selected?: string): Promise<{ fullCompletion: boolean; results: Result[]; evidenceRoot: string }> {
  validate(m, root);
  const all = m.requirements.flatMap(r => r.checks);
  // A section selector includes its children AND its independent parent witness.
  const checks = selected ? all.filter(c => c.id === selected || c.id.startsWith(`${selected}.`)) : all;
  need(checks.length, "unknown requirement/check selector");
  const results: Result[] = [], groups = new Map<string, Check[]>();
  for (const c of checks) {
    if (!c.verifier || !m.verifiers[c.verifier]?.checks[c.id]) results.push({ id: c.id, status: "blocked", reason: c.gap || "No trusted runtime verifier registered" });
    else groups.set(c.verifier, [...(groups.get(c.verifier) ?? []), c]);
  }
  const evidenceRoot = mkdtempSync("/tmp/unlock-self-composing-evidence-");
  for (const [id, group] of groups) results.push(...await execute(root, m.verifiers[id], group, evidenceRoot));
  // Partial Contract atoms never masquerade as the full goal.
  return { fullCompletion: !selected && results.length === all.length && results.every(r => r.status === "satisfied"), results, evidenceRoot };
}
async function selfTest() {
  const m: Manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
  validate(m, ROOT);
  let assertions = 0;
  const rejects = (fn: () => unknown) => { let rejected = false; try { fn(); } catch { rejected = true; } need(rejected, "negative gate test unexpectedly passed"); assertions++; };
  const removed = structuredClone(m); removed.requirements.pop(); rejects(() => validate(removed, ROOT));
  const waived = structuredClone(m); waived.requirements[0].mandatory = false; rejects(() => validate(waived, ROOT));
  const altered = structuredClone(m); altered.requirements[0].checks[0].outcome = "File exists"; rejects(() => validate(altered, ROOT));
  const dir = mkdtempSync("/tmp/unlock-self-composing-gate-test-");
  try {
    const c = m.requirements[0].checks[0];
    const v: Registration = { entry: "", entrySha256: "", inputDigests: {}, review: { identity: "self-test", rationale: "Gate mechanics only; not implementation evidence" }, timeoutMs: 1000,
      checks: { [c.id]: { nativeTrace: "trace.json", assertions: [{ id: "write-not-duplicated", artifact: "observed.json", pointer: "/writes", expected: 1 }] } } };
    writeFileSync(join(dir, "trace.json"), JSON.stringify({ fixture: "gate-protocol-only" }));
    writeFileSync(join(dir, "observed.json"), JSON.stringify({ writes: 1 }));
    const report = { schemaVersion: 1, nonce: "fresh", checks: { [c.id]: { status: "satisfied", operationId: "fixture-op", traceRef: "trace.json" } },
      artifacts: { "trace.json": sha(bytes(dir, "trace.json")), "observed.json": sha(bytes(dir, "observed.json")) } };
    checkReport(report, dir, "fresh", c, v); assertions++;
    rejects(() => checkReport({ passed: true }, dir, "fresh", c, v));
    rejects(() => checkReport(report, dir, "stale", c, v));
    const unknown = structuredClone(report); unknown.checks[c.id].status = "unknown"; rejects(() => checkReport(unknown, dir, "fresh", c, v));
    const missing = structuredClone(report); delete (missing.artifacts as any)["trace.json"]; rejects(() => checkReport(missing, dir, "fresh", c, v));
    writeFileSync(join(dir, "observed.json"), JSON.stringify({ writes: 2 }));
    rejects(() => checkReport(report, dir, "fresh", c, v));
    report.artifacts["observed.json"] = sha(bytes(dir, "observed.json"));
    rejects(() => checkReport(report, dir, "fresh", c, v));
    rejects(() => bytes(dir, "../outside.json"));
    // Real subprocesses establish exit-zero is insufficient and pins are checked.
    writeFileSync(join(dir, "empty.ts"), "process.exit(0);\n");
    const empty = { ...v, entry: "empty.ts", entrySha256: sha(bytes(dir, "empty.ts")) };
    const outcome = await execute(dir, empty, [c], dir);
    need(outcome[0].status === "blocked", "exit-zero without report passed"); assertions++;
    const badPin = await execute(dir, { ...empty, entrySha256: "0".repeat(64) }, [c], dir);
    need(badPin[0].status === "blocked", "changed verifier passed"); assertions++;
    writeFileSync(join(dir, "hang.ts"), "setInterval(() => {}, 1000); await new Promise(() => {});\n");
    const timed = await execute(dir, { ...v, entry: "hang.ts", entrySha256: sha(bytes(dir, "hang.ts")), timeoutMs: 50 }, [c], dir);
    need(timed[0].status === "blocked", "hung verifier passed"); assertions++;
    // A fresh child process writes actual evidence; prove the positive protocol
    // works while keeping these synthetic observations out of the real manifest.
    writeFileSync(join(dir, "writer.ts"), `
      import { writeFileSync, readdirSync, lstatSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { createHash } from 'node:crypto';
      const args = process.argv.slice(2), report = args[args.indexOf('--report') + 1], nonce = args[args.indexOf('--nonce') + 1];
      const trace = JSON.stringify({ fixture: 'gate-mechanics-only' });
      const observed = JSON.stringify({ writes: 1 });
      writeFileSync(join(dirname(report), 'trace.json'), trace);
      writeFileSync(join(dirname(report), 'observed.json'), observed);
      const sha = x => createHash('sha256').update(x).digest('hex');
      writeFileSync(report, JSON.stringify({schemaVersion: 1, nonce, checks: {
        '${c.id}': {status: 'satisfied', operationId: 'fixture-op', traceRef: 'trace.json'}
      }, artifacts: {'trace.json': sha(trace), 'observed.json': sha(observed)}}));
    `);
    const positive = await execute(dir, { ...v, entry: "writer.ts", entrySha256: sha(bytes(dir, "writer.ts")) }, [c], dir);
    need(positive[0].status === "satisfied", `fresh protocol fixture failed: ${positive[0].reason}`); assertions++;
    const dependencyDir = mkdtempSync(join(dir, "dependencies-"));
    const dependencyPath = relative(dir, dependencyDir);
    writeFileSync(join(dependencyDir, "runtime.js"), "export const version = 1;\n");
    const protectedWriter = { ...v, entry: "writer.ts", entrySha256: sha(bytes(dir, "writer.ts")), runtimeSha256: sha(readFileSync(process.execPath)), dependencyTrees: { [dependencyPath]: treeDigest(dir, dependencyPath) } };
    const protectedPass = await execute(dir, protectedWriter, [c], dir);
    need(protectedPass[0].status === "satisfied", "valid runtime/dependency pins failed"); assertions++;
    const wrongRuntime = await execute(dir, { ...protectedWriter, runtimeSha256: "0".repeat(64) }, [c], dir);
    need(wrongRuntime[0].status === "blocked", "changed runtime passed"); assertions++;
    writeFileSync(join(dependencyDir, "runtime.js"), "export const version = 2;\n");
    const changedDependency = await execute(dir, protectedWriter, [c], dir);
    need(changedDependency[0].status === "blocked", "changed dependency passed"); assertions++;
    writeFileSync(join(dependencyDir, "runtime.js"), "export const version = 1;\n");
    writeFileSync(join(dependencyDir, "injected.js"), "export const injected = true;\n");
    const injectedDependency = await execute(dir, protectedWriter, [c], dir);
    need(injectedDependency[0].status === "blocked", "new dependency file passed"); assertions++;
    writeFileSync(join(dir, "unregistered.ts"), "export const unregistered = true;\n");
    const missingGraphPin = await execute(dir, { ...v, entry: "writer.ts", entrySha256: sha(bytes(dir, "writer.ts")), graphEntrypoints: ["writer.ts", "unregistered.ts"] }, [c], dir);
    need(missingGraphPin[0].status === "blocked", "unpinned transitive graph input passed"); assertions++;
    const wrongTrace = structuredClone(report); wrongTrace.checks[c.id].traceRef = "unregistered-trace";
    rejects(() => checkReport(wrongTrace, dir, "fresh", c, v));
    const changedInput = await execute(dir, { ...v, entry: "writer.ts", entrySha256: sha(bytes(dir, "writer.ts")), inputDigests: { "observed.json": "0".repeat(64) } }, [c], dir);
    need(changedInput[0].status === "blocked", "changed implementation/fixture pin passed"); assertions++;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ mode: "self-test", assertions, passed: true, fullCompletion: false, note: "Synthetic gate mechanics; no application acceptance credit" }, null, 2));
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--self-test") await selfTest();
    else {
      need(args.length === 0 || (args.length === 1 && args[0] === "--validate") || (args.length === 2 && args[0] === "--check"), "usage: bun scripts/verify-self-composing-harness.ts [--validate | --self-test | --check S12[.C01]]");
      const m: Manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
      if (args[0] === "--validate") {
        validate(m, ROOT);
        console.log(JSON.stringify({ mode: "manifest-validation", fullCompletion: false, sections: m.requirements.length, checks: m.requirements.flatMap(r => r.checks).length, note: "Coverage/schema only; no runtime requirement is satisfied by this command" }, null, 2));
      } else {
        const result = await run(m, ROOT, args[1]);
        console.log(JSON.stringify({ mode: args[1] ? "partial-contract-check" : "completion-gate", ...result }, null, 2));
        if (result.results.some(r => r.status !== "satisfied")) process.exitCode = 1;
      }
    }
  } catch (e) { console.error(JSON.stringify({ fullCompletion: false, error: String(e) })); process.exitCode = 1; }
}
