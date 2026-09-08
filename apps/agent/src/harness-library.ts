import { harnessExperimentAppendAllowed } from "./harness-experiment-log.ts";
import { createHash, randomUUID } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { component } from "tardie/core/component";
import { canonicalStringify } from "@unbrowse/browser-harness/har";
import type { WorkflowKV } from "./workflow-host.ts";

export type HarnessJson = null | boolean | number | string | HarnessJson[] | { [key: string]: HarnessJson };
export type HarnessDigest = `sha256:${string}`;
export const harnessDigest = (value: unknown): HarnessDigest =>
  `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const sourcePathAllowed = (path: unknown): path is string => typeof path === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) && path.split("/").every(p => p !== "." && p !== "..");

/** Immutable code and locks. Private inputs and model outputs never belong here. */
export interface HarnessArtifact {
  version: 1;
  name: string;
  description: string;
  runtime: "javascript" | "python" | "network";
  runtimeLockDigest?: HarnessDigest;
  entrypoint: string;
  files: Record<string, string>;
  dependencies: { name: string; digest: HarnessDigest }[];
  sources: { uri: string; revision: string; digest: HarnessDigest; license: string }[];
  contractDigest: HarnessDigest;
}
export interface HarnessContract {
  version: 1;
  outcome: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: "read" | "write" | "mixed";
  verifierDigest: HarnessDigest;
  evaluatorDigest: HarnessDigest;
  applicability: Record<string, HarnessJson>;
  timeoutMs: number;
}
export interface HarnessContext {
  placement: "local" | "codegraff";
  runtimeDigest: HarnessDigest;
  bindings: Record<string, HarnessJson>;
}
export interface HarnessBlobStore {
  put(owner: string, value: unknown): Promise<HarnessDigest>;
  putPrivate(owner: string, value: unknown): Promise<HarnessDigest>;
  get(owner: string, digest: HarnessDigest): Promise<unknown>;
}
/** Seals retained data in existing private KV custody. Supply a separately held key for off-store key custody. */
export function harnessBlobStore(kv: WorkflowKV, externalKey?: Uint8Array): HarnessBlobStore {
  const key = (owner: string, hash: HarnessDigest) => `harness-blobs:${harnessDigest(owner)}:${hash}`;
  const keys = new Map<string, Promise<Uint8Array>>();
  const material = (owner: string) => {
    let promise = keys.get(owner);
    if (!promise) {
      promise = (async () => {
        if (externalKey) {
          if (externalKey.length !== 32) throw Error("Harness custody key must have 32 bytes");
          return new Uint8Array(externalKey);
        }
        const path = `harness-custody:${harnessDigest(owner)}`;
        await kv.update(path, previous => previous ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
        const raw = await kv.get(path);
        if (typeof raw !== "string") throw Error("Harness custody key unavailable");
        const bytes = new Uint8Array(Buffer.from(raw, "base64"));
        if (bytes.length !== 32) throw Error("Harness custody key unavailable");
        return bytes;
      })();
      keys.set(owner, promise);
    }
    return promise;
  };
  const privateDigest = async (owner: string, value: unknown): Promise<HarnessDigest> => {
    const macKey = await crypto.subtle.importKey("raw", await material(owner) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(canonicalStringify([owner, value])));
    return `sha256:${Buffer.from(mac).toString("hex")}`;
  };
  const aesKey = async (owner: string) => crypto.subtle.importKey("raw", await material(owner) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  const decode = async (owner: string, hash: HarnessDigest, row: unknown) => {
    const sealed = row as { version: number; private: boolean; iv: string; ciphertext: string };
    if (sealed?.version !== 1 || typeof sealed.private !== "boolean" || typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") throw Error("Retained harness artifact unavailable");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64"), additionalData: new TextEncoder().encode(canonicalStringify([owner, hash, sealed.private])) }, await aesKey(owner), Buffer.from(sealed.ciphertext, "base64"));
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    if ((sealed.private ? await privateDigest(owner, value) : harnessDigest(value)) !== hash) throw Error("Harness artifact integrity mismatch");
    return value;
  };
  const put = async (owner: string, value: unknown, isPrivate: boolean) => {
    const copy = JSON.parse(canonicalStringify(value));
    const hash = isPrivate ? await privateDigest(owner, copy) : harnessDigest(copy);
    const old = await kv.get(key(owner, hash));
    if (old !== undefined) { await decode(owner, hash, old); return hash; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(canonicalStringify([owner, hash, isPrivate])) }, await aesKey(owner), new TextEncoder().encode(canonicalStringify(copy)));
    await kv.update(key(owner, hash), previous => previous ?? { version: 1, private: isPrivate, iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") });
    await decode(owner, hash, await kv.get(key(owner, hash)));
    return hash;
  };
  return {
    put: (owner, value) => put(owner, value, false),
    putPrivate: (owner, value) => put(owner, value, true),
    async get(owner, hash) {
      if (!digestPattern.test(hash)) throw Error("Invalid artifact reference");
      const value = await kv.get(key(owner, hash));
      return decode(owner, hash, value);
    },
  };
}

export interface HarnessCheck {
  passed: boolean;
  evidence: string[];
  quality: number | null;
}
export interface HarnessCase { id: string; input: HarnessJson; split: "development" | "held-out" }
/** Registered by trusted application code, independently of candidate source and tool arguments. */
export interface HarnessVerifier {
  digest: HarnessDigest;
  evaluatorDigest: HarnessDigest;
  cases: readonly HarnessCase[];
  verify(input: { contract: HarnessContract; artifactDigest: HarnessDigest; input: HarnessJson; output: HarnessJson; caseId?: string }, signal: AbortSignal): Promise<HarnessCheck>;
}
export interface HarnessExecution {
  status: "succeeded" | "failed" | "unknown";
  output?: HarnessJson;
  evidence: string[];
  costUsd?: number;
  /** Trusted adapter measurements, never read from a candidate's output. */
  measurements?: { networkRequests: number; browserStarts: number; modelCalls: number | null; tokens: number | null };
}
export interface HarnessWitness {
  contractDigest: HarnessDigest;
  harnessDigest: HarnessDigest;
  operationId: string;
  contextDigest: HarnessDigest;
  verifierDigest: HarnessDigest;
  evaluatorDigest: HarnessDigest;
  status: "satisfied" | "violated" | "unknown" | "blocked";
  evidence: string[];
  quality: number | null;
  latencyMs: number;
  costUsd: number | null;
  outputRef?: HarnessDigest;
  measurements?: HarnessExecution["measurements"];
}
export interface HarnessLibraryBinding {
  owner: string;
  thread: string;
  blobs: HarnessBlobStore;
  verifiers: ReadonlyMap<HarnessDigest, HarnessVerifier>;
  context(signal: AbortSignal): Promise<HarnessContext>;
  authorize(artifact: HarnessArtifact, contract: HarnessContract, context: HarnessContext, input: HarnessJson, signal: AbortSignal): Promise<boolean>;
  /** Mutating evaluation requires a separate grant for controlled fixture resources. */
  authorizeEvaluation?(artifact: HarnessArtifact, contract: HarnessContract, context: HarnessContext, fixture: HarnessCase, signal: AbortSignal): Promise<boolean>;
  execute(input: { owner: string; operationId: string; artifactDigest: HarnessDigest; artifact: HarnessArtifact; contract: HarnessContract; context: HarnessContext; input: HarnessJson }, signal: AbortSignal): Promise<HarnessExecution>;
  guard(value: unknown): void;
}
export interface HarnessJournal { read(): Promise<readonly Event[]>; append(events: Event[]): Promise<void> }
export interface HarnessLibraryState {
  contracts: Map<string, Event>;
  candidates: Map<string, Event>;
  witnesses: Map<string, HarnessWitness>;
  evaluations: Map<string, Event>;
  heads: Map<string, Event>;
  skills: Map<string, Event>;
}
export const harnessLibraryEventKey = (e: Event) =>
  e.type.startsWith("AikoHarness") && typeof e.id === "string" && typeof e.owner === "string"
    ? e.type.startsWith("AikoHarnessSkill") ? `aiko-harness-skill:${e.owner}:${e.type}:${e.id}`
    : ["AikoHarnessPromoted", "AikoHarnessRetired"].includes(e.type)
      ? `aiko-harness:${e.owner}:head:${e.routeKey}:${e.previousGeneration}`
      : `aiko-harness:${e.owner}:${e.type}:${e.id}` : undefined;
/** A parent projects a child witness only after the native trial adapter joined
 * its actual checked receipt. This is not a parent execution or an import API. */
function joinedTrialWitness(event: Event, history: readonly Event[]): HarnessWitness | undefined {
  if (event.type !== "AikoHarnessExperimentTrialWitness") return undefined;
  const { owner, id, experimentId } = event;
  const find = (type: string) => history.find(e => e.type === type && e.owner === owner && e.id === id);
  const requested = find("AikoHarnessTrialRequested"), joined = find("AikoHarnessTrialJoined"),
    prepared = find("AikoHarnessExperimentPrepared"), reservation = find("AikoHarnessExperimentReserved");
  const registered = history.find(e => e.type === "AikoHarnessExperimentRegistered" && e.owner === owner && e.experimentId === experimentId);
  const contract = history.find(e => e.type === "AikoHarnessContractRegistered" && e.owner === owner && e.contractDigest === registered?.contractDigest);
  const witness = event.witness as HarnessWitness | undefined;
  if (!requested || !joined || !prepared || !reservation || !registered || !contract || !witness ||
    joined.status !== "checked" || requested.experimentId !== experimentId || joined.experimentId !== experimentId ||
    prepared.experimentId !== experimentId || reservation.experimentId !== experimentId || reservation.kind !== "trial" ||
    joined.childThread !== requested.childThread || event.childThread !== requested.childThread ||
    joined.briefRef !== requested.briefRef || event.briefRef !== requested.briefRef ||
    joined.witnessRef !== event.witnessRef || joined.inputRef !== event.inputRef || !digestPattern.test(String(event.witnessRef)) || !digestPattern.test(String(event.inputRef)) ||
    prepared.regimeDigest !== registered.regimeDigest || event.phase !== reservation.phase || event.repeat !== reservation.repeat ||
    typeof event.caseId !== "string" || harnessDigest(event.caseId) !== reservation.caseRef ||
    witness.operationId !== id || witness.harnessDigest !== reservation.harnessDigest ||
    witness.contractDigest !== registered.contractDigest || witness.contextDigest !== registered.contextDigest ||
    witness.verifierDigest !== contract.verifierDigest || witness.evaluatorDigest !== registered.evaluatorDigest ||
    event.witnessDigest !== harnessDigest(witness) || joined.witnessDigest !== event.witnessDigest) return undefined;
  return witness;
}
/** Reconstructs only metadata; no model, network, verifier or artifact execution during replay. */
export function harnessLibraryState(events: readonly Event[], owner: string): HarnessLibraryState {
  const state: HarnessLibraryState = { contracts: new Map(), candidates: new Map(), witnesses: new Map(), evaluations: new Map(), heads: new Map(), skills: new Map() };
  const history: Event[] = [];
  for (const e of events) {
    if (e.owner !== owner) continue;
    if (e.type === "AikoHarnessContractRegistered") state.contracts.set(String(e.contractDigest), e);
    if (e.type === "AikoHarnessCandidateRecorded") state.candidates.set(String(e.harnessDigest), e);
    if (e.type === "AikoHarnessChecked") state.witnesses.set(String(e.id), e.witness as HarnessWitness);
    if (e.type === "AikoHarnessExperimentTrialWitness") {
      const witness = joinedTrialWitness(e, history);
      if (witness) state.witnesses.set(String(e.id), witness);
    }
    if (e.type === "AikoHarnessEvaluated") state.evaluations.set(String(e.id), e);
    if (e.type === "AikoHarnessSkillAvailable") {
      const previous = state.skills.get(String(e.harnessDigest));
      if (!previous || Number(e.sourceWatermark) > Number(previous.sourceWatermark)) state.skills.set(String(e.harnessDigest), e);
    }
    if (e.type === "AikoHarnessPromoted" || e.type === "AikoHarnessRetired") {
      const key = String(e.routeKey), previous = state.heads.get(key);
      if (e.previousGeneration === (previous?.generation ?? 0)) state.heads.set(key, e);
    }
    history.push(e);
  }
  return state;
}
export function harnessLibraryComponent(owner: string) {
  return component({ name: "aiko.harness-library", keys: { prefixes: ["aiko-harness:"], keyOf: harnessLibraryEventKey },
    initial: () => undefined, step: state => state,
    output: () => ({ view: undefined, transitions: [] }),
  });
}
/** Host commit fence for competing promotions; input events cannot mint trusted library facts. */
export function harnessLibraryAppendAllowed(batch: readonly Event[], read: () => readonly Event[]): boolean {
  const existing = read();
  if (!harnessExperimentAppendAllowed(batch, () => existing)) return false;
  const history = [...existing];
  for (const event of batch) {
    if (event.type === "AikoHarnessExperimentTrialWitness") {
      if (!joinedTrialWitness(event, history) || history.some(e => e.owner === event.owner && e.experimentId === event.experimentId &&
        ["AikoHarnessExperimentCancelled", "AikoHarnessExperimentSettled"].includes(e.type))) return false;
    }
    if (["AikoHarnessPromoted", "AikoHarnessRetired"].includes(event.type)) {
      const state = harnessLibraryState(history, String(event.owner)), head = state.heads.get(String(event.routeKey));
      if (event.previousGeneration !== (head?.generation ?? 0) || event.generation !== Number(event.previousGeneration) + 1) return false;
    }
    history.push(event);
  }
  return true;
}
function schemaValid(schema: Record<string, unknown>, value: unknown) { return new Validator(schema as never).validate(value).valid; }
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(Error("Harness deadline or cancellation"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
function boundedJson(value: unknown): asserts value is HarnessJson {
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 32768 || depth > 32) throw Error("Harness JSON limit");
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) throw Error("Invalid harness JSON");
    for (const [key, item] of Object.entries(v)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("Unsafe harness JSON key");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw Error("Harness JSON limit");
}
export function validateHarnessArtifact(value: HarnessArtifact): HarnessArtifact {
  boundedJson(value);
  if (value.version !== 1 || !identifier.test(value.name) || typeof value.description !== "string" || value.description.length > 2000 || !["javascript", "python", "network"].includes(value.runtime) || !digestPattern.test(value.contractDigest)) throw Error("Invalid harness artifact");
  if (value.runtimeLockDigest !== undefined && !digestPattern.test(value.runtimeLockDigest)) throw Error("Invalid harness runtime lock");
  if (!value.files || Array.isArray(value.files) || !Object.hasOwn(value.files, value.entrypoint) || Object.keys(value.files).length > 128) throw Error("Missing harness entrypoint");
  for (const [path, code] of Object.entries(value.files)) {
    if (!sourcePathAllowed(path) || typeof code !== "string") throw Error("Invalid harness source path");
  }
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 64 || new Set(value.dependencies.map(d => d.name)).size !== value.dependencies.length || value.dependencies.some(d => !(identifier.test(d.name) || sourcePathAllowed(d.name)) || !digestPattern.test(d.digest))) throw Error("Invalid harness dependency lock");
  if (!Array.isArray(value.sources) || value.sources.length > 64 || value.sources.some(s => typeof s.uri !== "string" || !s.revision || !digestPattern.test(s.digest) || !s.license)) throw Error("Harness source provenance required");
  return structuredClone(value);
}

/** Invoked inside native keyed tool/effect calls. The journal, not this object, owns durable state. */
export class HarnessLibrary {
  constructor(readonly binding: HarnessLibraryBinding, readonly journal: HarnessJournal) {}
  private emit(type: string, id: string, data: object) {
    return this.journal.append([{ type, id, owner: this.binding.owner, at: Date.now(), ...data }]);
  }
  async registerContract(contract: HarnessContract) {
    boundedJson(contract);
    contract = structuredClone(contract);
    this.binding.guard(contract);
    const verifier = this.binding.verifiers.get(contract.verifierDigest);
    if (contract.version !== 1 || !contract.outcome || !["read", "write", "mixed"].includes(contract.effect) || !verifier || verifier.digest !== contract.verifierDigest || verifier.evaluatorDigest !== contract.evaluatorDigest || typeof verifier.verify !== "function" || !Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 300000) throw Error("Trusted harness contract required");
    new Validator(contract.inputSchema as never); new Validator(contract.outputSchema as never);
    const hash = await this.binding.blobs.put(this.binding.owner, contract);
    await this.emit("AikoHarnessContractRegistered", hash, { contractDigest: hash, verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, datasetDigest: harnessDigest(verifier.cases) });
    return hash;
  }
  async record(candidate: HarnessArtifact) {
    const artifact = validateHarnessArtifact(candidate); this.binding.guard(artifact);
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    if (!state.contracts.has(artifact.contractDigest)) throw Error("Contract is not registered");
    const hash = await this.binding.blobs.put(this.binding.owner, artifact);
    await this.emit("AikoHarnessCandidateRecorded", hash, { harnessDigest: hash, contractDigest: artifact.contractDigest, name: artifact.name, runtime: artifact.runtime, dependencies: artifact.dependencies });
    return hash;
  }
  async resolve(hash: HarnessDigest) {
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    if (!state.candidates.has(hash)) throw Error("Owned harness candidate unavailable");
    const artifact = validateHarnessArtifact(await this.binding.blobs.get(this.binding.owner, hash) as HarnessArtifact);
    if (!state.contracts.has(artifact.contractDigest)) throw Error("Harness contract unavailable");
    const contract = await this.binding.blobs.get(this.binding.owner, artifact.contractDigest) as HarnessContract;
    const verifier = this.binding.verifiers.get(contract.verifierDigest);
    if (!verifier || verifier.digest !== contract.verifierDigest || verifier.evaluatorDigest !== contract.evaluatorDigest || typeof verifier.verify !== "function") throw Error("Pinned verifier unavailable");
    const registered = state.contracts.get(artifact.contractDigest)!;
    if (registered.verifierDigest !== contract.verifierDigest || registered.evaluatorDigest !== contract.evaluatorDigest) throw Error("Registered verifier identity changed");
    if (registered.datasetDigest !== harnessDigest(verifier.cases)) throw Error("Registered evaluation cases changed");
    return { artifact, contract, verifier };
  }
  async run(hash: HarnessDigest, input: HarnessJson, operationId: string, signal: AbortSignal, options: { caseId?: string; expectedContext?: HarnessDigest } = {}): Promise<HarnessWitness> {
    if (!identifier.test(operationId)) throw Error("Invalid harness operation ID");
    boundedJson(input);
    input = structuredClone(input);
    options = structuredClone(options);
    const inputRef = await this.binding.blobs.putPrivate(this.binding.owner, input);
    const events = await this.journal.read();
    const started = events.find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.binding.owner && e.id === operationId);
    if (started && (started.harnessDigest !== hash || started.inputRef !== inputRef || started.caseId !== (options.caseId ?? null))) throw Error("Harness operation identity conflict");
    const child = events.find(e => e.type === "AikoHarnessExperimentTrialWitness" && e.owner === this.binding.owner && e.id === operationId);
    if (child && ((child.witness as HarnessWitness)?.harnessDigest !== hash || child.inputRef !== inputRef || child.caseId !== (options.caseId ?? null))) throw Error("Harness operation identity conflict");
    const previous = harnessLibraryState(events, this.binding.owner).witnesses.get(operationId);
    if (previous) return structuredClone(previous);
    const { artifact, contract, verifier } = await this.resolve(hash);
    const context = structuredClone(await this.binding.context(signal)), contextDigest = harnessDigest(context);
    if (options.expectedContext && options.expectedContext !== contextDigest) throw Error("Evaluation context changed");
    const request = { harnessDigest: hash, inputRef, contextDigest, caseId: options.caseId ?? null };
    const requestDigest = harnessDigest(request);
    const stamp = { contractDigest: artifact.contractDigest, harnessDigest: hash, operationId, contextDigest, verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest };
    const witness: HarnessWitness = { ...stamp, status: "unknown", evidence: [], quality: null, latencyMs: 0, costUsd: null };
    if (started) {
      // The caller may have disconnected after a write or verifier dispatch. Never infer failure.
      witness.evidence = ["interrupted-execution-needs-reconciliation"];
      return witness;
    }
    signal.throwIfAborted();
    const admitted = schemaValid(contract.inputSchema, input) && await this.binding.authorize(structuredClone(artifact), structuredClone(contract), structuredClone(context), structuredClone(input), signal);
    signal.throwIfAborted();
    const claimId = randomUUID();
    await this.emit("AikoHarnessRunStarted", operationId, { ...request, requestDigest, claimId });
    // The claim owns every terminal result, including authorization rejection.
    // A losing admission decision cannot overwrite a live executor's witness.
    const winner = (await this.journal.read()).find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.binding.owner && e.id === operationId);
    if (winner?.claimId !== claimId) return { ...witness, evidence: ["execution-owned-by-another-attempt"] };
    if (!admitted) {
      witness.status = "blocked"; witness.evidence = ["input-or-authorization-rejected"];
    } else {
      const startedAt = performance.now();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(contract.timeoutMs)]);
      try {
        const result = structuredClone(await bounded(() => this.binding.execute(structuredClone({ owner: this.binding.owner, operationId, artifactDigest: hash, artifact, contract, context, input }), deadline), deadline));
        deadline.throwIfAborted();
        boundedJson(result.evidence); this.binding.guard(result.evidence);
        const executionEvidence = [...result.evidence];
        witness.evidence = executionEvidence;
        witness.costUsd = typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : null;
        if (result.measurements) {
          const m = result.measurements;
          if (![m.networkRequests, m.browserStarts].every(n => Number.isSafeInteger(n) && n >= 0) ||
              ![m.modelCalls, m.tokens].every(n => n === null || Number.isSafeInteger(n) && n >= 0)) throw Error("Invalid trusted harness measurements");
          witness.measurements = structuredClone(m);
        }
        if (result.status === "succeeded") {
          boundedJson(result.output);
          const output = result.output;
          if (!schemaValid(contract.outputSchema, output)) {
            witness.status = "violated"; witness.evidence = [...executionEvidence, "output-schema-mismatch"];
          } else {
            // Custody and the independent checker receive separate copies of the
            // same accepted result; neither can mutate the other's witnessed bytes.
            witness.outputRef = await this.binding.blobs.putPrivate(this.binding.owner, structuredClone(output));
            const check = await bounded(() => verifier.verify({ contract: structuredClone(contract), artifactDigest: hash, input: structuredClone(input), output: structuredClone(output), caseId: options.caseId }, deadline), deadline);
            deadline.throwIfAborted();
            boundedJson(check);
            this.binding.guard(check.evidence);
            witness.evidence = [...new Set([...executionEvidence, ...check.evidence])];
            witness.status = check.passed === true && check.evidence.length > 0 && executionEvidence.length > 0 ? "satisfied" : "violated";
            witness.quality = typeof check.quality === "number" && Number.isFinite(check.quality) ? check.quality : null;
          }
        } else { witness.status = result.status === "failed" ? "violated" : "unknown"; witness.evidence = [...executionEvidence, "executor-" + result.status]; }
      } catch { witness.status = "unknown"; witness.evidence = [...witness.evidence, "execution-or-verification-unconfirmed"]; }
      witness.latencyMs = performance.now() - startedAt;
    }
    await this.emit("AikoHarnessChecked", operationId, { witness });
    return witness;
  }
  async evaluate(hash: HarnessDigest, evaluationId: string, signal: AbortSignal) {
    if (!identifier.test(evaluationId)) throw Error("Invalid evaluation ID");
    const { artifact, contract, verifier } = await this.resolve(hash);
    const cases = structuredClone(verifier.cases);
    if (!cases.length || cases.length > 64 || new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => !identifier.test(c.id)) || !cases.some(c => c.split === "development") || !cases.some(c => c.split === "held-out")) throw Error("Fixed development and held-out cases required");
    const context = await this.binding.context(signal), contextDigest = harnessDigest(context);
    const datasetDigest = harnessDigest(cases);
    const prior = harnessLibraryState(await this.journal.read(), this.binding.owner).evaluations.get(evaluationId);
    if (prior) {
      if (prior.harnessDigest !== hash || prior.contextDigest !== contextDigest || prior.datasetDigest !== datasetDigest) throw Error("Evaluation identity conflict");
      return prior;
    }
    for (const fixture of cases) if (this.binding.authorizeEvaluation ? !await this.binding.authorizeEvaluation(artifact, contract, context, fixture, signal) : contract.effect !== "read") throw Error("Controlled fixture authorization required");
    const requestDigest = harnessDigest([hash, datasetDigest, contextDigest]);
    await this.emit("AikoHarnessEvaluationStarted", evaluationId, { requestDigest });
    const winner = (await this.journal.read()).find(e => e.type === "AikoHarnessEvaluationStarted" && e.owner === this.binding.owner && e.id === evaluationId);
    if (winner?.requestDigest !== requestDigest) throw Error("Evaluation identity conflict");
    const witnessIds = cases.map(fixture => `eval:${harnessDigest([evaluationId, fixture.id]).slice(7)}`);
    for (const fixture of cases) {
      signal.throwIfAborted();
      if (this.binding.authorizeEvaluation ? !await this.binding.authorizeEvaluation(artifact, contract, context, fixture, signal) : contract.effect !== "read") throw Error("Controlled fixture authorization required");
      const id = `eval:${harnessDigest([evaluationId, fixture.id]).slice(7)}`;
      await this.run(hash, fixture.input, id, signal, { caseId: fixture.id, expectedContext: contextDigest });
      // Per-case native keys own dispatch. A recovered evaluation can start an
      // undispatched case, while an in-flight/uncertain case blocks progression.
      // Never turn an ephemeral follower's unknown into a terminal evaluation.
      if (!harnessLibraryState(await this.journal.read(), this.binding.owner).witnesses.has(id)) break;
    }
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    const settled = state.evaluations.get(evaluationId);
    if (settled) return settled;
    const completed = witnessIds.map(id => state.witnesses.get(id));
    if (completed.some(w => !w)) return { type: "AikoHarnessEvaluationPending", id: evaluationId, owner: this.binding.owner, status: "unknown", eligible: false } as Event;
    const witnesses = completed as HarnessWitness[];
    const data = { harnessDigest: hash, contractDigest: artifact.contractDigest, evaluatorDigest: verifier.evaluatorDigest, datasetDigest, contextDigest,
      eligible: witnesses.every(w => w.status === "satisfied" && w.contractDigest === artifact.contractDigest && w.verifierDigest === contract.verifierDigest && w.evaluatorDigest === contract.evaluatorDigest), witnessIds: witnesses.map(w => w.operationId),
      latencyMs: witnesses.reduce((total, w) => total + w.latencyMs, 0),
      costUsd: witnesses.every(w => w.costUsd !== null) ? witnesses.reduce((total, w) => total + w.costUsd!, 0) : null };
    signal.throwIfAborted();
    await this.emit("AikoHarnessEvaluated", evaluationId, data);
    return harnessLibraryState(await this.journal.read(), this.binding.owner).evaluations.get(evaluationId)!;
  }
  async promote(hash: HarnessDigest, evaluationId: string, expectedGeneration: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const { artifact, contract } = await this.resolve(hash);
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner), evaluation = state.evaluations.get(evaluationId);
    const context = await this.binding.context(signal), contextDigest = harnessDigest(context);
    if (!evaluation || evaluation.harnessDigest !== hash || !evaluation.eligible || evaluation.contextDigest !== contextDigest || evaluation.evaluatorDigest !== contract.evaluatorDigest) throw Error("Passing evaluation in current context required");
    const witnesses = (evaluation.witnessIds as string[]).map(id => state.witnesses.get(id));
    if (!witnesses.length || witnesses.some(w => !w || w.status !== "satisfied" || w.harnessDigest !== hash || w.contextDigest !== contextDigest || w.contractDigest !== artifact.contractDigest || w.verifierDigest !== contract.verifierDigest || w.evaluatorDigest !== contract.evaluatorDigest)) throw Error("Promotion witnesses missing");
    const routeKey = harnessDigest([artifact.name, artifact.contractDigest, contextDigest]);
    const head = state.heads.get(routeKey);
    if (head?.harnessDigest === hash && head.evaluationId === evaluationId && head.type === "AikoHarnessPromoted") return head;
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0 || (head?.generation ?? 0) !== expectedGeneration) throw Error("Harness generation conflict");
    // Documentation follows settled native evidence on the background actor.
    // Promotion never waits for a Markdown build or its artifact write.
    const data = { routeKey, harnessDigest: hash, name: artifact.name, contractDigest: artifact.contractDigest, contextDigest, evaluationId, generation: expectedGeneration + 1, previousGeneration: expectedGeneration };
    const id = harnessDigest([routeKey, expectedGeneration, hash]);
    signal.throwIfAborted();
    await this.emit("AikoHarnessPromoted", id, data);
    const winner = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
    if (winner?.harnessDigest !== hash || winner.evaluationId !== evaluationId) throw Error("Harness promotion superseded");
    return { type: "AikoHarnessPromoted", id, owner: this.binding.owner, ...data } as Event;
  }
  async list() {
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    return { contracts: [...state.contracts.values()], candidates: [...state.candidates.values()], active: [...state.heads.values()].filter(e => e.type === "AikoHarnessPromoted"), skills: [...state.skills.values()] };
  }
  async skill(hash: HarnessDigest, resource?: string): Promise<{ status: string; harnessDigest: HarnessDigest; markdown?: string; skillRef?: HarnessDigest; [key: string]: unknown }> {
    const events = await this.journal.read(), state = harnessLibraryState(events, this.binding.owner);
    if (!state.candidates.has(hash)) throw Error("Owned harness candidate unavailable");
    const document = state.skills.get(hash);
    const unavailable = events.findLast(e => e.owner === this.binding.owner && e.type === "AikoHarnessSkillUnavailable" && e.harnessDigest === hash);
    if (unavailable && (!document || Number(unavailable.sourceWatermark) > Number(document.sourceWatermark))) return { status: "unavailable", harnessDigest: hash, reason: unavailable.reason };
    if (!document) return { status: "pending", harnessDigest: hash };
    const markdown = await this.binding.blobs.get(this.binding.owner, document.skillRef as HarnessDigest);
    if (typeof markdown !== "string" || harnessDigest(markdown) !== document.skillRef) throw Error("Retained skill document unavailable");
    this.binding.guard(markdown);
    const refs = document.resources as Record<string, unknown>;
    if (!refs || typeof refs !== "object" || Array.isArray(refs) || Object.keys(refs).length > 32 ||
        !["references/contract.json", "references/evidence.json", "references/provenance.json"].every(path => Object.hasOwn(refs, path))) throw Error("Retained skill resources unavailable");
    const resources: Record<string, unknown> = {};
    for (const [path, ref] of Object.entries(refs)) {
      if (!sourcePathAllowed(path) || !digestPattern.test(String(ref))) throw Error("Retained skill resources unavailable");
      const value = await this.binding.blobs.get(this.binding.owner, ref as HarnessDigest);
      if (harnessDigest(value) !== ref) throw Error("Retained skill resource integrity mismatch");
      this.binding.guard(structuredClone(value)); resources[path] = value;
    }
    if (resource !== undefined) {
      if (!Object.hasOwn(resources, resource)) throw Error("Skill resource unavailable");
      return { status: "available", harnessDigest: hash, skillRef: document.skillRef as HarnessDigest, path: resource, value: resources[resource], resourceRef: refs[resource], freshness: "historical-evidence" };
    }
    return { ...document, status: String(document.status), harnessDigest: hash, skillRef: document.skillRef as HarnessDigest, markdown, freshness: "historical-evidence", executionEligibility: "rechecked-at-invocation" };
  }
  async output(operationId: string) {
    if (!identifier.test(operationId)) throw Error("Invalid harness operation ID");
    const events = await this.journal.read();
    const run = events.find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.binding.owner && e.id === operationId);
    // Evaluation output is checker custody, not a user-task result. Publishing
    // its operation ID or a satisfied witness must not expose held-out answers.
    // Reflection needs a separately scoped development-evidence interface.
    if (!run || run.caseId !== null) throw Error("Verified retained harness output unavailable");
    const witness = harnessLibraryState(events, this.binding.owner).witnesses.get(operationId);
    if (witness?.status !== "satisfied" || !witness.outputRef) throw Error("Verified retained harness output unavailable");
    const output = await this.binding.blobs.get(this.binding.owner, witness.outputRef);
    // The native CodeHarness facade retains this private value outside general
    // event payloads and makes it available to the next sandbox segment.
    return { status: "satisfied", operationId, output, outputRef: witness.outputRef, freshness: "historical-operation" };
  }
  async call(name: string, contractDigest: HarnessDigest, input: HarnessJson, operationId: string, signal: AbortSignal) {
    const contextDigest = harnessDigest(await this.binding.context(signal));
    const routeKey = harnessDigest([name, contractDigest, contextDigest]);
    const head = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
    if (head?.type !== "AikoHarnessPromoted") throw Error("No verified harness for this action and context");
    return this.run(head.harnessDigest as HarnessDigest, input, operationId, signal, { expectedContext: contextDigest });
  }
}

/** Native tools can create candidates but cannot register or edit trusted evaluation contracts. */
export function harnessLibraryTools(binding: HarnessLibraryBinding): NativeTool<Self | EventLog>[] {
  const methods = ["list", "record", "evaluate", "promote", "run", "call", "output", "skill"] as const;
  const schemas: Record<typeof methods[number], Record<string, unknown>> = {
    list: { type: "object", properties: {}, additionalProperties: false },
    record: { type: "object", properties: { artifact: { type: "object" } }, required: ["artifact"], additionalProperties: false },
    evaluate: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" } }, required: ["digest", "evaluationId"], additionalProperties: false },
    promote: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" }, expectedGeneration: { type: "integer", minimum: 0 } }, required: ["digest", "evaluationId", "expectedGeneration"], additionalProperties: false },
    run: { type: "object", properties: { digest: { type: "string" }, input: {}, operationId: { type: "string" } }, required: ["digest", "input", "operationId"], additionalProperties: false },
    call: { type: "object", properties: { name: { type: "string" }, contractDigest: { type: "string" }, input: {}, operationId: { type: "string" } }, required: ["name", "contractDigest", "input", "operationId"], additionalProperties: false },
    output: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false },
    skill: { type: "object", properties: { digest: { type: "string" }, resource: { type: "string" } }, required: ["digest"], additionalProperties: false },
  };
  return methods.map(method => ({
    spec: { name: `harness_${method}`, description: method === "skill" ? "Read the exact private SKILL.md produced by passive background derivation. Supply an optional declared resource path to read its contract, evidence or provenance. Pending and unavailable documentation never trigger regeneration or execution." : `Harness library ${method}: use immutable artifacts and independently registered outcome contracts. Evaluation executes fixed fixtures; promotion requires held-out witnesses. Run returns a durable witness and private output reference.`, inputSchema: schemas[method] },
    run: (input: unknown) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread || !schemaValid(schemas[method], input)) return { status: "rejected" };
      const library = new HarnessLibrary(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) });
      const args = input as any;
      return yield* Effect.tryPromise({ try: async (signal): Promise<unknown> => {
        if (method === "list") return library.list();
        if (method === "record") return library.record(args.artifact).then(digest => ({ digest }));
        if (method === "evaluate") return library.evaluate(args.digest, args.evaluationId, signal);
        if (method === "promote") return library.promote(args.digest, args.evaluationId, args.expectedGeneration, signal);
        if (method === "call") return library.call(args.name, args.contractDigest, args.input, args.operationId, signal);
        if (method === "output") return library.output(args.operationId);
        if (method === "skill") return library.skill(args.digest, args.resource);
        return library.run(args.digest, args.input, args.operationId, signal);
      }, catch: () => Error("Harness operation failed; inspect its durable receipt before retrying") }).pipe(Effect.catch(() => Effect.succeed({ status: "failed" })));
    }),
  }));
}
