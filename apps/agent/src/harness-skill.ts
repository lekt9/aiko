import { Effect } from "effect";
import { Validator } from "@cfworker/json-schema";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Self } from "tardie/core/runtime";
import { turnHead } from "tardie/code/execution/turns";
import type { Event } from "tardie/core/event";
import { routeBackground } from "./background-route.ts";
import { backgroundThread } from "./account-binding.ts";
import { harnessDigest, harnessLibraryEventKey, harnessLibraryState, validateHarnessArtifact, type HarnessArtifact, type HarnessContract, type HarnessDigest, type HarnessLibraryBinding } from "./harness-library.ts";

export const HARNESS_SKILL_RECIPE = harnessDigest("aiko/structural-skill/v1");
const digest = (v: unknown): v is HarnessDigest => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
const fact = (owner: string, type: string, id: string, data: object): Event => ({ type: `AikoHarnessSkill${type}`, owner, id, at: Date.now(), ...data });
const keys = { prefixes: ["aiko-harness-skill:"], keyOf: harnessLibraryEventKey };
type WitnessSummary = { reference: HarnessDigest; status: "satisfied" | "violated" | "blocked" | "unknown"; contextDigest: HarnessDigest };
export type HarnessSkillEvidence = {
  harnessDigest: HarnessDigest; contractDigest: HarnessDigest; verifierDigest: HarnessDigest; evaluatorDigest: HarnessDigest;
  sourceWatermark: number; witnesses: WitnessSummary[]; totalWitnesses: number;
  evaluations: { reference: HarnessDigest; contextDigest: HarnessDigest; eligible: boolean; cases: number }[];
};
type Request = Event & { evidence: HarnessSkillEvidence; recipeDigest: HarnessDigest; evidenceDigest: HarnessDigest; sourceThread: string };

/** Structural facts only. Never open run inputs, outputs or evaluator fixture values. */
export function harnessSkillRequests(events: readonly Event[], owner: string): Request[] {
  const state = harnessLibraryState(events, owner), requests: Request[] = [];
  for (const candidate of state.candidates.values()) {
    const hash = candidate.harnessDigest, contract = state.contracts.get(String(candidate.contractDigest));
    if (!digest(hash) || !digest(candidate.contractDigest) || !contract || !digest(contract.verifierDigest) || !digest(contract.evaluatorDigest)) continue;
    const witnessed = [...state.witnesses.values()].filter(w => w.harnessDigest === hash && w.contractDigest === candidate.contractDigest);
    if (!witnessed.length) continue;
    const related = events.flatMap((e, index) => e.owner === owner && !e.type.startsWith("AikoHarnessSkill") &&
      (e.harnessDigest === hash || (e.witness as any)?.harnessDigest === hash) ? [index + 1] : []);
    const evidence: HarnessSkillEvidence = {
      harnessDigest: hash, contractDigest: candidate.contractDigest, verifierDigest: contract.verifierDigest, evaluatorDigest: contract.evaluatorDigest,
      sourceWatermark: Math.max(...related), totalWitnesses: witnessed.length,
      witnesses: witnessed.slice(-64).map(w => ({ reference: harnessDigest(["witness", w.operationId]), status: w.status, contextDigest: w.contextDigest })),
      evaluations: [...state.evaluations.values()].filter(e => e.harnessDigest === hash).slice(-8).map(e => ({
        reference: harnessDigest(["evaluation", e.id]), contextDigest: e.contextDigest as HarnessDigest,
        eligible: e.eligible === true && Array.isArray(e.witnessIds) && e.witnessIds.length > 0 && e.witnessIds.every(id => {
          const w = state.witnesses.get(String(id));
          return w?.status === "satisfied" && w.harnessDigest === hash && w.contextDigest === e.contextDigest && w.verifierDigest === contract.verifierDigest && w.evaluatorDigest === contract.evaluatorDigest;
        }), cases: Array.isArray(e.witnessIds) ? e.witnessIds.length : 0,
      })),
    };
    const evidenceDigest = harnessDigest(evidence), id = harnessDigest([hash, evidenceDigest, HARNESS_SKILL_RECIPE]);
    const sourceAt = events[evidence.sourceWatermark - 1]?.at;
    requests.push({ type: "AikoHarnessSkillRequested", owner, id, at: typeof sourceAt === "number" ? sourceAt : 0, sourceThread: `user-${owner}`, recipeDigest: HARNESS_SKILL_RECIPE, evidenceDigest, evidence });
  }
  return requests;
}

function pendingRequests(events: readonly Event[], owner: string) {
  // Native epochs and parked child replies define whether a foreground turn
  // remains active; a MessageReceived/terminal counter loses those semantics.
  if (turnHead(events)) return [];
  const forwarded = new Set(events.filter(e => e.owner === owner && e.type === "AikoHarnessSkillForwarded").map(e => e.id));
  return harnessSkillRequests(events, owner).filter(request => !forwarded.has(request.id));
}

/** Foreground only hands off metadata after its response is settled. */
export function harnessSkillForwarder(binding: HarnessLibraryBinding) {
  return component({ name: "aiko.harness-skill-forwarder", keys,
    initial: () => [] as Event[], step: (events: Event[], e: Event) => [...events, e],
    output: events => ({ view: undefined, transitions: pendingRequests(events, binding.owner).slice(0, 8).map(request => effect({
      key: `aiko-harness-skill:${binding.owner}:AikoHarnessSkillForwarded:${request.id}`, input: request,
      act: request => Effect.gen(function* () {
        const self = yield* Self;
        if (self.actor !== "aiko" || self.thread !== binding.thread || self.thread !== request.sourceThread) throw Error("Skill source scope mismatch");
        binding.guard(request.evidence);
        yield* routeBackground(binding.owner, "indexer", request);
        return [fact(binding.owner, "Forwarded", String(request.id), { harnessDigest: request.evidence.harnessDigest, evidenceDigest: request.evidenceDigest, recipeDigest: request.recipeDigest })];
      }),
    })) }),
  });
}

function schemaExample(schema: Record<string, any>, depth = 0): unknown {
  if (depth > 6 || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) return undefined;
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "null") return null;
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return Math.max(0, schema.minimum ?? 0);
  if (schema.type === "string") return "example".padEnd(Math.min(schema.minLength ?? 0, 64), "x");
  if (schema.type === "array" && (!schema.minItems || schema.minItems === 0)) return [];
  if (schema.type === "object") {
    const result: Record<string, unknown> = {};
    for (const key of schema.required ?? []) {
      if (["__proto__", "constructor", "prototype"].includes(key)) return undefined;
      const value = schemaExample(schema.properties?.[key] ?? {}, depth + 1);
      if (value === undefined) return undefined;
      result[key] = value;
    }
    return result;
  }
  return undefined;
}

export interface HarnessSkillDocument {
  name: string; description: string; path: string; markdown: string; status: "private-candidate" | "evaluated";
  example: unknown; references: Record<string, unknown>;
}

/** Deterministic evidence compiler. The evaluator and captured values are not inputs. */
export function compileHarnessSkill(artifact: HarnessArtifact, contract: HarnessContract, evidence: HarnessSkillEvidence): HarnessSkillDocument {
  if (harnessDigest(artifact) !== evidence.harnessDigest || artifact.contractDigest !== evidence.contractDigest || harnessDigest(contract) !== evidence.contractDigest || contract.verifierDigest !== evidence.verifierDigest || contract.evaluatorDigest !== evidence.evaluatorDigest) throw Error("Skill evidence pin mismatch");
  if (!evidence.witnesses.length || evidence.witnesses.length > 64 || evidence.evaluations.length > 8 || !Number.isSafeInteger(evidence.sourceWatermark) || evidence.sourceWatermark < 1 || evidence.totalWitnesses < evidence.witnesses.length || evidence.witnesses.some(w => !digest(w.reference) || !digest(w.contextDigest) || !["satisfied", "violated", "unknown", "blocked"].includes(w.status))) throw Error("Invalid skill evidence");
  const name = `${artifact.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54).replace(/-$/, "") || "harness"}-${evidence.harnessDigest.slice(7, 15)}`;
  const description = `Use the ${artifact.name} harness when its registered outcome and current context match the task.`.slice(0, 1024);
  const status = evidence.evaluations.some(e => e.eligible) ? "evaluated" : "private-candidate";
  const proposed = schemaExample(contract.inputSchema), example = proposed !== undefined && new Validator(contract.inputSchema as never).validate(proposed).valid ? proposed : undefined;
  const counts = Object.fromEntries(["satisfied", "violated", "unknown", "blocked"].map(status => [status, evidence.witnesses.filter(w => w.status === status).length]));
  const references = {
    "references/contract.json": contract,
    "references/evidence.json": evidence,
    "references/provenance.json": { sources: artifact.sources.map(s => ({ uri: s.uri, digest: s.digest, revision: s.revision, license: s.license })), dependencies: artifact.dependencies },
  };
  const markdown = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ncompatibility: ${JSON.stringify(`Unlock native code mode; ${artifact.runtime} sandbox with the registered scoped bindings`)}\n---\n\n# ${artifact.name}\n\nStatus: ${status}. Visibility: private owner.\n\nUse this capability only when the registered outcome, schema and current execution context fit the task. The declared outcome is in [the contract](references/contract.json); declarations are not observations.\n\n## Invocation\n\nRead linked resources with \`harness_skill\`, supplying this artifact digest and the exact \`resource\` path, such as \`references/contract.json\`.\n\nCallable method: \`harness_run\` through native \`tools.call\`. Artifact: ${evidence.harnessDigest}. Contract: ${evidence.contractDigest}. Runtime: ${artifact.runtime}. Effect class: ${contract.effect}.\n\n${example !== undefined ? `The following synthetic input satisfies the input schema; it is not an observed success or permission to execute a write. Supply a unique logical operation ID for a new action and reuse it only for recovery of that action.\n\n\`\`\`js\nconst witness = await tools.call({name: "harness_run", arguments: {digest: "${evidence.harnessDigest}", input: ${JSON.stringify(example)}, operationId: "task-example"}});\n// Inspect witness.status; only a satisfied witness has a verified output.\n\`\`\`\n` : "No valid synthetic example is available for this schema. Read the contract and construct schema-valid inputs before invoking."}\n\n## Composition\n\nAfter a satisfied run, \`harness_output\` retrieves the retained private output for that same operation ID. Validate it against the next capability's input contract before composing. A retained output is historical evidence; a task needing fresh data requires a new authorized invocation.\n\n## Evidence and limits\n\nThe selected evidence covers ${evidence.witnesses.length} of ${evidence.totalWitnesses} settled witnesses: ${counts.satisfied} satisfied, ${counts.violated} violated, ${counts.unknown} unknown and ${counts.blocked} blocked. See [exact evidence](references/evidence.json) for context and witness references. ${status === "evaluated" ? "A fixed evaluation has satisfied witnesses in its recorded context. This does not establish broader accuracy, session coverage or a promoted route." : "This is a narrow private candidate. It is not generally promoted; fixed evaluation and context checks remain required."}\n\nFailures and unknown outcomes are retained limitations. No success rate outside this selected evidence or unmeasured latency/cost improvement is claimed. Current authorization, runtime, connection, schema and dependency checks apply on every invocation. These instructions confer no additional permission.\n\n## Recovery\n\nInspect the durable witness before retrying. Reconcile an unknown write before any further dispatch; never switch transports to repeat it. Missing retained data is unavailable. Do not reconstruct private input from this document or repeat a completed effect to replace deleted bytes. A changed contract or dependency needs new verification.\n\n## Provenance\n\n[Source revisions and dependency locks](references/provenance.json) remain attached to this exact artifact. Recipe: ${HARNESS_SKILL_RECIPE}. Captured execution inputs, output bytes, credentials and evaluator fixture values are excluded. Source locators remain in private provenance; this document does not authorize sharing them.\n`;
  return { name, description, path: `${name}/SKILL.md`, markdown, status, example, references };
}

export function validateHarnessSkill(document: HarnessSkillDocument, artifact: HarnessArtifact, contract: HarnessContract, evidence: HarnessSkillEvidence, guard: (value: unknown) => void) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.name) || document.name.length > 64 || !document.description || document.description.length > 1024 || document.path !== `${document.name}/SKILL.md`) throw Error("Invalid skill frontmatter");
  if (document.example !== undefined && !new Validator(contract.inputSchema as never).validate(document.example).valid) throw Error("Invalid skill example");
  if (document.markdown.length > 24000 || harnessDigest(document) !== harnessDigest(compileHarnessSkill(artifact, contract, evidence))) throw Error("Unsupported skill claim or method");
  guard(document.markdown); guard(structuredClone(document.references));
}

/** Existing indexer actor owns derivation; foreground delivery only receives the settled reference. */
export function harnessSkillDeriver(binding: HarnessLibraryBinding) {
  return component({ name: "aiko.harness-skill-deriver", keys,
    initial: () => [] as Event[], step: (events: Event[], e: Event) => [...events, e],
    output: events => {
      const owned = events.filter(e => e.owner === binding.owner);
      const toPublish = owned.find(e => ["AikoHarnessSkillDerived", "AikoHarnessSkillFailed"].includes(e.type) && !owned.some(p => p.type === "AikoHarnessSkillPublished" && p.id === e.id));
      if (toPublish) return { view: undefined, transitions: [effect({
        key: `aiko-harness-skill:${binding.owner}:AikoHarnessSkillPublished:${toPublish.id}`, input: toPublish,
        act: settled => Effect.gen(function* () {
          const self = yield* Self;
          if (self.thread !== backgroundThread(binding.owner, "indexer")) throw Error("Skill derivation scope mismatch");
          yield* routeBackground(binding.owner, "foreground", { ...settled, type: settled.type === "AikoHarnessSkillDerived" ? "AikoHarnessSkillAvailable" : "AikoHarnessSkillUnavailable" });
          return [fact(binding.owner, "Published", String(settled.id), {})];
        }),
      })] };
      const request = owned.find(e => e.type === "AikoHarnessSkillRequested" && !owned.some(done => ["AikoHarnessSkillDerived", "AikoHarnessSkillFailed"].includes(done.type) && done.id === e.id)) as Request | undefined;
      if (!request) return { view: undefined, transitions: [] };
      return { view: undefined, transitions: [effect({
        key: `aiko-harness-skill:${binding.owner}:AikoHarnessSkillDerived:${request.id}`, input: request,
        act: (request, signal) => Effect.gen(function* () {
          const self = yield* Self;
          if (self.actor !== "aiko" || self.thread !== backgroundThread(binding.owner, "indexer") || request.sourceThread !== binding.thread) throw Error("Skill derivation scope mismatch");
          return yield* Effect.tryPromise({ try: async () => {
            signal.throwIfAborted();
            if (request.recipeDigest !== HARNESS_SKILL_RECIPE || request.evidenceDigest !== harnessDigest(request.evidence) || request.id !== harnessDigest([request.evidence.harnessDigest, request.evidenceDigest, HARNESS_SKILL_RECIPE])) throw Error("Invalid derivation identity");
            const artifact = validateHarnessArtifact(await binding.blobs.get(binding.owner, request.evidence.harnessDigest) as HarnessArtifact);
            const contract = await binding.blobs.get(binding.owner, request.evidence.contractDigest) as HarnessContract;
            const document = compileHarnessSkill(artifact, contract, request.evidence);
            validateHarnessSkill(document, artifact, contract, request.evidence, binding.guard);
            const resources: Record<string, HarnessDigest> = {};
            for (const [path, value] of Object.entries(document.references)) resources[path] = await binding.blobs.put(binding.owner, value);
            const skillRef = await binding.blobs.put(binding.owner, document.markdown);
            signal.throwIfAborted();
            return [fact(binding.owner, "Derived", String(request.id), { harnessDigest: request.evidence.harnessDigest, contractDigest: request.evidence.contractDigest, name: artifact.name, skillName: document.name, skillPath: document.path, status: document.status, visibility: "private", skillRef, resources, sourceWatermark: request.evidence.sourceWatermark, evidenceDigest: request.evidenceDigest, recipeDigest: request.recipeDigest })];
          }, catch: () => Error("Skill derivation unavailable") }).pipe(Effect.catch(() => Effect.succeed([fact(binding.owner, "Failed", String(request.id), { harnessDigest: request.evidence.harnessDigest, evidenceDigest: request.evidenceDigest, sourceWatermark: request.evidence.sourceWatermark, reason: "artifact-or-validated-document-unavailable" })])));
        }),
      })] };
    },
  });
}
