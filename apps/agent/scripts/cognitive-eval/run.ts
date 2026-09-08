import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cognitiveSource, sourceScope } from "./manifest.ts";
import { cognitiveCases, type Category, type Split } from "./catalog.ts";
import { runProcedureCase, type ProcedureArm } from "./procedures.ts";
import { runRecoveryCase, type RecoveryArm } from "./recovery.ts";
import { runProactiveCase, type ProactiveArm } from "./proactive.ts";
type Arm = ProcedureArm | RecoveryArm | ProactiveArm;
const categoryArms = { procedures: ["current-control", "transfer-contract"], recovery: ["current-control", "bounded-recovery"], proactive: ["direct-notify-silent", "retained-contributions"] } satisfies Record<Category, string[]>;
import { harnessDigest } from "../../src/harness-library.ts";

const args = new Map(process.argv.slice(2).map(arg => { const [name, ...value] = arg.replace(/^--/, "").split("="); return [name!, value.join("=") || "true"]; }));
const root = resolve(import.meta.dir, "../../../.."), datasetDigest = harnessDigest(cognitiveCases);
const rubric = { version: 1, completion: "Independent outcome and exact-output checks plus real native terminal/receipt evidence", communication: "Existing Telegram host-receipt rubric; human usefulness/clarity ratings unavailable", failures: "Timeouts, unsupported drivers and missing evidence cannot pass", scope: "Offline mechanism probes; not autonomous model performance" };
const counts = Object.fromEntries((["recovery", "procedures", "proactive"] as const).map(category => [category, Object.fromEntries((["development", "validation", "protected"] as const).map(split => [split, cognitiveCases.filter(c => c.category === category && c.split === split).length]))]));
if (new Set(cognitiveCases.map(c => c.id)).size !== 60 || Object.values(counts).some(c => c.development !== 10 || c.validation !== 5 || c.protected !== 5)) throw Error("Invalid family counts or split leakage");

if (args.has("single")) {
  if (process.env.AIKO_COGNITIVE_EVAL_CHILD !== "offline-native-eval-child") throw Error("Internal case execution must be launched by the budgeted runner");
  const fixture = cognitiveCases.find(c => c.id === args.get("single"));
  const arm = args.get("arm") as Arm;
  if (!fixture || !(categoryArms[fixture.category] as string[]).includes(arm)) throw Error("Invalid isolated case request");
  const result = fixture.driver === "recovery-native" ? await runRecoveryCase(fixture, arm as RecoveryArm, args.get("scratch"))
    : fixture.driver === "proactive-native" ? await runProactiveCase(fixture, arm as ProactiveArm, args.get("scratch"))
    : await runProcedureCase(fixture, arm as ProcedureArm, args.get("scratch"));
  await writeFile(args.get("result")!, JSON.stringify(result, null, 2));
  process.exit(0);
}
if (args.has("list")) {
  console.log(JSON.stringify({ datasetDigest, counts, runnable: cognitiveCases.filter(c => c.driver !== "pending").length, pending: cognitiveCases.filter(c => c.driver === "pending").length,
    cases: cognitiveCases.map(({ id, split, driver }) => ({ id, split, driver })) }, null, 2));
  process.exit(0);
}
const category = (args.get("category") ?? "procedures") as Category, split = (args.get("split") ?? "development") as Split;
if (!["recovery", "procedures", "proactive"].includes(category) || !["development", "validation", "protected"].includes(split)) throw Error("Invalid category or split");
const selected = cognitiveCases.filter(c => c.category === category && c.split === split && (!args.has("case") || c.id === args.get("case")));
if (!selected.length || selected.some(c => c.driver === "pending")) throw Error("Selected scenario driver is not implemented; it cannot be counted as an executable pass");
const arms: Arm[] = args.get("arm") === "both" || !args.has("arm") ? [...categoryArms[category]] as Arm[] : [args.get("arm") as Arm];
if (arms.some(a => !(categoryArms[category] as string[]).includes(a))) throw Error("Invalid comparison arm");
const limit = Number(args.get("max-runs") ?? 20);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120 || selected.length * arms.length > limit) throw Error("Selected cases exceed the fixed run budget (maximum 120)");
const out = resolve(args.get("out") ?? "artifacts/cognitive-behavior/evaluation-development");
await mkdir(out, { recursive: true });
const source = () => cognitiveSource(root);
const initial = await source();
if (split === "protected") {
  if (!args.has("sealed-candidate")) throw Error("Protected families require a sealed candidate and a complete passing validation report; development is the default");
  const seal = JSON.parse(await readFile(resolve(args.get("sealed-candidate")!), "utf8"));
  const validation = JSON.parse(await readFile(resolve(seal.validationReport), "utf8"));
  const expected = cognitiveCases.filter(c => c.category === category && c.split === "validation").map(c => c.id).sort();
  const validated = validation.results.filter((r: any) => r.arm === seal.arm);
  if (seal.datasetDigest !== datasetDigest || seal.sourceDigest !== initial.digest || validation.sourceDigest !== initial.digest || validation.datasetDigest !== datasetDigest || validation.category !== category || validation.split !== "validation" || validation.sourceDrift !== false || validation.finalSourceDigest !== initial.digest || validation.rubricDigest !== harnessDigest(rubric) ||
    harnessDigest(validated.map((r: any) => r.id).sort()) !== harnessDigest(expected) || validated.some((r: any) => !r.passed) || arms.some(a => a !== seal.arm)) throw Error("Protected candidate or validation evidence mismatch");
}
const lock = { version: 1, datasetDigest, cases: cognitiveCases, rubric, rubricDigest: harnessDigest(rubric), counts,
  visibility: "Authored fixtures are builder-visible; protected means excluded from development execution, not independently unseen tasks", budgets: { maxRuns: limit, perCaseWallMs: 30000, totalWallMs: 7200000, providerSpendUsd: 0 },
  arms, category, split, model: { provider: "fixture", model_id: "cognitive-scripted-v1" }, initialMemory: "empty isolated owner-123 memory; only declared synthetic fixtures",
  sourceDigest: initial.digest, sourceFiles: initial.files, sourceScope,
  baseline: "current-control uses current source without the selected transfer requirement or recovery decorator; it is not the preserved pre-change baseline" };
const lockPath = join(out, "freeze.json");
if (await Bun.file(lockPath).exists()) {
  if (harnessDigest(JSON.parse(await readFile(lockPath, "utf8"))) !== harnessDigest(lock)) throw Error("Frozen experiment differs; use a new output directory and preserve the old evidence");
} else await writeFile(lockPath, JSON.stringify(lock, null, 2));
// An experiment directory is a single budgeted run. A crash or second caller
// cannot silently reset its attempt count or overwrite an earlier comparison.
await writeFile(join(out, "run-started.json"), JSON.stringify({ at: Date.now(), pid: process.pid, datasetDigest, sourceDigest: initial.digest, attempts: selected.length * arms.length }), { flag: "wx" });
const results: any[] = [], started = Date.now();
for (const [index, fixture] of selected.entries()) {
  // Alternate order across families. Both arms receive the same script/input.
  for (const arm of index % 2 ? [...arms].reverse() : arms) {
    if (Date.now() - started >= lock.budgets.totalWallMs) throw Error("Whole experiment wall budget exhausted");
    const name = `${fixture.id.replaceAll("/", "-")}.${arm}`, resultPath = join(out, `${name}.json`), errorPath = join(out, `${name}.log`);
    const scratch = await mkdtemp("/tmp/cognitive-eval-case-");
    const child = Bun.spawn([process.execPath, import.meta.path, `--single=${fixture.id}`, `--arm=${arm}`, `--result=${resultPath}`, `--scratch=${scratch}`], { cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", AIKO_COGNITIVE_EVAL_CHILD: "offline-native-eval-child" }, stdout: Bun.file(errorPath), stderr: Bun.file(errorPath) });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, lock.budgets.perCaseWallMs);
    const exit = await child.exited; clearTimeout(timer);
    await rm(scratch, { recursive: true, force: true });
    let result: any;
    if (exit !== 0 || timedOut || !await Bun.file(resultPath).exists()) result = { id: fixture.id, arm, passed: false, error: timedOut ? "case-wall-budget-exhausted" : "driver-failed", elapsedLowerBoundMs: timedOut ? lock.budgets.perCaseWallMs : null, log: errorPath };
    else {
      result = JSON.parse(await readFile(resultPath, "utf8"));
      const grader = Bun.spawn(["python3", join(import.meta.dir, "score.py"), resultPath], { stdout: "pipe", stderr: "pipe" });
      const [text, code] = await Promise.all([new Response(grader.stdout).text(), grader.exited]);
      if (code !== 0) throw Error(`Shared receipt grader failed: ${await new Response(grader.stderr).text()}`);
      result.communication = JSON.parse(text);
      await writeFile(resultPath, JSON.stringify(result, null, 2));
    }
    results.push({ ...result, events: undefined, artifact: resultPath });
    console.log(`${fixture.id} ${arm}: ${result.passed ? "pass" : "fail"}`);
    await writeFile(join(out, "partial.json"), JSON.stringify({ datasetDigest, sourceDigest: initial.digest, category, split, results }, null, 2));
  }
}
const final = await source();
const report = { version: 1, datasetDigest, rubricDigest: lock.rubricDigest, sourceDigest: initial.digest, finalSourceDigest: final.digest, sourceDrift: final.digest !== initial.digest,
  category, split, arms, results, completedFamilies: selected.length, executableFamiliesInCatalog: cognitiveCases.filter(c => c.driver !== "pending").length, totalFamiliesInCatalog: 60,
  metrics: { providerSpendUsd: 0, providerTokens: null, humanQuality: null, fullPlanAcceptance: false },
  limitations: ["Offline scripted execution; no autonomous-agent performance claim", "Current-control is not the preserved pre-change source baseline", `${cognitiveCases.filter(c => c.driver === "pending").length} recovery/proactive drivers remain unimplemented`, "Family independence and fresh protected-case authorship remain to be audited"] };
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: join(out, "report.json"), families: selected.length, passed: results.filter(r => r.passed).length, runs: results.length, sourceDrift: report.sourceDrift }));
process.exitCode = results.some(r => !r.passed) || report.sourceDrift ? 1 : 0;
