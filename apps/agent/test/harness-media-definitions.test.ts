import { expect, test } from "bun:test";
import {
  mediaHarnessDefinitions,
  mediaAcquisitionWallMs,
  mediaProcessingWallMs,
  mediaLifecycleBudgets,
  mediaWordErrorRate,
  type MediaFixture,
  type MediaHarnessConfig,
} from "../src/harness-media.ts";
import { harnessDigest } from "../src/harness-library.ts";
import {
  mediaModelPin,
  mediaPackagePin,
  mediaRuntimeLockMetadata,
} from "../src/harness-media-lock.ts";

const fixtures: MediaFixture[] = [
  "media.probe",
  "media.frames",
  "media.transcribe",
].flatMap((capability) =>
  ["development", "held-out"].map(
    (split) =>
      ({
        id: `${capability}:${split}`,
        capability,
        split,
        input:
          capability === "media.frames"
            ? { asset: `${split}.bin`, timestamps: [0] }
            : { asset: `${split}.bin` },
        expected: { status: "invalid_media" },
      }) as MediaFixture,
  ),
);
const configuration = (): MediaHarnessConfig => ({
  modelPath: "/models/whisper-tiny.en",
  modelRevision: mediaModelPin.revision,
  fixtures: structuredClone(fixtures),
  decodeFrame: async () => {
    throw Error("No trusted frame decoder in this contract fixture");
  },
});

test("candidate source cannot alter fixed media contracts or evaluation answers", async () => {
  const original = configuration();
  const definitions = mediaHarnessDefinitions(
    harnessDigest("runtime"),
    "def run_probe(input): return {}",
    original,
  );
  const candidate = mediaHarnessDefinitions(
    harnessDigest("runtime"),
    "def run_probe(input): return {'status':'ok'}",
    original,
  );
  expect(candidate.map((d) => d.contract)).toEqual(
    definitions.map((d) => d.contract),
  );
  expect(candidate.map((d) => harnessDigest(d.artifact))).not.toEqual(
    definitions.map((d) => harnessDigest(d.artifact)),
  );
  original.fixtures[0]!.expected.status = "ok";
  const probe = definitions[0]!,
    input = { asset: "development.bin" };
  const verify = (output: any, caseId?: string) =>
    probe.verifier.verify(
      {
        contract: probe.contract,
        artifactDigest: harnessDigest(probe.artifact),
        input,
        output,
        caseId,
      },
      AbortSignal.timeout(1000),
    );
  expect(
    (
      await verify(
        { status: "invalid_media", reason: "decode_failed" },
        "media.probe:development",
      )
    ).passed,
  ).toBe(true);
  expect(
    (await verify({ status: "ok" }, "media.probe:development")).passed,
  ).toBe(false);
  expect(
    (
      await verify(
        {
          status: "invalid_media",
          reason: "decode_failed",
          privateDump: "unexpected",
        },
        "media.probe:development",
      )
    ).passed,
  ).toBe(false);
  expect(
    (await verify({ status: "invalid_media", reason: "decode_failed" })).passed,
  ).toBe(false);
  expect(JSON.stringify(probe.contract)).not.toContain("development.bin");
  expect(probe.artifact.files["main.py"]).not.toContain("development.bin");
});

test("media quality metric counts real word edits and does not excuse silence hallucination", () => {
  expect(mediaWordErrorRate("The blue book.", "the blue book")).toBe(0);
  expect(mediaWordErrorRate("The blue book.", "the red book")).toBeCloseTo(
    1 / 3,
  );
  expect(mediaWordErrorRate("the blue book", "blue")).toBeCloseTo(2 / 3);
  expect(mediaWordErrorRate("", "hallucination")).toBe(Infinity);
  expect(mediaWordErrorRate("", "")).toBe(0);
});

test("media definitions reject missing held-out cases, caller model paths and unpinned runtime", () => {
  expect(() =>
    mediaHarnessDefinitions("unlocked" as any, "source", configuration()),
  ).toThrow();
  expect(() =>
    mediaHarnessDefinitions(harnessDigest("runtime"), "source", {
      ...configuration(),
      modelPath: "https://model.invalid/model",
    }),
  ).toThrow();
  expect(() =>
    mediaHarnessDefinitions(harnessDigest("runtime"), "source", {
      ...configuration(),
      fixtures: fixtures.filter((f) => f.split === "development"),
    }),
  ).toThrow();
});

test("public model lock contains immutable model and wheel pins, never an unversioned download", () => {
  expect(mediaModelPin.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(mediaModelPin.files["model.bin"].sha256).toBe(
    "1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a",
  );
  expect(mediaPackagePin.version).toBe("1.2.0");
  expect(() =>
    mediaRuntimeLockMetadata({
      python: { version: "3.13", executableSha256: "unverified" },
    } as any),
  ).toThrow();
});

test("cold media lifecycle declares every evaluation and normal-run invocation without increasing a host grant", () => {
  const definitions = mediaHarnessDefinitions(harnessDigest("runtime"), "def run_probe(input): return {}", configuration());
  expect(definitions.every(d => d.contract.timeoutMs === 120000)).toBe(true);
  expect(mediaLifecycleBudgets.jobWallMs).toBe(60000);
  expect(definitions.map(mediaAcquisitionWallMs)).toEqual([240000,240000,240000]);
  expect(mediaProcessingWallMs(definitions)).toBe(1080000);
  expect(mediaProcessingWallMs(definitions)).toBeLessThanOrEqual(mediaLifecycleBudgets.maxAdmissionWallMs);
  expect(definitions.every(d => d.contract.effect === "read")).toBe(true);
});

test("multilingual catalog freezes declared languages and preserves default English routing", async () => {
  const defaults = mediaHarnessDefinitions(harnessDigest("runtime"),"source",configuration());
  const configured = {...configuration(),languages:["en","es"],selectionLanguages:["es"],transcriptionName:"media.transcribe.multilingual"};
  const variant = mediaHarnessDefinitions(harnessDigest("runtime"),"source",configured).find(d => d.artifact.name === "media.transcribe.multilingual")!;
  expect((defaults[2]!.contract.applicability.media as any).languages).toEqual(["en"]);
  expect((variant.contract.applicability.media as any).languages).toEqual(["es"]);
  expect((variant.contract.inputSchema as any).properties.language.enum).toEqual(["en","es"]);
  expect(variant.artifact.files["main.py"]).toContain('["en","es"]');
  configured.languages.push("fr");
  expect((variant.contract.inputSchema as any).properties.language.enum).toEqual(["en","es"]);
  expect(() => mediaHarnessDefinitions(harnessDigest("runtime"),"source",{...configuration(),languages:["en","es"],selectionLanguages:["fr"]})).toThrow();
  expect(() => mediaHarnessDefinitions(harnessDigest("runtime"),"source",{...configuration(),transcriptionName:"unrelated.install"})).toThrow();
  expect(mediaWordErrorRate("Los niños tienen mucha imaginación", "Los ninos tienen mucha imaginacion")).toBe(0.4);
});

test("multilingual model metadata pins the unchanged resolved dependency lock", async () => {
  const pins = await Bun.file(new URL("../assets/media-multilingual-model.lock.json",import.meta.url)).json();
  const lock = await Bun.file(new URL("../assets/media-requirements.lock",import.meta.url)).arrayBuffer();
  const {createHash} = await import("node:crypto");
  expect(createHash("sha256").update(Buffer.from(lock)).digest("hex")).toBe(pins.runtimeDependenciesSha256);
  expect(pins.model.revision).toBe("d90ca5fe260221311c53c58e660288d3deb8d356");
  expect(pins.model.license).toBe("MIT");
  expect(pins.model.files["model.bin"].sha256).toBe("dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1");
});
