import { createHash } from "node:crypto";

/** Host-created source metadata for context prepared before native inference. */
export interface CodeInferenceSource {
  tool: string;
  definitionDigest: string;
  arguments: unknown;
}

const sourcesKey = Symbol("aiko.native-inference-sources");
type WithSources = { [sourcesKey]?: readonly CodeInferenceSource[] };

export function codeInferenceSource(spec: { name: string }, args: unknown): CodeInferenceSource {
  const encoded = JSON.stringify(args);
  if (encoded === undefined || Buffer.byteLength(encoded) > 131072) throw Error("Inference source selectors exceed their bound");
  return { tool: spec.name, definitionDigest: `sha256:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`,
    arguments: JSON.parse(encoded) };
}

/** Symbols survive trusted request spreads but cannot be supplied by JSON/model output. */
export function withCodeInferenceSources<T extends object>(request: T, sources: readonly CodeInferenceSource[]): T {
  const all = [...codeInferenceSourcesOf(request), ...sources];
  if (all.length > 2048) throw Error("Inference source limit exceeded");
  return Object.assign({ ...request }, { [sourcesKey]: structuredClone(all) });
}

export function codeInferenceSourcesOf(request: object): readonly CodeInferenceSource[] {
  return (request as WithSources)[sourcesKey] ?? [];
}
