import { Database } from "bun:sqlite"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"
import {
  canonicalSiteHarnessArtifact,
  isSha256Digest,
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact,
  type JsonValue,
  type Sha256Digest,
  type SiteHarnessArtifact
} from "./harness-artifact"
import {
  HARNESS_EVALUATION_REVISION,
  canonicalHarnessEvaluationAttestation,
  evaluateHarnessArtifact,
  harnessEvaluationAttestationOf,
  harnessEvaluationCaseSetDigest,
  type HarnessEvaluationAttestation,
  type HarnessEvalCase,
  type HarnessEvaluationReport
} from "./harness-eval"
import type { ApprovedHarnessJsAdapter, ApprovedHarnessWasmAdapter } from "./harness-runtime"
import {
  canonicalNetworkToolDefinition, networkToolDigest, summarizeCompiledNetworkTool,
  validateNetworkToolDefinition, type IndexedNetworkTool, type NetworkToolIndexPage
} from "./network-tool-catalog"

export const HARNESS_REGISTRY_SCHEMA_VERSION = 2 as const

export type HarnessEvaluationStatus = "passed" | "failed"

export interface HarnessArtifactSnapshot {
  readonly digest: Sha256Digest
  readonly artifact: SiteHarnessArtifact
  readonly canonicalJson: string
  readonly createdAt: number
}

export interface RecordHarnessEvaluationInput {
  readonly evaluationId: string
  readonly artifactDigest: Sha256Digest
  readonly cases: ReadonlyArray<HarnessEvalCase>
  /**
   * Optional trusted controller-provided adapters (real modules from the
   * store). They are not reported: the report stays value-free and is still
   * bound to the artifact digest, whose producers carry every module digest.
   */
  readonly wasm?: ReadonlyArray<ApprovedHarnessWasmAdapter>
  readonly js?: ReadonlyArray<ApprovedHarnessJsAdapter>
}

export interface HarnessEvaluationRun {
  readonly evaluationId: string
  readonly artifactDigest: Sha256Digest
  readonly siteId: string
  readonly status: HarnessEvaluationStatus
  readonly evaluationRevision: string
  readonly evidenceDigest: Sha256Digest
  readonly attestation: HarnessEvaluationAttestation
  readonly createdAt: number
}

export interface PromoteHarnessInput {
  readonly siteId: string
  readonly environment: string
  readonly artifactDigest: Sha256Digest
  readonly evaluationId: string
  /** Zero means that no activation may exist yet. */
  readonly expectedGeneration: number
  /** An explicit operator/control-plane approval identity, also used as the promotion idempotency key. */
  readonly approvalId: string
}

export interface ResolvedHarness {
  readonly siteId: string
  readonly environment: string
  readonly generation: number
  readonly artifactDigest: Sha256Digest
  readonly artifact: SiteHarnessArtifact
  readonly canonicalJson: string
  readonly activatedAt: number
  readonly approvalId: string
  readonly evaluationId: string
}

export interface HarnessActivationRecord extends ResolvedHarness {}

export interface HarnessRegistryOptions {
  /** Defaults to an isolated in-memory registry. */
  readonly database?: string
  /** Injectable for deterministic tests. Must return Unix milliseconds. */
  readonly now?: () => number
}

export type HarnessRegistryErrorCode =
  | "closed"
  | "invalid_input"
  | "artifact_conflict"
  | "artifact_not_found"
  | "evaluation_conflict"
  | "evaluation_not_found"
  | "evaluation_not_passed"
  | "approval_conflict"
  | "generation_conflict"
  | "site_mismatch"
  | "corrupt_registry"
  | "database_error"

export class HarnessRegistryError extends Error {
  readonly code: HarnessRegistryErrorCode

  constructor(code: HarnessRegistryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "HarnessRegistryError"
    this.code = code
  }
}

interface ArtifactRow {
  readonly digest: string
  readonly site_id: string
  readonly artifact_version: string
  readonly source_capture_digest: string
  readonly schema_version: number
  readonly executor_abi: string
  readonly canonical_json: string
  readonly created_at: number
}

interface EvaluationRow {
  readonly evaluation_id: string
  readonly artifact_digest: string
  readonly site_id: string
  readonly status: string
  readonly evaluation_revision: string
  readonly evidence_digest: string
  readonly details_json: string
  readonly created_at: number
}

interface ActivationRow {
  readonly site_id: string
  readonly environment: string
  readonly generation: number
  readonly artifact_digest: string
  readonly evaluation_id: string
  readonly approval_id: string
  readonly activated_at: number
  readonly canonical_json: string
}

interface HeadRow {
  readonly generation: number
}

const SITE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const ENVIRONMENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u
const MAX_EVALUATION_ATTESTATION_BYTES = 8 * 1024 * 1024

const schemaSql = `
CREATE TABLE IF NOT EXISTS browser_network_tool_index (
  digest TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('detail', 'list', 'lookup')),
  source_thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  definition_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS browser_network_tool_index_site ON browser_network_tool_index(site_id, digest);

CREATE TABLE IF NOT EXISTS harness_registry_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO harness_registry_metadata (singleton, schema_version)
VALUES (1, ${HARNESS_REGISTRY_SCHEMA_VERSION});

CREATE TABLE IF NOT EXISTS harness_artifacts (
  digest TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  source_capture_digest TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  executor_abi TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (site_id, artifact_version),
  UNIQUE (site_id, digest)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_evaluation_runs (
  evaluation_id TEXT PRIMARY KEY,
  artifact_digest TEXT NOT NULL,
  site_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  evaluation_revision TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (evaluation_id, artifact_digest),
  FOREIGN KEY (site_id, artifact_digest) REFERENCES harness_artifacts (site_id, digest)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_activations (
  site_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  artifact_digest TEXT NOT NULL,
  evaluation_id TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
  PRIMARY KEY (site_id, environment, generation),
  FOREIGN KEY (site_id, artifact_digest) REFERENCES harness_artifacts (site_id, digest),
  FOREIGN KEY (evaluation_id, artifact_digest) REFERENCES harness_evaluation_runs (evaluation_id, artifact_digest)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_activation_heads (
  site_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  PRIMARY KEY (site_id, environment),
  FOREIGN KEY (site_id, environment, generation)
    REFERENCES harness_activations (site_id, environment, generation)
) STRICT;

CREATE TRIGGER IF NOT EXISTS harness_artifacts_no_update
BEFORE UPDATE ON harness_artifacts BEGIN
  SELECT RAISE(ABORT, 'harness artifacts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS harness_artifacts_no_delete
BEFORE DELETE ON harness_artifacts BEGIN
  SELECT RAISE(ABORT, 'harness artifacts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS harness_evaluations_no_update
BEFORE UPDATE ON harness_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'harness evaluations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS harness_evaluations_no_delete
BEFORE DELETE ON harness_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'harness evaluations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS harness_activations_no_update
BEFORE UPDATE ON harness_activations BEGIN
  SELECT RAISE(ABORT, 'harness activations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS harness_activations_no_delete
BEFORE DELETE ON harness_activations BEGIN
  SELECT RAISE(ABORT, 'harness activations are append-only');
END;

DROP TRIGGER IF EXISTS harness_activation_requires_passed_evaluation;
CREATE TRIGGER IF NOT EXISTS harness_activation_requires_passed_evaluation
BEFORE INSERT ON harness_activations
WHEN NOT EXISTS (
  SELECT 1 FROM harness_evaluation_runs e
  WHERE e.evaluation_id = NEW.evaluation_id
    AND e.artifact_digest = NEW.artifact_digest
    AND e.site_id = NEW.site_id
    AND e.status = 'passed'
    AND e.evaluation_revision = '${HARNESS_EVALUATION_REVISION}'
    AND e.evidence_digest IS NOT NULL
    AND e.details_json IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'activation requires an exact passed evaluation');
END;

CREATE TRIGGER IF NOT EXISTS harness_passed_evaluation_requires_witness
BEFORE INSERT ON harness_evaluation_runs
WHEN NEW.status = 'passed'
  AND (NEW.evaluation_revision != '${HARNESS_EVALUATION_REVISION}' OR NEW.evidence_digest IS NULL OR NEW.details_json IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'passed evaluation requires revision and evidence digest');
END;

DROP TRIGGER IF EXISTS harness_evaluation_attestation_consistent;
CREATE TRIGGER IF NOT EXISTS harness_evaluation_attestation_consistent
BEFORE INSERT ON harness_evaluation_runs
WHEN json_valid(NEW.details_json) != 1
  OR json_extract(NEW.details_json, '$.schemaVersion') IS NOT 1
  OR json_extract(NEW.details_json, '$.evaluationRevision') IS NOT NEW.evaluation_revision
  OR json_extract(NEW.details_json, '$.evidenceDigest') IS NOT NEW.evidence_digest
  OR json_extract(NEW.details_json, '$.artifact.digest') IS NOT NEW.artifact_digest
  OR json_extract(NEW.details_json, '$.artifact.siteId') IS NOT NEW.site_id
  OR json_extract(NEW.details_json, '$.eligibleForPromotion') IS NOT CASE WHEN NEW.status = 'passed' THEN 1 ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'evaluation attestation does not match its row');
END;
`

const activationSelect = `
SELECT
  a.site_id,
  a.environment,
  a.generation,
  a.artifact_digest,
  a.evaluation_id,
  a.approval_id,
  a.activated_at,
  r.canonical_json
FROM harness_activations a
JOIN harness_artifacts r ON r.digest = a.artifact_digest
`

const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value)

const requiredString = (value: unknown, name: string, max: number, pattern: RegExp): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !pattern.test(value)) {
    throw new HarnessRegistryError("invalid_input", `${name} has an invalid format`)
  }
  return value
}

const requiredDigest = (value: unknown, name: string): Sha256Digest => {
  if (!isSha256Digest(value)) {
    throw new HarnessRegistryError("invalid_input", `${name} must be a lowercase sha256:<64 hex characters> digest`)
  }
  return value
}

const timestampOf = (now: () => number): number => {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HarnessRegistryError("invalid_input", "registry clock must return a non-negative safe integer Unix millisecond timestamp")
  }
  return value
}

const jsonDataAt = (
  value: unknown,
  path = "details",
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
  ancestors: ReadonlySet<object> = new Set()
): JsonValue => {
  budget.nodes += 1
  if (budget.nodes > 4_096 || depth > 16) {
    throw new HarnessRegistryError("invalid_input", `${path} exceeds the JSON size/depth limit`)
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HarnessRegistryError("invalid_input", `${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== "object" || value === null) {
    throw new HarnessRegistryError("invalid_input", `${path} must contain JSON data only`)
  }
  if (ancestors.has(value)) throw new HarnessRegistryError("invalid_input", `${path} must not be cyclic`)
  const next = new Set(ancestors)
  next.add(value)
  if (Array.isArray(value)) return value.map((entry, index) => jsonDataAt(entry, `${path}[${index}]`, depth + 1, budget, next))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HarnessRegistryError("invalid_input", `${path} must contain plain JSON objects only`)
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || key.length === 0 || key.length > 256) {
      throw new HarnessRegistryError("invalid_input", `${path} contains an invalid object key`)
    }
    result[key] = jsonDataAt((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, budget, next)
  }
  return result
}

const canonicalJsonData = (value: JsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonData).join(",")}]`
  const record = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonData(record[key] as JsonValue)}`).join(",")}}`
}

const deepFreezeJson = (value: JsonValue): JsonValue => {
  if (typeof value !== "object" || value === null) return value
  for (const nested of Object.values(value)) deepFreezeJson(nested)
  return Object.freeze(value)
}

const attestationJsonOf = (
  report: HarnessEvaluationReport,
  cases: ReadonlyArray<HarnessEvalCase>
): { readonly attestation: HarnessEvaluationAttestation; readonly json: string } => {
  let attestation: HarnessEvaluationAttestation
  try {
    attestation = harnessEvaluationAttestationOf(report)
    if (harnessEvaluationCaseSetDigest(cases) !== attestation.contract.caseSetDigest) {
      throw new TypeError("case corpus does not match its evaluation report")
    }
  } catch (error) {
    throw new HarnessRegistryError("invalid_input", "evaluation report failed verification", error)
  }
  const json = canonicalHarnessEvaluationAttestation(attestation)
  if (new TextEncoder().encode(json).byteLength > MAX_EVALUATION_ATTESTATION_BYTES) {
    throw new HarnessRegistryError(
      "invalid_input",
      `evaluation attestation exceeds ${MAX_EVALUATION_ATTESTATION_BYTES} bytes`
    )
  }
  return { attestation, json }
}

const storedAttestationOf = (row: EvaluationRow): HarnessEvaluationAttestation => {
  try {
    const parsedJson = jsonDataAt(JSON.parse(row.details_json), "attestation")
    const parsed = parsedJson as unknown as HarnessEvaluationAttestation
    const expectedFields = [
      "artifact",
      "capability",
      "cases",
      "contract",
      "eligibleForPromotion",
      "evaluationRevision",
      "evidenceDigest",
      "gates",
      "safetyFindingCodes",
      "schemaVersion",
      "usage"
    ]
    if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson) ||
      Object.keys(parsedJson).sort().join("\u0000") !== expectedFields.sort().join("\u0000") ||
      parsed.schemaVersion !== 1 || parsed.evaluationRevision !== HARNESS_EVALUATION_REVISION ||
      parsed.evidenceDigest !== row.evidence_digest || parsed.artifact?.digest !== row.artifact_digest ||
      parsed.artifact?.siteId !== row.site_id ||
      parsed.eligibleForPromotion !== (row.status === "passed") ||
      canonicalHarnessEvaluationAttestation(parsed) !== row.details_json) {
      throw new Error("attestation metadata does not match the evaluation row")
    }
    return deepFreezeJson(parsedJson) as unknown as HarnessEvaluationAttestation
  } catch (error) {
    throw new HarnessRegistryError(
      "corrupt_registry",
      `evaluation ${JSON.stringify(row.evaluation_id)} has a corrupt attestation`,
      error
    )
  }
}

export class HarnessRegistry implements Disposable {
  readonly database: string
  readonly #db: Database
  readonly #now: () => number
  #closed = false

  constructor(options: string | HarnessRegistryOptions = {}) {
    const normalized = typeof options === "string" ? { database: options } : options
    this.database = normalized.database ?? ":memory:"
    this.#now = normalized.now ?? Date.now
    if (this.database !== "" && this.database !== ":memory:" && !this.database.startsWith("file:")) {
      mkdirSync(dirname(this.database), { recursive: true })
    }
    try {
      this.#db = new Database(this.database)
      this.#db.exec("PRAGMA foreign_keys = ON")
      this.#db.exec("PRAGMA busy_timeout = 5000")
      if (this.database !== "" && this.database !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL")
      this.#db.exec(schemaSql)
      const metadata = this.#db.query<{ readonly schema_version: number }, []>(
        "SELECT schema_version FROM harness_registry_metadata WHERE singleton = 1"
      ).get()
      if (metadata?.schema_version !== HARNESS_REGISTRY_SCHEMA_VERSION) {
        throw new HarnessRegistryError(
          "corrupt_registry",
          `unsupported harness registry schema ${String(metadata?.schema_version)}`
        )
      }
    } catch (error) {
      if (error instanceof HarnessRegistryError) throw error
      throw new HarnessRegistryError("database_error", "could not open the harness registry", error)
    }
  }

  static open(options: string | HarnessRegistryOptions = {}): HarnessRegistry {
    return new HarnessRegistry(options)
  }

  /** Trusted ingress only; remote/model callers never supply definitions or approval records. */
  indexNetworkTool(input: Pick<IndexedNetworkTool, "tool" | "intent" | "sourceThreadId">): IndexedNetworkTool {
    if (!input || Object.keys(input).sort().join(",") !== "intent,sourceThreadId,tool" ||
        !["detail", "list", "lookup"].includes(input.intent) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.sourceThreadId) ||
        !input.tool || Object.keys(input.tool).sort().join(",") !== "definition,digest") {
      throw new HarnessRegistryError("invalid_input", "invalid browser bookmark")
    }
    const definitionJson = canonicalNetworkToolDefinition(input.tool.definition)
    const digest = networkToolDigest(input.tool.definition)
    if (digest !== input.tool.digest || Buffer.byteLength(definitionJson) > 262_144) {
      throw new HarnessRegistryError("invalid_input", "invalid browser bookmark digest or size")
    }
    return this.#databaseCall(() => this.#db.transaction(() => {
      const existing = this.getIndexedNetworkTool(digest)
      if (existing) return existing
      const size = this.#db.query<{ count: number; bytes: number }, []>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(definition_json AS BLOB))), 0) AS bytes FROM browser_network_tool_index"
      ).get()!
      if (size.count >= 4_096 || size.bytes + Buffer.byteLength(definitionJson) > 64 * 1024 * 1024) {
        throw new HarnessRegistryError("invalid_input", "browser bookmark storage limit reached")
      }
      const createdAt = this.#now()
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new HarnessRegistryError("invalid_input", "invalid bookmark clock")
      this.#db.query("INSERT INTO browser_network_tool_index VALUES (?, ?, ?, ?, ?, ?)").run(
        digest, input.tool.definition.siteId, input.intent, input.sourceThreadId, createdAt, definitionJson
      )
      return this.getIndexedNetworkTool(digest)!
    }).immediate())
  }

  getIndexedNetworkTool(digest: string): IndexedNetworkTool | undefined {
    if (!isSha256Digest(digest)) throw new HarnessRegistryError("invalid_input", "invalid bookmark digest")
    return this.#databaseCall(() => {
      const row = this.#db.query<{ digest: string; site_id: string; intent: string; source_thread_id: string; created_at: number; definition_json: string }, [string]>(
        "SELECT * FROM browser_network_tool_index WHERE digest = ?"
      ).get(digest)
      if (!row) return undefined
      try {
        if (Buffer.byteLength(row.definition_json) > 262_144) throw new Error("size")
        const definition = validateNetworkToolDefinition(JSON.parse(row.definition_json))
        if (networkToolDigest(definition) !== digest || definition.siteId !== row.site_id ||
            canonicalNetworkToolDefinition(definition) !== row.definition_json ||
            !["detail", "list", "lookup"].includes(row.intent) ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.source_thread_id) ||
            !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error("binding")
        return Object.freeze({ status: "draft", intent: row.intent as IndexedNetworkTool["intent"],
          sourceThreadId: row.source_thread_id, createdAt: row.created_at,
          tool: Object.freeze({ digest, definition }) })
      } catch { throw new HarnessRegistryError("corrupt_registry", "invalid stored browser bookmark") }
    })
  }

  listIndexedNetworkTools(input: { readonly siteId?: string; readonly cursor: number }): NetworkToolIndexPage {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > 4_096 ||
        (input.siteId !== undefined && (!SITE_ID.test(input.siteId) || input.siteId.length > 253))) {
      throw new HarnessRegistryError("invalid_input", "invalid bookmark query")
    }
    return this.#databaseCall(() => {
      const rows = this.#db.query<{ digest: string }, [string | null, string | null, number]>(
        "SELECT digest FROM browser_network_tool_index WHERE (? IS NULL OR site_id = ?) ORDER BY digest LIMIT 21 OFFSET ?"
      ).all(input.siteId ?? null, input.siteId ?? null, input.cursor)
      return Object.freeze({ items: Object.freeze(rows.slice(0, 20).map(({ digest }) => {
        const { tool, ...bookmark } = this.getIndexedNetworkTool(digest)!
        return Object.freeze({ ...bookmark, toolDigest: tool.digest, toolId: tool.definition.toolId, summary: summarizeCompiledNetworkTool(tool) })
      })), ...(rows.length > 20 ? { nextCursor: input.cursor + 20 } : {}) })
    })
  }

  #assertOpen(): void {
    if (this.#closed) throw new HarnessRegistryError("closed", "harness registry is closed")
  }

  #databaseCall<T>(operation: () => T): T {
    this.#assertOpen()
    try {
      return operation()
    } catch (error) {
      if (error instanceof HarnessRegistryError) throw error
      throw new HarnessRegistryError("database_error", "harness registry database operation failed", error)
    }
  }

  #artifactFromRow(row: ArtifactRow): HarnessArtifactSnapshot {
    try {
      const artifact = validateSiteHarnessArtifact(JSON.parse(row.canonical_json))
      const canonicalJson = canonicalSiteHarnessArtifact(artifact)
      const digest = siteHarnessArtifactDigest(artifact)
      if (
        digest !== row.digest ||
        canonicalJson !== row.canonical_json ||
        artifact.siteId !== row.site_id ||
        artifact.version !== row.artifact_version ||
        artifact.sourceCaptureDigest !== row.source_capture_digest ||
        artifact.schemaVersion !== row.schema_version ||
        artifact.executorAbi !== row.executor_abi
      ) {
        throw new Error("artifact row metadata or digest does not match its canonical artifact")
      }
      return frozen({ digest, artifact, canonicalJson, createdAt: row.created_at })
    } catch (error) {
      throw new HarnessRegistryError("corrupt_registry", `artifact row ${JSON.stringify(row.digest)} is corrupt`, error)
    }
  }

  putArtifact(value: unknown): HarnessArtifactSnapshot {
    const artifact = validateSiteHarnessArtifact(value)
    const canonicalJson = canonicalSiteHarnessArtifact(artifact)
    const digest = siteHarnessArtifactDigest(artifact)
    return this.#databaseCall(() => {
      const existing = this.#db.query<ArtifactRow, [string]>(
        "SELECT * FROM harness_artifacts WHERE digest = ?"
      ).get(digest)
      if (existing !== null && existing !== undefined) {
        if (existing.canonical_json !== canonicalJson) {
          throw new HarnessRegistryError("artifact_conflict", `digest collision for ${digest}`)
        }
        return this.#artifactFromRow(existing)
      }
      const version = this.#db.query<{ readonly digest: string }, [string, string]>(
        "SELECT digest FROM harness_artifacts WHERE site_id = ? AND artifact_version = ?"
      ).get(artifact.siteId, artifact.version)
      if (version !== null && version !== undefined) {
        throw new HarnessRegistryError(
          "artifact_conflict",
          `site ${JSON.stringify(artifact.siteId)} version ${JSON.stringify(artifact.version)} is already bound to ${version.digest}`
        )
      }
      const createdAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, string, string, number, string, string, number]>(`
        INSERT INTO harness_artifacts (
          digest, site_id, artifact_version, source_capture_digest,
          schema_version, executor_abi, canonical_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        digest,
        artifact.siteId,
        artifact.version,
        artifact.sourceCaptureDigest,
        artifact.schemaVersion,
        artifact.executorAbi,
        canonicalJson,
        createdAt
      )
      return frozen({ digest, artifact, canonicalJson, createdAt })
    })
  }

  getArtifact(digest: Sha256Digest): HarnessArtifactSnapshot | undefined {
    requiredDigest(digest, "digest")
    return this.#databaseCall(() => {
      const row = this.#db.query<ArtifactRow, [string]>("SELECT * FROM harness_artifacts WHERE digest = ?").get(digest)
      return row === null || row === undefined ? undefined : this.#artifactFromRow(row)
    })
  }

  #evaluationFromRow(row: EvaluationRow): HarnessEvaluationRun {
    if (!isSha256Digest(row.artifact_digest) || !isSha256Digest(row.evidence_digest)) {
      throw new HarnessRegistryError("corrupt_registry", `evaluation ${JSON.stringify(row.evaluation_id)} contains an invalid digest`)
    }
    if (row.status !== "passed" && row.status !== "failed") {
      throw new HarnessRegistryError("corrupt_registry", `evaluation ${JSON.stringify(row.evaluation_id)} contains an invalid status`)
    }
    const attestation = storedAttestationOf(row)
    return frozen({
      evaluationId: row.evaluation_id,
      artifactDigest: row.artifact_digest,
      siteId: row.site_id,
      status: row.status,
      evaluationRevision: row.evaluation_revision,
      evidenceDigest: row.evidence_digest,
      attestation,
      createdAt: row.created_at
    })
  }

  async recordEvaluation(input: RecordHarnessEvaluationInput): Promise<HarnessEvaluationRun> {
    const allowedFields = new Set(["artifactDigest", "cases", "evaluationId", "wasm", "js"])
    if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).some((field) => !allowedFields.has(field))) {
      throw new HarnessRegistryError("invalid_input", "evaluation recording input contains an unknown field")
    }
    const evaluationId = requiredString(input.evaluationId, "evaluationId", 128, OPAQUE_ID)
    const artifactDigest = requiredDigest(input.artifactDigest, "artifactDigest")
    let cases: ReadonlyArray<HarnessEvalCase>
    try {
      if (!Array.isArray(input.cases)) throw new TypeError("cases must be an array")
      cases = structuredClone(input.cases) as ReadonlyArray<HarnessEvalCase>
    } catch (error) {
      throw new HarnessRegistryError("invalid_input", "evaluation cases must be cloneable data", error)
    }
    const snapshot = this.getArtifact(artifactDigest)
    if (snapshot === undefined) {
      throw new HarnessRegistryError("artifact_not_found", `artifact ${artifactDigest} is not registered`)
    }
    let report: HarnessEvaluationReport
    try {
      report = await evaluateHarnessArtifact({
        artifact: snapshot.artifact,
        cases,
        ...(input.wasm === undefined || input.wasm.length === 0 ? {} : { wasm: input.wasm }),
        ...(input.js === undefined || input.js.length === 0 ? {} : { js: input.js })
      })
    } catch (error) {
      throw new HarnessRegistryError("invalid_input", "trusted evaluation could not be completed", error)
    }
    const witnessed = attestationJsonOf(report, cases)
    const status: HarnessEvaluationStatus = witnessed.attestation.eligibleForPromotion ? "passed" : "failed"
    return this.#databaseCall(() => this.#db.transaction(() => {
      const artifact = this.#db.query<ArtifactRow, [string]>("SELECT * FROM harness_artifacts WHERE digest = ?").get(artifactDigest)
      if (artifact === null || artifact === undefined) {
        throw new HarnessRegistryError("artifact_not_found", `artifact ${artifactDigest} is not registered`)
      }
      if (witnessed.attestation.artifact.digest !== artifactDigest ||
        witnessed.attestation.artifact.siteId !== artifact.site_id ||
        witnessed.attestation.artifact.version !== artifact.artifact_version) {
        throw new HarnessRegistryError("evaluation_conflict", "evaluation report does not exactly cover the installed artifact")
      }
      const existing = this.#db.query<EvaluationRow, [string]>(
        "SELECT * FROM harness_evaluation_runs WHERE evaluation_id = ?"
      ).get(evaluationId)
      if (existing !== null && existing !== undefined) {
        if (
          existing.artifact_digest !== artifactDigest ||
          existing.status !== status ||
          existing.evaluation_revision !== witnessed.attestation.evaluationRevision ||
          existing.evidence_digest !== witnessed.attestation.evidenceDigest ||
          existing.details_json !== witnessed.json
        ) {
          throw new HarnessRegistryError("evaluation_conflict", `evaluation ${JSON.stringify(evaluationId)} is immutable`)
        }
        return this.#evaluationFromRow(existing)
      }
      const createdAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, string, string, string, string, string, number]>(`
        INSERT INTO harness_evaluation_runs (
          evaluation_id, artifact_digest, site_id, status,
          evaluation_revision, evidence_digest, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evaluationId,
        artifactDigest,
        artifact.site_id,
        status,
        witnessed.attestation.evaluationRevision,
        witnessed.attestation.evidenceDigest,
        witnessed.json,
        createdAt
      )
      return this.#evaluationFromRow({
        evaluation_id: evaluationId,
        artifact_digest: artifactDigest,
        site_id: artifact.site_id,
        status,
        evaluation_revision: witnessed.attestation.evaluationRevision,
        evidence_digest: witnessed.attestation.evidenceDigest,
        details_json: witnessed.json,
        created_at: createdAt
      })
    }).immediate())
  }

  getEvaluation(evaluationId: string): HarnessEvaluationRun | undefined {
    requiredString(evaluationId, "evaluationId", 128, OPAQUE_ID)
    return this.#databaseCall(() => {
      const row = this.#db.query<EvaluationRow, [string]>(
        "SELECT * FROM harness_evaluation_runs WHERE evaluation_id = ?"
      ).get(evaluationId)
      return row === null || row === undefined ? undefined : this.#evaluationFromRow(row)
    })
  }

  #resolvedFromRow(row: ActivationRow): ResolvedHarness {
    if (!isSha256Digest(row.artifact_digest)) {
      throw new HarnessRegistryError("corrupt_registry", "activation contains an invalid artifact digest")
    }
    let artifact: SiteHarnessArtifact
    try {
      artifact = validateSiteHarnessArtifact(JSON.parse(row.canonical_json))
      if (canonicalSiteHarnessArtifact(artifact) !== row.canonical_json || siteHarnessArtifactDigest(artifact) !== row.artifact_digest) {
        throw new Error("activation artifact digest does not match")
      }
      if (artifact.siteId !== row.site_id) throw new Error("activation site does not match artifact site")
    } catch (error) {
      throw new HarnessRegistryError("corrupt_registry", "activation resolves to a corrupt artifact", error)
    }
    return frozen({
      siteId: row.site_id,
      environment: row.environment,
      generation: row.generation,
      artifactDigest: row.artifact_digest,
      artifact,
      canonicalJson: row.canonical_json,
      activatedAt: row.activated_at,
      approvalId: row.approval_id,
      evaluationId: row.evaluation_id
    })
  }

  promote(input: PromoteHarnessInput): ResolvedHarness {
    const siteId = requiredString(input.siteId, "siteId", 64, SITE_ID)
    const environment = requiredString(input.environment, "environment", 64, ENVIRONMENT)
    const artifactDigest = requiredDigest(input.artifactDigest, "artifactDigest")
    const evaluationId = requiredString(input.evaluationId, "evaluationId", 128, OPAQUE_ID)
    const approvalId = requiredString(input.approvalId, "approvalId", 128, OPAQUE_ID)
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
      throw new HarnessRegistryError("invalid_input", "expectedGeneration must be a non-negative safe integer")
    }

    return this.#databaseCall(() => this.#db.transaction(() => {
      const retried = this.#db.query<ActivationRow, [string]>(
        `${activationSelect} WHERE a.approval_id = ?`
      ).get(approvalId)
      if (retried !== null && retried !== undefined) {
        if (
          retried.site_id !== siteId ||
          retried.environment !== environment ||
          retried.artifact_digest !== artifactDigest ||
          retried.evaluation_id !== evaluationId ||
          retried.generation !== input.expectedGeneration + 1
        ) {
          throw new HarnessRegistryError("approval_conflict", `approval ${JSON.stringify(approvalId)} was already used for another activation`)
        }
        return this.#resolvedFromRow(retried)
      }

      const artifact = this.#db.query<ArtifactRow, [string]>("SELECT * FROM harness_artifacts WHERE digest = ?").get(artifactDigest)
      if (artifact === null || artifact === undefined) {
        throw new HarnessRegistryError("artifact_not_found", `artifact ${artifactDigest} is not registered`)
      }
      if (artifact.site_id !== siteId) {
        throw new HarnessRegistryError("site_mismatch", `artifact ${artifactDigest} belongs to ${JSON.stringify(artifact.site_id)}, not ${JSON.stringify(siteId)}`)
      }
      const evaluation = this.#db.query<EvaluationRow, [string]>(
        "SELECT * FROM harness_evaluation_runs WHERE evaluation_id = ?"
      ).get(evaluationId)
      if (evaluation === null || evaluation === undefined) {
        throw new HarnessRegistryError("evaluation_not_found", `evaluation ${JSON.stringify(evaluationId)} is not registered`)
      }
      if (evaluation.artifact_digest !== artifactDigest || evaluation.site_id !== siteId) {
        throw new HarnessRegistryError("evaluation_conflict", "evaluation does not exactly cover the artifact and site being promoted")
      }
      if (evaluation.status !== "passed") {
        throw new HarnessRegistryError("evaluation_not_passed", `evaluation ${JSON.stringify(evaluationId)} did not pass`)
      }
      const attestation = storedAttestationOf(evaluation)
      if (evaluation.evaluation_revision !== HARNESS_EVALUATION_REVISION ||
        !attestation.eligibleForPromotion || attestation.artifact.digest !== artifactDigest) {
        throw new HarnessRegistryError(
          "evaluation_not_passed",
          `evaluation ${JSON.stringify(evaluationId)} has no verified promotion attestation`
        )
      }
      const head = this.#db.query<HeadRow, [string, string]>(`
        SELECT generation FROM harness_activation_heads WHERE site_id = ? AND environment = ?
      `).get(siteId, environment)
      const currentGeneration = head?.generation ?? 0
      if (currentGeneration !== input.expectedGeneration) {
        throw new HarnessRegistryError(
          "generation_conflict",
          `activation generation is ${currentGeneration}, expected ${input.expectedGeneration}`
        )
      }
      const generation = currentGeneration + 1
      const activatedAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, number, string, string, string, number]>(`
        INSERT INTO harness_activations (
          site_id, environment, generation, artifact_digest,
          evaluation_id, approval_id, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(siteId, environment, generation, artifactDigest, evaluationId, approvalId, activatedAt)
      if (currentGeneration === 0) {
        this.#db.query<never, [string, string, number]>(`
          INSERT INTO harness_activation_heads (site_id, environment, generation) VALUES (?, ?, ?)
        `).run(siteId, environment, generation)
      } else {
        const changed = this.#db.query<never, [number, string, string, number]>(`
          UPDATE harness_activation_heads SET generation = ?
          WHERE site_id = ? AND environment = ? AND generation = ?
        `).run(generation, siteId, environment, currentGeneration)
        if (changed.changes !== 1) {
          throw new HarnessRegistryError("generation_conflict", "activation head changed during promotion")
        }
      }
      return this.#resolvedFromRow({
        site_id: siteId,
        environment,
        generation,
        artifact_digest: artifactDigest,
        evaluation_id: evaluationId,
        approval_id: approvalId,
        activated_at: activatedAt,
        canonical_json: artifact.canonical_json
      })
    }).immediate())
  }

  resolveApproved(siteIdValue: string, environmentValue: string): ResolvedHarness | undefined {
    const siteId = requiredString(siteIdValue, "siteId", 64, SITE_ID)
    const environment = requiredString(environmentValue, "environment", 64, ENVIRONMENT)
    return this.#databaseCall(() => {
      const row = this.#db.query<ActivationRow, [string, string]>(`
        ${activationSelect}
        JOIN harness_activation_heads h
          ON h.site_id = a.site_id
         AND h.environment = a.environment
         AND h.generation = a.generation
        WHERE a.site_id = ? AND a.environment = ?
      `).get(siteId, environment)
      return row === null || row === undefined ? undefined : this.#resolvedFromRow(row)
    })
  }

  resolveGeneration(siteIdValue: string, environmentValue: string, generation: number): ResolvedHarness | undefined {
    const siteId = requiredString(siteIdValue, "siteId", 64, SITE_ID)
    const environment = requiredString(environmentValue, "environment", 64, ENVIRONMENT)
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new HarnessRegistryError("invalid_input", "generation must be a positive safe integer")
    }
    return this.#databaseCall(() => {
      const row = this.#db.query<ActivationRow, [string, string, number]>(`
        ${activationSelect} WHERE a.site_id = ? AND a.environment = ? AND a.generation = ?
      `).get(siteId, environment, generation)
      return row === null || row === undefined ? undefined : this.#resolvedFromRow(row)
    })
  }

  listActivations(siteIdValue: string, environmentValue: string): ReadonlyArray<HarnessActivationRecord> {
    const siteId = requiredString(siteIdValue, "siteId", 64, SITE_ID)
    const environment = requiredString(environmentValue, "environment", 64, ENVIRONMENT)
    return this.#databaseCall(() => Object.freeze(this.#db.query<ActivationRow, [string, string]>(`
      ${activationSelect} WHERE a.site_id = ? AND a.environment = ? ORDER BY a.generation ASC
    `).all(siteId, environment).map((row) => this.#resolvedFromRow(row))))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close(true)
  }

  [Symbol.dispose](): void {
    this.close()
  }
}

export const openHarnessRegistry = (options: string | HarnessRegistryOptions = {}): HarnessRegistry =>
  HarnessRegistry.open(options)
