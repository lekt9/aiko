import { beforeAll, afterAll, expect, test } from "bun:test";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createPythonSandboxRuntime,
  type SandboxPythonRuntime,
} from "../src/sandbox-python.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import {
  runSandboxJob,
  sandboxEnvironment,
  type SandboxJobBinding,
} from "../src/sandbox-job-runner.ts";
import {
  sandboxDigest,
  sandboxArtifactDependencies,
  verifySandboxReceipt,
  type SandboxJob,
} from "../src/sandbox-job.ts";
import {
  mediaHarnessDefinitions,
  mediaLifecycleBudgets,
  mediaAcquisitionWallMs,
  mediaWordErrorRate,
  type MediaCapability,
} from "../src/harness-media.ts";
import {
  mediaModelPin,
  verifyMediaModelDirectory,
} from "../src/harness-media-lock.ts";
import {
  harnessDigest,
  HarnessLibrary,
  harnessBlobStore,
  type HarnessLibraryBinding,
} from "../src/harness-library.ts";
import { createHarnessSandboxBinding } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { HarnessAcquisition } from "../src/harness-acquisition.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { createMultilingualFixtures as createMediaFixtures } from "./fixtures/media-multilingual-fixtures.ts";
import multilingualPins from "../assets/media-multilingual-model.lock.json";

let fixture: Awaited<ReturnType<typeof createMediaFixtures>>,
  runtime: SandboxPythonRuntime,
  binding: SandboxJobBinding,
  db: Database;
let definitions: ReturnType<typeof mediaHarnessDefinitions>;
const signal = () => AbortSignal.timeout(mediaLifecycleBudgets.invocationWallMs);
beforeAll(async () => {
  const setupBegan = performance.now();
  fixture = await createMediaFixtures();
  const models =
    process.env.MEDIA_HARNESS_MODELS ?? join(fixture.directory, "models");
  if (process.env.MEDIA_HARNESS_MODELS)
    await verifyMediaModelDirectory(join(models, "whisper-tiny"), multilingualPins.model);
  else await mkdir(join(models, "whisper-tiny"), { recursive: true });
  runtime = await createPythonSandboxRuntime({
    sharedLibraries: ["/usr/lib/libSDL3.so.0"],
    tools: { ffprobe: "/usr/bin/ffprobe", ffmpeg: "/usr/bin/ffmpeg" },
    ...(process.env.MEDIA_HARNESS_PACKAGES
      ? { packages: process.env.MEDIA_HARNESS_PACKAGES }
      : {}),
    models,
    ...(process.env.MEDIA_HARNESS_PYTHON
      ? { python: process.env.MEDIA_HARNESS_PYTHON }
      : {}),
  });
  console.info("media-setup-profile", JSON.stringify({wallMs:Math.round(performance.now()-setupBegan),phase:"fixtures-and-sealed-runtime-capture",runtimeLockDigest:runtime.lockDigest}));
  expect(runtime.lock.version).toBe(2);
  db = new Database(join(fixture.directory, "jobs.sqlite"));
  binding = {
    owner: "media-owner",
    environmentDigest: await sandboxEnvironment("media-test-v1"),
    journal: await sandboxJobJournal(
      db,
      join(fixture.directory, "receipt.key"),
    ),
    python: runtime,
  };
  definitions = mediaHarnessDefinitions(
    runtime.lockDigest,
    await readFile(
      new URL("../assets/media-harness.py", import.meta.url),
      "utf8",
    ),
    {
      modelPath: "/models/whisper-tiny",
      languages: ["en", "es"],
      modelRevision: multilingualPins.model.revision,
      fixtures: fixture.fixtures,
      decodeFrame: fixture.decodeFrame,
      reference: async (capability, input) =>
        fixture.fixtures.find(
          (f) =>
            f.capability === capability &&
            harnessDigest(f.input) === harnessDigest(input),
        )?.expected,
    },
  );
}, 300000);
afterAll(async () => {
  runtime?.dispose();
  db?.close();
  await fixture?.close();
});

async function jobFor(
  capability: MediaCapability,
  input: any,
  operationId = crypto.randomUUID(),
): Promise<SandboxJob> {
  const definition = definitions.find((d) => d.artifact.name === capability)!;
  const modules = Object.fromEntries(
    await Promise.all(
      Object.entries(definition.artifact.files).map(async ([name, source]) => [
        name,
        { source, digest: await sandboxDigest(source) },
      ]),
    ),
  );
  const artifact = {
    kind: "python" as const,
    entry: definition.artifact.entrypoint,
    modules,
    runtimeLockDigest: runtime.lockDigest,
  };
  const dependencyLock = sandboxArtifactDependencies(artifact);
  const bytes = await fixture.bytes(input.asset);
  const data = bytes.toString("base64");
  return {
    version: 1,
    owner: binding.owner,
    operationId,
    contextRef: "media-context",
    authorityRef: "media-read-only",
    artifact,
    harnessDigest: await sandboxDigest(artifact),
    dependencyLock,
    dependencyLockDigest: await sandboxDigest(dependencyLock),
    environmentDigest: binding.environmentDigest,
    input,
    assets: {
      [input.asset]: {
        data,
        bytes: bytes.length,
        digest: await sandboxDigest(data),
      },
    },
    authority: { origins: [], methods: [] },
    budget: {
      wallMs: mediaLifecycleBudgets.jobWallMs,
      requests: 0,
      outputBytes: 1048576,
      memoryBytes: 2147483648,
      processes: 64,
      scratchBytes: 67108864,
    },
  };
}
async function executeCase(id: string) {
  const sample = fixture.fixtures.find((f) => f.id === id)!;
  const job = await jobFor(sample.capability, sample.input);
  const began = performance.now();
  const receipt = await runSandboxJob(job, binding, signal());
  console.info("media-job-profile", JSON.stringify({caseId:id,wallMs:Math.round(performance.now()-began),status:receipt.status,resources:receipt.resources}));
  expect(receipt.status).toBe("completed");
  await verifySandboxReceipt(job, receipt);
  const definition = definitions.find(
    (d) => d.artifact.name === sample.capability,
  )!;
  const checked = await definition.verifier.verify(
    {
      contract: definition.contract,
      artifactDigest: harnessDigest(definition.artifact),
      input: sample.input,
      output: receipt.output as any,
      caseId: sample.id,
    },
    signal(),
  );

  console.info("multilingual-quality", JSON.stringify({id, passed:checked.passed, status:(receipt.output as any).status, wer:sample.expected.transcript === undefined ? undefined : mediaWordErrorRate(sample.expected.transcript, (receipt.output as any).text ?? "")}));
  expect(checked.passed).toBe(true);
  return { job, receipt, checked };
}


test("multilingual CPU sandbox meets frozen natural Spanish and English speech rubric with bounded timestamps", async () => {
  for (const id of ["speech", "held-out-speech", "6930-75918-0000", "6930-75918-0007", "cof_00610_00008989777", "com_00610_00008909944"]) await executeCase(id);
}, 300000);

test("multilingual CPU sandbox returns explicit silence noise malformed and long outcomes", async () => {
  for (const id of ["silence-es", "noise-es", "malformed-es", "long-es", "no-audio"]) await executeCase(id);
}, 300000);

test("retained multilingual job result survives SQLite journal reopen without executing again", async () => {
  const {job,receipt} = await executeCase("com_00610_00008909944");
  db.close(); db = new Database(join(fixture.directory,"jobs.sqlite"));
  const journal = await sandboxJobJournal(db, join(fixture.directory,"receipt.key"));
  const python = {...runtime, execute: async () => { throw Error("Retained receipt must not repeat execution"); }};
  expect(await runSandboxJob(job,{...binding,journal,python},signal())).toEqual(receipt);
  binding = {...binding,journal};
},300000);

test("cancelled physical multilingual job retains terminal custody and cleans its resource scope", async () => {
  const job = await jobFor("media.transcribe",{asset:"cof_00610_00008989777.wav",language:"es"});
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),200);
  let receipt;
  try { receipt = await runSandboxJob(job,binding,controller.signal); } finally { clearTimeout(timer); }
  expect(receipt.status).toBe("failed");
  expect(receipt.reason).toBe("cancelled_or_deadline");
  expect(receipt.resources?.cleaned).toBe(true);
  await verifySandboxReceipt(job,receipt);
  expect(await runSandboxJob(job,{...binding,python:{...runtime,execute:async()=>{throw Error("Cancelled operation redispatched");}}},signal())).toEqual(receipt);
},300000);

test("independent multilingual checker rejects fabricated words language identity and segment bounds", async () => {
  const {receipt} = await executeCase("cof_00610_00008989777");
  const sample = fixture.fixtures.find(f => f.id === "cof_00610_00008989777")!;
  const definition = definitions.find(d => d.artifact.name === "media.transcribe")!;
  const check = async (output: any) => (await definition.verifier.verify({contract:definition.contract,artifactDigest:harnessDigest(definition.artifact),input:sample.input,output,caseId:sample.id},signal())).passed;
  for (const replacement of [{text:"An unrelated invented sentence."},{language:"en"},{modelRevision:"0".repeat(40)}]) {
    expect(await check({...receipt.output as any,...replacement})).toBe(false);
  }
  const outside = structuredClone(receipt.output) as any;
  outside.segments[0].endSeconds = outside.durationSeconds + 10;
  expect(await check(outside)).toBe(false);
},300000);
