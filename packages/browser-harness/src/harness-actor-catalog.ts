import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

import { isSha256Digest, type Sha256Digest } from "./harness-artifact"
import {
  canonicalSiteInterfaceContract,
  siteInterfaceContractDigest,
  type SiteInterfaceContract
} from "./harness-interface"

export const HARNESS_ACTOR_CATALOG_SCHEMA_VERSION = 3 as const

export type PublicRouteStatus = "verified" | "unavailable"

export interface HarnessActorBuildInput {
  readonly siteId: string
  readonly environment: string
  readonly generation: number
  readonly artifactDigest: Sha256Digest
  readonly evaluationId: string
  readonly artifactApprovalId: string
  readonly interfaceContract: SiteInterfaceContract
  readonly actorName: string
  readonly generatorRevision: string
  readonly sourceDigest: Sha256Digest
  readonly bundleDigest: Sha256Digest
  readonly manifestSchema: 3
  readonly moduleName: "actor.mjs"
}

export interface HarnessActorBuildRecord extends HarnessActorBuildInput {
  readonly harnessId: Sha256Digest
  readonly interfaceDigest: Sha256Digest
  readonly builtAt: number
}

export interface HarnessDefinitionApprovalInput {
  readonly definitionApprovalId: string
  readonly harnessId: Sha256Digest
  readonly targetId: string
  readonly targetOrigin: string
}

export interface HarnessDefinitionApprovalRecord extends HarnessDefinitionApprovalInput {
  readonly statementDigest: Sha256Digest
  readonly approvedAt: number
}

export interface HarnessDefinitionLoadInput {
  readonly loadId: string
  readonly harnessId: Sha256Digest
  readonly definitionApprovalId: string
  readonly targetId: string
  readonly definitionDigest: Sha256Digest
  readonly publicRoute: PublicRouteStatus
  readonly code?: HarnessDefinitionLoadCode
}

export type HarnessDefinitionLoadCode =
  | "public_route_verified"
  | "upstream_public_binding_unavailable"
  | "public_route_probe_failed"

export interface HarnessDefinitionLoadRecord extends HarnessDefinitionLoadInput {
  readonly loadedAt: number
}

export interface HarnessDefinitionLoadAttemptInput {
  readonly loadId: string
  readonly harnessId: Sha256Digest
  readonly definitionApprovalId: string
  readonly targetId: string
  readonly definitionDigest: Sha256Digest
}

export interface HarnessDefinitionLoadAttemptRecord extends HarnessDefinitionLoadAttemptInput {
  readonly targetOriginDigest: Sha256Digest
  readonly definitionApprovalDigest: Sha256Digest
  readonly reservedAt: number
  readonly outcome?: HarnessDefinitionLoadAttemptOutcomeRecord
}

export type HarnessDefinitionLoadAttemptStatus = "verified" | "unavailable" | "failed"

export type HarnessDefinitionLoadAttemptFailureCode =
  | "activation_not_current"
  | "bundle_invalid"
  | "candidate_escape"
  | "candidate_symlink"
  | "definition_conflict"
  | "definition_load_failed"
  | "definition_not_discoverable"
  | "load_deadline_exceeded"
  | "push_refused"

export type HarnessDefinitionLoadAttemptCode =
  | HarnessDefinitionLoadCode
  | HarnessDefinitionLoadAttemptFailureCode

export interface HarnessDefinitionLoadAttemptOutcomeInput {
  readonly loadId: string
  readonly status: HarnessDefinitionLoadAttemptStatus
  readonly code: HarnessDefinitionLoadAttemptCode
}

export interface HarnessDefinitionLoadAttemptOutcomeRecord extends HarnessDefinitionLoadAttemptOutcomeInput {
  readonly completedAt: number
}

export interface HarnessDefinitionLoadAttemptReservation {
  readonly attempt: HarnessDefinitionLoadAttemptRecord
  readonly created: boolean
}

export interface HarnessDefinitionLoadAttemptCompletion {
  readonly attempt: HarnessDefinitionLoadAttemptRecord
  readonly outcome: HarnessDefinitionLoadAttemptOutcomeRecord
  readonly load?: HarnessDefinitionLoadRecord
}

export interface HarnessActorCatalogEntry {
  readonly build: HarnessActorBuildRecord
  readonly approval?: HarnessDefinitionApprovalRecord
  readonly load?: HarnessDefinitionLoadRecord
  readonly latestAttempt?: HarnessDefinitionLoadAttemptRecord
}

export interface RoutableHarnessActor {
  readonly siteId: string
  readonly environment: string
  readonly targetId: string
  readonly generation: number
  readonly actorName: string
  readonly artifactDigest: Sha256Digest
  readonly interfaceDigest: Sha256Digest
  readonly sourceDigest: Sha256Digest
  readonly buildDigest: Sha256Digest
  readonly definitionDigest: Sha256Digest
  readonly actions: SiteInterfaceContract["actions"]
}

export type RoutableHarnessResolution =
  | { readonly status: "resolved"; readonly actor: RoutableHarnessActor }
  | { readonly status: "not_found" }
  | { readonly status: "not_routable" }

export type HarnessActorCatalogErrorCode =
  | "closed"
  | "invalid_input"
  | "activation_not_current"
  | "build_conflict"
  | "build_not_found"
  | "approval_conflict"
  | "approval_not_found"
  | "attempt_conflict"
  | "attempt_not_found"
  | "load_conflict"
  | "corrupt_catalog"
  | "database_error"

export class HarnessActorCatalogError extends Error {
  readonly code: HarnessActorCatalogErrorCode

  constructor(code: HarnessActorCatalogErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "HarnessActorCatalogError"
    this.code = code
  }
}

export interface HarnessActorCatalogOptions {
  readonly database: string
  readonly now?: () => number
}

interface BuildRow {
  readonly harness_id: string
  readonly site_id: string
  readonly environment: string
  readonly generation: number
  readonly artifact_digest: string
  readonly evaluation_id: string
  readonly artifact_approval_id: string
  readonly interface_digest: string
  readonly interface_json: string
  readonly actor_name: string
  readonly generator_revision: string
  readonly source_digest: string
  readonly bundle_digest: string
  readonly manifest_schema: number
  readonly module_name: string
  readonly built_at: number
}

interface ApprovalRow {
  readonly definition_approval_id: string
  readonly harness_id: string
  readonly target_id: string
  readonly target_origin: string
  readonly statement_digest: string
  readonly approved_at: number
}

interface LoadRow {
  readonly load_id: string
  readonly harness_id: string
  readonly definition_approval_id: string
  readonly target_id: string
  readonly definition_digest: string
  readonly public_route: string
  readonly code: string | null
  readonly loaded_at: number
}

interface LoadAttemptRow {
  readonly load_id: string
  readonly harness_id: string
  readonly definition_approval_id: string
  readonly target_id: string
  readonly target_origin_digest: string
  readonly definition_approval_digest: string
  readonly definition_digest: string
  readonly reserved_at: number
}

interface LoadAttemptOutcomeRow {
  readonly load_id: string
  readonly status: string
  readonly code: string
  readonly completed_at: number
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ACTOR_NAME = /^[a-z][a-z0-9-]{0,62}$/u
const SITE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const ENVIRONMENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u
const GENERATOR_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/u

const schemaSql = `
CREATE TABLE IF NOT EXISTS harness_actor_catalog_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO harness_actor_catalog_metadata (singleton, schema_version)
VALUES (1, ${HARNESS_ACTOR_CATALOG_SCHEMA_VERSION});

CREATE TABLE IF NOT EXISTS harness_interface_contracts (
  digest TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  interface_abi TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_actor_builds (
  harness_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  artifact_digest TEXT NOT NULL,
  evaluation_id TEXT NOT NULL,
  artifact_approval_id TEXT NOT NULL,
  interface_digest TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  generator_revision TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  manifest_schema INTEGER NOT NULL CHECK (manifest_schema = 3),
  module_name TEXT NOT NULL CHECK (module_name = 'actor.mjs'),
  built_at INTEGER NOT NULL CHECK (built_at >= 0),
  UNIQUE (site_id, environment, generation, interface_digest, bundle_digest),
  FOREIGN KEY (interface_digest) REFERENCES harness_interface_contracts (digest),
  FOREIGN KEY (site_id, environment, generation)
    REFERENCES harness_activations (site_id, environment, generation)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_definition_approvals (
  definition_approval_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  UNIQUE (harness_id, target_id, definition_approval_id),
  FOREIGN KEY (harness_id) REFERENCES harness_actor_builds (harness_id)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_definition_load_attempts (
  load_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  definition_approval_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_origin_digest TEXT NOT NULL,
  definition_approval_digest TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0),
  FOREIGN KEY (harness_id) REFERENCES harness_actor_builds (harness_id),
  FOREIGN KEY (definition_approval_id) REFERENCES harness_definition_approvals (definition_approval_id)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_definition_load_attempt_outcomes (
  load_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('verified', 'unavailable', 'failed')),
  code TEXT NOT NULL CHECK (
    (status = 'verified' AND code = 'public_route_verified') OR
    (status = 'unavailable' AND code IN ('upstream_public_binding_unavailable', 'public_route_probe_failed')) OR
    (status = 'failed' AND code IN (
      'activation_not_current', 'bundle_invalid', 'candidate_escape',
      'candidate_symlink', 'definition_conflict', 'definition_load_failed',
      'definition_not_discoverable', 'load_deadline_exceeded', 'push_refused'
    ))
  ),
  completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
  FOREIGN KEY (load_id) REFERENCES harness_definition_load_attempts (load_id)
) STRICT;

CREATE TABLE IF NOT EXISTS harness_definition_loads (
  load_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  definition_approval_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  public_route TEXT NOT NULL CHECK (public_route IN ('verified', 'unavailable')),
  code TEXT,
  loaded_at INTEGER NOT NULL CHECK (loaded_at >= 0),
  FOREIGN KEY (load_id) REFERENCES harness_definition_load_attempts (load_id),
  FOREIGN KEY (harness_id) REFERENCES harness_actor_builds (harness_id),
  FOREIGN KEY (definition_approval_id) REFERENCES harness_definition_approvals (definition_approval_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS harness_interface_contracts_no_update
BEFORE UPDATE ON harness_interface_contracts BEGIN
  SELECT RAISE(ABORT, 'harness interface contracts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_interface_contracts_no_delete
BEFORE DELETE ON harness_interface_contracts BEGIN
  SELECT RAISE(ABORT, 'harness interface contracts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_actor_builds_no_update
BEFORE UPDATE ON harness_actor_builds BEGIN
  SELECT RAISE(ABORT, 'harness actor builds are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_actor_builds_no_delete
BEFORE DELETE ON harness_actor_builds BEGIN
  SELECT RAISE(ABORT, 'harness actor builds are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_approvals_no_update
BEFORE UPDATE ON harness_definition_approvals BEGIN
  SELECT RAISE(ABORT, 'harness definition approvals are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_approvals_no_delete
BEFORE DELETE ON harness_definition_approvals BEGIN
  SELECT RAISE(ABORT, 'harness definition approvals are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempts_no_update
BEFORE UPDATE ON harness_definition_load_attempts BEGIN
  SELECT RAISE(ABORT, 'harness definition load attempts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempts_no_delete
BEFORE DELETE ON harness_definition_load_attempts BEGIN
  SELECT RAISE(ABORT, 'harness definition load attempts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempt_outcomes_no_update
BEFORE UPDATE ON harness_definition_load_attempt_outcomes BEGIN
  SELECT RAISE(ABORT, 'harness definition load outcomes are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempt_outcomes_no_delete
BEFORE DELETE ON harness_definition_load_attempt_outcomes BEGIN
  SELECT RAISE(ABORT, 'harness definition load outcomes are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_loads_no_update
BEFORE UPDATE ON harness_definition_loads BEGIN
  SELECT RAISE(ABORT, 'harness definition loads are immutable');
END;
CREATE TRIGGER IF NOT EXISTS harness_definition_loads_no_delete
BEFORE DELETE ON harness_definition_loads BEGIN
  SELECT RAISE(ABORT, 'harness definition loads are immutable');
END;

CREATE TRIGGER IF NOT EXISTS harness_actor_build_requires_current_activation
BEFORE INSERT ON harness_actor_builds
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_activations a
  JOIN harness_activation_heads h
    ON h.site_id = a.site_id
   AND h.environment = a.environment
   AND h.generation = a.generation
  WHERE a.site_id = NEW.site_id
    AND a.environment = NEW.environment
    AND a.generation = NEW.generation
    AND a.artifact_digest = NEW.artifact_digest
    AND a.evaluation_id = NEW.evaluation_id
    AND a.approval_id = NEW.artifact_approval_id
)
BEGIN
  SELECT RAISE(ABORT, 'actor build requires the exact current approved activation');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_approval_requires_current_build
BEFORE INSERT ON harness_definition_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_actor_builds b
  JOIN harness_activation_heads h
    ON h.site_id = b.site_id
   AND h.environment = b.environment
   AND h.generation = b.generation
  WHERE b.harness_id = NEW.harness_id
)
BEGIN
  SELECT RAISE(ABORT, 'definition approval requires a current actor build');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_target_origin_is_stable_v2
BEFORE INSERT ON harness_definition_approvals
WHEN EXISTS (
  SELECT 1
  FROM harness_definition_approvals p
  JOIN harness_actor_builds prior ON prior.harness_id = p.harness_id
  JOIN harness_actor_builds next ON next.harness_id = NEW.harness_id
  WHERE prior.site_id = next.site_id
    AND prior.environment = next.environment
    AND p.target_id = NEW.target_id
    AND p.target_origin <> NEW.target_origin
)
BEGIN
  SELECT RAISE(ABORT, 'target id is already bound to a different origin');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempt_requires_exact_approval
BEFORE INSERT ON harness_definition_load_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_definition_approvals p
  JOIN harness_actor_builds b ON b.harness_id = p.harness_id
  WHERE p.definition_approval_id = NEW.definition_approval_id
    AND p.harness_id = NEW.harness_id
    AND p.target_id = NEW.target_id
    AND p.statement_digest = NEW.definition_approval_digest
    AND b.bundle_digest = NEW.definition_digest
)
BEGIN
  SELECT RAISE(ABORT, 'definition load attempt requires its exact approved build and target');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_load_attempt_requires_current_build
BEFORE INSERT ON harness_definition_load_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_actor_builds b
  JOIN harness_activation_heads h
    ON h.site_id = b.site_id
   AND h.environment = b.environment
   AND h.generation = b.generation
  WHERE b.harness_id = NEW.harness_id
)
BEGIN
  SELECT RAISE(ABORT, 'definition load attempt requires the current actor build');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_load_matches_attempt
BEFORE INSERT ON harness_definition_loads
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_definition_load_attempts t
  WHERE t.load_id = NEW.load_id
    AND t.harness_id = NEW.harness_id
    AND t.definition_approval_id = NEW.definition_approval_id
    AND t.target_id = NEW.target_id
    AND t.definition_digest = NEW.definition_digest
)
BEGIN
  SELECT RAISE(ABORT, 'definition load does not match its reserved attempt');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_load_requires_exact_approval
BEFORE INSERT ON harness_definition_loads
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_definition_approvals p
  WHERE p.definition_approval_id = NEW.definition_approval_id
    AND p.harness_id = NEW.harness_id
    AND p.target_id = NEW.target_id
)
BEGIN
  SELECT RAISE(ABORT, 'definition load requires exact target approval for the current actor build');
END;

CREATE TRIGGER IF NOT EXISTS harness_definition_load_requires_current_build_v2
BEFORE INSERT ON harness_definition_loads
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_actor_builds b
  JOIN harness_activation_heads h
    ON h.site_id = b.site_id
   AND h.environment = b.environment
   AND h.generation = b.generation
  WHERE b.harness_id = NEW.harness_id
)
BEGIN
  SELECT RAISE(ABORT, 'definition load requires the current actor build');
END;
`

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object" || value === null) throw new TypeError("canonical value must be JSON data")
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

const digestOf = (value: unknown): Sha256Digest =>
  `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`
const textDigestOf = (value: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`

const requiredString = (value: unknown, name: string, max: number, pattern: RegExp): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !pattern.test(value)) {
    throw new HarnessActorCatalogError("invalid_input", `${name} has an invalid format`)
  }
  return value
}

const requiredDigest = (value: unknown, name: string): Sha256Digest => {
  if (!isSha256Digest(value) || !DIGEST.test(value)) {
    throw new HarnessActorCatalogError("invalid_input", `${name} must be a lowercase SHA-256 digest`)
  }
  return value
}

const requiredGeneration = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new HarnessActorCatalogError("invalid_input", "generation must be a positive safe integer")
  }
  return Number(value)
}

const timestampOf = (now: () => number): number => {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HarnessActorCatalogError("invalid_input", "catalog clock must return non-negative Unix milliseconds")
  }
  return value
}

const loadCodes = new Set<HarnessDefinitionLoadCode>([
  "public_route_verified",
  "upstream_public_binding_unavailable",
  "public_route_probe_failed"
])
const loadAttemptFailureCodes = new Set<HarnessDefinitionLoadAttemptFailureCode>([
  "activation_not_current",
  "bundle_invalid",
  "candidate_escape",
  "candidate_symlink",
  "definition_conflict",
  "definition_load_failed",
  "definition_not_discoverable",
  "load_deadline_exceeded",
  "push_refused"
])

const validAttemptOutcome = (
  status: HarnessDefinitionLoadAttemptStatus,
  code: HarnessDefinitionLoadAttemptCode
): boolean => status === "verified"
  ? code === "public_route_verified"
  : status === "unavailable"
  ? code === "upstream_public_binding_unavailable" || code === "public_route_probe_failed"
  : loadAttemptFailureCodes.has(code as HarnessDefinitionLoadAttemptFailureCode)

const buildIdentity = (input: Omit<HarnessActorBuildRecord, "harnessId" | "builtAt">): Sha256Digest => digestOf({
  schemaVersion: 1,
  siteId: input.siteId,
  environment: input.environment,
  generation: input.generation,
  artifactDigest: input.artifactDigest,
  evaluationId: input.evaluationId,
  artifactApprovalId: input.artifactApprovalId,
  interfaceDigest: input.interfaceDigest,
  actorName: input.actorName,
  generatorRevision: input.generatorRevision,
  sourceDigest: input.sourceDigest,
  bundleDigest: input.bundleDigest,
  manifestSchema: input.manifestSchema,
  moduleName: input.moduleName
})

export const definitionApprovalStatementDigest = (
  build: HarnessActorBuildRecord,
  targetId: string,
  targetOrigin: string
): Sha256Digest => digestOf({
  schemaVersion: 1,
  policy: "manual-definition-load/1",
  harnessId: build.harnessId,
  actorName: build.actorName,
  bundleDigest: build.bundleDigest,
  interfaceDigest: build.interfaceDigest,
  artifactDigest: build.artifactDigest,
  targetId,
  targetOrigin
})

export const canonicalDefinitionTargetOrigin = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new HarnessActorCatalogError("invalid_input", "targetOrigin must be a bounded absolute URL")
  }
  let target: URL
  try {
    target = new URL(value)
  } catch (error) {
    throw new HarnessActorCatalogError("invalid_input", "targetOrigin must be an absolute HTTP(S) URL", error)
  }
  const loopback = target.hostname === "127.0.0.1" || target.hostname === "localhost" ||
    target.hostname === "[::1]"
  if ((target.protocol !== "https:" && target.protocol !== "http:") ||
    (target.protocol === "http:" && !loopback) || target.username.length > 0 ||
    target.password.length > 0 || target.pathname !== "/" || target.search.length > 0 ||
    target.hash.length > 0) {
    throw new HarnessActorCatalogError(
      "invalid_input",
      "targetOrigin must be a credential-free HTTPS origin, or a credential-free loopback HTTP origin"
    )
  }
  return target.origin
}

export class HarnessActorCatalog implements Disposable {
  readonly database: string
  readonly #db: Database
  readonly #now: () => number
  #closed = false

  constructor(options: HarnessActorCatalogOptions) {
    this.database = requiredString(options.database, "database", 4_096, /\S/u)
    this.#now = options.now ?? Date.now
    if (this.database !== ":memory:" && !this.database.startsWith("file:")) {
      mkdirSync(dirname(this.database), { recursive: true })
    }
    let opened: Database | undefined
    try {
      opened = new Database(this.database)
      opened.exec("PRAGMA foreign_keys = ON")
      opened.exec("PRAGMA busy_timeout = 5000")
      if (this.database !== ":memory:") opened.exec("PRAGMA journal_mode = WAL")
      const metadataTable = opened.query<{ readonly name: string }, []>(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'harness_actor_catalog_metadata'
      `).get()
      if (metadataTable !== null && metadataTable !== undefined) {
        const existingMetadata = opened.query<{ readonly schema_version: number }, []>(
          "SELECT schema_version FROM harness_actor_catalog_metadata WHERE singleton = 1"
        ).get()
        if (existingMetadata?.schema_version !== HARNESS_ACTOR_CATALOG_SCHEMA_VERSION) {
          throw new HarnessActorCatalogError(
            "corrupt_catalog",
            `unsupported actor catalog schema ${String(existingMetadata?.schema_version)}`
          )
        }
      }
      opened.exec(schemaSql)
      const metadata = opened.query<{ readonly schema_version: number }, []>(
        "SELECT schema_version FROM harness_actor_catalog_metadata WHERE singleton = 1"
      ).get()
      if (metadata?.schema_version !== HARNESS_ACTOR_CATALOG_SCHEMA_VERSION) {
        throw new HarnessActorCatalogError(
          "corrupt_catalog",
          `unsupported actor catalog schema ${String(metadata?.schema_version)}`
        )
      }
      this.#db = opened
    } catch (error) {
      try {
        opened?.close(true)
      } catch {
        // Preserve the schema/open failure; a close failure carries no safer diagnosis.
      }
      if (error instanceof HarnessActorCatalogError) throw error
      throw new HarnessActorCatalogError("database_error", "could not open the harness actor catalog", error)
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new HarnessActorCatalogError("closed", "harness actor catalog is closed")
  }

  #databaseCall<T>(operation: () => T): T {
    this.#assertOpen()
    try {
      return operation()
    } catch (error) {
      if (error instanceof HarnessActorCatalogError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("current approved activation") || message.includes("current actor build")) {
        throw new HarnessActorCatalogError("activation_not_current", "actor build no longer matches the current approved activation", error)
      }
      if (message.includes("target id is already bound to a different origin")) {
        throw new HarnessActorCatalogError("approval_conflict", "targetId is already bound to a different origin", error)
      }
      throw new HarnessActorCatalogError("database_error", "harness actor catalog operation failed", error)
    }
  }

  #buildFromRow(row: BuildRow): HarnessActorBuildRecord {
    try {
      const interfaceContract = JSON.parse(row.interface_json) as SiteInterfaceContract
      const canonicalInterface = canonicalSiteInterfaceContract(interfaceContract)
      const interfaceDigest = siteInterfaceContractDigest(interfaceContract)
      const record: Omit<HarnessActorBuildRecord, "harnessId" | "builtAt"> = {
        siteId: row.site_id,
        environment: row.environment,
        generation: row.generation,
        artifactDigest: requiredDigest(row.artifact_digest, "artifactDigest"),
        evaluationId: row.evaluation_id,
        artifactApprovalId: row.artifact_approval_id,
        interfaceContract,
        interfaceDigest,
        actorName: row.actor_name,
        generatorRevision: row.generator_revision,
        sourceDigest: requiredDigest(row.source_digest, "sourceDigest"),
        bundleDigest: requiredDigest(row.bundle_digest, "bundleDigest"),
        manifestSchema: 3,
        moduleName: "actor.mjs"
      }
      const harnessId = buildIdentity(record)
      if (
        canonicalInterface !== row.interface_json || interfaceDigest !== row.interface_digest ||
        harnessId !== row.harness_id || row.manifest_schema !== 3 || row.module_name !== "actor.mjs"
      ) throw new Error("build row does not match its canonical identity")
      return Object.freeze({ ...record, harnessId, builtAt: row.built_at })
    } catch (error) {
      throw new HarnessActorCatalogError("corrupt_catalog", `actor build ${JSON.stringify(row.harness_id)} is corrupt`, error)
    }
  }

  recordBuild(input: HarnessActorBuildInput): HarnessActorBuildRecord {
    const interfaceContract = input.interfaceContract
    const interfaceJson = canonicalSiteInterfaceContract(interfaceContract)
    const interfaceDigest = siteInterfaceContractDigest(interfaceContract)
    const normalized: Omit<HarnessActorBuildRecord, "harnessId" | "builtAt"> = {
      siteId: requiredString(input.siteId, "siteId", 64, SITE_ID),
      environment: requiredString(input.environment, "environment", 64, ENVIRONMENT),
      generation: requiredGeneration(input.generation),
      artifactDigest: requiredDigest(input.artifactDigest, "artifactDigest"),
      evaluationId: requiredString(input.evaluationId, "evaluationId", 128, OPAQUE_ID),
      artifactApprovalId: requiredString(input.artifactApprovalId, "artifactApprovalId", 128, OPAQUE_ID),
      interfaceContract,
      interfaceDigest,
      actorName: requiredString(input.actorName, "actorName", 63, ACTOR_NAME),
      generatorRevision: requiredString(input.generatorRevision, "generatorRevision", 128, GENERATOR_REVISION),
      sourceDigest: requiredDigest(input.sourceDigest, "sourceDigest"),
      bundleDigest: requiredDigest(input.bundleDigest, "bundleDigest"),
      manifestSchema: input.manifestSchema,
      moduleName: input.moduleName
    }
    if (normalized.siteId !== interfaceContract.siteId || input.manifestSchema !== 3 || input.moduleName !== "actor.mjs") {
      throw new HarnessActorCatalogError("invalid_input", "build identity does not match its interface or Tardigrade manifest ABI")
    }
    const harnessId = buildIdentity(normalized)
    return this.#databaseCall(() => this.#db.transaction(() => {
      const existing = this.#db.query<BuildRow, [string]>(
        `SELECT b.*, i.canonical_json AS interface_json FROM harness_actor_builds b
         JOIN harness_interface_contracts i ON i.digest = b.interface_digest WHERE b.harness_id = ?`
      ).get(harnessId)
      if (existing !== null && existing !== undefined) return this.#buildFromRow(existing)
      const interfaceRow = this.#db.query<{ readonly canonical_json: string; readonly site_id: string }, [string]>(
        "SELECT canonical_json, site_id FROM harness_interface_contracts WHERE digest = ?"
      ).get(interfaceDigest)
      const builtAt = timestampOf(this.#now)
      if (interfaceRow === null || interfaceRow === undefined) {
        this.#db.query<never, [string, string, number, string, string, number]>(`
          INSERT INTO harness_interface_contracts (
            digest, site_id, schema_version, interface_abi, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          interfaceDigest,
          interfaceContract.siteId,
          interfaceContract.schemaVersion,
          interfaceContract.interfaceAbi,
          interfaceJson,
          builtAt
        )
      } else if (interfaceRow.canonical_json !== interfaceJson || interfaceRow.site_id !== interfaceContract.siteId) {
        throw new HarnessActorCatalogError("build_conflict", `interface digest ${interfaceDigest} is already bound to different content`)
      }
      try {
        this.#db.query<never, [string, string, string, number, string, string, string, string, string, string, string, string, number, string, number]>(`
          INSERT INTO harness_actor_builds (
            harness_id, site_id, environment, generation, artifact_digest,
            evaluation_id, artifact_approval_id, interface_digest, actor_name,
            generator_revision, source_digest, bundle_digest, manifest_schema,
            module_name, built_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          harnessId,
          normalized.siteId,
          normalized.environment,
          normalized.generation,
          normalized.artifactDigest,
          normalized.evaluationId,
          normalized.artifactApprovalId,
          normalized.interfaceDigest,
          normalized.actorName,
          normalized.generatorRevision,
          normalized.sourceDigest,
          normalized.bundleDigest,
          normalized.manifestSchema,
          normalized.moduleName,
          builtAt
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("UNIQUE")) throw new HarnessActorCatalogError("build_conflict", "this activation already has a different actor build", error)
        throw error
      }
      return Object.freeze({ ...normalized, harnessId, builtAt })
    }).immediate())
  }

  getBuild(harnessIdValue: Sha256Digest): HarnessActorBuildRecord | undefined {
    const harnessId = requiredDigest(harnessIdValue, "harnessId")
    return this.#databaseCall(() => {
      const row = this.#db.query<BuildRow, [string]>(
        `SELECT b.*, i.canonical_json AS interface_json FROM harness_actor_builds b
         JOIN harness_interface_contracts i ON i.digest = b.interface_digest WHERE b.harness_id = ?`
      ).get(harnessId)
      return row === null || row === undefined ? undefined : this.#buildFromRow(row)
    })
  }

  getBuildsByActorName(actorNameValue: string): ReadonlyArray<HarnessActorBuildRecord> {
    const actorName = requiredString(actorNameValue, "actorName", 63, ACTOR_NAME)
    return this.#databaseCall(() => this.#db.query<BuildRow, [string]>(
        `SELECT b.*, i.canonical_json AS interface_json FROM harness_actor_builds b
         JOIN harness_interface_contracts i ON i.digest = b.interface_digest WHERE b.actor_name = ?
         ORDER BY b.built_at DESC, b.harness_id ASC`
      ).all(actorName).map((row) => this.#buildFromRow(row)))
  }

  assertCurrent(harnessIdValue: Sha256Digest): HarnessActorBuildRecord {
    const build = this.getBuild(harnessIdValue)
    if (build === undefined) throw new HarnessActorCatalogError("build_not_found", `actor build ${harnessIdValue} is not registered`)
    return this.#databaseCall(() => {
      const current = this.#db.query<{ readonly generation: number }, [string, string, number]>(`
        SELECT h.generation FROM harness_activation_heads h
        WHERE h.site_id = ? AND h.environment = ? AND h.generation = ?
      `).get(build.siteId, build.environment, build.generation)
      if (current === null || current === undefined) {
        throw new HarnessActorCatalogError("activation_not_current", "actor build no longer matches the current approved activation")
      }
      return build
    })
  }

  recordDefinitionApproval(input: HarnessDefinitionApprovalInput): HarnessDefinitionApprovalRecord {
    const definitionApprovalId = requiredString(input.definitionApprovalId, "definitionApprovalId", 128, OPAQUE_ID)
    const build = this.assertCurrent(input.harnessId)
    const targetId = requiredString(input.targetId, "targetId", 128, OPAQUE_ID)
    const targetOrigin = canonicalDefinitionTargetOrigin(input.targetOrigin)
    const statementDigest = definitionApprovalStatementDigest(build, targetId, targetOrigin)
    return this.#databaseCall(() => this.#db.transaction(() => {
      const targetBinding = this.#db.query<{ readonly target_origin: string }, [string, string, string]>(`
        SELECT p.target_origin
        FROM harness_definition_approvals p
        JOIN harness_actor_builds b ON b.harness_id = p.harness_id
        WHERE b.site_id = ? AND b.environment = ? AND p.target_id = ?
        ORDER BY p.rowid DESC LIMIT 1
      `).get(build.siteId, build.environment, targetId)
      if (targetBinding !== null && targetBinding !== undefined && targetBinding.target_origin !== targetOrigin) {
        throw new HarnessActorCatalogError("approval_conflict", "targetId is already bound to a different origin")
      }
      const existing = this.#db.query<ApprovalRow, [string]>(
        "SELECT * FROM harness_definition_approvals WHERE definition_approval_id = ?"
      ).get(definitionApprovalId)
      if (existing !== null && existing !== undefined) {
        const found = this.#approvalFromRow(existing)
        if (found.harnessId !== build.harnessId || found.targetId !== targetId ||
          found.targetOrigin !== targetOrigin || found.statementDigest !== statementDigest) {
          throw new HarnessActorCatalogError("approval_conflict", `definition approval ${JSON.stringify(definitionApprovalId)} is immutable`)
        }
        return found
      }
      const approvedAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, string, string, string, number]>(`
        INSERT INTO harness_definition_approvals (
          definition_approval_id, harness_id, target_id, target_origin, statement_digest, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(definitionApprovalId, build.harnessId, targetId, targetOrigin, statementDigest, approvedAt)
      return Object.freeze({ definitionApprovalId, harnessId: build.harnessId, targetId, targetOrigin, statementDigest, approvedAt })
    }).immediate())
  }

  #approvalFromRow(row: ApprovalRow): HarnessDefinitionApprovalRecord {
    return Object.freeze({
      definitionApprovalId: requiredString(row.definition_approval_id, "definitionApprovalId", 128, OPAQUE_ID),
      harnessId: requiredDigest(row.harness_id, "harnessId"),
      targetId: requiredString(row.target_id, "targetId", 128, OPAQUE_ID),
      targetOrigin: canonicalDefinitionTargetOrigin(row.target_origin),
      statementDigest: requiredDigest(row.statement_digest, "statementDigest"),
      approvedAt: row.approved_at
    })
  }

  getDefinitionApproval(definitionApprovalIdValue: string): HarnessDefinitionApprovalRecord | undefined {
    const definitionApprovalId = requiredString(definitionApprovalIdValue, "definitionApprovalId", 128, OPAQUE_ID)
    return this.#databaseCall(() => {
      const row = this.#db.query<ApprovalRow, [string]>(
        "SELECT * FROM harness_definition_approvals WHERE definition_approval_id = ?"
      ).get(definitionApprovalId)
      return row === null || row === undefined ? undefined : this.#approvalFromRow(row)
    })
  }

  #attemptOutcomeFromRow(row: LoadAttemptOutcomeRow): HarnessDefinitionLoadAttemptOutcomeRecord {
    if ((row.status !== "verified" && row.status !== "unavailable" && row.status !== "failed") ||
      !validAttemptOutcome(
        row.status as HarnessDefinitionLoadAttemptStatus,
        row.code as HarnessDefinitionLoadAttemptCode
      ) || !Number.isSafeInteger(row.completed_at) || row.completed_at < 0) {
      throw new HarnessActorCatalogError(
        "corrupt_catalog",
        `definition load attempt outcome ${JSON.stringify(row.load_id)} is corrupt`
      )
    }
    return Object.freeze({
      loadId: requiredString(row.load_id, "loadId", 128, OPAQUE_ID),
      status: row.status as HarnessDefinitionLoadAttemptStatus,
      code: row.code as HarnessDefinitionLoadAttemptCode,
      completedAt: row.completed_at
    })
  }

  #attemptFromRow(
    row: LoadAttemptRow,
    outcomeRow?: LoadAttemptOutcomeRow
  ): HarnessDefinitionLoadAttemptRecord {
    if (!Number.isSafeInteger(row.reserved_at) || row.reserved_at < 0) {
      throw new HarnessActorCatalogError(
        "corrupt_catalog",
        `definition load attempt ${JSON.stringify(row.load_id)} has an invalid reservation time`
      )
    }
    const outcome = outcomeRow === undefined ? undefined : this.#attemptOutcomeFromRow(outcomeRow)
    if (outcome !== undefined && outcome.loadId !== row.load_id) {
      throw new HarnessActorCatalogError("corrupt_catalog", "definition load outcome does not match its attempt")
    }
    return Object.freeze({
      loadId: requiredString(row.load_id, "loadId", 128, OPAQUE_ID),
      harnessId: requiredDigest(row.harness_id, "harnessId"),
      definitionApprovalId: requiredString(
        row.definition_approval_id,
        "definitionApprovalId",
        128,
        OPAQUE_ID
      ),
      targetId: requiredString(row.target_id, "targetId", 128, OPAQUE_ID),
      targetOriginDigest: requiredDigest(row.target_origin_digest, "targetOriginDigest"),
      definitionApprovalDigest: requiredDigest(
        row.definition_approval_digest,
        "definitionApprovalDigest"
      ),
      definitionDigest: requiredDigest(row.definition_digest, "definitionDigest"),
      reservedAt: row.reserved_at,
      ...(outcome === undefined ? {} : { outcome })
    })
  }

  getLoadAttempt(loadIdValue: string): HarnessDefinitionLoadAttemptRecord | undefined {
    const loadId = requiredString(loadIdValue, "loadId", 128, OPAQUE_ID)
    return this.#databaseCall(() => {
      const row = this.#db.query<LoadAttemptRow, [string]>(
        "SELECT * FROM harness_definition_load_attempts WHERE load_id = ?"
      ).get(loadId)
      if (row === null || row === undefined) return undefined
      const outcome = this.#db.query<LoadAttemptOutcomeRow, [string]>(
        "SELECT * FROM harness_definition_load_attempt_outcomes WHERE load_id = ?"
      ).get(loadId)
      return this.#attemptFromRow(row, outcome ?? undefined)
    })
  }

  reserveLoadAttempt(input: HarnessDefinitionLoadAttemptInput): HarnessDefinitionLoadAttemptReservation {
    const loadId = requiredString(input.loadId, "loadId", 128, OPAQUE_ID)
    const build = this.assertCurrent(input.harnessId)
    const definitionApprovalId = requiredString(
      input.definitionApprovalId,
      "definitionApprovalId",
      128,
      OPAQUE_ID
    )
    const targetId = requiredString(input.targetId, "targetId", 128, OPAQUE_ID)
    const definitionDigest = requiredDigest(input.definitionDigest, "definitionDigest")
    if (definitionDigest !== build.bundleDigest) {
      throw new HarnessActorCatalogError("invalid_input", "definition digest does not match the approved actor bundle")
    }
    const approval = this.getDefinitionApproval(definitionApprovalId)
    if (approval === undefined) {
      throw new HarnessActorCatalogError("approval_not_found", "definition approval is not registered")
    }
    if (approval.harnessId !== build.harnessId || approval.targetId !== targetId ||
      approval.statementDigest !== definitionApprovalStatementDigest(build, targetId, approval.targetOrigin)) {
      throw new HarnessActorCatalogError("approval_conflict", "definition approval does not cover this build and target")
    }
    const identity = {
      loadId,
      harnessId: build.harnessId,
      definitionApprovalId,
      targetId,
      targetOriginDigest: textDigestOf(approval.targetOrigin),
      definitionApprovalDigest: approval.statementDigest,
      definitionDigest
    }
    return this.#databaseCall(() => this.#db.transaction(() => {
      const existing = this.#db.query<LoadAttemptRow, [string]>(
        "SELECT * FROM harness_definition_load_attempts WHERE load_id = ?"
      ).get(loadId)
      if (existing !== null && existing !== undefined) {
        const outcome = this.#db.query<LoadAttemptOutcomeRow, [string]>(
          "SELECT * FROM harness_definition_load_attempt_outcomes WHERE load_id = ?"
        ).get(loadId)
        const found = this.#attemptFromRow(existing, outcome ?? undefined)
        const comparable = {
          loadId: found.loadId,
          harnessId: found.harnessId,
          definitionApprovalId: found.definitionApprovalId,
          targetId: found.targetId,
          targetOriginDigest: found.targetOriginDigest,
          definitionApprovalDigest: found.definitionApprovalDigest,
          definitionDigest: found.definitionDigest
        }
        if (canonical(comparable) !== canonical(identity)) {
          throw new HarnessActorCatalogError(
            "attempt_conflict",
            `definition load attempt ${JSON.stringify(loadId)} is immutable`
          )
        }
        return Object.freeze({ attempt: found, created: false })
      }
      const reservedAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, string, string, string, string, string, number]>(`
        INSERT INTO harness_definition_load_attempts (
          load_id, harness_id, definition_approval_id, target_id,
          target_origin_digest, definition_approval_digest, definition_digest, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        loadId,
        build.harnessId,
        definitionApprovalId,
        targetId,
        identity.targetOriginDigest,
        identity.definitionApprovalDigest,
        definitionDigest,
        reservedAt
      )
      return Object.freeze({
        attempt: Object.freeze({ ...identity, reservedAt }),
        created: true
      })
    }).immediate())
  }

  recordLoadAttemptOutcome(
    input: HarnessDefinitionLoadAttemptOutcomeInput
  ): HarnessDefinitionLoadAttemptCompletion {
    const loadId = requiredString(input.loadId, "loadId", 128, OPAQUE_ID)
    if ((input.status !== "verified" && input.status !== "unavailable" && input.status !== "failed") ||
      !validAttemptOutcome(input.status, input.code)) {
      throw new HarnessActorCatalogError("invalid_input", "definition load attempt outcome is inconsistent")
    }
    return this.#databaseCall(() => this.#db.transaction(() => {
      const attemptRow = this.#db.query<LoadAttemptRow, [string]>(
        "SELECT * FROM harness_definition_load_attempts WHERE load_id = ?"
      ).get(loadId)
      if (attemptRow === null || attemptRow === undefined) {
        throw new HarnessActorCatalogError("attempt_not_found", "definition load attempt is not reserved")
      }
      const priorOutcomeRow = this.#db.query<LoadAttemptOutcomeRow, [string]>(
        "SELECT * FROM harness_definition_load_attempt_outcomes WHERE load_id = ?"
      ).get(loadId)
      if (priorOutcomeRow !== null && priorOutcomeRow !== undefined) {
        const outcome = this.#attemptOutcomeFromRow(priorOutcomeRow)
        if (outcome.status !== input.status || outcome.code !== input.code) {
          throw new HarnessActorCatalogError(
            "attempt_conflict",
            `definition load attempt ${JSON.stringify(loadId)} already has a different terminal outcome`
          )
        }
        const loadRow = this.#db.query<LoadRow, [string]>(
          "SELECT * FROM harness_definition_loads WHERE load_id = ?"
        ).get(loadId)
        const attempt = this.#attemptFromRow(attemptRow, priorOutcomeRow)
        return Object.freeze({
          attempt,
          outcome,
          ...(loadRow === null || loadRow === undefined ? {} : { load: this.#loadFromRow(loadRow) })
        })
      }

      if (input.status !== "failed") this.assertCurrent(requiredDigest(attemptRow.harness_id, "harnessId"))
      const completedAt = timestampOf(this.#now)
      this.#db.query<never, [string, string, string, number]>(`
        INSERT INTO harness_definition_load_attempt_outcomes (load_id, status, code, completed_at)
        VALUES (?, ?, ?, ?)
      `).run(loadId, input.status, input.code, completedAt)
      const outcome = Object.freeze({
        loadId,
        status: input.status,
        code: input.code,
        completedAt
      })

      let load: HarnessDefinitionLoadRecord | undefined
      if (input.status !== "failed") {
        const publicRoute = input.status
        this.#db.query<never, [string, string, string, string, string, string, string, number]>(`
          INSERT INTO harness_definition_loads (
            load_id, harness_id, definition_approval_id, target_id,
            definition_digest, public_route, code, loaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          loadId,
          attemptRow.harness_id,
          attemptRow.definition_approval_id,
          attemptRow.target_id,
          attemptRow.definition_digest,
          publicRoute,
          input.code,
          completedAt
        )
        load = Object.freeze({
          loadId,
          harnessId: requiredDigest(attemptRow.harness_id, "harnessId"),
          definitionApprovalId: attemptRow.definition_approval_id,
          targetId: attemptRow.target_id,
          definitionDigest: requiredDigest(attemptRow.definition_digest, "definitionDigest"),
          publicRoute,
          code: input.code as HarnessDefinitionLoadCode,
          loadedAt: completedAt
        })
      }
      const attempt = this.#attemptFromRow(attemptRow, {
        load_id: loadId,
        status: input.status,
        code: input.code,
        completed_at: completedAt
      })
      return Object.freeze({ attempt, outcome, ...(load === undefined ? {} : { load }) })
    }).immediate())
  }

  recordLoad(input: HarnessDefinitionLoadInput): HarnessDefinitionLoadRecord {
    const code = input.code
    if (!(["verified", "unavailable"] as const).includes(input.publicRoute) ||
      (code !== undefined && !loadCodes.has(code)) ||
      (input.publicRoute === "verified" && code !== "public_route_verified") ||
      (input.publicRoute === "unavailable" && (code === undefined || code === "public_route_verified"))) {
      throw new HarnessActorCatalogError("invalid_input", "definition load route evidence is inconsistent")
    }
    this.reserveLoadAttempt({
      loadId: input.loadId,
      harnessId: input.harnessId,
      definitionApprovalId: input.definitionApprovalId,
      targetId: input.targetId,
      definitionDigest: input.definitionDigest
    })
    const completed = this.recordLoadAttemptOutcome({
      loadId: input.loadId,
      status: input.publicRoute,
      code: code!
    })
    if (completed.load === undefined) {
      throw new HarnessActorCatalogError("corrupt_catalog", "completed definition load has no load record")
    }
    return completed.load
  }

  #loadFromRow(row: LoadRow): HarnessDefinitionLoadRecord {
    if (row.public_route !== "verified" && row.public_route !== "unavailable") {
      throw new HarnessActorCatalogError("corrupt_catalog", `load ${JSON.stringify(row.load_id)} has an invalid route status`)
    }
    if (row.code !== null && !loadCodes.has(row.code as HarnessDefinitionLoadCode)) {
      throw new HarnessActorCatalogError("corrupt_catalog", `load ${JSON.stringify(row.load_id)} has an invalid evidence code`)
    }
    return Object.freeze({
      loadId: row.load_id,
      harnessId: requiredDigest(row.harness_id, "harnessId"),
      definitionApprovalId: row.definition_approval_id,
      targetId: row.target_id,
      definitionDigest: requiredDigest(row.definition_digest, "definitionDigest"),
      publicRoute: row.public_route,
      ...(row.code === null ? {} : { code: row.code as HarnessDefinitionLoadCode }),
      loadedAt: row.loaded_at
    })
  }

  getLoad(loadIdValue: string): HarnessDefinitionLoadRecord | undefined {
    const loadId = requiredString(loadIdValue, "loadId", 128, OPAQUE_ID)
    return this.#databaseCall(() => {
      const row = this.#db.query<LoadRow, [string]>(
        "SELECT * FROM harness_definition_loads WHERE load_id = ?"
      ).get(loadId)
      return row === null || row === undefined ? undefined : this.#loadFromRow(row)
    })
  }

  /**
   * Resolves the public actor route for the exact activation head and target.
   * A historical verified load cannot mask a newer unavailable outcome, and a
   * load for a prior activation is never eligible.
   */
  resolveRoutable(
    siteIdValue: string,
    environmentValue: string,
    targetIdValue: string
  ): RoutableHarnessResolution {
    const siteId = requiredString(siteIdValue, "siteId", 64, SITE_ID)
    const environment = requiredString(environmentValue, "environment", 64, ENVIRONMENT)
    const targetId = requiredString(targetIdValue, "targetId", 128, OPAQUE_ID)
    return this.#databaseCall(() => this.#db.transaction((): RoutableHarnessResolution => {
      const builds = this.#db.query<BuildRow, [string, string]>(`
        SELECT b.*, i.canonical_json AS interface_json
        FROM harness_actor_builds b
        JOIN harness_interface_contracts i ON i.digest = b.interface_digest
        JOIN harness_activations a
          ON a.site_id = b.site_id
         AND a.environment = b.environment
         AND a.generation = b.generation
         AND a.artifact_digest = b.artifact_digest
         AND a.evaluation_id = b.evaluation_id
         AND a.approval_id = b.artifact_approval_id
        JOIN harness_activation_heads h
          ON h.site_id = a.site_id
         AND h.environment = a.environment
         AND h.generation = a.generation
        WHERE b.site_id = ? AND b.environment = ?
      `).all(siteId, environment).map((row) => this.#buildFromRow(row))
      if (builds.length === 0) return Object.freeze({ status: "not_found" })

      const attemptRow = this.#db.query<LoadAttemptRow, [string, string, string]>(`
        SELECT t.*
        FROM harness_definition_load_attempts t
        JOIN harness_actor_builds b ON b.harness_id = t.harness_id
        JOIN harness_activations a
          ON a.site_id = b.site_id
         AND a.environment = b.environment
         AND a.generation = b.generation
         AND a.artifact_digest = b.artifact_digest
         AND a.evaluation_id = b.evaluation_id
         AND a.approval_id = b.artifact_approval_id
        JOIN harness_activation_heads h
          ON h.site_id = a.site_id
         AND h.environment = a.environment
         AND h.generation = a.generation
        WHERE b.site_id = ? AND b.environment = ? AND t.target_id = ?
        ORDER BY t.reserved_at DESC, t.rowid DESC
        LIMIT 1
      `).get(siteId, environment, targetId)
      if (attemptRow === null || attemptRow === undefined) return Object.freeze({ status: "not_routable" })

      const outcomeRow = this.#db.query<LoadAttemptOutcomeRow, [string]>(
        "SELECT * FROM harness_definition_load_attempt_outcomes WHERE load_id = ?"
      ).get(attemptRow.load_id)
      const attempt = this.#attemptFromRow(attemptRow, outcomeRow ?? undefined)
      if (attempt.outcome?.status !== "verified" || attempt.outcome.code !== "public_route_verified") {
        return Object.freeze({ status: "not_routable" })
      }
      const loadRow = this.#db.query<LoadRow, [string]>(
        "SELECT * FROM harness_definition_loads WHERE load_id = ?"
      ).get(attempt.loadId)
      if (loadRow === null || loadRow === undefined) {
        throw new HarnessActorCatalogError("corrupt_catalog", "verified definition load attempt has no load record")
      }

      const load = this.#loadFromRow(loadRow)
      const build = builds.find((candidate) => candidate.harnessId === load.harnessId)
      if (build === undefined || load.targetId !== targetId || load.definitionDigest !== build.bundleDigest) {
        throw new HarnessActorCatalogError("corrupt_catalog", "latest definition load does not match its current actor build")
      }
      const approvalRow = this.#db.query<ApprovalRow, [string]>(
        "SELECT * FROM harness_definition_approvals WHERE definition_approval_id = ?"
      ).get(load.definitionApprovalId)
      if (approvalRow === null || approvalRow === undefined) {
        throw new HarnessActorCatalogError("corrupt_catalog", "latest definition load has no approval")
      }
      const approval = this.#approvalFromRow(approvalRow)
      if (
        approval.harnessId !== build.harnessId || approval.targetId !== targetId ||
        approval.statementDigest !== definitionApprovalStatementDigest(build, targetId, approval.targetOrigin)
      ) {
        throw new HarnessActorCatalogError("corrupt_catalog", "latest definition load does not match its target approval")
      }
      if (load.publicRoute !== "verified" || load.code !== "public_route_verified") {
        return Object.freeze({ status: "not_routable" })
      }

      const actions = Object.freeze(build.interfaceContract.actions.map((action) => Object.freeze({
        id: action.id,
        methodName: action.methodName,
        inputs: Object.freeze(action.inputs.map((input) => Object.freeze({ ...input })))
      })))
      return Object.freeze({
        status: "resolved",
        actor: Object.freeze({
          siteId: build.siteId,
          environment: build.environment,
          targetId,
          generation: build.generation,
          actorName: build.actorName,
          artifactDigest: build.artifactDigest,
          interfaceDigest: build.interfaceDigest,
          sourceDigest: build.sourceDigest,
          buildDigest: build.bundleDigest,
          definitionDigest: load.definitionDigest,
          actions
        })
      })
    }).deferred())
  }

  list(): ReadonlyArray<HarnessActorCatalogEntry> {
    return this.#databaseCall(() => this.#db.query<BuildRow, []>(`
      SELECT b.*, i.canonical_json AS interface_json FROM harness_actor_builds b
      JOIN harness_interface_contracts i ON i.digest = b.interface_digest
      ORDER BY b.built_at DESC, b.harness_id ASC
    `).all().map((row) => {
      const build = this.#buildFromRow(row)
      const approvalRow = this.#db.query<ApprovalRow, [string]>(`
        SELECT * FROM harness_definition_approvals WHERE harness_id = ?
        ORDER BY approved_at DESC, rowid DESC LIMIT 1
      `).get(build.harnessId)
      const loadRow = this.#db.query<LoadRow, [string]>(`
        SELECT * FROM harness_definition_loads WHERE harness_id = ?
        ORDER BY loaded_at DESC, rowid DESC LIMIT 1
      `).get(build.harnessId)
      const attemptRow = this.#db.query<LoadAttemptRow, [string]>(`
        SELECT * FROM harness_definition_load_attempts WHERE harness_id = ?
        ORDER BY reserved_at DESC, rowid DESC LIMIT 1
      `).get(build.harnessId)
      const attemptOutcomeRow = attemptRow === null || attemptRow === undefined
        ? undefined
        : this.#db.query<LoadAttemptOutcomeRow, [string]>(
          "SELECT * FROM harness_definition_load_attempt_outcomes WHERE load_id = ?"
        ).get(attemptRow.load_id) ?? undefined
      return Object.freeze({
        build,
        ...(approvalRow === null || approvalRow === undefined ? {} : { approval: this.#approvalFromRow(approvalRow) }),
        ...(loadRow === null || loadRow === undefined ? {} : { load: this.#loadFromRow(loadRow) }),
        ...(attemptRow === null || attemptRow === undefined
          ? {}
          : { latestAttempt: this.#attemptFromRow(attemptRow, attemptOutcomeRow) })
      })
    }))
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
