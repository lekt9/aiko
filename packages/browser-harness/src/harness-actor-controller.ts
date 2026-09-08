import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import { buildActor, lintActor, type BuiltActor } from "tardie/cli/build"
import { makeActorClient, makeControlClient, ProblemError, type ActorArtifact } from "tardie/client"

import {
  canonicalSiteHarnessArtifact,
  isSha256Digest,
  type Sha256Digest
} from "./harness-artifact"
import {
  canonicalSiteInterfaceContract,
  harnessLifecycleEventId
} from "./harness-interface"
import {
  HARNESS_ACTOR_GENERATOR_REVISION,
  generatedHarnessActorFactoryBundle,
  generatedHarnessActorSource,
  generatedHarnessActorIdentity
} from "./generated-harness-actor"
import {
  HarnessActorCatalog,
  HarnessActorCatalogError,
  canonicalDefinitionTargetOrigin,
  definitionApprovalStatementDigest,
  type HarnessActorBuildRecord,
  type HarnessDefinitionLoadAttemptFailureCode,
  type HarnessDefinitionLoadCode,
  type HarnessDefinitionLoadRecord
} from "./harness-actor-catalog"
import { HarnessRegistry } from "./harness-registry"

const RUNTIME_ROOT = resolve(import.meta.dir, "..")
export const DEFAULT_HARNESS_CANDIDATES_ROOT = join(RUNTIME_ROOT, "candidates")
export const DEFAULT_HARNESS_BUILD_ROOT = join(RUNTIME_ROOT, ".tardigrade", "generated-builds")
export const DEFAULT_HARNESS_CATALOG_ACTOR = "har-website-inspector"
export const DEFAULT_HARNESS_CATALOG_THREAD = "harness-catalog"
export const MAX_GENERATED_ACTOR_MODULE_BYTES = 16 * 1024 * 1024
export const MAX_GENERATED_ACTOR_MANIFEST_BYTES = 16 * 1024
export const DEFAULT_HARNESS_LOAD_TIMEOUT_MS = 30_000
export const MAX_HARNESS_LOAD_TIMEOUT_MS = 120_000
export const DEFAULT_HARNESS_LIFECYCLE_SCAN_PAGES = 32
export const MAX_HARNESS_LIFECYCLE_SCAN_PAGES = 64
const MAX_HARNESS_LOAD_RESPONSE_BYTES = 8 * 1024 * 1024

export type HarnessActorControllerErrorCode =
  | "invalid_input"
  | "candidate_conflict"
  | "candidate_escape"
  | "candidate_symlink"
  | "lint_failed"
  | "build_failed"
  | "bundle_invalid"
  | "definition_conflict"
  | "push_refused"
  | "definition_not_discoverable"
  | "evidence_publish_failed"
  | "definition_load_failed"
  | "load_deadline_exceeded"
  | "load_attempt_incomplete"

export class HarnessActorControllerError extends Error {
  readonly code: HarnessActorControllerErrorCode

  constructor(code: HarnessActorControllerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "HarnessActorControllerError"
    this.code = code
  }
}

export interface BuildApprovedHarnessActorOptions {
  readonly database: string
  readonly siteId: string
  readonly environment: string
  readonly candidatesRoot?: string
  readonly buildRoot?: string
  readonly now?: () => number
}

export interface BuiltApprovedHarnessActor {
  readonly record: HarnessActorBuildRecord
  readonly candidateDirectory: string
  readonly buildDirectory: string
}

export interface LoadApprovedHarnessActorOptions {
  readonly database: string
  readonly harnessId: Sha256Digest
  readonly baseUrl: string
  readonly targetId: string
  readonly definitionApprovalId: string
  readonly loadId: string
  readonly token?: string
  readonly buildRoot?: string
  readonly catalogThread?: string
  readonly now?: () => number
  readonly routeProbeTimeoutMs?: number
  readonly loadTimeoutMs?: number
  readonly maxLifecycleScanPages?: number
  readonly fetch?: typeof globalThis.fetch
}

export interface LoadedApprovedHarnessActor {
  readonly record: HarnessActorBuildRecord
  readonly load: HarnessDefinitionLoadRecord
  readonly pushed: boolean
  readonly discovered: boolean
  readonly publicRoute: "verified" | "unavailable"
}

const sha256 = (value: string | Uint8Array): Sha256Digest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object" || value === null) throw new TypeError("lifecycle evidence must be JSON data")
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

const requiredText = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HarnessActorControllerError("invalid_input", `${name} is required`)
  }
  return value.trim()
}

class HarnessLoadDeadlineExceeded extends Error {
  constructor() {
    super("the bounded definition-load deadline elapsed")
    this.name = "HarnessLoadDeadlineExceeded"
  }
}

class HarnessLoadResponseTooLarge extends Error {
  constructor() {
    super("the definition host response exceeded the bounded byte limit")
    this.name = "HarnessLoadResponseTooLarge"
  }
}

const boundedIntegerOption = (
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number => {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) {
    throw new HarnessActorControllerError(
      "invalid_input",
      `${name} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return Number(normalized)
}

interface HarnessLoadBudget {
  readonly fetch: typeof globalThis.fetch
  readonly maxLifecycleScanPages: number
  readonly routeProbeTimeoutMs: number
  readonly remaining: () => number
  readonly assertRemaining: () => void
}

const loadBudgetOf = (options: LoadApprovedHarnessActorOptions): HarnessLoadBudget => {
  const timeoutMs = boundedIntegerOption(
    options.loadTimeoutMs,
    DEFAULT_HARNESS_LOAD_TIMEOUT_MS,
    "loadTimeoutMs",
    50,
    MAX_HARNESS_LOAD_TIMEOUT_MS
  )
  const maxLifecycleScanPages = boundedIntegerOption(
    options.maxLifecycleScanPages,
    DEFAULT_HARNESS_LIFECYCLE_SCAN_PAGES,
    "maxLifecycleScanPages",
    1,
    MAX_HARNESS_LIFECYCLE_SCAN_PAGES
  )
  const routeProbeTimeoutMs = boundedIntegerOption(
    options.routeProbeTimeoutMs,
    10_000,
    "routeProbeTimeoutMs",
    25,
    MAX_HARNESS_LOAD_TIMEOUT_MS
  )
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new HarnessActorControllerError("invalid_input", "fetch must be a function")
  }
  const underlyingFetch = options.fetch ?? globalThis.fetch
  const deadline = performance.now() + timeoutMs
  const remaining = (): number => Math.max(0, Math.ceil(deadline - performance.now()))
  const assertRemaining = (): void => {
    if (remaining() <= 0) throw new HarnessLoadDeadlineExceeded()
  }
  const boundedFetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    assertRemaining()
    const controller = new AbortController()
    const inheritedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = inheritedSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, inheritedSignal])
    let cancelBody: (() => void) | undefined
    return await new Promise<Response>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        controller.abort()
        cancelBody?.()
        rejectPromise(new HarnessLoadDeadlineExceeded())
      }, remaining())
      void (async (): Promise<Response> => {
        const response = await underlyingFetch(input, { ...init, redirect: "manual", signal })
        const contentLength = response.headers.get("content-length")
        if (contentLength !== null && /^[0-9]+$/u.test(contentLength) &&
          Number(contentLength) > MAX_HARNESS_LOAD_RESPONSE_BYTES) {
          void response.body?.cancel().catch(() => undefined)
          throw new HarnessLoadResponseTooLarge()
        }

        const chunks: Array<Uint8Array> = []
        let byteLength = 0
        if (response.body !== null) {
          const reader = response.body.getReader()
          cancelBody = () => {
            void reader.cancel().catch(() => undefined)
          }
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              byteLength += next.value.byteLength
              if (byteLength > MAX_HARNESS_LOAD_RESPONSE_BYTES) {
                throw new HarnessLoadResponseTooLarge()
              }
              chunks.push(next.value)
            }
          } finally {
            if (byteLength > MAX_HARNESS_LOAD_RESPONSE_BYTES || controller.signal.aborted) {
              void reader.cancel().catch(() => undefined)
            }
            reader.releaseLock()
            cancelBody = undefined
          }
        }
        assertRemaining()
        const body = new Uint8Array(byteLength)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
        }
        const headers = new Headers(response.headers)
        headers.delete("content-encoding")
        headers.delete("content-length")
        headers.delete("transfer-encoding")
        const method = input instanceof Request ? input.method : init?.method ?? "GET"
        const bodyForbidden = method === "HEAD" || response.body === null ||
          response.status === 204 || response.status === 205 || response.status === 304
        if (!bodyForbidden) headers.set("content-length", String(byteLength))
        return new Response(bodyForbidden ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers
        })
      })().then(
        (response) => {
          clearTimeout(timer)
          resolvePromise(response)
        },
        (error) => {
          clearTimeout(timer)
          cancelBody?.()
          rejectPromise(controller.signal.aborted ? new HarnessLoadDeadlineExceeded() : error)
        }
      )
    })
  }) as typeof globalThis.fetch
  return {
    fetch: boundedFetch,
    maxLifecycleScanPages,
    routeProbeTimeoutMs,
    remaining,
    assertRemaining
  }
}

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
}

const safeRoot = async (value: string): Promise<string> => {
  const root = resolve(value)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) throw new HarnessActorControllerError("candidate_symlink", `root ${root} must not be a symlink`)
  if (!stat.isDirectory()) throw new HarnessActorControllerError("candidate_escape", `root ${root} is not a directory`)
  return await realpath(root)
}

const assertNoSymlinks = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new HarnessActorControllerError("candidate_symlink", `generated actor tree contains a symlink at ${path}`)
    }
    if (entry.isDirectory()) await assertNoSymlinks(path)
  }
}

const ensureImmutableCandidate = async (
  rootValue: string,
  actorName: string,
  files: Readonly<Record<string, string>>
): Promise<string> => {
  const root = await safeRoot(rootValue)
  const candidate = resolve(root, actorName)
  if (!within(root, candidate) || basename(candidate) !== actorName) {
    throw new HarnessActorControllerError("candidate_escape", "generated actor directory escaped the candidate root")
  }
  let exists = true
  try {
    const stat = await lstat(candidate)
    if (stat.isSymbolicLink()) throw new HarnessActorControllerError("candidate_symlink", `candidate ${candidate} is a symlink`)
    if (!stat.isDirectory()) throw new HarnessActorControllerError("candidate_conflict", `candidate ${candidate} is not a directory`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    exists = false
    await mkdir(candidate, { mode: 0o700 })
  }

  if (exists) {
    await assertNoSymlinks(candidate)
    const names = (await readdir(candidate)).sort()
    const expected = new Set(Object.keys(files))
    if (names.some((name) => !expected.has(name))) {
      throw new HarnessActorControllerError("candidate_conflict", `candidate ${candidate} contains an unexpected file set`)
    }
  }

  for (const [name, content] of Object.entries(files)) {
    const path = join(candidate, name)
    if (!within(candidate, path) || dirname(path) !== candidate) {
      throw new HarnessActorControllerError("candidate_escape", `candidate file ${name} escaped its directory`)
    }
    try {
      const found = await readFile(path, "utf8")
      if (found !== content) {
        throw new HarnessActorControllerError("candidate_conflict", `immutable candidate file ${name} has different content`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    }
  }
  await assertNoSymlinks(candidate)
  return candidate
}

const exactMethodContract = (
  linted: Awaited<ReturnType<typeof lintActor>>,
  expected: ReadonlyArray<string>
): boolean => {
  const methods = linted.methods.map((method) => ({
    name: method.name,
    handling: [...method.handling].sort()
  })).sort((left, right) => left.name.localeCompare(right.name))
  const wanted = [...expected].sort().map((name) => ({ name, handling: ["local"] }))
  return canonical(methods) === canonical(wanted) && linted.calls.length === 0
}

const builtArtifactOf = async (built: BuiltActor): Promise<ActorArtifact> => {
  const modulePath = join(built.directory, built.manifest.module)
  const stat = await lstat(modulePath)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_GENERATED_ACTOR_MODULE_BYTES) {
    throw new HarnessActorControllerError("bundle_invalid", "generated actor module is not a bounded regular file")
  }
  const module = await readFile(modulePath, "utf8")
  if (sha256(module) !== built.manifest.digest || built.manifest.module !== "actor.mjs" || built.manifest.schema !== 3) {
    throw new HarnessActorControllerError("bundle_invalid", "generated actor manifest does not match its module bytes")
  }
  return { manifest: built.manifest, module }
}

const artifactAtBuildDirectory = async (directory: string, buildRoot: string): Promise<ActorArtifact> => {
  const directoryStat = await lstat(directory)
  if (directoryStat.isSymbolicLink()) {
    throw new HarnessActorControllerError("candidate_symlink", `generated build directory ${directory} is a symlink`)
  }
  if (!directoryStat.isDirectory()) {
    throw new HarnessActorControllerError("bundle_invalid", "generated build path is not a directory")
  }
  const realDirectory = await realpath(directory)
  if (!within(buildRoot, realDirectory) || dirname(realDirectory) !== buildRoot) {
    throw new HarnessActorControllerError("candidate_escape", "generated build directory escaped its root")
  }
  await assertNoSymlinks(realDirectory)
  const names = (await readdir(realDirectory)).sort()
  if (canonical(names) !== canonical(["actor.mjs", "manifest.json"])) {
    throw new HarnessActorControllerError("bundle_invalid", "committed generated actor contains an unexpected file set")
  }
  const manifestPath = join(realDirectory, "manifest.json")
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_GENERATED_ACTOR_MANIFEST_BYTES) {
    throw new HarnessActorControllerError("bundle_invalid", "committed generated actor manifest is not a bounded regular file")
  }
  const manifestValue = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ActorArtifact["manifest"]>
  if (manifestValue.schema !== 3 || typeof manifestValue.name !== "string" ||
    manifestValue.module !== "actor.mjs" || !isSha256Digest(manifestValue.digest)) {
    throw new HarnessActorControllerError("bundle_invalid", "committed generated actor manifest is invalid")
  }
  const modulePath = join(realDirectory, "actor.mjs")
  const stat = await lstat(modulePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GENERATED_ACTOR_MODULE_BYTES) {
    throw new HarnessActorControllerError("bundle_invalid", "committed generated actor module is not a bounded regular file")
  }
  const module = await readFile(modulePath, "utf8")
  if (sha256(module) !== manifestValue.digest) {
    throw new HarnessActorControllerError("bundle_invalid", "committed generated actor digest does not match its bytes")
  }
  return { manifest: manifestValue as ActorArtifact["manifest"], module }
}

const commitBuiltArtifact = async (
  staged: BuiltActor,
  artifact: ActorArtifact,
  buildRoot: string
): Promise<string> => {
  const destination = resolve(buildRoot, artifact.manifest.name)
  if (!within(buildRoot, destination) || dirname(destination) !== buildRoot) {
    throw new HarnessActorControllerError("candidate_escape", "generated build destination escaped its root")
  }
  const acceptExisting = async (): Promise<string> => {
    const existing = await artifactAtBuildDirectory(destination, buildRoot)
    if (existing.manifest.digest !== artifact.manifest.digest || existing.module !== artifact.module) {
      throw new HarnessActorControllerError(
        "build_failed",
        "an immutable build directory already contains different actor bytes"
      )
    }
    return destination
  }
  try {
    await lstat(destination)
    return await acceptExisting()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    await rename(staged.directory, destination)
    const committed = await artifactAtBuildDirectory(destination, buildRoot)
    if (committed.manifest.digest !== artifact.manifest.digest || committed.module !== artifact.module) {
      throw new HarnessActorControllerError("build_failed", "committed generated actor bytes changed during installation")
    }
    return destination
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    return await acceptExisting()
  }
}

export const buildApprovedHarnessActor = async (
  options: BuildApprovedHarnessActorOptions
): Promise<BuiltApprovedHarnessActor> => {
  const database = requiredText(options.database, "database")
  const registry = new HarnessRegistry(database)
  let catalog: HarnessActorCatalog | undefined
  try {
    const resolved = registry.resolveApproved(options.siteId, options.environment)
    if (resolved === undefined) {
      throw new HarnessActorControllerError("invalid_input", "no approved harness is active for that site and environment")
    }
    const identity = generatedHarnessActorIdentity(resolved.artifact)
    const factory = await generatedHarnessActorFactoryBundle()
    const source = generatedHarnessActorSource({
      actorName: identity.actorName,
      artifact: resolved.artifact,
      interfaceContract: identity.interfaceContract,
      factoryImport: "./factory.mjs"
    })
    const sourceDigest = sha256(canonical({
      schemaVersion: 1,
      generatorRevision: HARNESS_ACTOR_GENERATOR_REVISION,
      actorSourceDigest: sha256(source),
      factoryDigest: factory.digest
    }))
    const candidatesRoot = options.candidatesRoot ?? DEFAULT_HARNESS_CANDIDATES_ROOT
    const buildRoot = await safeRoot(options.buildRoot ?? DEFAULT_HARNESS_BUILD_ROOT)
    const candidateDirectory = await ensureImmutableCandidate(candidatesRoot, identity.actorName, {
      "actor.ts": source,
      "factory.mjs": factory.source,
      "artifact.json": `${canonicalSiteHarnessArtifact(resolved.artifact)}\n`,
      "interface.json": `${canonicalSiteInterfaceContract(identity.interfaceContract)}\n`
    })
    if (within(candidateDirectory, buildRoot) || within(buildRoot, candidateDirectory)) {
      throw new HarnessActorControllerError(
        "candidate_conflict",
        "candidate and build directories must be disjoint so a build cannot replace immutable source"
      )
    }
    let linted: Awaited<ReturnType<typeof lintActor>>
    try {
      linted = await lintActor("actor.ts", { cwd: candidateDirectory })
    } catch (error) {
      throw new HarnessActorControllerError("lint_failed", "generated actor failed Tardigrade contract lint", error)
    }
    if (linted.name !== identity.actorName || !exactMethodContract(linted, identity.interfaceContract.actions.map((action) => action.methodName))) {
      throw new HarnessActorControllerError("lint_failed", "generated actor method surface does not match its immutable interface contract")
    }
    catalog = new HarnessActorCatalog({ database, ...(options.now === undefined ? {} : { now: options.now }) })
    const priorBuilds = catalog.getBuildsByActorName(identity.actorName)
    if (priorBuilds.some((prior) => prior.sourceDigest !== sourceDigest ||
      prior.interfaceDigest !== identity.interfaceDigest || prior.artifactDigest !== resolved.artifactDigest)) {
      throw new HarnessActorCatalogError(
        "build_conflict",
        "this content-addressed actor name is already bound to a different immutable source closure"
      )
    }
    const stagingRoot = await mkdtemp(join(buildRoot, ".staging-"))
    try {
      let built: BuiltActor
      try {
        built = await buildActor("actor.ts", { cwd: candidateDirectory, out: stagingRoot })
      } catch (error) {
        throw new HarnessActorControllerError("build_failed", "generated actor failed the Tardigrade build", error)
      }
      const artifact = await builtArtifactOf(built)
      if (artifact.manifest.name !== identity.actorName || !isSha256Digest(artifact.manifest.digest)) {
        throw new HarnessActorControllerError("bundle_invalid", "built actor identity does not match its generated source")
      }
      if (priorBuilds.some((prior) => prior.bundleDigest !== artifact.manifest.digest)) {
        throw new HarnessActorCatalogError(
          "build_conflict",
          "the same immutable source closure produced a different bundle digest"
        )
      }
      const buildDirectory = await commitBuiltArtifact(built, artifact, buildRoot)
      const record = catalog.recordBuild({
        siteId: resolved.siteId,
        environment: resolved.environment,
        generation: resolved.generation,
        artifactDigest: resolved.artifactDigest,
        evaluationId: resolved.evaluationId,
        artifactApprovalId: resolved.approvalId,
        interfaceContract: identity.interfaceContract,
        actorName: identity.actorName,
        generatorRevision: HARNESS_ACTOR_GENERATOR_REVISION,
        sourceDigest,
        bundleDigest: artifact.manifest.digest,
        manifestSchema: 3,
        moduleName: "actor.mjs"
      })
      return { record, candidateDirectory, buildDirectory }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  } finally {
    catalog?.close()
    registry.close()
  }
}

const lifecycleIdentity = (build: HarnessActorBuildRecord): Readonly<Record<string, unknown>> => ({
  schemaVersion: 1,
  harnessId: build.harnessId,
  siteId: build.siteId,
  environment: build.environment,
  generation: build.generation,
  artifactDigest: build.artifactDigest,
  interfaceDigest: build.interfaceDigest,
  sourceDigest: build.sourceDigest,
  buildDigest: build.bundleDigest,
  definitionDigest: build.bundleDigest,
  actorName: build.actorName,
  generatorRevision: build.generatorRevision,
  actions: build.interfaceContract.actions.map((action) => ({
    id: action.id,
    methodName: action.methodName,
    inputs: action.inputs
  }))
})

const appendOnce = async (
  client: ReturnType<typeof makeActorClient>,
  actor: string,
  thread: string,
  event: Readonly<Record<string, unknown>>,
  maxPages: number
): Promise<void> => {
  const eventId = String(event.eventId)
  let after = 0
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    let page
    try {
      page = await client.events(actor, thread, { after, limit: 200 })
    } catch (error) {
      if (error instanceof ProblemError && error.status === 404 && after === 0) {
        await client.append(actor, thread, event as { readonly type: string })
        return
      }
      throw error
    }
    if (page.length === 0) {
      await client.append(actor, thread, event as { readonly type: string })
      return
    }
    for (const row of page) {
      const found = row.event as Readonly<Record<string, unknown>>
      if (found.eventId === eventId) {
        const { at: _at, traceparent: _traceparent, ...domain } = found
        if (canonical(domain) !== canonical(event)) {
          throw new HarnessActorControllerError("evidence_publish_failed", `lifecycle event ${eventId} already has different content`)
        }
        return
      }
      after = row.seq
    }
  }
  throw new HarnessActorControllerError(
    "evidence_publish_failed",
    "lifecycle event scan exceeded its bounded page limit"
  )
}

const lifecyclePublisher = (
  options: LoadApprovedHarnessActorOptions,
  budget: HarnessLoadBudget,
  targetOrigin: string
) => {
  const client = makeActorClient({
    baseUrl: targetOrigin,
    ...(options.token === undefined ? {} : { token: options.token }),
    fetch: budget.fetch
  })
  const actor = DEFAULT_HARNESS_CATALOG_ACTOR
  const thread = options.catalogThread ?? DEFAULT_HARNESS_CATALOG_THREAD
  let ensured: Promise<unknown> | undefined
  return async (event: Readonly<Record<string, unknown>>) => {
    ensured ??= client.ensureActor(actor)
    await ensured
    await appendOnce(client, actor, thread, event, budget.maxLifecycleScanPages)
  }
}

const probeInputOf = (build: HarnessActorBuildRecord): {
  readonly methodName: string
  readonly input: Readonly<Record<string, unknown>>
} | undefined => {
  const action = build.interfaceContract.actions[0]
  if (action === undefined) return undefined
  return {
    methodName: action.methodName,
    input: {
      bindings: Object.fromEntries(action.inputs.map((input) => [
        input.name,
        { ref: `vault:v1:${createHash("sha256").update(`route-probe:${build.harnessId}:${input.name}`).digest("hex").slice(0, 32)}` }
      ]))
    }
  }
}

const waitForProbe = async (
  client: ReturnType<typeof makeActorClient>,
  actor: string,
  thread: string,
  method: string,
  call: string,
  timeoutMs: number,
  budget: HarnessLoadBudget
): Promise<boolean> => {
  const deadline = performance.now() + Math.min(timeoutMs, budget.remaining())
  for (;;) {
    budget.assertRemaining()
    const state = await client.methodState(actor, thread, method, call)
    if (state.status === "completed") return true
    if (state.status === "failed" || state.status === "cancelled") return false
    if (performance.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(
      resolvePromise,
      Math.max(1, Math.min(25, deadline - performance.now(), budget.remaining()))
    ))
  }
}

const publicRouteProbe = async (
  options: LoadApprovedHarnessActorOptions,
  build: HarnessActorBuildRecord,
  budget: HarnessLoadBudget,
  targetOrigin: string
): Promise<{ readonly status: "verified" | "unavailable"; readonly code: HarnessDefinitionLoadCode }> => {
  const probe = probeInputOf(build)
  if (probe === undefined) return { status: "unavailable", code: "public_route_probe_failed" }
  const client = makeActorClient({
    baseUrl: targetOrigin,
    ...(options.token === undefined ? {} : { token: options.token }),
    fetch: budget.fetch
  })
  const scope = build.harnessId.slice(7, 23)
  const thread = `route-probe-${scope}`
  const call = `route-probe-${scope}`
  try {
    budget.assertRemaining()
    const probeTimeoutMs = Math.max(1, Math.min(budget.routeProbeTimeoutMs, budget.remaining()))
    await client.call(build.actorName, thread, probe.methodName, {
      id: call,
      input: probe.input,
      timeoutMs: probeTimeoutMs
    })
    const completed = await waitForProbe(
      client,
      build.actorName,
      thread,
      probe.methodName,
      call,
      probeTimeoutMs,
      budget
    )
    return completed
      ? { status: "verified", code: "public_route_verified" }
      : { status: "unavailable", code: "public_route_probe_failed" }
  } catch (error) {
    if (error instanceof HarnessLoadDeadlineExceeded || budget.remaining() <= 0) {
      throw new HarnessLoadDeadlineExceeded()
    }
    return {
      status: "unavailable",
      code: error instanceof ProblemError && (error.status === 404 || /unknown method/iu.test(error.message))
        ? "upstream_public_binding_unavailable"
        : "public_route_probe_failed"
    }
  }
}

const safeLoadFailureCode = (error: unknown): HarnessDefinitionLoadAttemptFailureCode => {
  if (error instanceof HarnessLoadDeadlineExceeded ||
    (error instanceof HarnessActorControllerError && error.code === "load_deadline_exceeded")) {
    return "load_deadline_exceeded"
  }
  if (error instanceof HarnessActorControllerError && [
    "bundle_invalid",
    "candidate_escape",
    "candidate_symlink",
    "definition_conflict",
    "definition_load_failed",
    "definition_not_discoverable",
    "push_refused"
  ].includes(error.code)) return error.code as HarnessDefinitionLoadAttemptFailureCode
  if (error instanceof HarnessActorCatalogError && error.code === "activation_not_current") {
    return "activation_not_current"
  }
  if (error instanceof ProblemError && error.status === 400) return "push_refused"
  return "definition_load_failed"
}

const publicLoadError = (error: unknown): Error => error instanceof HarnessLoadDeadlineExceeded
  ? new HarnessActorControllerError(
    "load_deadline_exceeded",
    "the bounded definition-load deadline elapsed"
  )
  : error instanceof Error
  ? error
  : new HarnessActorControllerError("definition_load_failed", "definition load failed")

const replayedLoadFailure = (code: HarnessDefinitionLoadAttemptFailureCode): Error =>
  code === "activation_not_current"
    ? new HarnessActorCatalogError(
      "activation_not_current",
      "the recorded definition load attempt no longer matched the current activation"
    )
    : new HarnessActorControllerError(
      code,
      `the recorded definition load attempt failed with ${code}`
    )

export const loadApprovedHarnessActor = async (
  options: LoadApprovedHarnessActorOptions
): Promise<LoadedApprovedHarnessActor> => {
  const targetOrigin = canonicalDefinitionTargetOrigin(requiredText(options.baseUrl, "baseUrl"))
  const targetUrl = new URL(targetOrigin)
  const loopback = targetUrl.hostname === "127.0.0.1" || targetUrl.hostname === "localhost" || targetUrl.hostname === "[::1]"
  if (!loopback && !(options.token?.trim().length)) {
    throw new HarnessActorControllerError(
      "invalid_input",
      "definition targets must use HTTPS, or HTTP on loopback; non-loopback targets require TARDIGRADE_TOKEN"
    )
  }
  const budget = loadBudgetOf(options)
  const catalog = new HarnessActorCatalog({ database: options.database, ...(options.now === undefined ? {} : { now: options.now }) })
  try {
    const build = catalog.getBuild(options.harnessId)
    if (build === undefined) {
      throw new HarnessActorCatalogError("build_not_found", `actor build ${options.harnessId} is not registered`)
    }
    const approval = catalog.getDefinitionApproval(options.definitionApprovalId)
    if (approval === undefined) {
      throw new HarnessActorCatalogError("approval_not_found", "definition approval must be recorded before loading")
    }
    if (approval.harnessId !== build.harnessId || approval.targetId !== options.targetId ||
      approval.targetOrigin !== targetOrigin ||
      approval.statementDigest !== definitionApprovalStatementDigest(build, options.targetId, targetOrigin)) {
      throw new HarnessActorCatalogError("approval_conflict", "definition approval does not cover this exact build and target")
    }

    const expectedAttempt = {
      loadId: options.loadId,
      harnessId: build.harnessId,
      definitionApprovalId: approval.definitionApprovalId,
      targetId: options.targetId,
      targetOriginDigest: sha256(targetOrigin),
      definitionApprovalDigest: approval.statementDigest,
      definitionDigest: build.bundleDigest
    }
    const existingAttempt = catalog.getLoadAttempt(options.loadId)
    if (existingAttempt !== undefined) {
      const comparable = {
        loadId: existingAttempt.loadId,
        harnessId: existingAttempt.harnessId,
        definitionApprovalId: existingAttempt.definitionApprovalId,
        targetId: existingAttempt.targetId,
        targetOriginDigest: existingAttempt.targetOriginDigest,
        definitionApprovalDigest: existingAttempt.definitionApprovalDigest,
        definitionDigest: existingAttempt.definitionDigest
      }
      if (canonical(comparable) !== canonical(expectedAttempt)) {
        throw new HarnessActorCatalogError(
          "attempt_conflict",
          `definition load attempt ${JSON.stringify(options.loadId)} is immutable`
        )
      }
      if (existingAttempt.outcome === undefined) {
        throw new HarnessActorControllerError(
          "load_attempt_incomplete",
          "the definition load ID is already reserved without a terminal outcome; use a new load ID after review"
        )
      }
      if (existingAttempt.outcome.status === "failed") {
        throw replayedLoadFailure(existingAttempt.outcome.code as HarnessDefinitionLoadAttemptFailureCode)
      }
      const existingLoad = catalog.getLoad(options.loadId)
      if (existingLoad === undefined || existingLoad.publicRoute !== existingAttempt.outcome.status ||
        existingLoad.code !== existingAttempt.outcome.code) {
        throw new HarnessActorCatalogError("corrupt_catalog", "terminal definition load attempt has no matching load record")
      }
      return {
        record: build,
        load: existingLoad,
        pushed: false,
        discovered: true,
        publicRoute: existingLoad.publicRoute
      }
    }

    // Reservation is the durable idempotency boundary. It is committed before
    // the first lifecycle, discovery, push, or route-probe request.
    catalog.assertCurrent(build.harnessId)
    const reservation = catalog.reserveLoadAttempt({
      loadId: options.loadId,
      harnessId: build.harnessId,
      definitionApprovalId: approval.definitionApprovalId,
      targetId: options.targetId,
      definitionDigest: build.bundleDigest
    })
    if (!reservation.created) {
      if (reservation.attempt.outcome === undefined) {
        throw new HarnessActorControllerError(
          "load_attempt_incomplete",
          "the definition load ID is already reserved without a terminal outcome; use a new load ID after review"
        )
      }
      if (reservation.attempt.outcome.status === "failed") {
        throw replayedLoadFailure(
          reservation.attempt.outcome.code as HarnessDefinitionLoadAttemptFailureCode
        )
      }
      const concurrentLoad = catalog.getLoad(options.loadId)
      if (concurrentLoad === undefined || concurrentLoad.publicRoute !== reservation.attempt.outcome.status ||
        concurrentLoad.code !== reservation.attempt.outcome.code) {
        throw new HarnessActorCatalogError(
          "corrupt_catalog",
          "terminal definition load attempt has no matching load record"
        )
      }
      return {
        record: build,
        load: concurrentLoad,
        pushed: false,
        discovered: true,
        publicRoute: concurrentLoad.publicRoute
      }
    }

    const identity = lifecycleIdentity(build)
    const loadIdentity = {
      targetId: options.targetId,
      targetOriginDigest: reservation.attempt.targetOriginDigest,
      definitionApprovalDigest: reservation.attempt.definitionApprovalDigest,
      loadId: options.loadId
    }
    const baseLifecycleEvents: ReadonlyArray<Readonly<Record<string, unknown>>> = [{
      type: "HarnessActivationObserved",
      eventId: harnessLifecycleEventId({ harnessId: build.harnessId, phase: "activation" }),
      ...identity
    }, {
      type: "HarnessActorGenerated",
      eventId: harnessLifecycleEventId({ harnessId: build.harnessId, phase: "generated" }),
      ...identity
    }, {
      type: "HarnessDefinitionApprovalObserved",
      eventId: harnessLifecycleEventId({
        harnessId: build.harnessId,
        phase: "definition-approved",
        targetId: options.targetId,
        loadId: options.loadId
      }),
      ...identity,
      ...loadIdentity
    }]
    const publish = lifecyclePublisher(options, budget, targetOrigin)
    const mirror = async (events: ReadonlyArray<Readonly<Record<string, unknown>>>): Promise<void> => {
      try {
        for (const event of events) await publish(event)
      } catch {
        // The SQLite attempt ledger is authoritative. The UI log is a bounded,
        // value-minimized mirror and cannot replace a target or verifier result.
      }
    }

    let discovered = false
    try {
      budget.assertRemaining()
      const buildRoot = await safeRoot(options.buildRoot ?? DEFAULT_HARNESS_BUILD_ROOT)
      const directory = resolve(buildRoot, build.actorName)
      if (!within(buildRoot, directory)) {
        throw new HarnessActorControllerError("candidate_escape", "build directory escaped the build root")
      }
      const storedArtifact = await artifactAtBuildDirectory(directory, buildRoot)
      budget.assertRemaining()
      const manifest = storedArtifact.manifest
      const module = storedArtifact.module
      if (
        manifest.schema !== 3 || manifest.name !== build.actorName || manifest.module !== "actor.mjs" ||
        manifest.digest !== build.bundleDigest || sha256(module) !== build.bundleDigest
      ) {
        throw new HarnessActorControllerError("bundle_invalid", "approved actor files do not match the recorded build attestation")
      }
      const artifact: ActorArtifact = { manifest: manifest as ActorArtifact["manifest"], module }
      const control = makeControlClient({
        baseUrl: targetOrigin,
        ...(options.token === undefined ? {} : { token: options.token }),
        fetch: budget.fetch
      })
      budget.assertRemaining()
      const before = await control.definitions()
      const existing = before.find((definition) => definition.name === build.actorName)
      let pushed = false
      if (existing !== undefined && existing.digest !== build.bundleDigest) {
        throw new HarnessActorControllerError(
          "definition_conflict",
          "target already has a different bundle under the content-addressed actor name"
        )
      }
      if (existing === undefined) {
        catalog.assertCurrent(build.harnessId)
        let accepted
        try {
          budget.assertRemaining()
          accepted = await control.pushDefinition(artifact)
        } catch (error) {
          if (error instanceof HarnessLoadDeadlineExceeded || budget.remaining() <= 0) {
            throw new HarnessLoadDeadlineExceeded()
          }
          throw new HarnessActorControllerError("push_refused", "target refused the approved actor definition", error)
        }
        if (accepted.name !== build.actorName || accepted.digest !== build.bundleDigest) {
          throw new HarnessActorControllerError("push_refused", "target acknowledged a different actor definition")
        }
        pushed = true
      }
      budget.assertRemaining()
      discovered = (await control.definitions()).some((definition) =>
        definition.name === build.actorName && definition.digest === build.bundleDigest)
      if (!discovered) {
        throw new HarnessActorControllerError(
          "definition_not_discoverable",
          "target did not discover the exact definition after installation"
        )
      }

      const route = await publicRouteProbe(options, build, budget, targetOrigin)
      catalog.assertCurrent(build.harnessId)
      const completion = catalog.recordLoadAttemptOutcome({
        loadId: options.loadId,
        status: route.status,
        code: route.code
      })
      if (completion.load === undefined) {
        throw new HarnessActorCatalogError("corrupt_catalog", "terminal definition load attempt has no load record")
      }
      await mirror([...baseLifecycleEvents, {
        type: "HarnessDefinitionInstalled",
        eventId: harnessLifecycleEventId({
          harnessId: build.harnessId,
          phase: "installed",
          targetId: options.targetId,
          loadId: options.loadId
        }),
        ...identity,
        ...loadIdentity
      }, {
        type: route.status === "verified" ? "HarnessPublicRouteVerified" : "HarnessPublicRouteUnavailable",
        eventId: harnessLifecycleEventId({
          harnessId: build.harnessId,
          phase: "route",
          targetId: options.targetId,
          loadId: options.loadId
        }),
        ...identity,
        ...loadIdentity,
        code: route.code
      }])
      return {
        record: build,
        load: completion.load,
        pushed,
        discovered: true,
        publicRoute: route.status
      }
    } catch (error) {
      const original = publicLoadError(
        budget.remaining() <= 0 ? new HarnessLoadDeadlineExceeded() : error
      )
      const code = safeLoadFailureCode(original)
      catalog.recordLoadAttemptOutcome({ loadId: options.loadId, status: "failed", code })
      await mirror([...baseLifecycleEvents, ...(discovered ? [{
        type: "HarnessDefinitionInstalled",
        eventId: harnessLifecycleEventId({
          harnessId: build.harnessId,
          phase: "installed",
          targetId: options.targetId,
          loadId: options.loadId
        }),
        ...identity,
        ...loadIdentity
      }] : []), {
        type: "HarnessDefinitionLoadFailed",
        eventId: harnessLifecycleEventId({
          harnessId: build.harnessId,
          phase: "load-failed",
          targetId: options.targetId,
          loadId: options.loadId
        }),
        ...identity,
        ...loadIdentity,
        code
      }])
      throw original
    }
  } finally {
    catalog.close()
  }
}
