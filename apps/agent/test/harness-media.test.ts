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
import { createMediaFixtures } from "./fixtures/media-fixtures.ts";

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
    await verifyMediaModelDirectory(join(models, "whisper-tiny.en"));
  else await mkdir(join(models, "whisper-tiny.en"), { recursive: true });
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
      modelPath: "/models/whisper-tiny.en",
      modelRevision: mediaModelPin.revision,
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

  expect(checked.passed).toBe(true);
  return { job, receipt, checked };
}

test("pinned FFprobe jobs inspect real audiovisual/audio/no-audio/malformed fixtures", async () => {
  for (const id of [
    "probe-av",
    "probe-video",
    "probe-silence",
    "probe-malformed",
  ])
    await executeCase(id);
}, 300000);

test("FFmpeg decodes actual colored frames with observed timestamps and non-exhaustive coverage", async () => {
  for (const id of ["frames-colors", "frames-av", "frames-no-video"])
    await executeCase(id);
  const { job, receipt } = await executeCase("frames-colors");
  const first = (receipt.output as any).frames[0];
  expect(first.requestedSeconds).toBe(0.05);
  expect(first.atSeconds).toBe(0.1);
  expect((receipt.output as any).coverage.exhaustive).toBe(false);
  const reopened = await sandboxJobJournal(
    db,
    join(fixture.directory, "receipt.key"),
  );
  expect(
    await runSandboxJob(job, { ...binding, journal: reopened }, signal()),
  ).toEqual(receipt);
}, 300000);

test("independent checker rejects planned timestamps, wrong pixels, altered contracts and forged case identity", async () => {
  const { receipt } = await executeCase("frames-colors");
  const sample = fixture.fixtures.find((f) => f.id === "frames-colors")!,
    definition = definitions.find((d) => d.artifact.name === "media.frames")!;
  const check = (
    output: any,
    contract = definition.contract,
    caseId = sample.id,
  ) =>
    definition.verifier.verify(
      {
        contract,
        artifactDigest: harnessDigest(definition.artifact),
        input: sample.input,
        output,
        caseId,
      },
      signal(),
    );
  expect(
    (
      await check({
        status: "ok",
        durationSeconds: 2,
        timestamps: [0.05, 1.05],
      })
    ).passed,
  ).toBe(false);
  const swapped = structuredClone(receipt.output) as any;
  swapped.frames[1].data = swapped.frames[0].data;
  swapped.frames[1].bytes = swapped.frames[0].bytes;
  expect((await check(swapped)).passed).toBe(false);
  expect(
    (
      await check(receipt.output, {
        ...definition.contract,
        outcome: "just plan timestamps",
      })
    ).passed,
  ).toBe(false);
  expect(
    (await check(receipt.output, definition.contract, "unknown-case")).passed,
  ).toBe(false);
  const changed = structuredClone(receipt.output) as any;
  changed.frames[0].atSeconds = 0.05;
  expect((await check(changed)).passed).toBe(false);
}, 300000);

test("media job rejects asset forgery, source pin changes, path injection and out-of-range timestamps", async () => {
  const job = await jobFor("media.frames", {
    asset: "video.mp4",
    timestamps: [2],
  });
  expect((await runSandboxJob(job, binding, signal())).status).toBe("failed");
  const valid = await jobFor("media.probe", { asset: "video.mp4" });
  const bad = structuredClone(valid);
  bad.assets!["video.mp4"]!.data = "eA==";
  expect((await runSandboxJob(bad, binding, signal())).status).toBe("failed");
  const source = structuredClone(valid);
  (source.artifact as any).modules["main.py"].source =
    "def run(input): return {}";
  await expect(runSandboxJob(source, binding, signal())).rejects.toThrow(
    "pin mismatch",
  );
  const foreign = await jobFor("media.probe", { asset: "video.mp4" });
  foreign.input = {
    asset: "/etc/passwd",
    _files: { "/etc/passwd": "/etc/passwd" },
  };
  expect((await runSandboxJob(foreign, binding, signal())).status).toBe(
    "failed",
  );
}, 300000);

test("media seeds acquire through the real HarnessAcquisition catalog and private sandbox receipts", async () => {
  const sandbox = localHarnessSandbox(binding);
  const bridge = createHarnessSandboxBinding({
    owner: binding.owner,
    thread: "media-thread",
    placement: "local",
    sandbox,
    current: async () => ({
      owner: binding.owner,
      active: true,
      runtimeDigest: binding.environmentDigest,
      pythonRuntimeLockDigest: runtime.lockDigest,
      contextRef: "media-context",
      authorityRef: "media-read-only",
      sessionRevision: null,
      effects: ["read"],
      origins: [],
      methods: [],
      budget: {
        wallMs: mediaLifecycleBudgets.jobWallMs,
        requests: 0,
        outputBytes: 1048576,
        memoryBytes: 2147483648,
        processes: 64,
      },
    }),
    assets: async (request) => {
      const name = (request.input as any).asset,
        bytes = await fixture.bytes(name),
        data = bytes.toString("base64");
      return {
        [name]: {
          data,
          digest: await sandboxDigest(data),
          bytes: bytes.length,
        },
      };
    },
  });
  const rows: any[] = [];
  const journal = {
    read: async () => rows,
    append: async (events: readonly any[]) => {
      rows.push(...events);
    },
  };
  const libraryBinding: HarnessLibraryBinding = {
    owner: binding.owner,
    thread: "media-thread",
    blobs: harnessBlobStore(sqliteWorkflowKV(db)),
    verifiers: new Map(definitions.map((d) => [d.verifier.digest, d.verifier])),
    guard: () => {},
    ...bridge,
  };
  const acquisition = new HarnessAcquisition(
    libraryBinding,
    journal,
    definitions,
  );
  expect((await acquisition.catalog()).capabilities.map((c) => c.name)).toEqual(
    ["media.probe", "media.frames", "media.transcribe"],
  );
  const acquired = await acquisition.acquire(
    { name: "media.probe", operationId: "acquire-probe" },
    AbortSignal.timeout(mediaAcquisitionWallMs(definitions.find(d => d.artifact.name === "media.probe")!)),
  );
  expect(acquired.status).toBe("ready");
  const acquisitionRequest = rows.find(row => row.type === "AikoHarnessAcquisitionRequested" && row.id === "acquire-probe");
  expect(acquisitionRequest.limits.wallMs).toBe(definitions.find(definition => definition.artifact.name === "media.probe")!.verifier.cases.length * mediaLifecycleBudgets.invocationWallMs);
  expect(acquisitionRequest.deadlineAt).toBeGreaterThan(acquisitionRequest.at + 30000);
  const library = new HarnessLibrary(libraryBinding, journal);
  const run = await library.run(
    acquired.harnessDigest as any,
    { asset: "video.mp4" },
    "fresh-probe",
    signal(),
  );
  expect(run.status).toBe("satisfied");
  expect(rows.some((e) => e.type === "AikoHarnessPromoted")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(
    (await fixture.bytes("video.mp4")).toString("base64"),
  );
}, 900000);

const whisper =
  process.env.MEDIA_HARNESS_PACKAGES && process.env.MEDIA_HARNESS_MODELS
    ? test
    : test.skip;
whisper(
  "offline pinned Whisper physically transcribes development/held-out speech and rejects silence hallucination",
  async () => {
    for (const id of ["speech", "held-out-speech", "silence", "no-audio"]) {
      const { receipt, checked } = await executeCase(id);
      if ((receipt.output as any).status === "transcribed") {
        const expected = fixture.fixtures.find((f) => f.id === id)!.expected;
        const wer = mediaWordErrorRate(
          expected.transcript!,
          (receipt.output as any).text,
        );
        console.log(
          JSON.stringify({
            fixture: id,
            wordErrorRate: wer,
            segments: (receipt.output as any).segments.length,
            evidence: checked.evidence,
          }),
        );
        expect(wer).toBeLessThanOrEqual(0.35);
      }
    }
  },
  120000,
);
