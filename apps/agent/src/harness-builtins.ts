import { harnessDigest, type HarnessArtifact, type HarnessCase, type HarnessContract, type HarnessVerifier } from "./harness-library.ts";

export interface BuiltinHarnessDefinition {
  artifact: HarnessArtifact;
  contract: HarnessContract;
  verifier: HarnessVerifier;
}

/** Trusted host templates. Candidate code cannot change these outcomes, cases or
 * checkers. They bootstrap a useful library; they do not verify arbitrary tasks. */
function definition(spec: {
  name: string;
  outcome: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  code: string;
  cases: HarnessCase[];
  check(input: any, output: any): boolean;
  applicability?: HarnessContract["applicability"];
}): BuiltinHarnessDefinition {
  const evaluatorDigest = harnessDigest(["unlock-builtin-evaluation/v1", spec.name, spec.cases]);
  const verifierDigest = harnessDigest(["unlock-builtin-verifier/v1", spec.name, spec.outcome, spec.check.toString()]);
  const contract: HarnessContract = {
    version: 1, outcome: spec.outcome, inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema, effect: "read", verifierDigest,
    evaluatorDigest, applicability: spec.applicability ?? { capability: spec.name, scope: "declared-input-semantics" }, timeoutMs: 5000,
  };
  const contractDigest = harnessDigest(contract);
  const artifact: HarnessArtifact = {
    version: 1, name: spec.name, description: spec.outcome, runtime: "javascript",
    entrypoint: "main.js", files: { "main.js": spec.code }, dependencies: [], contractDigest,
    sources: [{ uri: `unlock:builtins/${spec.name}`, revision: harnessDigest(spec.code), digest: harnessDigest(spec.code), license: "NOASSERTION" }],
  };
  const verifier: HarnessVerifier = {
    digest: verifierDigest, evaluatorDigest, cases: structuredClone(spec.cases),
    async verify({ contract: supplied, input, output }, signal) {
      signal.throwIfAborted();
      let passed = false;
      try { passed = harnessDigest(supplied) === contractDigest && spec.check(input, output) === true; } catch { /* A malformed result fails the fixed contract. */ }
      return { passed, evidence: [`trusted-builtin:${spec.name}:${passed ? "satisfied" : "violated"}`], quality: passed ? 1 : 0 };
    },
  };
  return { artifact, contract, verifier };
}

const textValue = { type: "object", properties: { text: { type: "string", maxLength: 16384 } }, required: ["text"], additionalProperties: false };
const definitions = [
  definition({
    name: "json.project", outcome: "Select the requested own fields from a JSON object; omit missing fields and preserve every selected value exactly.",
    inputSchema: { type: "object", properties: { value: { type: "object", maxProperties: 1024 }, keys: { type: "array", maxItems: 128, items: { type: "string", maxLength: 256 } } }, required: ["value", "keys"], additionalProperties: false },
    outputSchema: { type: "object", maxProperties: 128 },
    code: "const result = {}; for (const key of input.keys) if (Object.prototype.hasOwnProperty.call(input.value, key)) result[key] = input.value[key]; return result;",
    cases: [
      { id: "nested", split: "development", input: { value: { title: "Example", details: { n: 2 }, hidden: true }, keys: ["title", "details"] } },
      { id: "missing-and-repeat", split: "development", input: { value: { x: null }, keys: ["missing", "x", "x"] } },
      { id: "empty", split: "held-out", input: { value: { retained: [false, 0, ""] }, keys: [] } },
      { id: "array-and-unicode", split: "held-out", input: { value: { "音声": [0, null, false], omitted: 2 }, keys: ["音声", "absent"] } },
    ],
    check(input, output) {
      if (!output || typeof output !== "object" || Array.isArray(output)) return false;
      const selected = Object.keys(input.value).filter(key => input.keys.includes(key)).sort();
      return JSON.stringify(Object.keys(output).sort()) === JSON.stringify(selected) && selected.every(key => harnessDigest(output[key]) === harnessDigest(input.value[key]));
    },
  }),
  definition({
    name: "text.chunk", outcome: "Split text into consecutive bounded Unicode code-point chunks, preserving all characters and whitespace; empty text produces no chunks.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 16384 }, maxCharacters: { type: "integer", minimum: 1, maximum: 4096 } }, required: ["text", "maxCharacters"], additionalProperties: false },
    outputSchema: { type: "array", maxItems: 16384, items: { type: "string", minLength: 1, maxLength: 8192 } },
    code: "const chars = Array.from(input.text); const chunks = []; for (let i = 0; i < chars.length; i += input.maxCharacters) chunks.push(chars.slice(i, i + input.maxCharacters).join('')); return chunks;",
    cases: [
      { id: "ordinary", split: "development", input: { text: "one two three", maxCharacters: 4 } },
      { id: "empty", split: "development", input: { text: "", maxCharacters: 2 } },
      { id: "unicode", split: "held-out", input: { text: "🎧声\n a\t", maxCharacters: 2 } },
      { id: "exact", split: "held-out", input: { text: " abc ", maxCharacters: 5 } },
    ],
    check(input, output) {
      if (!Array.isArray(output) || !output.every(value => typeof value === "string") || output.join("") !== input.text) return false;
      const original = Array.from(input.text), emitted = output.flatMap(value => Array.from(value));
      if (original.length !== emitted.length || original.some((value, index) => value !== emitted[index])) return false;
      const lengths = output.map(value => [...value].length);
      return lengths.every((length, index) => length > 0 && length <= input.maxCharacters && (index === lengths.length - 1 || length === input.maxCharacters));
    },
  }),
  definition({
    name: "media.sample_times", outcome: "Plan evenly spaced midpoint timestamps within a media duration of at least one microsecond; zero duration produces no timestamps. Sampling plans do not establish video coverage or decode frames.",
    inputSchema: { type: "object", properties: { durationSeconds: { anyOf: [{ const: 0 }, { type: "number", minimum: 0.000001, maximum: 86400 }] }, count: { type: "integer", minimum: 1, maximum: 32 } }, required: ["durationSeconds", "count"], additionalProperties: false },
    outputSchema: { type: "object", properties: { timestamps: { type: "array", maxItems: 32, items: { type: "number", minimum: 0 } }, coverage: { const: "uniform-samples" }, exhaustive: { const: false } }, required: ["timestamps", "coverage", "exhaustive"], additionalProperties: false },
    code: "return { timestamps: input.durationSeconds === 0 ? [] : Array.from({length: input.count}, (_, i) => input.durationSeconds * (i + 0.5) / input.count), coverage: 'uniform-samples', exhaustive: false };",
    cases: [
      { id: "six-frames", split: "development", input: { durationSeconds: 60, count: 6 } },
      { id: "zero-duration", split: "development", input: { durationSeconds: 0, count: 6 } },
      { id: "short", split: "held-out", input: { durationSeconds: 0.125, count: 4 } },
      { id: "single", split: "held-out", input: { durationSeconds: 91.5, count: 1 } },
      { id: "microsecond", split: "held-out", input: { durationSeconds: 0.000001, count: 32 } },
    ],
    check(input, output) {
      if (output?.coverage !== "uniform-samples" || output.exhaustive !== false || !Array.isArray(output.timestamps)) return false;
      if (input.durationSeconds === 0) return output.timestamps.length === 0;
      const width = input.durationSeconds / input.count;
      return output.timestamps.length === input.count && output.timestamps.every((value: number, i: number) => Number.isFinite(value) && value > 0 && value < input.durationSeconds && Math.abs(value / width - i - 0.5) < 1e-10);
    },
  }),
  definition({
    name: "channel.text.echo", outcome: "Return exactly the authenticated typed input text as the checked output, without changing the reply destination or acquiring send authority.",
    inputSchema: { type: "object", properties: { value: textValue, schema: { const: "text.message.v1" }, correlation: { type: "string", maxLength: 512 } }, required: ["value", "schema", "correlation"], additionalProperties: false },
    outputSchema: textValue,
    applicability: { hook: { accepts: "text.message.v1", emits: "text.message.v1", inputSchema: textValue, effects: ["pure", "channel.reply"] } },
    code: "return { text: input.value.text };",
    cases: [
      { id: "ordinary", split: "development", input: { value: { text: "Hello" }, schema: "text.message.v1", correlation: "fixture-1" } },
      { id: "empty", split: "development", input: { value: { text: "" }, schema: "text.message.v1", correlation: "fixture-2" } },
      { id: "unicode", split: "held-out", input: { value: { text: "声 🎧\n" }, schema: "text.message.v1", correlation: "fixture-3" } },
    ],
    check(input, output) { return typeof output?.text === "string" && output.text === input.value.text && Object.keys(output).length === 1; },
  }),
];

/** Return isolated configuration objects. Verifier closure retains the original
 * fixed contract, so a consumer cannot grant a candidate an easier contract. */
export function builtinHarnessDefinitions(): readonly BuiltinHarnessDefinition[] {
  return definitions.map(({ artifact, contract, verifier }) => ({
    artifact: structuredClone(artifact), contract: structuredClone(contract),
    verifier: { ...verifier, cases: structuredClone(verifier.cases) },
  }));
}

export function builtinHarnessCatalog(): { name: string; contractDigest: string; contract: HarnessContract; seedDigest: string; status: "trusted-template" }[] {
  return definitions.map(({ artifact, contract }) => ({ name: artifact.name, contractDigest: harnessDigest(contract), contract: structuredClone(contract), seedDigest: harnessDigest(artifact), status: "trusted-template" }));
}
