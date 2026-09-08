import { harnessExperimentAppendAllowed } from "./harness-experiment-log.ts";
import { harnessRecoveryAppendAllowed, harnessReconciledWitness } from "./harness-recovery-log.ts";
import { HarnessRevisions, observedRequestEvidenceAvailable } from "./harness-revisions.ts";
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
  /** Content-addressed edit lineage. Sources remain the original observations,
   * not a claim that edited executable bytes were observed at those sources. */
  revision?: { version: 1; predecessorDigest: HarnessDigest; changedFields: string[] };
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
  /** Trusted opt-in: a passing repeated example is insufficient for promotion. */
  transfer?: { version: 1; minimumNovelHeldOutInputs: number };
}
export interface HarnessContext {
  placement: "local" | "codegraff";
  runtimeDigest: HarnessDigest;
  bindings: Record<string, HarnessJson>;
}
export interface HarnessBlobStore {
  put(owner: string, value: unknown): Promise<HarnessDigest>;
  putPrivate(owner: string, value: unknown, dependencies?: readonly HarnessDigest[]): Promise<HarnessDigest>;
  get(owner: string, digest: HarnessDigest): Promise<unknown>;
  /** Trusted host custody only. The caller authorizes the exact references and their dependent uses. */
  erase?(owner: string, digest: HarnessDigest, operationId: string): Promise<HarnessErasureReceipt>;
  /** Trusted host evidence retirement. Dependencies are opaque owner-scoped identities, never grants. */
  eraseDependencies?(owner: string, dependencies: readonly HarnessDigest[], operationId: string): Promise<HarnessDependencyErasureReceipt>;
}
export interface HarnessDependencyErasureReceipt {
  version: 1;
  operation: HarnessDigest;
  status: "erased";
  references: HarnessDigest[];
}
export interface HarnessErasureReceipt {
  version: 1;
  reference: HarnessDigest;
  operation: HarnessDigest;
  status: "erased";
}
/** Seals retained data in existing private KV custody. Supply a separately held key for off-store key custody. */
export function harnessBlobStore(kv: WorkflowKV, externalKey?: Uint8Array): HarnessBlobStore {
  const key = (owner: string, hash: HarnessDigest) => `harness-blobs:${harnessDigest(owner)}:${hash}`;
  const dependencyKey = (owner: string, hash: HarnessDigest) => `harness-blob-dependencies:${harnessDigest(owner)}:${hash}`;
  type Dependency = { version: 1; references: HarnessDigest[]; erased?: true };
  const dependenciesOf = (value: readonly HarnessDigest[] = [], limit = 1024): HarnessDigest[] => {
    if (!Array.isArray(value) || value.length > limit || value.some(id => !digestPattern.test(id))) throw Error("Invalid custody dependencies");
    return [...new Set(value)].sort();
  };
  const dependency = (value: unknown): Dependency => {
    if (value === undefined) return { version: 1, references: [] };
    const row = value as Dependency;
    if (row?.version !== 1 || !Array.isArray(row.references) || row.references.length > 16384 ||
        row.references.some(ref => !digestPattern.test(ref)) || (row.erased !== undefined && row.erased !== true)) throw Error("Custody dependency unavailable");
    return row;
  };
  const currentDependencies = async (owner: string, refs: readonly HarnessDigest[]) => {
    for (const ref of refs) {
      const row = await kv.get(dependencyKey(owner, ref));
      if (row === undefined || dependency(row).erased) throw Error("Retained harness artifact unavailable");
    }
  };
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
    const sealed = row as { version: number; private: boolean; iv: string; ciphertext: string; dependencies?: HarnessDigest[] };
    if (![1, 3].includes(sealed?.version) || typeof sealed.private !== "boolean" || typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") throw Error("Retained harness artifact unavailable");
    const dependencies = sealed.version === 3 ? dependenciesOf(sealed.dependencies) : [];
    if (sealed.version === 3 && (!sealed.private || !dependencies.length || canonicalStringify(dependencies) !== canonicalStringify(sealed.dependencies))) throw Error("Custody dependency unavailable");
    await currentDependencies(owner, dependencies);
    const associated = dependencies.length ? [owner, hash, true, dependencies] : [owner, hash, sealed.private];
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64"), additionalData: new TextEncoder().encode(canonicalStringify(associated)) }, await aesKey(owner), Buffer.from(sealed.ciphertext, "base64"));
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    if ((sealed.private ? await privateDigest(owner, dependencies.length ? ["aiko-dependent-private/v1", value, dependencies] : value) : harnessDigest(value)) !== hash) throw Error("Harness artifact integrity mismatch");
    return value;
  };
  const read = async (owner: string, hash: HarnessDigest) => {
    const row = await kv.get(key(owner, hash));
    const value = await decode(owner, hash, row);
    if ((row as { version: number }).version === 3) await currentDependencies(owner, (row as { dependencies: HarnessDigest[] }).dependencies);
    // Decryption is asynchronous; an erasure committed while it was pending
    // must invalidate this read before private bytes leave custody.
    const current = await kv.get(key(owner, hash));
    if (current === undefined || canonicalStringify(current) !== canonicalStringify(row))
      throw Error("Retained harness artifact unavailable");
    return value;
  };
  const put = async (owner: string, value: unknown, isPrivate: boolean, sourceDependencies?: readonly HarnessDigest[]) => {
    const dependencies = dependenciesOf(sourceDependencies);
    const copy = JSON.parse(canonicalStringify(value));
    const hash = isPrivate ? await privateDigest(owner, dependencies.length ? ["aiko-dependent-private/v1", copy, dependencies] : copy) : harnessDigest(copy);
    // Register before storing bytes. A concurrent erasure sees this reference,
    // including a write interrupted before its post-storage authority check.
    for (const ref of dependencies) await kv.update(dependencyKey(owner, ref), previous => {
      const row = dependency(previous);
      if (row.erased) throw Error("Retained harness artifact unavailable");
      const references = [...new Set([...row.references, hash])].sort();
      if (references.length > 16384) throw Error("Custody dependency capacity exceeded");
      return { version: 1, references };
    });
    const old = await kv.get(key(owner, hash));
    if (old !== undefined) { await read(owner, hash); return hash; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const associated = dependencies.length ? [owner, hash, true, dependencies] : [owner, hash, isPrivate];
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(canonicalStringify(associated)) }, await aesKey(owner), new TextEncoder().encode(canonicalStringify(copy)));
    await kv.update(key(owner, hash), previous => previous ?? { version: dependencies.length ? 3 : 1, private: isPrivate,
      ...(dependencies.length ? { dependencies } : {}), iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") });
    try { await read(owner, hash); }
    catch (error) {
      // If retirement raced encryption, discard the just-written ciphertext.
      for (const ref of dependencies) if (dependency(await kv.get(dependencyKey(owner, ref))).erased) { await eraseDependent(owner, hash); break; }
      throw error;
    }
    return hash;
  };
  const eraseDependent = async (owner: string, reference: HarnessDigest) => {
    await kv.update(key(owner, reference), previous => {
      if ((previous as { kind?: string })?.kind === "erased") return previous;
      return { version: 2, kind: "erased", receipt: { version: 1, reference,
        operation: harnessDigest(["aiko-dependent-erasure/v1", owner, reference]), status: "erased" } };
    });
  };
  return {
    put: (owner, value) => put(owner, value, false),
    putPrivate: (owner, value, dependencies) => put(owner, value, true, dependencies),
    async eraseDependencies(owner, sourceDependencies, operationId) {
      if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 512) throw Error("Invalid dependency erasure");
      // A complete trusted journal erasure can contain many individually bounded
      // result dependencies. Never truncate that closure to the per-result cap.
      const dependencies = dependenciesOf(sourceDependencies, Number.MAX_SAFE_INTEGER), references = new Set<HarnessDigest>();
      const operation = harnessDigest(["aiko-custody-erasure/v1", owner, dependencies, operationId]);
      const operationKey = `harness-custody-erasure:${harnessDigest(owner)}:${harnessDigest(operationId)}`;
      await kv.update(operationKey, previous => {
        if (previous !== undefined && canonicalStringify(previous) !== canonicalStringify({ version: 1, operation })) throw Error("Custody erasure operation conflict");
        return { version: 1, operation };
      });
      // Fence every dependency before cleanup. Retry resumes the same retained
      // reference set; a missing blob is fenced against an interrupted writer.
      for (const ref of dependencies) {
        await kv.update(dependencyKey(owner, ref), previous => ({ ...dependency(previous), erased: true }));
        for (const reference of dependency(await kv.get(dependencyKey(owner, ref))).references) references.add(reference);
      }
      for (const reference of references) await eraseDependent(owner, reference);
      return { version: 1, operation, status: "erased", references: [...references].sort() };
    },
    async get(owner, hash) {
      if (!digestPattern.test(hash)) throw Error("Invalid artifact reference");
      return read(owner, hash);
    },
    async erase(owner, hash, operationId) {
      if (!digestPattern.test(hash) || typeof operationId !== "string" || !operationId.trim() || operationId.length > 512)
        throw Error("Invalid artifact erasure");
      const receipt: HarnessErasureReceipt = { version: 1, reference: hash,
        operation: harnessDigest(["aiko-harness-erasure/v1", owner, hash, operationId]), status: "erased" };
      const tombstone = { version: 2, kind: "erased", receipt };
      await kv.update(key(owner, hash), previous => {
        if (previous === undefined) throw Error("Retained harness artifact unavailable");
        if ((previous as { kind?: string })?.kind === "erased" && canonicalStringify(previous) !== canonicalStringify(tombstone))
          throw Error("Artifact erasure operation conflict");
        return tombstone;
      });
      if (canonicalStringify(await kv.get(key(owner, hash))) !== canonicalStringify(tombstone))
        throw Error("Artifact erasure receipt unavailable");
      return receipt;
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
  execute(input: { owner: string; operationId: string; caseId?: string; artifactDigest: HarnessDigest; artifact: HarnessArtifact; contract: HarnessContract; context: HarnessContext; input: HarnessJson }, signal: AbortSignal): Promise<HarnessExecution>;
  /** Trusted receipt read only. Must never submit or replay an artifact/write. */
  reconcile?: HarnessLibraryBinding["execute"];
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
    if (e.type === "AikoHarnessChecked" && !history.some(r => r.type === "AikoHarnessReconciled" && r.operationId === e.id && harnessReconciledWitness(r, history))) state.witnesses.set(String(e.id), e.witness as HarnessWitness);
    if (e.type === "AikoHarnessReconciled") {
      const witness = harnessReconciledWitness(e, history);
      if (witness) state.witnesses.set(witness.operationId, witness);
    }
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
  if (!harnessRecoveryAppendAllowed(batch, () => existing)) return false;
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
  if (value.revision && (value.revision.version !== 1 || !digestPattern.test(value.revision.predecessorDigest) ||
    !Array.isArray(value.revision.changedFields) || !value.revision.changedFields.length ||
    value.revision.changedFields.some(field => !["description", "runtime", "runtimeLockDigest", "entrypoint", "files", "dependencies", "sources", "contractDigest"].includes(field)) ||
    new Set(value.revision.changedFields).size !== value.revision.changedFields.length ||
    Object.keys(value.revision).some(key => !["version", "predecessorDigest", "changedFields"].includes(key)))) throw Error("Invalid harness revision lineage");
  return structuredClone(value);
}

/** Invoked inside native keyed tool/effect calls. The journal, not this object, owns durable state. */
export class HarnessLibrary {
  constructor(readonly binding: HarnessLibraryBinding, readonly journal: HarnessJournal) {}
  inputValid(schema: Record<string, unknown>, value: unknown) { boundedJson(value); return schemaValid(schema, value); }
  private emit(type: string, id: string, data: object) {
    return this.journal.append([{ type, id, owner: this.binding.owner, at: Date.now(), ...data }]);
  }
  async registerContract(contract: HarnessContract) {
    boundedJson(contract);
    contract = structuredClone(contract);
    this.binding.guard(contract);
    const verifier = this.binding.verifiers.get(contract.verifierDigest);
    if (contract.version !== 1 || !contract.outcome || !["read", "write", "mixed"].includes(contract.effect) || !verifier || verifier.digest !== contract.verifierDigest || verifier.evaluatorDigest !== contract.evaluatorDigest || typeof verifier.verify !== "function" || !Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 300000) throw Error("Trusted harness contract required");
    if (contract.transfer !== undefined && (!contract.transfer || Array.isArray(contract.transfer) || contract.transfer.version !== 1 || !Number.isSafeInteger(contract.transfer.minimumNovelHeldOutInputs) ||
      contract.transfer.minimumNovelHeldOutInputs < 1 || contract.transfer.minimumNovelHeldOutInputs > 64 ||
      Object.keys(contract.transfer).some(key => !["version", "minimumNovelHeldOutInputs"].includes(key)))) throw Error("Invalid procedure transfer requirement");
    new Validator(contract.inputSchema as never); new Validator(contract.outputSchema as never);
    const hash = await this.binding.blobs.put(this.binding.owner, contract);
    await this.emit("AikoHarnessContractRegistered", hash, { contractDigest: hash, verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, datasetDigest: harnessDigest(verifier.cases) });
    return hash;
  }
  async record(candidate: HarnessArtifact) {
    const artifact = validateHarnessArtifact(candidate); this.binding.guard(artifact);
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    if (!state.contracts.has(artifact.contractDigest)) throw Error("Contract is not registered");
    if (!observedRequestEvidenceAvailable(artifact, await this.journal.read())) throw Error("Owned observed request evidence unavailable");
    if (artifact.revision) {
      const { artifact: predecessor } = await this.resolve(artifact.revision.predecessorDigest);
      const changed = ["description", "runtime", "runtimeLockDigest", "entrypoint", "files", "dependencies", "sources", "contractDigest"]
        .filter(key => harnessDigest((artifact as any)[key] ?? null) !== harnessDigest((predecessor as any)[key] ?? null));
      if (artifact.name !== predecessor.name || harnessDigest(changed) !== harnessDigest(artifact.revision.changedFields) ||
        predecessor.sources.some(source => !artifact.sources.some(next => harnessDigest(next) === harnessDigest(source)))) throw Error("Revision must preserve predecessor identity and source evidence");
    }
    const hash = await this.binding.blobs.put(this.binding.owner, artifact);
    await this.emit("AikoHarnessCandidateRecorded", hash, { harnessDigest: hash, contractDigest: artifact.contractDigest, name: artifact.name, runtime: artifact.runtime, dependencies: artifact.dependencies, ...(artifact.revision ? { revision: artifact.revision } : {}) });
    return hash;
  }
  /** Edits make a candidate, never a route change or execution grant. A changed
   * schema/effect requires a separately registered trusted outcome contract. */
  async revise(predecessorDigest: HarnessDigest, changes: Partial<Pick<HarnessArtifact, "description" | "runtime" | "runtimeLockDigest" | "entrypoint" | "files" | "dependencies" | "sources" | "contractDigest">>) {
    boundedJson(changes); this.binding.guard(changes);
    const allowed = ["description", "runtime", "runtimeLockDigest", "entrypoint", "files", "dependencies", "sources", "contractDigest"];
    if (!changes || Array.isArray(changes) || Object.keys(changes).some(key => !allowed.includes(key))) throw Error("Unsupported revision field");
    const { artifact: predecessor } = await this.resolve(predecessorDigest);
    const candidate = { ...predecessor, ...structuredClone(changes) };
    const changedFields = allowed.filter(key => harnessDigest((candidate as any)[key] ?? null) !== harnessDigest((predecessor as any)[key] ?? null));
    if (!changedFields.length) throw Error("Revision must change the executable definition or its metadata; use fresh inputs with the current version");
    candidate.revision = { version: 1, predecessorDigest, changedFields };
    return this.record(candidate);
  }
  async resolve(hash: HarnessDigest) {
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    if (!state.candidates.has(hash)) throw Error("Owned harness candidate unavailable");
    const artifact = validateHarnessArtifact(await this.binding.blobs.get(this.binding.owner, hash) as HarnessArtifact);
    if (!observedRequestEvidenceAvailable(artifact, await this.journal.read())) throw Error("Owned observed request evidence unavailable");
    const { contract, verifier } = await this.resolveContract(artifact.contractDigest);
    return { artifact, contract, verifier };
  }
  async resolveContract(digest: HarnessDigest) {
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    if (!state.contracts.has(digest)) throw Error("Harness contract unavailable");
    const contract = await this.binding.blobs.get(this.binding.owner, digest) as HarnessContract;
    const verifier = this.binding.verifiers.get(contract.verifierDigest);
    if (!verifier || verifier.digest !== contract.verifierDigest || verifier.evaluatorDigest !== contract.evaluatorDigest || typeof verifier.verify !== "function") throw Error("Pinned verifier unavailable");
    const registered = state.contracts.get(digest)!;
    if (registered.verifierDigest !== contract.verifierDigest || registered.evaluatorDigest !== contract.evaluatorDigest) throw Error("Registered verifier identity changed");
    if (registered.datasetDigest !== harnessDigest(verifier.cases)) throw Error("Registered evaluation cases changed");
    return { contract, verifier };
  }
  async run(hash: HarnessDigest, input: HarnessJson, operationId: string, signal: AbortSignal, options: { caseId?: string; expectedContext?: HarnessDigest; receiptOf?: string; reconciliationCallId?: string } = {}): Promise<HarnessWitness> {
    if (!identifier.test(operationId)) throw Error("Invalid harness operation ID");
    boundedJson(input);
    input = structuredClone(input);
    options = structuredClone(options);
    const inputRef = await this.binding.blobs.putPrivate(this.binding.owner, input);
    const events = await this.journal.read();
    const started = events.find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.binding.owner && e.id === operationId);
    if (started && (started.harnessDigest !== hash || started.inputRef !== inputRef || started.caseId !== (options.caseId ?? null) || started.receiptOf !== options.receiptOf)) throw Error("Harness operation identity conflict");
    const child = events.find(e => e.type === "AikoHarnessExperimentTrialWitness" && e.owner === this.binding.owner && e.id === operationId);
    if (child && ((child.witness as HarnessWitness)?.harnessDigest !== hash || child.inputRef !== inputRef || child.caseId !== (options.caseId ?? null))) throw Error("Harness operation identity conflict");
    const previous = harnessLibraryState(events, this.binding.owner).witnesses.get(operationId);
    if (previous) return structuredClone(previous);
    const { artifact, contract, verifier } = await this.resolve(hash);
    const context = structuredClone(await this.binding.context(signal)), contextDigest = harnessDigest(context);
    if (options.expectedContext && options.expectedContext !== contextDigest) throw Error("Evaluation context changed");
    if (options.receiptOf) {
      const original = events.find(e => e.type === "AikoHarnessRunStarted" && e.owner === this.binding.owner && e.id === options.receiptOf);
      if (!this.binding.reconcile || !original || original.caseId !== null || options.caseId !== undefined ||
        original.harnessDigest !== hash || original.inputRef !== inputRef || original.contextDigest !== contextDigest) throw Error("Exact current receipt reconciliation unavailable");
    }
    const request = { harnessDigest: hash, inputRef, contextDigest, caseId: options.caseId ?? null,
      ...(options.receiptOf ? { receiptOf: options.receiptOf, reconciliationCallId: options.reconciliationCallId } : {}) };
    const requestDigest = harnessDigest(request);
    const stamp = { contractDigest: artifact.contractDigest, harnessDigest: hash, operationId, contextDigest, verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest };
    const witness: HarnessWitness = { ...stamp, status: "unknown", evidence: [], quality: null, latencyMs: 0, costUsd: null };
    if (started) {
      // The caller may have disconnected after a write or verifier dispatch. Never infer failure.
      witness.evidence = ["interrupted-execution-needs-reconciliation"];
      return witness;
    }
    signal.throwIfAborted();
    const executionCase = options.caseId === undefined ? undefined : verifier.cases.find(fixture => fixture.id === options.caseId && harnessDigest(fixture.input) === harnessDigest(input));
    const admitted = schemaValid(contract.inputSchema, input) && (options.caseId === undefined
      ? await this.binding.authorize(structuredClone(artifact), structuredClone(contract), structuredClone(context), structuredClone(input), signal)
      : !!executionCase && (this.binding.authorizeEvaluation
        ? await this.binding.authorizeEvaluation(structuredClone(artifact), structuredClone(contract), structuredClone(context), structuredClone(executionCase), signal)
        : contract.effect === "read" && await this.binding.authorize(structuredClone(artifact), structuredClone(contract), structuredClone(context), structuredClone(input), signal)));
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
        const execute = options.receiptOf ? this.binding.reconcile! : this.binding.execute;
        const result = structuredClone(await bounded(async () => {
          if (!observedRequestEvidenceAvailable(artifact, await this.journal.read())) throw Error("Owned observed request evidence changed before dispatch");
          return execute(structuredClone({ owner: this.binding.owner, operationId: options.receiptOf ?? operationId, ...(options.caseId === undefined ? {} : { caseId: options.caseId }), artifactDigest: hash, artifact, contract, context, input }), deadline);
        }, deadline));
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
    if (contract.transfer && !(await this.transferEvidence(hash, evaluationId, signal)).eligible) throw Error("Independent transfer evidence required");
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
  /** Inspect independent fixed-case evidence without returning fixture inputs or
   * answers. A renamed copy of a development input is not held-out transfer. */
  async transferEvidence(hash: HarnessDigest, evaluationId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const { artifact, contract, verifier } = await this.resolve(hash);
    const events = await this.journal.read(), state = harnessLibraryState(events, this.binding.owner), evaluation = state.evaluations.get(evaluationId);
    const contextDigest = harnessDigest(await this.binding.context(signal));
    const development = new Set(verifier.cases.filter(c => c.split === "development").map(c => harnessDigest(c.input)));
    const novel = new Set(verifier.cases.filter(c => c.split === "held-out" && !development.has(harnessDigest(c.input))).map(c => harnessDigest(c.input)));
    const required = contract.transfer?.minimumNovelHeldOutInputs ?? 1;
    const ids = Array.isArray(evaluation?.witnessIds) ? evaluation.witnessIds as string[] : [];
    const covered = new Set<string>();
    let valid = !!evaluation?.eligible && evaluation.harnessDigest === hash && evaluation.contractDigest === artifact.contractDigest &&
      evaluation.contextDigest === contextDigest && evaluation.datasetDigest === harnessDigest(verifier.cases) && ids.length > 0;
    for (const id of ids) {
      const witness = state.witnesses.get(id);
      const run = events.find(e => e.owner === this.binding.owner && e.id === id && ["AikoHarnessRunStarted", "AikoHarnessExperimentTrialWitness"].includes(e.type));
      const fixture = verifier.cases.find(c => c.id === run?.caseId);
      if (!witness || !run || !fixture || witness.status !== "satisfied" || witness.harnessDigest !== hash || witness.contractDigest !== artifact.contractDigest ||
        witness.verifierDigest !== contract.verifierDigest || witness.evaluatorDigest !== contract.evaluatorDigest || witness.contextDigest !== contextDigest) { valid = false; continue; }
      // Validate the retained execution's exact input, including joined native
      // trial witnesses. Erased/missing custody cannot establish fresh transfer.
      try {
        const input = await this.binding.blobs.get(this.binding.owner, run.inputRef as HarnessDigest);
        if (harnessDigest(input) !== harnessDigest(fixture.input)) { valid = false; continue; }
      } catch { valid = false; continue; }
      covered.add(fixture.id);
    }
    signal.throwIfAborted();
    valid = valid && covered.size === verifier.cases.length && development.size > 0;
    return { version: 1, eligible: valid && novel.size >= required,
      reason: !valid ? "current-independent-evidence-unavailable" : novel.size < required ? "insufficient-novel-held-out-inputs" : "fixed-case-transfer-checked",
      developmentInputs: development.size, novelHeldOutInputs: novel.size, requiredNovelHeldOutInputs: required,
      checkedCases: covered.size, evaluationId, contextDigest, scope: "registered-input-domain-and-current-context" };
  }
  /** Parameters and initiation scope come from the pinned contract; examples
   * and failure lineage come from existing receipts. Reading never optimizes. */
  async procedure(hash: HarnessDigest, signal: AbortSignal) {
    const { artifact, contract } = await this.resolve(hash);
    const events = await this.journal.read(), state = harnessLibraryState(events, this.binding.owner);
    const contextDigest = harnessDigest(await this.binding.context(signal));
    const head = state.heads.get(harnessDigest([artifact.name, artifact.contractDigest, contextDigest]));
    const current = head?.type === "AikoHarnessPromoted" && head.harnessDigest === hash;
    const transfer = current ? await this.transferEvidence(hash, String(head.evaluationId), signal) : undefined;
    const runs = events.filter(e => e.owner === this.binding.owner && e.type === "AikoHarnessRunStarted" && e.harnessDigest === hash);
    const summarize = (evaluation: boolean, reconciliation = false) => {
      const selected = runs.filter(e => (e.caseId !== null) === evaluation && (e.receiptOf !== undefined) === reconciliation);
      // Keep the original execution's failures/unknowns and costs in lineage;
      // a later receipt check has its own measurements and does not erase them.
      const witnesses = selected.map(e => events.find(w => w.owner === this.binding.owner && w.type === "AikoHarnessChecked" && w.id === e.id)?.witness as HarnessWitness | undefined);
      const complete = witnesses.every(w => !!w);
      const sum = (field: "costUsd" | "latencyMs") => complete && witnesses.every(w => typeof w?.[field] === "number") ? witnesses.reduce((n, w) => n + w![field]!, 0) : null;
      const measured = (field: "modelCalls" | "tokens") => complete && witnesses.every(w => typeof w?.measurements?.[field] === "number") ? witnesses.reduce((n, w) => n + w!.measurements![field]!, 0) : null;
      return { executions: selected.length, satisfied: witnesses.filter(w => w?.status === "satisfied").length,
        failed: witnesses.filter(w => w?.status === "violated" || w?.status === "blocked").length, unknown: witnesses.filter(w => !w || w.status === "unknown").length,
        costUsd: sum("costUsd"), executionLatencyMs: sum("latencyMs"), executorModelCalls: measured("modelCalls"), executorTokens: measured("tokens") };
    };
    const resolutions = events.filter(e => e.owner === this.binding.owner && e.type === "AikoHarnessRecoverySettled" && e.status === "recovered")
      .flatMap(settled => {
        const impasse = events.find(e => e.owner === this.binding.owner && e.type === "AikoHarnessImpasseRecorded" && e.id === settled.impasseId && e.harnessDigest === hash);
        const attempt = events.find(e => e.owner === this.binding.owner && e.type === "AikoHarnessRecoveryStarted" && e.id === settled.id);
        const parent = state.witnesses.get(String(settled.parentWitnessId)), child = state.witnesses.get(String(settled.childId));
        const association = events.find(e => e.owner === this.binding.owner && e.type === "AikoHarnessTaskBound" && e.id === settled.parentWitnessId && e.recoveryId === settled.id);
        const childAssociation = events.find(e => e.owner === this.binding.owner && e.type === "AikoHarnessTaskBound" && e.id === settled.childId && e.recoveryId === settled.id && e.stage === "child");
        if (!impasse || !attempt || attempt.impasseId !== impasse.id || !association || !childAssociation || association.inputRef !== impasse.inputRef ||
          harnessDigest(association.task) !== harnessDigest(impasse.task) || parent?.status !== "satisfied" || child?.status !== "satisfied" || parent.contractDigest !== artifact.contractDigest) return [];
        return [{ strategy: String(attempt.strategy), childHarnessDigest: child.harnessDigest, contextDigest: parent.contextDigest,
          childWitnessId: child.operationId, parentWitnessId: parent.operationId, scope: "historical-resolution-only" }];
      }).slice(-4);
    const result = { version: 1, harnessDigest: hash, contractDigest: artifact.contractDigest, name: artifact.name,
      basis: current && transfer?.eligible ? "verified-transfer" : runs.some(e => e.caseId === null && state.witnesses.get(String(e.id))?.status === "satisfied") ? "saved-example" : "candidate",
      currentRoute: !!current, transfer: transfer ?? null,
      parameters: contract.inputSchema, outcome: contract.outcome, outputSchema: contract.outputSchema,
      initiation: { contextDigest, declaredApplicability: contract.applicability, authority: "rechecked-for-exact-input-at-invocation" },
      dependencies: artifact.dependencies, runtimeLockDigest: artifact.runtimeLockDigest ?? null,
      recovery: { maxStrategies: 2, maxSubgoalDepth: 1, examples: resolutions, rule: "Use checked prerequisite outcomes; reconcile uncertain writes before retry; do not infer parent completion from child success." },
      measurements: { scope: "ordinary-library-executor-receipts-only", coldEvaluation: summarize(true), taskRuns: summarize(false), reconciliationReads: summarize(false, true), acquisitionAndGenerationCostUsd: null, breakEvenUses: null },
      limitations: ["Fixed cases do not prove universal generalization.", "Joined experiment costs belong to the experiment report.", "Dependency repair uses the existing authorized experiment path; reading or ordinary reuse launches no optimization."] };
    this.binding.guard(result);
    return result;
  }
  async list() {
    const state = harnessLibraryState(await this.journal.read(), this.binding.owner);
    return { contracts: [...state.contracts.values()], candidates: [...state.candidates.values()], active: [...state.heads.values()].filter(e => e.type === "AikoHarnessPromoted"), routes: [...state.heads.values()], skills: [...state.skills.values()] };
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
    boundedJson(output);
    // The native CodeHarness facade retains this private value outside general
    // event payloads and makes it available to the next sandbox segment.
    return { status: "satisfied", operationId, output, outputRef: witness.outputRef, freshness: "historical-operation" };
  }
  async verifiedRoute(name: string, contractDigest: HarnessDigest, signal: AbortSignal) {
    const contextDigest = harnessDigest(await this.binding.context(signal));
    const routeKey = harnessDigest([name, contractDigest, contextDigest]);
    const head = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
    if (head?.type !== "AikoHarnessPromoted") throw Error("No verified harness for this action and context");
    const { contract } = await this.resolve(head.harnessDigest as HarnessDigest);
    if (contract.transfer && !(await this.transferEvidence(head.harnessDigest as HarnessDigest, String(head.evaluationId), signal)).eligible) throw Error("Independent transfer evidence required");
    const current = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
    if (current?.type !== "AikoHarnessPromoted" || current.id !== head.id || current.generation !== head.generation ||
      harnessDigest(await this.binding.context(signal)) !== contextDigest) throw Error("Verified route or context changed during lookup");
    return { harnessDigest: head.harnessDigest as HarnessDigest, contextDigest };
  }
  async call(name: string, contractDigest: HarnessDigest, input: HarnessJson, operationId: string, signal: AbortSignal) {
    const head = await this.verifiedRoute(name, contractDigest, signal);
    return this.run(head.harnessDigest, input, operationId, signal, { expectedContext: head.contextDigest });
  }
}

/** Native tools can create candidates but cannot register or edit trusted evaluation contracts. */
export function harnessLibraryTools(binding: HarnessLibraryBinding): NativeTool<Self | EventLog>[] {
  const methods = ["list", "record", "evaluate", "promote", "run", "call", "output", "skill", "procedure", "inspect", "revise", "revision_evaluate", "revision_promote", "recall", "from_request"] as const;
  const schemas: Record<typeof methods[number], Record<string, unknown>> = {
    list: { type: "object", properties: {}, additionalProperties: false },
    record: { type: "object", properties: { artifact: { type: "object" } }, required: ["artifact"], additionalProperties: false },
    evaluate: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" } }, required: ["digest", "evaluationId"], additionalProperties: false },
    promote: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" }, expectedGeneration: { type: "integer", minimum: 0 } }, required: ["digest", "evaluationId", "expectedGeneration"], additionalProperties: false },
    run: { type: "object", properties: { digest: { type: "string" }, input: {}, operationId: { type: "string" } }, required: ["digest", "input", "operationId"], additionalProperties: false },
    call: { type: "object", properties: { name: { type: "string" }, contractDigest: { type: "string" }, input: {}, operationId: { type: "string" } }, required: ["name", "contractDigest", "input", "operationId"], additionalProperties: false },
    output: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false },
    skill: { type: "object", properties: { digest: { type: "string" }, resource: { type: "string" } }, required: ["digest"], additionalProperties: false },
    procedure: { type: "object", properties: { digest: { type: "string" } }, required: ["digest"], additionalProperties: false },
    inspect: { type: "object", properties: { digest: { type: "string" } }, required: ["digest"], additionalProperties: false },
    revise: { type: "object", properties: { predecessorDigest: { type: "string" }, changes: { type: "object" } }, required: ["predecessorDigest", "changes"], additionalProperties: false },
    revision_evaluate: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" } }, required: ["digest", "evaluationId"], additionalProperties: false },
    revision_promote: { type: "object", properties: { digest: { type: "string" }, evaluationId: { type: "string" }, expectedGeneration: { type: "integer", minimum: 0 } }, required: ["digest", "evaluationId", "expectedGeneration"], additionalProperties: false },
    recall: { type: "object", properties: { name: { type: "string" }, contractDigest: { type: "string" }, input: {} }, required: ["name", "contractDigest", "input"], additionalProperties: false },
    from_request: { type: "object", properties: { toolDigest: { type: "string" }, name: { type: "string" }, contractDigest: { type: "string" } }, required: ["toolDigest", "name", "contractDigest"], additionalProperties: false },
  };
  const revisionDescriptions: Partial<Record<typeof methods[number], string>> = {
    inspect: "Inspect an immutable tool version, source evidence, authored edits, input/outcome contract and current route generation. No execution or fixture answers are returned.",
    revise: "Create an immutable candidate from predecessorDigest and changed artifact fields. Preserve source evidence. New schemas or effects require a separately registered contractDigest. Different declared inputs use harness_run instead.",
    revision_evaluate: "Evaluate a candidate against its fixed independent contract cases. Retain failures and unknown outcomes without replaying uncertain execution. No promotion occurs.",
    revision_promote: "Promote an independently eligible candidate with expectedGeneration from harness_inspect. Recheck current authority. Existing watch connections keep their pinned versions.",
    recall: "Resolve the current verified version for name and contractDigest, checking its schema and current authority for the supplied fresh input. Return availability and evidence without executing anything.",
    from_request: "Create a network candidate from an owned indexed public request toolDigest or captured session-read artifactDigest, supplied as toolDigest, and an independently registered read contract. The contract must classify this exact source in applicability.observedRequest. Session reads require an explicitly approved current host session/read binding. Writes remain on observed_network_run and its approval path. Captured evidence is not a passing evaluation.",
  };
  return methods.map(method => ({
    spec: { name: `harness_${method}`, description: revisionDescriptions[method] ?? (method === "procedure" ? "Inspect whether this artifact is a saved example or has checked transfer on new inputs. Read its pinned parameters, current context, dependencies, checked recovery examples and measured executor costs. Missing learning costs remain unknown. This read does not execute, repair or promote anything; authority is checked for the exact input at invocation." : method === "skill" ? "Read the exact private SKILL.md produced by passive background derivation. Supply an optional declared resource path to read its contract, evidence or provenance. Pending and unavailable documentation never trigger regeneration or execution." : `Harness library ${method}: use immutable artifacts and independently registered outcome contracts. Evaluation executes fixed fixtures; promotion requires held-out witnesses. Run returns a durable witness and private output reference.`), inputSchema: schemas[method] },
    run: (input: unknown) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread || !schemaValid(schemas[method], input)) return { status: "rejected" };
      const library = new HarnessLibrary(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) });
      const args = input as any;
      return yield* Effect.tryPromise({ try: async (signal): Promise<unknown> => {
        const revisions = new HarnessRevisions(library);
        if (method === "from_request") return revisions.fromRequest(args.toolDigest, args.name, args.contractDigest, signal);
        if (method === "inspect") return revisions.inspect(args.digest, signal);
        if (method === "revise") return revisions.derive(args.predecessorDigest, args.changes, signal);
        if (method === "revision_evaluate") return revisions.evaluate(args.digest, args.evaluationId, signal);
        if (method === "revision_promote") return revisions.promote(args.digest, args.evaluationId, args.expectedGeneration, signal);
        if (method === "recall") return revisions.recall(args.name, args.contractDigest, args.input, signal);
        if (method === "list") return library.list();
        if (method === "record") return library.record(args.artifact).then(digest => ({ digest }));
        if (method === "evaluate") return library.evaluate(args.digest, args.evaluationId, signal);
        if (method === "promote") return library.promote(args.digest, args.evaluationId, args.expectedGeneration, signal);
        if (method === "call") return library.call(args.name, args.contractDigest, args.input, args.operationId, signal);
        if (method === "output") return library.output(args.operationId);
        if (method === "skill") return library.skill(args.digest, args.resource);
        if (method === "procedure") return library.procedure(args.digest, signal);
        return library.run(args.digest, args.input, args.operationId, signal);
      }, catch: () => Error("Harness operation failed; inspect its durable receipt before retrying") }).pipe(Effect.catch(() => Effect.succeed({ status: "failed" })));
    }),
  }));
}
