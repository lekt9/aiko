import { Validator } from "@cfworker/json-schema";
import {
  harnessDigest,
  type HarnessDigest,
  type HarnessJson,
  type HarnessContract,
} from "./harness-library.ts";
import type { BuiltinHarnessDefinition } from "./harness-builtins.ts";

export type MediaCapability =
  "media.probe" | "media.frames" | "media.transcribe";
export type MediaReference = {
  status:
    | "ok"
    | "invalid_media"
    | "no_video"
    | "no_audio"
    | "no_speech"
    | "transcribed"
    | "physical_audio"
    | "unsupported_language"
    | "unsupported_duration";
  durationSeconds?: number;
  durationTolerance?: number;
  streams?: Record<string, string | number>[];
  frames?: {
    atSeconds: number;
    toleranceSeconds: number;
    width: number;
    height: number;
    /** Exact independent RGB24 digest, or a known solid-color fixture bound. */
    pixelDigest?: HarnessDigest;
    solidRgb?: [number, number, number];
    colorTolerance?: number;
  }[];
  speechSeconds?: number;
  regions?: { startSeconds: number; endSeconds: number }[];
  transcript?: string;
  maxWordErrorRate?: number;
};
export interface MediaFixture {
  id: string;
  split: "development" | "held-out";
  capability: MediaCapability;
  input: HarnessJson;
  expected: MediaReference;
}
/** Cold v2 reconstruction is inside the job's resource scope. These are ceilings,
 * not grants: the host's smaller current budget and caller deadline still win. */
export const mediaLifecycleBudgets = Object.freeze({ jobWallMs: 60000, invocationWallMs: 120000, maxAdmissionWallMs: 1800000 });
export function mediaAcquisitionWallMs(definition: BuiltinHarnessDefinition): number {
  // All fixed cases remain required; verification can include an independent job.
  return definition.verifier.cases.length * definition.contract.timeoutMs;
}
export function mediaProcessingWallMs(definitions: readonly BuiltinHarnessDefinition[]): number {
  return definitions.reduce((total, definition) => total + mediaAcquisitionWallMs(definition) + definition.contract.timeoutMs, 0);
}
export interface MediaHarnessConfig {
  /** Frozen model/language policy; default preserves the English-only artifact. */
  languages?: readonly string[];
  transcriptionName?: string;
  selectionLanguages?: readonly string[];
  modelPath: string;
  modelRevision: string;
  fixtures: readonly MediaFixture[];
  /** Pins the separate trusted inspector implementation and runtime. */
  evidenceDigest?: HarnessDigest;
  /** Trusted independent inspection of owned input bytes for non-evaluation runs.
   * No candidate-supplied reference answers. Undefined fails closed. */
  reference?(
    capability: MediaCapability,
    input: HarnessJson,
    signal: AbortSignal,
  ): Promise<MediaReference | undefined>;
  /** Independent bounded image decoder; inspect every decoded RGB24 pixel.
   * A JPEG header or a claimed timestamp alone is not extraction evidence. */
  decodeFrame(
    data: string,
    signal: AbortSignal,
  ): Promise<{
    width: number;
    height: number;
    pixelDigest: HarnessDigest;
    minRgb: [number, number, number];
    maxRgb: [number, number, number];
  }>;
}

const digest = /^sha256:[a-f0-9]{64}$/;
const asset = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,120}$" };
const inputSchemas: Record<MediaCapability, Record<string, unknown>> = {
  "media.probe": {
    type: "object",
    properties: { asset },
    required: ["asset"],
    additionalProperties: false,
  },
  "media.frames": {
    type: "object",
    properties: {
      asset,
      timestamps: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: { type: "number", minimum: 0, maximum: 600 },
      },
    },
    required: ["asset", "timestamps"],
    additionalProperties: false,
  },
  "media.transcribe": {
    type: "object",
    properties: { asset, language: { const: "en" } },
    required: ["asset"],
    additionalProperties: false,
  },
};
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const seconds = { type: "number", minimum: 0, maximum: 600.25 };
const invalid = object({
  status: { const: "invalid_media" },
  reason: { const: "decode_failed" },
});
const outputSchemas: Record<MediaCapability, Record<string, unknown>> = {
  "media.probe": {
    anyOf: [
      invalid,
      object({
        status: { const: "ok" },
        durationSeconds: seconds,
        hasAudio: { type: "boolean" },
        hasVideo: { type: "boolean" },
        streams: {
          type: "array",
          maxItems: 32,
          items: {
            anyOf: [
              object({
                index: { type: "integer", minimum: 0 },
                kind: { const: "video" },
                codec: { type: "string", maxLength: 64 },
                width: { type: "integer", minimum: 1 },
                height: { type: "integer", minimum: 1 },
              }),
              object({
                index: { type: "integer", minimum: 0 },
                kind: { const: "audio" },
                codec: { type: "string", maxLength: 64 },
                sample_rate: { type: "integer", minimum: 1 },
                channels: { type: "integer", minimum: 1 },
              }),
            ],
          },
        },
      }),
    ],
  },
  "media.frames": {
    anyOf: [
      invalid,
      object({
        status: { const: "no_video" },
        durationSeconds: seconds,
        frames: { type: "array", maxItems: 0 },
      }),
      object({
        status: { const: "ok" },
        durationSeconds: seconds,
        frames: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: object({
            requestedSeconds: seconds,
            atSeconds: seconds,
            mimeType: { const: "image/jpeg" },
            data: { type: "string", maxLength: 262144 },
            bytes: { type: "integer", minimum: 1, maximum: 196608 },
          }),
        },
        coverage: object({
          kind: { const: "decoded-requested-frames" },
          exhaustive: { const: false },
          requested: { type: "integer", minimum: 1, maximum: 16 },
          decoded: { type: "integer", minimum: 1, maximum: 16 },
        }),
      }),
    ],
  },
  "media.transcribe": {
    anyOf: [
      invalid,
      object({
        status: { const: "no_audio" },
        durationSeconds: seconds,
        text: { const: "" },
        segments: { type: "array", maxItems: 0 },
      }),
      object({
        status: { enum: ["transcribed", "no_speech"] },
        durationSeconds: seconds,
        text: { type: "string", maxLength: 64000 },
        segments: {
          type: "array",
          maxItems: 256,
          items: object({
            startSeconds: seconds,
            endSeconds: seconds,
            text: { type: "string", minLength: 1, maxLength: 64000 },
            noSpeechProbability: { type: "number", minimum: 0, maximum: 1 },
            avgLogProbability: { type: "number", maximum: 0 },
            compressionRatio: { type: "number", minimum: 0 },
          }),
        },
        language: { const: "en" },
        modelRevision: { type: "string", pattern: "^[a-f0-9]{40}$" },
        coverage: { const: "full-audio-vad" },
        speechSeconds: seconds,
      }),
    ],
  },
};
const outcomes: Record<MediaCapability, string> = {
  "media.probe":
    "Probe owned media bytes with FFprobe; report actual audio/video streams and duration, or explicit invalid media. Never infer streams from an extension.",
  "media.frames":
    "Decode real bounded JPEG frames at or after requested media-relative timestamps; preserve observed timestamps and disclose non-exhaustive sampled coverage. Frame pixels must match independent input evidence.",
  "media.transcribe":
    "Transcribe owned English audio offline with the locked Whisper model, preserving timed segments; distinguish absent audio and no detected speech. Evaluation measures word error against fixed references. Normal runs verify pinned execution, physical VAD coverage and confidence; semantic accuracy is unmeasured without a reference.",
};

/** Ordinary Levenshtein WER, normalized only for case/punctuation/whitespace. */
export function mediaWordErrorRate(
  reference: string,
  hypothesis: string,
): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const expected = words(reference),
    actual = words(hypothesis);
  if (!expected.length) return actual.length ? Infinity : 0;
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const row = [i];
    for (let j = 1; j <= actual.length; j++)
      row[j] = Math.min(
        row[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[actual.length]! / expected.length;
}
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

async function checkMedia(
  capability: MediaCapability,
  input: any,
  output: any,
  expected: MediaReference,
  modelRevision: string,
  decode: MediaHarnessConfig["decodeFrame"],
  signal: AbortSignal,
) {
  const physical = expected.status === "physical_audio" && capability === "media.transcribe";
  if (!output || (!physical && output.status !== expected.status)) return { passed: false };
  if (expected.status === "unsupported_language") return {passed: output.requestedLanguage === input.language};
  if (expected.status === "unsupported_duration") return {passed: output.limitSeconds === 600};
  if (expected.status === "invalid_media")
    return {
      passed:
        output.reason === "decode_failed" && Object.keys(output).length === 2,
    };
  if (
    !finite(output.durationSeconds) ||
    !finite(expected.durationSeconds) ||
    Math.abs(output.durationSeconds - expected.durationSeconds) >
      (expected.durationTolerance ?? 0.05)
  )
    return { passed: false };
  if (capability === "media.probe") {
    const streams = expected.streams;
    return {
      passed:
        !!streams &&
        harnessDigest(output.streams) === harnessDigest(streams) &&
        output.hasAudio === streams.some((s) => s.kind === "audio") &&
        output.hasVideo === streams.some((s) => s.kind === "video"),
    };
  }
  if (capability === "media.frames") {
    if (expected.status === "no_video")
      return {
        passed: Array.isArray(output.frames) && output.frames.length === 0,
      };
    if (
      output.coverage?.kind !== "decoded-requested-frames" ||
      output.coverage.exhaustive !== false ||
      output.coverage.requested !== input.timestamps.length ||
      output.coverage.decoded !== input.timestamps.length ||
      !Array.isArray(output.frames) ||
      output.frames.length !== input.timestamps.length ||
      expected.frames?.length !== output.frames.length
    )
      return { passed: false };
    for (let i = 0; i < output.frames.length; i++) {
      const frame = output.frames[i],
        ref = expected.frames![i]!;
      if (
        frame.requestedSeconds !== input.timestamps[i] ||
        !finite(frame.atSeconds) ||
        frame.atSeconds < input.timestamps[i] - 0.00001 ||
        frame.atSeconds >= output.durationSeconds ||
        Math.abs(frame.atSeconds - ref.atSeconds) > ref.toleranceSeconds ||
        frame.mimeType !== "image/jpeg" ||
        typeof frame.data !== "string" ||
        frame.data.length > 262144 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)
      )
        return { passed: false };
      const bytes = Buffer.from(frame.data, "base64");
      if (
        bytes.length !== frame.bytes ||
        bytes.toString("base64") !== frame.data
      )
        return { passed: false };
      const pixels = await decode(frame.data, signal);
      if (pixels.width !== ref.width || pixels.height !== ref.height)
        return { passed: false };
      if (ref.pixelDigest) {
        if (
          !digest.test(ref.pixelDigest) ||
          pixels.pixelDigest !== ref.pixelDigest
        )
          return { passed: false };
      } else if (
        ref.solidRgb &&
        finite(ref.colorTolerance) &&
        ref.colorTolerance >= 0 &&
        ref.colorTolerance <= 16
      ) {
        if (
          pixels.minRgb.length !== 3 ||
          pixels.maxRgb.length !== 3 ||
          ref.solidRgb.some(
            (value, j) =>
              !finite(pixels.minRgb[j]) ||
              !finite(pixels.maxRgb[j]) ||
              pixels.minRgb[j]! < value - ref.colorTolerance! ||
              pixels.maxRgb[j]! > value + ref.colorTolerance!,
          )
        )
          return { passed: false };
      } else return { passed: false };
    }
    return { passed: true };
  }
  if (
    !Array.isArray(output.segments) ||
    output.segments.length > 256 ||
    typeof output.text !== "string" ||
    output.text.length > 64000
  )
    return { passed: false };
  if (expected.status === "no_audio")
    return { passed: output.text === "" && output.segments.length === 0 };
  if (
    output.modelRevision !== modelRevision ||
    output.language !== (input.language ?? "en") ||
    output.coverage !== "full-audio-vad" ||
    !finite(output.speechSeconds) ||
    output.speechSeconds < 0 ||
    output.speechSeconds > output.durationSeconds + 0.25
  )
    return { passed: false };
  if (physical) {
    if (!finite(expected.speechSeconds) || !Array.isArray(expected.regions) ||
        Math.abs(output.speechSeconds - expected.speechSeconds) > 0.05) return { passed: false };
    if (expected.speechSeconds === 0) return { passed: output.status === "no_speech" && output.text === "" && output.segments.length === 0, unmeasured: true };
    if (output.status !== "transcribed") return { passed: false };
  }
  if (expected.status === "no_speech")
    return { passed: output.text === "" && output.segments.length === 0 };
  let end = 0;
  for (const segment of output.segments) {
    if (
      !finite(segment.startSeconds) ||
      !finite(segment.endSeconds) ||
      segment.startSeconds < end - 0.02 ||
      segment.endSeconds < segment.startSeconds ||
      segment.endSeconds > output.durationSeconds + 0.25 ||
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      !finite(segment.noSpeechProbability) ||
      segment.noSpeechProbability < 0 ||
      segment.noSpeechProbability > 1 ||
      !finite(segment.avgLogProbability) || segment.avgLogProbability > 0 ||
      !finite(segment.compressionRatio) || segment.compressionRatio < 0
    )
      return { passed: false };
    end = segment.endSeconds;
  }
  if (physical) {
    const segments = output.segments;
    // Fixed confidence bounds are diagnostics, never measured transcription accuracy.
    // Every physical VAD region must overlap a returned segment; do not certify omitted speech.
    return { passed: segments.length > 0 && output.text === segments.map((s: any) => s.text).join(" ") &&
      segments.every((s: any) => s.noSpeechProbability <= 0.6 && s.avgLogProbability >= -1 && s.compressionRatio <= 2.4) &&
      expected.regions!.length > 0 && expected.regions!.every(r => {
        let cursor = r.startSeconds, touched = false;
        for (const s of segments) {
          if (s.endSeconds < cursor) continue;
          if (s.startSeconds > cursor + 0.5) break;
          touched = true; cursor = Math.max(cursor, s.endSeconds);
          if (cursor >= r.endSeconds - 0.5) return true;
        }
        return touched && cursor >= r.endSeconds - 0.5;
      }), unmeasured: true };
  }
  if (
    !output.segments.length ||
    output.text !== output.segments.map((s: any) => s.text).join(" ") ||
    !expected.transcript ||
    !finite(expected.maxWordErrorRate) ||
    expected.maxWordErrorRate < 0 ||
    expected.maxWordErrorRate > 0.5
  )
    return { passed: false };
  const wer = mediaWordErrorRate(expected.transcript, output.text);
  return { passed: wer <= expected.maxWordErrorRate, wer };
}

/** Seed definitions for HarnessAcquisition, never per-artifact application handlers.
 * Caller installs verifiers in its trusted registry before acquisition. Fixtures and
 * independent reference inspectors stay outside candidate source, registry prose and tools. */
export function mediaHarnessDefinitions(
  runtimeLockDigest: HarnessDigest,
  sourceCode: string,
  trusted: MediaHarnessConfig,
): readonly BuiltinHarnessDefinition[] {
  if (
    !digest.test(runtimeLockDigest) ||
    !sourceCode.trim() ||
    !/^\/models\/[A-Za-z0-9_.-]+$/.test(trusted.modelPath) ||
    !/^[a-f0-9]{40}$/.test(trusted.modelRevision)
  )
    throw Error("Invalid pinned media configuration");
  const config = { ...trusted, fixtures: structuredClone(trusted.fixtures) };
  const languages = [...(trusted.languages ?? ["en"])];
  if (!languages.includes("en") || new Set(languages).size !== languages.length || languages.some(l => !/^[a-z]{2,3}$/.test(l)) ||
      trusted.transcriptionName && !/^media\.transcribe(?:\.[a-z0-9-]+)?$/.test(trusted.transcriptionName) ||
      trusted.selectionLanguages?.some(l => !languages.includes(l))) throw Error("Invalid frozen media language policy");
  return (Object.keys(outcomes) as MediaCapability[]).map((capability) => {
    const fixtures = config.fixtures.filter((f) => f.capability === capability);
    if (
      !fixtures.some((f) => f.split === "development") ||
      !fixtures.some((f) => f.split === "held-out") ||
      fixtures.length > 16 ||
      new Set(fixtures.map((f) => f.id)).size !== fixtures.length
    )
      throw Error(`Fixed media cases unavailable: ${capability}`);
    const selectedInput = structuredClone(inputSchemas[capability]) as any;
    const selectedOutput = structuredClone(outputSchemas[capability]) as any;
    if(capability === "media.transcribe") {
      selectedInput.properties.language = {enum:languages};
      selectedOutput.anyOf.find((branch:any)=>branch.properties.language).properties.language = {enum:languages};
      selectedOutput.anyOf.push(object({status:{const:"unsupported_duration"},limitSeconds:{const:600}}));
      selectedOutput.anyOf.push(object({status:{const:"unsupported_language"},requestedLanguage:{type:"string",maxLength:16}}));
    }
    const evaluatorDigest = harnessDigest([
      "media-evaluation/v1",
      capability,
      fixtures,
    ]);
    const verifierDigest = harnessDigest([
      "media-verifier/v1",
      capability,
      checkMedia.toString(),
      mediaWordErrorRate.toString(),
      config.modelRevision,
      languages,
      config.decodeFrame.toString(),
      config.reference?.toString() ?? "no-runtime-reference",
      config.evidenceDigest ?? null,
    ]);
    const contract: HarnessContract = {
      version: 1,
      outcome: capability === "media.transcribe" ? outcomes[capability].replace("English",languages.join("/")) : outcomes[capability],
      inputSchema: selectedInput,
      outputSchema: selectedOutput,
      effect: "read",
      verifierDigest,
      evaluatorDigest,
      applicability: {
        capability,
        runtimeLockDigest,
        scope: "owned-private-media",
        maxInputBytes: 67108864,
        maxDurationSeconds: 600,
        media: {
          version: 1,
          ...(capability === "media.transcribe" ? {languages:[...(config.selectionLanguages ?? languages)]} : {}),
          priority: { "media.probe": 0, "media.frames": 1, "media.transcribe": 2 }[capability],
          accepts: ["audio/", "video/", "application/octet-stream"],
          ...(capability === "media.probe" ? {} : { requires: { capability: "media.probe", field: capability === "media.frames" ? "hasVideo" : "hasAudio", equals: true } }),
          inputs: { asset: { source: "asset" }, ...(capability === "media.transcribe" ? {language:{source:"language"}} : {}), ...(capability === "media.frames" ? { timestamps: { source: "fractions", capability: "media.probe", field: "durationSeconds", fractions: [0.1, 0.5, 0.9] } } : {}) },
        },
      },
      timeoutMs: mediaLifecycleBudgets.invocationWallMs,
    };
    const contractDigest = harnessDigest(contract);
    const functionName = {
      "media.probe": "run_probe",
      "media.frames": "run_frames",
      "media.transcribe": "run_transcribe",
    }[capability];
    const code = `from media_harness import ${functionName}\n\ndef run(input):\n    return ${functionName}(input${capability === "media.transcribe" ? `, ${JSON.stringify(config.modelPath)}, ${JSON.stringify(config.modelRevision)}, ${JSON.stringify(languages)}` : ""})\n`;
    const definition: BuiltinHarnessDefinition = {
      contract,
      artifact: {
        version: 1,
        name: capability === "media.transcribe" ? config.transcriptionName ?? capability : capability,
        description: contract.outcome,
        runtime: "python",
        entrypoint: "main.py",
        files: { "main.py": code, "media_harness.py": sourceCode },
        dependencies: [
          { name: "media_harness.py", digest: harnessDigest(sourceCode) },
        ],
        contractDigest,
        sources: [
          {
            uri: "unlock:media/media-harness.py",
            revision: harnessDigest(sourceCode),
            digest: harnessDigest(sourceCode),
            license: "NOASSERTION",
          },
        ],
      },
      verifier: {
        digest: verifierDigest,
        evaluatorDigest,
        cases: fixtures.map(({ id, split, input }) => ({
          id,
          split,
          input: structuredClone(input),
        })),
        async verify({ contract: supplied, artifactDigest, input, output, caseId }, signal) {
          signal.throwIfAborted();
          let checked: { passed: boolean; wer?: number; unmeasured?: boolean } = { passed: false };
          try {
            if (
              harnessDigest(supplied) !== contractDigest ||
              !new Validator(selectedInput as any).validate(input)
                .valid ||
              !new Validator(selectedOutput as any).validate(output)
                .valid
            )
              throw Error("media_contract_mismatch");
            const fixture = caseId
              ? fixtures.find(
                  (f) =>
                    f.id === caseId &&
                    harnessDigest(f.input) === harnessDigest(input),
                )
              : undefined;
            const reference = caseId
              ? fixture?.expected
              : await config.reference?.(capability, input, signal);
            if (!caseId && capability === "media.transcribe" && reference?.status === "physical_audio" &&
                (!config.evidenceDigest || artifactDigest !== trustedSeedDigest)) throw Error("Unmeasured transcription requires exact trusted seed execution");
            if (reference)
              checked = await checkMedia(
                capability,
                input,
                output,
                reference,
                config.modelRevision,
                config.decodeFrame,
                signal,
              );
          } catch {
            /* Value-free failed witness; no private transcript, pixels or paths. */
          }
          return {
            passed: checked.passed,
            quality: checked.unmeasured ? null : checked.passed ? 1 : 0,
            evidence: [
              `trusted-media:${capability}:${checked.passed ? "satisfied" : "violated"}`,
              ...(checked.unmeasured ? ["physical-coverage-confidence-checked", "semantic-accuracy-unmeasured", `language-scope:${languages.join(",")}`] : []),
              ...(checked.wer === undefined
                ? []
                : [`wer:${checked.wer.toFixed(6)}`]),
            ],
          };
        },
      },
    };
    const trustedSeedDigest = harnessDigest(definition.artifact);
    return definition;
  });
}
