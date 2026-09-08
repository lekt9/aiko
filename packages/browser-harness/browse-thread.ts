import { inferBoundedHarAssociations, compileObservedReadNetworkTools, preparedNetworkToolIdOf, type BrowseThreadPreparedTools, type HarAssociation } from "./src/observed-network"
export { inferBoundedHarAssociations, compileObservedReadNetworkTools, preparedNetworkToolIdOf, type BrowseThreadPreparedTools } from "./src/observed-network"
import { chmod, mkdir, mkdtemp, open as openFile, rename, rm } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { browserBackendOf, browserLaunchConfig, CLOAK_BROWSER_VERIFIED_MESSAGE, type BrowserBackend } from "./src/cloak-browser"

import { makeActorClient, ProblemError, type EventRow } from "tardie/client"
import type { Event } from "tardie/core/log/event"

import {
  AGENT_BROWSER_AGENT_DAEMON_ACTIONS,
  AgentBrowserClient,
  AgentBrowserClientError,
  agentBrowserClientStopReason,
  normalizeAgentBrowserAllowedDomains,
  validateAgentBrowserTarget,
  type AgentBrowserCallWindow,
  type AgentBrowserClientOptions,
  type AgentBrowserSpawn,
  type AgentBrowserWebSocketFactory
} from "./src/agent-browser-client"
import {
  AgentBrowserAgentError,
  MAX_AGENT_BROWSER_PROMPT_BYTES,
  runAgentBrowserAgent,
  validateAgentBrowserAgentConfiguration,
  validateAgentBrowserAgentPrompt,
  type AgentBrowserAgentLimits
} from "./src/agent-browser-agent"
import {
  MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL,
  MAX_BROWSER_PREPARED_TOOLS,
  MAX_BROWSER_TRACE_CALLS,
  MAX_BROWSER_TRACE_EVENTS,
  browserNetworkDependencyEventOf,
  browserNetworkToolPreparedEventOf,
  browserNetworkToolReuseEventOf,
  browserRequestEvidenceIdOf,
  browserToolCallEventOf,
  browserToolResultEventOf,
  browserTraceNdjsonLineOf,
  browserTraceProjectionOf,
  decodeBrowserToolResultShape,
  type BrowserNetworkReuseReason,
  type BrowserPayloadShape,
  type BrowserTraceEvent
} from "./src/browser-trace"
import {
  prepareTrustedNetworkEntries,
  type HarImportResult,
  type TrustedHarImportPreparation
} from "./import-har"
import { buildObservedReadHarnessDraft, type HarnessDraftIssue } from "./src/harness-builder"
import { harnessAuthorBriefOf, MAX_AUTHOR_REQUESTS } from "./src/harness-author"
import { searchHarnessAuthorGraph, inspectHarnessAuthorRequest, navigateHarnessAuthorGraph } from "./src/harness-author-graph"
import { validatedHarCaptureFactsOf, planHarImport, networkFactObservedEventOf, networkGraphCheckpointOf, assertNetworkSnapshotBackedByLog } from "./src/har-component"
import { CdpNetworkListener, type NetworkEntry, type NetworkSocketFactory } from "./src/cdp-network-listener"
import { observedReadDraftPreparedEventOf } from "./src/harness-component"
import { siteHarnessArtifactDigest, type Sha256Digest } from "./src/harness-artifact"
import { canonicalStringify, sha256, type NormalizedHarEntry } from "./src/har"
import type { BrowseHarnessStopReason, BrowseHarnessIndexRequest } from "./src/browse-harness-contract"
import {
  NETWORK_TOOL_COMPILER_REVISION,
  compileNetworkTool,
  createNetworkToolCatalog,
  decideNetworkToolShortCircuit,
  type CompiledNetworkTool,
  type NetworkToolCatalog,
  type NetworkToolCompileFallbackReason,
  type NetworkToolDefinition,
  type NetworkToolInvocationRequest,
  type NetworkToolShortCircuitFallbackReason,
  type BrowserNetworkToolIndex
} from "./src/network-tool-catalog"

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const DEFAULT_ACTOR = "main"
const DEFAULT_BASE_URL = "http://127.0.0.1:4242"
const DEFAULT_NETWORK_EXECUTION_TIMEOUT_MS = 30_000
const MAX_NETWORK_EXECUTION_TIMEOUT_MS = 60_000
const DEFAULT_TRACE_SINK_OPERATION_TIMEOUT_MS = 10_000
const MAX_TRACE_SINK_OPERATION_TIMEOUT_MS = 60_000
const DEFAULT_TRUSTED_CONTROLLER_OPERATION_TIMEOUT_MS = 120_000
const MAX_TRUSTED_CONTROLLER_OPERATION_TIMEOUT_MS = 300_000
const DEFAULT_PRIVATE_CLEANUP_TIMEOUT_MS = 30_000
const MAX_PRIVATE_CLEANUP_TIMEOUT_MS = 120_000
const DEFAULT_NDJSON_DELIVERY_TIMEOUT_MS = 1_000
const MAX_NDJSON_DELIVERY_TIMEOUT_MS = 5_000
/** Hard upper bound across the complete value-free NDJSON trace for one thread. */
export const MAX_BROWSER_TRACE_NDJSON_BYTES = 16 * 1024 * 1024
// The run now includes immutable HAR prefixes as well as browser events.
// Browser-event/NDJSON quotas are unchanged; these bound the combined log read.
export const MAX_BROWSER_TRACE_LOAD_ROWS = 100_000
export const MAX_BROWSER_TRACE_LOAD_BYTES = 64 * 1024 * 1024
export const MAX_BROWSER_TRACE_LOAD_PAGES = 512
/**
 * agent-browser v0.36's native daemon checks the parsed raw action (for
 * example `evaluate` and `state_save`), not the command-family labels shown
 * by some older documentation. Default-deny also keeps newly added upstream
 * actions unavailable until this boundary is reviewed again.
 */
const CONTROLLER_ACTION_POLICY_JSON = `${JSON.stringify({
  default: "deny",
  allow: [
    "close",
    "cdp_url",
    "launch",
    "navigate",
    "stream_enable",
    "stream_status",
    "viewport"
  ]
})}\n`

/**
 * The trusted structured browser agent may operate the already-running browser,
 * but it cannot control the daemon/capture lifecycle or select filesystem-bearing actions.
 * The allowlist uses exact v0.36 daemon action names and is default-deny so a
 * newly added upstream action stays unavailable until reviewed.
 */
const AGENT_ACTION_POLICY_JSON = `${JSON.stringify({
  default: "deny",
  // v0.36 performs an internal launch/reuse check before each fixed command.
  // The model has no launch tool, so this grants daemon plumbing rather than
  // a model-addressable lifecycle action.
  allow: ["launch", ...AGENT_BROWSER_AGENT_DAEMON_ACTIONS]
})}\n`

export type BrowseThreadErrorCode =
  | "invalid_input"
  | "cancelled"
  | "trace_invalid"
  | "trace_append_failed"
  | "network_execution_failed"
  | "browser_failed"
  | "har_capture_failed"
  | "har_import_failed"
  | "cleanup_failed"

export class BrowseThreadError extends Error {
  readonly code: BrowseThreadErrorCode

  constructor(code: BrowseThreadErrorCode, message: string, readonly reason?: BrowseHarnessStopReason) {
    super(message)
    this.name = "BrowseThreadError"
    this.code = code
  }
}

export interface BrowserTraceSink {
  ensure(): Promise<void>
  load(): Promise<ReadonlyArray<Event>>
  /** Trusted controller ingress: structural browser, HAR and draft events only. */
  append(event: Event): Promise<void>
}

export interface NetworkToolExecutionResult {
  readonly success: boolean
  /**
   * Optional value-free shape reduced under the injected adapter's own byte
   * bound. Raw website output is deliberately not accepted by this boundary.
   */
  readonly resultShape?: BrowserPayloadShape
}

export interface NetworkToolExecutionContext {
  readonly tool: NetworkToolDefinition
  readonly invocation: NetworkToolInvocationRequest
  /** Caller-owned identity: reuse it only when retrying the same concrete execution. */
  readonly executionAttemptId: string
  /** Stable across retries of the same digest-bound read on one trace thread. */
  readonly attemptKey: string
  readonly idempotencyKey: string
  readonly deadlineAtMs: number
  readonly signal: AbortSignal
}

export type NetworkToolExecutor = (context: NetworkToolExecutionContext) => Promise<NetworkToolExecutionResult>

export type ApprovedNetworkToolCatalogLoader = (
  existingLog: ReadonlyArray<Event>
) => NetworkToolCatalog | undefined | Promise<NetworkToolCatalog | undefined>

export interface BrowseThreadAgentBrowserOptions {
  /** Trusted test/adapter seam for the passive listener, never a model tool. */
  readonly networkSocketFactory?: NetworkSocketFactory
  readonly executablePath?: string
  readonly nodeExecutable?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: AgentBrowserSpawn
  readonly webSocketFactory?: AgentBrowserWebSocketFactory
  readonly now?: () => number
  readonly controlTimeoutMs?: number
  readonly killGraceMs?: number
  readonly stdoutLimitBytes?: number
  readonly stderrLimitBytes?: number
}

export interface BrowseThreadBrowserAgentOptions {
  /** Trusted-controller credential; never forwarded to agent-browser. */
  readonly apiKey?: string
  readonly gatewayUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly limits?: AgentBrowserAgentLimits
  readonly now?: () => number
}

export interface BrowseThreadOptions {
  /** Trusted task-acceptance wall time, pinned before optional website selection. */
  readonly taskStartedAt?: number
  /** Trusted host configuration, never a model tool argument. */
  readonly browserBackend?: BrowserBackend
  readonly prompt: string
  readonly targetUrl: string
  readonly allowedDomains: ReadonlyArray<string>
  readonly threadId: string
  readonly baseUrl?: string
  readonly actor?: string
  readonly token?: string
  readonly model?: string
  /** Trusted caller cancellation; active child operations still settle before cleanup. */
  readonly signal?: AbortSignal
  readonly tempRoot?: string
  readonly traceSink?: BrowserTraceSink
  readonly onNdjson?: (line: string) => void | Promise<void>
  /** Authenticated, opt-in transient transcript; separate from durable NDJSON. */
  readonly onDebug?: (entry: import("./src/browse-harness-contract").BrowseHarnessDebugEntry) => void
  readonly approvedCatalog?: NetworkToolCatalog
  readonly loadApprovedCatalog?: ApprovedNetworkToolCatalogLoader
  readonly networkInvocation?: NetworkToolInvocationRequest
  readonly networkExecutor?: NetworkToolExecutor
  /** Required with an executor; distinct concrete calls must use distinct opaque IDs. */
  readonly networkExecutionAttemptId?: string
  /** May lower, but never raise, the hard cumulative value-free NDJSON cap. */
  readonly traceNdjsonByteLimit?: number
  /** Per-operation hard deadline for canonical trace ensure, load, append, and flush. */
  readonly traceSinkOperationTimeoutMs?: number
  /** Per-operation hard deadline for the optional catalog loader. */
  readonly trustedControllerOperationTimeoutMs?: number
  /** Independent hard deadline for private-directory removal. */
  readonly privateCleanupTimeoutMs?: number
  /** Per-line deadline for the optional, non-authoritative audit sink. */
  readonly ndjsonDeliveryTimeoutMs?: number
  readonly networkExecutionTimeoutMs?: number
  /** Test seam for proving that deletion failure is surfaced, never ignored. */
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>
  readonly agentBrowser?: BrowseThreadAgentBrowserOptions
  readonly browserAgent?: BrowseThreadBrowserAgentOptions
  /** Host-owned shared draft storage; never an execution or approval interface. */
  readonly indexStore?: BrowserNetworkToolIndex
}

export type BrowseThreadResult =
  | {
    readonly mode: "network_tool"
    readonly success: boolean
    readonly traceThreadId: string
    readonly toolDigest: Sha256Digest
    /** False only when the optional audit callback stopped accepting lines. */
    readonly ndjsonDeliveryComplete: boolean
  }
  | {
    readonly mode: "browser"
    readonly success: true
    readonly traceThreadId: string
    readonly agentToolCallCount: number
    readonly telemetryComplete: boolean
    /** False only when the optional audit callback stopped accepting lines. */
    readonly ndjsonDeliveryComplete: boolean
    readonly capture: {
      readonly captureId: string
      readonly thread: string
      readonly importDigest: string
      readonly attemptedEvents: number
      readonly requestCount: number
    }
    readonly preparedToolCount: number
    readonly compileFallbackCount: number
  }

interface PrivateRunFiles {
  readonly directory: string
  readonly socketDirectory: string
  readonly browserTemporaryDirectory: string
  readonly configPath: string
  /** Daemon-stable path; its contents are atomically leased to the structured agent. */
  readonly actionPolicyPath: string
  readonly controllerActionPolicyPath: string
  readonly agentActionPolicyPath: string
}

const opaque = (value: string, name: string): string => {
  if (!OPAQUE_ID.test(value)) throw new BrowseThreadError("invalid_input", `${name} must be an opaque identifier`)
  return value
}

const errorOf = (code: BrowseThreadErrorCode, message: string): BrowseThreadError =>
  new BrowseThreadError(code, message)

export const validateBrowseThreadBaseUrl = (value: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw errorOf("invalid_input", "The Tardigrade URL is outside its bounded range")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw errorOf("invalid_input", "The Tardigrade URL is invalid")
  }
  const hostname = parsed.hostname.toLowerCase()
  const loopback = hostname === "localhost" || hostname === "[::1]" || hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" || !loopback ||
    (parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search !== "" || parsed.hash !== ""
  ) {
    throw errorOf("invalid_input", "The Tardigrade URL must be a credential-free loopback HTTP(S) origin")
  }
  return parsed.origin
}

const safeBrowserError = (error: unknown): BrowseThreadError => {
  if (error instanceof BrowseThreadError) return error
  if (error instanceof AgentBrowserClientError && error.code === "cancelled") return errorOf("cancelled", "The browser run was cancelled")
  if (error instanceof AgentBrowserClientError) return new BrowseThreadError("browser_failed", `Agent-browser failed (${error.code})`, agentBrowserClientStopReason(error.code))
  if (error instanceof AgentBrowserAgentError && error.code === "cancelled") {
    return errorOf("cancelled", "The browser run was cancelled")
  }
  if (error instanceof AgentBrowserAgentError) return new BrowseThreadError("browser_failed", `Browser agent failed (${error.code})`, error.reason)
  return errorOf("browser_failed", "Agent-browser failed")
}

const requireActiveRun = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw errorOf("cancelled", "The browser run was cancelled")
}

const boundedTraceNdjsonByteLimit = (value: number | undefined): number => {
  if (value === undefined) return MAX_BROWSER_TRACE_NDJSON_BYTES
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BROWSER_TRACE_NDJSON_BYTES) {
    throw errorOf("invalid_input", "The browser trace NDJSON byte limit is invalid")
  }
  return value
}

const boundedNetworkExecutionTimeout = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_NETWORK_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_NETWORK_EXECUTION_TIMEOUT_MS) {
    throw errorOf("invalid_input", "The network execution timeout is invalid")
  }
  return value
}

const boundedTraceSinkOperationTimeout = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_TRACE_SINK_OPERATION_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TRACE_SINK_OPERATION_TIMEOUT_MS) {
    throw errorOf("invalid_input", "The canonical trace sink operation timeout is invalid")
  }
  return resolved
}

const boundedTrustedControllerOperationTimeout = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_TRUSTED_CONTROLLER_OPERATION_TIMEOUT_MS
  if (
    !Number.isSafeInteger(resolved) || resolved <= 0 ||
    resolved > MAX_TRUSTED_CONTROLLER_OPERATION_TIMEOUT_MS
  ) {
    throw errorOf("invalid_input", "The trusted controller operation timeout is invalid")
  }
  return resolved
}

const boundedPrivateCleanupTimeout = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_PRIVATE_CLEANUP_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_PRIVATE_CLEANUP_TIMEOUT_MS) {
    throw errorOf("invalid_input", "The private cleanup timeout is invalid")
  }
  return resolved
}

const boundedNdjsonDeliveryTimeout = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_NDJSON_DELIVERY_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_NDJSON_DELIVERY_TIMEOUT_MS) {
    throw errorOf("invalid_input", "The NDJSON delivery timeout is invalid")
  }
  return resolved
}

type BoundedOperationOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "failed" }
  | { readonly status: "timed_out" }

/**
 * Settles controller-owned operations without retaining their error or allowing
 * a late rejection to become unhandled. Callers decide whether timeout is
 * authoritative (canonical trace) or auxiliary (NDJSON delivery).
 */
const settleBoundedOperation = async <T>(
  operation: () => T | PromiseLike<T>,
  timeoutMs: number
): Promise<BoundedOperationOutcome<T>> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const work = Promise.resolve().then(operation).then(
    (value) => ({ status: "completed", value }) as const,
    () => ({ status: "failed" }) as const
  )
  const timeout = new Promise<BoundedOperationOutcome<T>>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout({ status: "timed_out" }), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

interface BrowserTraceLoadLimits {
  readonly rows?: number
  readonly bytes?: number
  readonly pages?: number
}

/**
 * Browse-specific pagination guard. Each page is validated and byte-counted
 * before it is retained, and the loop cannot request an unbounded number of
 * sparse pages from a hostile or corrupt control plane.
 */
export const drainBoundedBrowserTraceRows = async (
  readPage: (after: number, limit: number) => Promise<ReadonlyArray<EventRow>>,
  pageSize = 200,
  requested: BrowserTraceLoadLimits = {}
): Promise<ReadonlyArray<EventRow>> => {
  const bounded = (value: number | undefined, maximum: number, name: string): number => {
    const resolved = value ?? maximum
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
      throw new Error(`${name} is outside its hard bound`)
    }
    return resolved
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("browser trace page size is invalid")
  }
  const rowLimit = bounded(requested.rows, MAX_BROWSER_TRACE_LOAD_ROWS, "browser trace row limit")
  const byteLimit = bounded(requested.bytes, MAX_BROWSER_TRACE_LOAD_BYTES, "browser trace byte limit")
  const pageLimit = bounded(requested.pages, MAX_BROWSER_TRACE_LOAD_PAGES, "browser trace page limit")
  const rows: EventRow[] = []
  let after = 0
  let bytes = 0
  for (let pageCount = 0; pageCount < pageLimit; pageCount += 1) {
    const page = await readPage(after, pageSize)
    if (!Array.isArray(page) || page.length > pageSize) throw new Error("browser trace page is invalid")
    let encoded: string
    try { encoded = JSON.stringify(page) } catch { throw new Error("browser trace page is not JSON-safe") }
    bytes += Buffer.byteLength(encoded, "utf8")
    if (bytes > byteLimit || rows.length + page.length > rowLimit) {
      throw new Error("browser trace history exceeded its load bound")
    }
    if (page.length === 0) return Object.freeze(rows)
    for (const row of page) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= after) {
        throw new Error("browser trace event sequence did not advance")
      }
      rows.push(row)
      after = row.seq
    }
  }
  throw new Error("browser trace history exceeded its page bound")
}

const defaultTraceSink = (
  baseUrl: string,
  actor: string,
  thread: string,
  token: string | undefined
): BrowserTraceSink => {
  const client = makeActorClient({
    baseUrl,
    ...(token === undefined || token.trim().length === 0 ? {} : { token: token.trim() })
  })
  return {
    ensure: async () => { await client.ensureActor(actor) },
    load: async () => {
      try {
        const rows = await drainBoundedBrowserTraceRows(
          (after, limit) => client.events(actor, thread, { after, limit }),
          200
        )
        return rows.map((row) => row.event)
      } catch (error) {
        if (error instanceof ProblemError && error.status === 404) return []
        throw error
      }
    },
    append: async (event) => { await client.append(actor, thread, event) }
  }
}

class SerializedTracePublisher {
  private evidenceBytes = 0
  private evidenceEvents = 0
  private evidenceClosed = false
  readonly threadId: string
  private nextReservedSequence: number
  private nextEnqueuedSequence: number
  private callOrdinal: number
  private readonly callIds: Set<string>
  private readonly sink: BrowserTraceSink
  private readonly onNdjson: BrowseThreadOptions["onNdjson"]
  private readonly ndjsonByteLimit: number
  private readonly traceSinkOperationTimeoutMs: number
  private readonly ndjsonDeliveryTimeoutMs: number
  private eventCount: number
  private ndjsonBytes: number
  private canonicalTail: Promise<void> = Promise.resolve()
  private deliveryTail: Promise<void> = Promise.resolve()
  private failure: BrowseThreadError | undefined
  private ndjsonHealthy = true

  constructor(
    threadId: string,
    firstSequence: number,
    existingCallIds: ReadonlyArray<string>,
    existingEventCount: number,
    existingNdjsonBytes: number,
    ndjsonByteLimit: number,
    traceSinkOperationTimeoutMs: number,
    ndjsonDeliveryTimeoutMs: number,
    sink: BrowserTraceSink,
    onNdjson?: BrowseThreadOptions["onNdjson"]
  ) {
    this.threadId = threadId
    this.nextReservedSequence = firstSequence
    this.nextEnqueuedSequence = firstSequence
    this.callOrdinal = existingCallIds.length
    this.callIds = new Set(existingCallIds)
    this.eventCount = existingEventCount
    this.ndjsonBytes = existingNdjsonBytes
    this.ndjsonByteLimit = ndjsonByteLimit
    this.traceSinkOperationTimeoutMs = traceSinkOperationTimeoutMs
    this.ndjsonDeliveryTimeoutMs = ndjsonDeliveryTimeoutMs
    this.sink = sink
    this.onNdjson = onNdjson
  }

  nextSequence = (): number => this.nextReservedSequence++

  nextCallId = (): string => {
    if (this.callIds.size >= MAX_BROWSER_TRACE_CALLS) {
      this.failure ??= errorOf("trace_append_failed", "The browser trace call limit was exceeded")
      throw this.failure
    }
    while (true) {
      this.callOrdinal += 1
      const candidate = `call-${String(this.callOrdinal).padStart(6, "0")}`
      if (!this.callIds.has(candidate)) {
        this.callIds.add(candidate)
        return candidate
      }
    }
  }

  get ndjsonDeliveryComplete(): boolean {
    return this.ndjsonHealthy
  }

  closeEvidence(): void { this.evidenceClosed = true }

  // Same serialized writer as browser calls, but HAR/draft facts do not enter
  // the browser-only NDJSON protocol or consume its sequence numbers.
  appendEvidence = async (event: Event): Promise<void> => {
    if (this.evidenceClosed || this.failure) throw this.failure ?? errorOf("trace_append_failed", "Evidence ingress is closed")
    this.evidenceBytes += Buffer.byteLength(JSON.stringify(event), "utf8")
    this.evidenceEvents += 1
    if (this.evidenceBytes > MAX_BROWSER_TRACE_LOAD_BYTES / 2 || this.evidenceEvents > MAX_BROWSER_TRACE_LOAD_ROWS / 2) {
      this.failure = errorOf("trace_append_failed", "The structural network evidence exceeded its storage bound")
      throw this.failure
    }
    const canonical = this.canonicalTail = this.canonicalTail.then(async () => {
      if (this.evidenceClosed || this.failure) throw this.failure ?? errorOf("trace_append_failed", "Evidence ingress is closed")
      const appended = await settleBoundedOperation(() => this.sink.append(event), this.traceSinkOperationTimeoutMs)
      if (appended.status !== "completed") {
        this.failure = errorOf("trace_append_failed", "Structural evidence publication failed or timed out")
        throw this.failure
      }
    })
    await canonical
  }

  publish = (event: BrowserTraceEvent): void => {
    if (this.failure !== undefined) throw this.failure
    if (event.threadId !== this.threadId || event.sequence !== this.nextEnqueuedSequence) {
      this.failure ??= errorOf("trace_append_failed", "Browser trace publication order was invalid")
      throw this.failure
    }
    let line: string
    try {
      line = browserTraceNdjsonLineOf(event)
    } catch {
      this.failure ??= errorOf("trace_append_failed", "Browser trace publication was invalid")
      throw this.failure
    }
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8")
    if (this.eventCount >= MAX_BROWSER_TRACE_EVENTS) {
      this.failure ??= errorOf("trace_append_failed", "The browser trace event limit was exceeded")
      throw this.failure
    }
    if (lineBytes > this.ndjsonByteLimit - this.ndjsonBytes) {
      this.failure ??= errorOf("trace_append_failed", "The browser trace NDJSON byte limit was exceeded")
      throw this.failure
    }
    this.nextEnqueuedSequence += 1
    this.eventCount += 1
    this.ndjsonBytes += lineBytes
    const canonical = this.canonicalTail = this.canonicalTail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      const appended = await settleBoundedOperation(
        () => this.sink.append(event),
        this.traceSinkOperationTimeoutMs
      )
      if (appended.status !== "completed") {
        this.failure ??= errorOf("trace_append_failed", "Browser trace publication failed or timed out")
        throw this.failure
      }
    })
    // A later flush observes this rejection; keep the internal chain handled.
    void canonical.catch(() => {})
    this.deliveryTail = this.deliveryTail.then(async () => {
      try { await canonical } catch { return }
      if (this.failure !== undefined || this.onNdjson === undefined || !this.ndjsonHealthy) return
      const delivered = await settleBoundedOperation(
        () => this.onNdjson!(line),
        this.ndjsonDeliveryTimeoutMs
      )
      if (delivered.status !== "completed") {
        // NDJSON is an auxiliary delivery sink. Once the canonical append
        // succeeds it must not retroactively poison durable trace evidence.
        this.ndjsonHealthy = false
      }
    })
    void this.deliveryTail.catch(() => {})
  }

  async flush(): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    const canonical = await settleBoundedOperation(
      () => this.canonicalTail,
      this.traceSinkOperationTimeoutMs
    )
    if (canonical.status !== "completed") {
      this.failure ??= errorOf("trace_append_failed", "Browser trace flush failed or timed out")
    }
    if (this.failure !== undefined) throw this.failure
    if (this.nextReservedSequence !== this.nextEnqueuedSequence) {
      this.failure = errorOf("trace_append_failed", "A browser trace sequence was reserved but not published")
      throw this.failure
    }
    if (this.onNdjson !== undefined && this.ndjsonHealthy) {
      const delivered = await settleBoundedOperation(
        () => this.deliveryTail,
        this.ndjsonDeliveryTimeoutMs
      )
      if (delivered.status !== "completed") this.ndjsonHealthy = false
    }
  }
}

const createPrivateFile = async (path: string, contents?: string): Promise<void> => {
  const handle = await openFile(path, "wx", 0o600)
  try {
    if (contents !== undefined) await handle.writeFile(contents, { encoding: "utf8" })
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

const replacePrivatePolicy = async (files: PrivateRunFiles, contents: string): Promise<void> => {
  const replacementPath = join(files.directory, `.action-policy-${crypto.randomUUID()}.next`)
  try {
    await createPrivateFile(replacementPath, contents)
    // Same-directory rename keeps the active path continuously bound to one
    // complete mode-0600 file; the v0.36 daemon reloads this path per action.
    await rename(replacementPath, files.actionPolicyPath)
  } catch (error) {
    try { await rm(replacementPath, { force: true }) } catch {}
    throw error
  }
}

const createPrivateRunFiles = async (root: string, browserConfig: Readonly<{ executablePath?: string }>): Promise<PrivateRunFiles> => {
  if (!isAbsolute(root)) throw errorOf("invalid_input", "The temporary root must be absolute")
  const directory = await mkdtemp(join(root, "unbrowse-agent-browser-"))
  try {
    await chmod(directory, 0o700)
    const socketDirectory = join(directory, "sockets")
    await mkdir(socketDirectory, { mode: 0o700 })
    await chmod(socketDirectory, 0o700)
    const browserTemporaryDirectory = join(directory, "browser-temp")
    await mkdir(browserTemporaryDirectory, { mode: 0o700 })
    await chmod(browserTemporaryDirectory, 0o700)
    const configPath = join(directory, "config.json")
    const actionPolicyPath = join(directory, "action-policy.json")
    const controllerActionPolicyPath = join(directory, "controller-action-policy.json")
    const agentActionPolicyPath = join(directory, "agent-action-policy.json")
    await createPrivateFile(configPath, `${JSON.stringify(browserConfig)}\n`)
    await createPrivateFile(controllerActionPolicyPath, CONTROLLER_ACTION_POLICY_JSON)
    await createPrivateFile(agentActionPolicyPath, AGENT_ACTION_POLICY_JSON)
    await createPrivateFile(actionPolicyPath, CONTROLLER_ACTION_POLICY_JSON)
    return {
      directory,
      socketDirectory,
      browserTemporaryDirectory,
      configPath,
      actionPolicyPath,
      controllerActionPolicyPath,
      agentActionPolicyPath
    }
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {
      throw errorOf("cleanup_failed", "The private browser run directory could not be removed")
    }
    throw error
  }
}

const mapCatalogFallback = (reason: NetworkToolShortCircuitFallbackReason): BrowserNetworkReuseReason => {
  switch (reason) {
    case "no_exact_match": return "no_candidate"
    case "tool_unapproved":
    case "tool_unverified": return "candidate_unapproved"
    case "input_contract_mismatch": return "input_shape_mismatch"
    case "session_requirement_missing": return "session_unavailable"
    case "verification_failed": return "candidate_failed"
    case "invalid_catalog":
    case "invalid_request":
    case "tool_digest_mismatch":
    case "ambiguous_match": return "policy_denied"
  }
}

const networkAttemptKeyOf = (
  threadId: string,
  toolDigest: Sha256Digest,
  executionAttemptId: string,
  invocation: NetworkToolInvocationRequest
): string => `network-attempt-${sha256(canonicalStringify({
  schemaVersion: 1,
  threadId,
  toolDigest,
  executionAttemptId,
  invocation
}))}`

type NetworkExecutionRace =
  | { readonly status: "completed"; readonly execution: NetworkToolExecutionResult }
  | { readonly status: "failed" }
  | { readonly status: "timed_out" }

const executeBoundedNetworkTool = async (
  options: BrowseThreadOptions,
  publisher: SerializedTracePublisher,
  tool: NetworkToolDefinition,
  toolDigest: Sha256Digest,
  invocation: NetworkToolInvocationRequest
): Promise<NetworkToolExecutionResult> => {
  const executor = options.networkExecutor
  if (executor === undefined) throw errorOf("network_execution_failed", "The approved network tool executor was unavailable")
  const executionAttemptId = options.networkExecutionAttemptId
  if (executionAttemptId === undefined) {
    throw errorOf("invalid_input", "An opaque network execution attempt ID is required")
  }
  const timeoutMs = boundedNetworkExecutionTimeout(options.networkExecutionTimeoutMs)
  const deadlineAtMs = Date.now() + timeoutMs
  const attemptKey = networkAttemptKeyOf(publisher.threadId, toolDigest, executionAttemptId, invocation)
  const abortController = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const completion: Promise<NetworkExecutionRace> = Promise.resolve()
    .then(() => executor({
      tool,
      invocation,
      executionAttemptId,
      attemptKey,
      idempotencyKey: attemptKey,
      deadlineAtMs,
      signal: abortController.signal
    }))
    .then(
      (execution) => ({ status: "completed", execution }) as const,
      () => ({ status: "failed" }) as const
    )
  const timeout = new Promise<NetworkExecutionRace>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout({ status: "timed_out" }), timeoutMs)
  })
  const outcome = await Promise.race([completion, timeout])
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  if (outcome.status !== "completed") {
    abortController.abort()
    throw errorOf("network_execution_failed", "The approved network tool executor failed")
  }
  return outcome.execution
}

const tryNetworkShortCircuit = async (
  options: BrowseThreadOptions,
  existingLog: ReadonlyArray<Event>,
  publisher: SerializedTracePublisher,
  trustedControllerOperationTimeoutMs: number
): Promise<BrowseThreadResult | undefined> => {
  const invocation = options.networkInvocation
  if (invocation === undefined) return undefined
  const callId = publisher.nextCallId()
  publisher.publish(browserToolCallEventOf({
    threadId: publisher.threadId,
    sequence: publisher.nextSequence(),
    callId,
    action: "other",
    params: { action: "network_tool" }
  }))

  let catalog: NetworkToolCatalog
  try {
    let loaded = options.approvedCatalog
    const loadApprovedCatalog = options.loadApprovedCatalog
    if (loaded === undefined && loadApprovedCatalog !== undefined) {
      const outcome = await settleBoundedOperation(
        () => loadApprovedCatalog(existingLog),
        trustedControllerOperationTimeoutMs
      )
      if (outcome.status !== "completed") throw new Error("catalog loader unavailable")
      loaded = outcome.value
    }
    catalog = loaded ?? createNetworkToolCatalog([])
  } catch {
    publisher.publish(browserNetworkToolReuseEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      decision: "browser_fallback",
      reason: "policy_denied"
    }))
    publisher.publish(browserToolResultEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      action: "other",
      success: false
    }))
    await publisher.flush()
    return undefined
  }

  const decision = decideNetworkToolShortCircuit(catalog, invocation)
  if (decision.decision === "browser_fallback" || options.networkExecutor === undefined) {
    publisher.publish(browserNetworkToolReuseEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      decision: "browser_fallback",
      reason: decision.decision === "browser_fallback" ? mapCatalogFallback(decision.reason) : "policy_denied"
    }))
    publisher.publish(browserToolResultEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      action: "other",
      success: false
    }))
    await publisher.flush()
    return undefined
  }

  const binding = {
    toolId: decision.tool.toolId,
    toolDigest: decision.toolDigest,
    sourceTraceDigest: decision.tool.sourceTraceDigest,
    sourceArtifactDigest: decision.tool.sourceArtifactDigest
  }
  publisher.publish(browserNetworkToolReuseEventOf({
    threadId: publisher.threadId,
    sequence: publisher.nextSequence(),
    callId,
    decision: "network_tool",
    reason: "approved_exact_match",
    binding
  }))
  let execution: NetworkToolExecutionResult
  try {
    execution = await executeBoundedNetworkTool(
      options,
      publisher,
      decision.tool,
      decision.toolDigest,
      decision.invocation
    )
  } catch {
    publisher.publish(browserToolResultEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      action: "other",
      success: false
    }))
    await publisher.flush()
    throw errorOf("network_execution_failed", "The approved network tool executor failed")
  }
  const executionRecord = typeof execution === "object" && execution !== null
    ? execution as unknown as Record<string, unknown>
    : undefined
  const suppliedResultShape = executionRecord?.resultShape
  const resultShape = suppliedResultShape === undefined
    ? undefined
    : decodeBrowserToolResultShape(suppliedResultShape)
  if (
    executionRecord === undefined || typeof executionRecord.success !== "boolean" ||
    // Reject the legacy arbitrary-result surface without traversing it.
    Object.hasOwn(executionRecord, "result") ||
    (suppliedResultShape !== undefined && resultShape === undefined)
  ) {
    publisher.publish(browserToolResultEventOf({
      threadId: publisher.threadId,
      sequence: publisher.nextSequence(),
      callId,
      action: "other",
      success: false
    }))
    await publisher.flush()
    throw errorOf("network_execution_failed", "The approved network tool executor returned an invalid result")
  }
  publisher.publish(browserToolResultEventOf({
    threadId: publisher.threadId,
    sequence: publisher.nextSequence(),
    callId,
    action: "other",
    success: executionRecord.success,
    ...(resultShape === undefined ? {} : { resultShape })
  }))
  await publisher.flush()
  requireActiveRun(options.signal)
  return {
    mode: "network_tool",
    success: executionRecord.success,
    traceThreadId: publisher.threadId,
    toolDigest: decision.toolDigest,
    ndjsonDeliveryComplete: publisher.ndjsonDeliveryComplete
  }
}

const agentBrowserClientOptions = (
  options: BrowseThreadOptions,
  files: PrivateRunFiles,
  allowedDomains: ReadonlyArray<string>,
  session: string,
  namespace: string,
  publisher: SerializedTracePublisher,
  backend: BrowserBackend
): AgentBrowserClientOptions => ({
  isolation: {
    configPath: files.configPath,
    actionPolicyPath: files.actionPolicyPath,
    socketDirectory: files.socketDirectory,
    temporaryDirectory: files.browserTemporaryDirectory,
    session,
    namespace,
    allowedDomains,
    idleTimeoutMs: 300_000
  },
  trace: {
    threadId: publisher.threadId,
    nextSequence: publisher.nextSequence,
    nextCallId: publisher.nextCallId,
    publish: publisher.publish
  },
  ...(options.agentBrowser?.executablePath === undefined ? {} : { executablePath: options.agentBrowser.executablePath }),
  ...(options.agentBrowser?.nodeExecutable === undefined ? {} : { nodeExecutable: options.agentBrowser.nodeExecutable }),
  ...(options.agentBrowser?.env === undefined ? {} : { env: options.agentBrowser.env }),
  ...(options.agentBrowser?.spawn === undefined ? {} : { spawn: options.agentBrowser.spawn }),
  ...(options.agentBrowser?.webSocketFactory === undefined ? {} : { webSocketFactory: options.agentBrowser.webSocketFactory }),
  ...(options.agentBrowser?.now === undefined ? {} : { now: options.agentBrowser.now }),
  ...(options.agentBrowser?.controlTimeoutMs !== undefined
    ? { controlTimeoutMs: options.agentBrowser.controlTimeoutMs }
    : backend === "cloakbrowser" ? { controlTimeoutMs: 30_000 } : {}),
  ...(options.agentBrowser?.killGraceMs === undefined ? {} : { killGraceMs: options.agentBrowser.killGraceMs }),
  ...(options.agentBrowser?.stdoutLimitBytes === undefined ? {} : { stdoutLimitBytes: options.agentBrowser.stdoutLimitBytes }),
  ...(options.agentBrowser?.stderrLimitBytes === undefined ? {} : { stderrLimitBytes: options.agentBrowser.stderrLimitBytes })
})

export const browseThread = async (options: BrowseThreadOptions): Promise<BrowseThreadResult> => {
  const taskStartedAt = options.taskStartedAt ?? Date.now()
  requireActiveRun(options.signal)
  try { validateAgentBrowserAgentPrompt(options.prompt) } catch {
    throw errorOf("invalid_input", "The browser-agent prompt is invalid")
  }
  const threadId = opaque(options.threadId, "trace thread")
  if (["captureId", "captureThread", "harImporter", "beforePrivateHarRead"].some((key) => Object.hasOwn(options, key))) {
    throw errorOf("invalid_input", "Browser HAR-file options were removed; passive network evidence uses the run's trace sink")
  }
  const actor = opaque(options.actor ?? DEFAULT_ACTOR, "actor")
  // Validate before either control-plane client can receive a bearer token.
  const baseUrl = validateBrowseThreadBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  const allowedDomains = normalizeAgentBrowserAllowedDomains(options.allowedDomains)
  const targetUrl = validateAgentBrowserTarget(options.targetUrl, allowedDomains)
  const targetOrigin = new URL(targetUrl).origin
  const gatewayApiKey = options.browserAgent?.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? ""
  const gatewayUrl = options.browserAgent?.gatewayUrl ?? process.env.AI_GATEWAY_URL
  const gatewayModel = options.model ?? process.env.AI_GATEWAY_MODEL
  const validateGatewayConfiguration = (): void => {
    try {
      validateAgentBrowserAgentConfiguration({
        prompt: options.prompt,
        allowedDomains,
        apiKey: gatewayApiKey,
        ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
        ...(gatewayModel === undefined ? {} : { model: gatewayModel }),
        ...(options.browserAgent?.limits === undefined ? {} : { limits: options.browserAgent.limits })
      })
    } catch (error) {
      throw safeBrowserError(error)
    }
  }
  const traceNdjsonByteLimit = boundedTraceNdjsonByteLimit(options.traceNdjsonByteLimit)
  const traceSinkOperationTimeoutMs = boundedTraceSinkOperationTimeout(options.traceSinkOperationTimeoutMs)
  const trustedControllerOperationTimeoutMs = boundedTrustedControllerOperationTimeout(
    options.trustedControllerOperationTimeoutMs
  )
  const privateCleanupTimeoutMs = boundedPrivateCleanupTimeout(options.privateCleanupTimeoutMs)
  const ndjsonDeliveryTimeoutMs = boundedNdjsonDeliveryTimeout(options.ndjsonDeliveryTimeoutMs)
  if (options.networkExecutionTimeoutMs !== undefined) {
    boundedNetworkExecutionTimeout(options.networkExecutionTimeoutMs)
  }
  if (options.approvedCatalog !== undefined && options.loadApprovedCatalog !== undefined) {
    throw errorOf("invalid_input", "Choose one approved network-tool catalog source")
  }
  if (options.networkExecutor !== undefined) {
    if (options.networkInvocation === undefined || options.networkExecutionAttemptId === undefined) {
      throw errorOf("invalid_input", "A network executor requires an invocation and opaque execution attempt ID")
    }
    opaque(options.networkExecutionAttemptId, "network execution attempt ID")
  } else if (options.networkExecutionAttemptId !== undefined) {
    throw errorOf("invalid_input", "A network execution attempt ID requires an executor")
  }
  const mayUseApprovedNetworkTool = options.networkInvocation !== undefined &&
    (options.approvedCatalog !== undefined || options.loadApprovedCatalog !== undefined)
  if (!mayUseApprovedNetworkTool) validateGatewayConfiguration()

  const sink = options.traceSink ?? defaultTraceSink(baseUrl, actor, threadId, options.token)
  const ensured = await settleBoundedOperation(() => sink.ensure(), traceSinkOperationTimeoutMs)
  if (ensured.status !== "completed") {
    throw errorOf("trace_append_failed", "The browser trace actor was unavailable or timed out")
  }
  requireActiveRun(options.signal)
  let existingLog: ReadonlyArray<Event>
  const loaded = await settleBoundedOperation(() => sink.load(), traceSinkOperationTimeoutMs)
  if (loaded.status !== "completed") {
    throw errorOf("trace_append_failed", "The browser trace could not be loaded before its deadline")
  }
  requireActiveRun(options.signal)
  existingLog = loaded.value
  const projection = browserTraceProjectionOf(existingLog, threadId)
  if (projection.status === "invalid") throw errorOf("trace_invalid", "The existing browser trace is invalid")
  const existingNdjsonBytes = projection.events.reduce(
    (total, event) => total + Buffer.byteLength(`${browserTraceNdjsonLineOf(event)}\n`, "utf8"),
    0
  )
  const publisher = new SerializedTracePublisher(
    threadId,
    projection.nextSequence,
    projection.calls.map((call) => call.callId),
    projection.eventCount,
    existingNdjsonBytes,
    traceNdjsonByteLimit,
    traceSinkOperationTimeoutMs,
    ndjsonDeliveryTimeoutMs,
    sink,
    options.onNdjson
  )

  const shortCircuit = await tryNetworkShortCircuit(
    options,
    existingLog,
    publisher,
    trustedControllerOperationTimeoutMs
  )
  requireActiveRun(options.signal)
  if (shortCircuit !== undefined) return shortCircuit
  if (mayUseApprovedNetworkTool) validateGatewayConfiguration()

  // Keep the private names short enough for Linux's 108-byte Unix socket path
  // limit after agent-browser adds its own namespace/session suffixes.
  // The socket directory is already unique per run. Keep only a short label:
  // v0.36 includes both names in its Unix socket filename, whose full path is
  // capped at 103 bytes on Linux.
  const runSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
  const session = `b${runSuffix}`
  const namespace = `t${runSuffix}`
  const runCallId = publisher.nextCallId()
  publisher.publish(browserToolCallEventOf({
    threadId,
    sequence: publisher.nextSequence(),
    callId: runCallId,
    action: "other",
    params: { action: "browser_run" }
  }))
  await publisher.flush()
  let files: PrivateRunFiles | undefined
  let client: AgentBrowserClient | undefined
  let runError: BrowseThreadError | undefined
  let preparedToolCount = 0
  let compileFallbackCount = 0
  const existingRequestEvidence = new Set(projection.calls.flatMap((call) =>
    call.network.map((dependency) => dependency.requestEvidenceId)))
  const existingPrepared = new Map(projection.preparedTools.map((tool) => [tool.toolId, tool.toolDigest]))
  const dependencyCounts = new Map(projection.calls.map((call) => [call.callId, call.network.length]))
  const publishAssociations = (preparation: TrustedHarImportPreparation, associations: ReadonlyArray<HarAssociation>): ReadonlyArray<HarAssociation> => {
    const published: HarAssociation[] = []
    for (const association of associations) {
      const evidenceId = browserRequestEvidenceIdOf({ captureId: preparation.preview.captureId,
        importDigest: preparation.preview.importDigest, requestId: association.entry.id })
      if (existingRequestEvidence.has(evidenceId)) { published.push(association); continue }
      const count = dependencyCounts.get(association.callId) ?? 0
      if (count >= MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL) continue
      publisher.publish(browserNetworkDependencyEventOf({ threadId, sequence: publisher.nextSequence(),
        callId: association.callId, captureId: preparation.preview.captureId,
        importDigest: preparation.preview.importDigest, requestId: association.entry.id,
        relation: "command_triggered_request", evidence: "bounded_time_window" }))
      existingRequestEvidence.add(evidenceId)
      dependencyCounts.set(association.callId, count + 1)
      published.push(association)
    }
    return published
  }
  const publishPrepared = (tool: CompiledNetworkTool): boolean => {
    const prior = existingPrepared.get(tool.definition.toolId)
    if (prior === tool.digest) return true
    if (prior !== undefined) throw errorOf("trace_invalid", "A prepared network tool ID already has another digest")
    if (existingPrepared.size >= MAX_BROWSER_PREPARED_TOOLS) return false
    // Validate the stricter browser-ledger resource contract BEFORE reserving
    // a sequence. An oversized draft must not leave a hole in the trace.
    try { browserNetworkToolPreparedEventOf({ threadId, sequence: 0, tool }) } catch { return false }
    publisher.publish(browserNetworkToolPreparedEventOf({ threadId, sequence: publisher.nextSequence(), tool }))
    existingPrepared.set(tool.definition.toolId, tool.digest)
    preparedToolCount += 1
    return true
  }
  let browserResult: Omit<Extract<BrowseThreadResult, { readonly mode: "browser" }>, "ndjsonDeliveryComplete"> | undefined
  try {
    const backend = browserBackendOf(options.browserBackend ?? process.env.BROWSE_HARNESS_BROWSER)
    let launchConfig: Readonly<{ executablePath?: string }>
    try { launchConfig = await browserLaunchConfig(backend) } catch {
      throw new BrowseThreadError("browser_failed", "The selected browser backend is missing or failed integrity verification; run bun run cloakbrowser:verify on the host", "browser_unavailable")
    }
    requireActiveRun(options.signal)
    files = await createPrivateRunFiles(options.tempRoot ?? tmpdir(), launchConfig)
    client = new AgentBrowserClient(agentBrowserClientOptions(
      options,
      files,
      allowedDomains,
      session,
      namespace,
      publisher,
      backend
    ))
    const browserClient = client
    let primaryError: BrowseThreadError | undefined
    let finalNetworkEntries: ReadonlyArray<NetworkEntry> | undefined
    let finalNetworkSequence = 0
    let agentToolCallCount = 0
    const eventStore: BrowserTraceSink = { ensure: () => sink.ensure(), load: async () => {
      await publisher.flush()
      const read = await settleBoundedOperation(() => sink.load(), traceSinkOperationTimeoutMs)
      if (read.status !== "completed") throw errorOf("trace_append_failed", "The shared run log could not be read")
      return read.value
    }, append: publisher.appendEvidence }
    let networkSequence = existingLog.filter((event) => event.type === "NetworkFactObserved").length
    if (networkSequence !== 0) throw errorOf("invalid_input", "A new isolated browser requires a fresh network trace thread")
    const observedFacts = new Map<string, string>()
    const network = new CdpNetworkListener(async (entry, index, complete) => {
      const single = prepareTrustedNetworkEntries([entry])
      const trace = { ...single.trace, entries: single.trace.entries.map((item) => ({ ...item,
        index, id: `req-${String(index + 1).padStart(4, "0")}` })) }
      const source = planHarImport(trace).events("live-network")
      for (const fact of source.filter((event) => event.type === "HarRequestObserved" || (complete && event.type === "HarResponseObserved"))) {
        const candidate = networkFactObservedEventOf(threadId, networkSequence, fact)
        const identity = `${fact.type}:${fact.requestId}`
        const content = canonicalStringify(candidate.fact)
        if (observedFacts.get(identity) === content) continue
        requireActiveRun(options.signal)
        await publisher.appendEvidence(candidate)
        networkSequence += 1
        observedFacts.set(identity, content)
      }
    }, options.agentBrowser?.networkSocketFactory, options.signal)
    const materializeNetwork = async (entries: ReadonlyArray<NetworkEntry>, watermark: number): Promise<{ preparation: TrustedHarImportPreparation; result: HarImportResult; pendingRequests: number }> => {
      requireActiveRun(options.signal)
      const completed = entries.flatMap((entry, index) => entry._observationComplete === true ? [{ entry, sourceId: `req-${String(index + 1).padStart(4, "0")}` }] : [])
      const sourceRequestIds = completed.map((item) => item.sourceId)
      const preparation = prepareTrustedNetworkEntries(completed.map((item) => item.entry))
      const plan = planHarImport(preparation.trace)
      const captureId = completed.length === entries.length ? preparation.preview.captureId
        : `net-${sha256(canonicalStringify({ digest: plan.importDigest, sourceRequestIds })).slice(0, 20)}`
      const events = plan.events(captureId)
      const log = await eventStore.load()
      requireActiveRun(options.signal)
      assertNetworkSnapshotBackedByLog(log.filter((event) => event.type !== "NetworkFactObserved" || Number(event.sequence) < watermark), threadId, events, sourceRequestIds, watermark)
      const matchesCheckpoint = (event: Event): boolean => networkGraphCheckpointOf(event) !== undefined &&
        event.threadId === threadId && event.captureId === captureId && event.importDigest === plan.importDigest &&
        event.sourceNetworkSequence === watermark && canonicalStringify(event.sourceRequestIds) === canonicalStringify(sourceRequestIds)
      if (!log.some(matchesCheckpoint)) await eventStore.append({ type: "NetworkGraphCheckpointPrepared", schemaVersion: 1, threadId, captureId,
        importDigest: plan.importDigest, sourceNetworkSequence: watermark, sourceRequestIds })
      if (validatedHarCaptureFactsOf(log, captureId).status !== "completed") {
        for (const event of events) { requireActiveRun(options.signal); await eventStore.append(event) }
      }
      const reloaded = await eventStore.load()
      const persisted = validatedHarCaptureFactsOf(reloaded, captureId)
      if (persisted.status !== "completed" || !reloaded.some(matchesCheckpoint)) throw errorOf("trace_invalid", "The network graph checkpoint was not confirmed")
      return { pendingRequests: entries.length - completed.length,
        preparation: { ...preparation, authorFacts: persisted.capture, preview: { ...preparation.preview, captureId, thread: threadId } },
        result: { captureId, thread: threadId, importDigest: plan.importDigest, attemptedEvents: events.length, dryRun: false } }
    }
    let browserRevision = 0
    let inspection: { revision: number; networkSequence: number; pendingRequests: number; preparation: TrustedHarImportPreparation; associations: ReadonlyArray<HarAssociation>;
      offered: Set<string>; reviewed: Map<string, CompiledNetworkTool> } | undefined
    const indexAction = async (request: BrowseHarnessIndexRequest, assertActive: () => void): Promise<unknown> => {
      assertActive()
      requireActiveRun(options.signal)
      network.assertHealthy()
      await network.flush()
      await publisher.flush()
      assertActive()
      requireActiveRun(options.signal)
      if (!browserClient.telemetryReady) throw new AgentBrowserAgentError("action_failed", "Indexing requires healthy connected telemetry", "telemetry_incomplete")
      const callId = publisher.nextCallId()
      publisher.publish(browserToolCallEventOf({ threadId, sequence: publisher.nextSequence(), callId,
        action: "other", params: { operation: request.tool } }))
      await publisher.flush()
      let result: Record<string, unknown> = { error: "index_failed" }
      let succeeded = false
      try {
        result = await performIndexAction(request, assertActive)
        assertActive()
        requireActiveRun(options.signal)
        if (!browserClient.telemetryReady) throw new AgentBrowserAgentError("action_failed", "Indexing lost browser telemetry", "telemetry_incomplete")
        succeeded = result.error === undefined
        return result
      } catch (error) {
        if (error instanceof AgentBrowserAgentError) throw error
        const safe = safeBrowserError(error)
        throw new AgentBrowserAgentError("action_failed", "The network indexing controller could not finish safely", safe.reason ?? "trace_failed")
      } finally {
        publisher.publish(browserToolResultEventOf({ threadId, sequence: publisher.nextSequence(), callId,
          action: "other", success: succeeded, data: result }))
        await publisher.flush()
      }
    }
    const performIndexAction = async (request: BrowseHarnessIndexRequest, assertActive: () => void): Promise<Record<string, unknown>> => {
      assertActive()
      if (request.tool === "harness_list_index") {
        try { return { status: "drafts_only", ...options.indexStore!.listIndexedNetworkTools({ siteId: new URL(targetOrigin).hostname, cursor: request.cursor }) } }
        catch { return { error: "index_store_unavailable", message: "The shared draft index could not be read; continue the browser task." } }
      }
      if (request.tool === "harness_inspect_network") {
        if (!inspection || inspection.revision !== browserRevision || inspection.networkSequence !== networkSequence) {
          assertActive()
          requireActiveRun(options.signal)
          let watermark = 0
          const snapshot = await network.snapshot(() => { watermark = networkSequence })
          const imported = await materializeNetwork(snapshot, watermark)
          requireActiveRun(options.signal)
          assertActive()
          const associations = publishAssociations(imported.preparation,
            inferBoundedHarAssociations(imported.preparation.trace.entries, browserClient.callWindows, targetOrigin))
          await publisher.flush()
          try { options.onDebug?.({ kind: "controller", text: `Network inspection · ${imported.preparation.trace.entries.length} captured requests in this run's playground log · ${associations.length} published timing links · implicit launch/reuse checks excluded · links remain low confidence` }) } catch { /* Optional display only. */ }
          inspection = { revision: browserRevision, networkSequence: watermark, pendingRequests: imported.pendingRequests,
            preparation: imported.preparation, associations,
            offered: new Set(), reviewed: new Map() }
        }
        const preparation = inspection.preparation
        // Page the complete bounded capture, not the author's first 64 records:
        // a useful request near the end of a long run must remain discoverable.
        const eligible = preparation.authorFacts.exchanges.filter((exchange) =>
          exchange.request.origin === targetOrigin && ["GET", "HEAD"].includes(exchange.request.method) && exchange.response.mimeType.includes("json")
        ).sort((left, right) => right.index - left.index)
        const selection = new Set(eligible.slice(request.cursor, request.cursor + 6).map((exchange) => exchange.requestId))
        const brief = harnessAuthorBriefOf(preparation.authorFacts, targetOrigin, [], 12, preparation.trace, selection)
        const page = searchHarnessAuthorGraph(brief, { cursor: 0, limit: 6, readInterfaceEligible: true })
        const items = (page.items as Array<{ id: string; index: number }>).sort((left, right) => right.index - left.index)
        for (const item of items) inspection.offered.add(item.id)
        const next = request.cursor + items.length
        return { threadId, captureId: preparation.preview.captureId, items, matched: eligible.length, order: "newest_first",
          ...(next < eligible.length ? { nextCursor: next } : {}), omittedRequests: brief.omittedRequests,
          pendingRequests: inspection.pendingRequests,
          message: "Observed structural evidence from this run's passive network log. Match a useful page result, review its DAG, then index the selected request. No capture file or rotation. Timing links remain low confidence." }
      }
      if (!inspection || inspection.revision !== browserRevision || inspection.networkSequence !== networkSequence || inspection.preparation.preview.captureId !== request.captureId) {
        return { error: "network_snapshot_stale", message: "Inspect network evidence again before reviewing or saving this result." }
      }
      if (!inspection.offered.has(request.requestId)) return { error: "request_not_offered", message: "Select an eligible request returned by network inspection." }
      if (request.tool === "harness_review_dag") {
        const preparation = inspection.preparation
        const draftLog = await eventStore.load()
        assertActive()
        requireActiveRun(options.signal)
        const draftEvent = observedReadDraftPreparedEventOf(draftLog, request.captureId, {
          requestId: request.requestId, interfaceId: `read-${request.requestId}`, valueProfile: preparation.valueProfile
        })
        await eventStore.append(draftEvent)
        await publisher.flush()
        const incoming = preparation.authorFacts.dependencies.filter((edge) => edge.to === request.requestId)
        const neighbors = new Set([request.requestId])
        for (const edge of incoming) {
          if (neighbors.size >= MAX_AUTHOR_REQUESTS) break
          neighbors.add(edge.from)
        }
        const brief = harnessAuthorBriefOf(preparation.authorFacts, targetOrigin, [], 12, preparation.trace, neighbors)
        const dag = navigateHarnessAuthorGraph(brief, { requestId: request.requestId, direction: "incoming", limit: 8 })
        const shownEdges = (dag.edges as ReadonlyArray<unknown>).length
        const compiled = compileObservedReadNetworkTools(preparation, targetOrigin, inspection.associations, new Set([request.requestId]))
        const tool = compiled.prepared[0]
        if (tool) inspection.reviewed.set(request.requestId, tool)
        return { threadId, captureId: request.captureId, requestId: request.requestId, draftRecorded: true,
          canIndex: tool !== undefined, blockers: compiled.fallbacks,
          request: inspectHarnessAuthorRequest(brief, request),
          dag: { ...dag, matched: incoming.length, omitted: incoming.length - shownEdges },
          ...(tool ? { steps: tool.definition.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn, method: step.method,
            pathParameters: step.pathParameters, query: step.query, headers: step.headers })),
            inputs: tool.definition.inputs } : {}) }
      }
      const tool = inspection.reviewed.get(request.requestId)
      if (!tool) return { error: "dag_review_required", message: "Review the request DAG first; only an evidence-complete read can be indexed." }
      if (!publishPrepared(tool)) return { error: "prepared_tool_limit", message: "The run's prepared-tool storage is full." }
      await publisher.flush()
      assertActive()
      requireActiveRun(options.signal)
      if (inspection.networkSequence !== networkSequence) return { error: "network_snapshot_stale", message: "New network evidence arrived; inspect and review the current DAG before saving." }
      try {
        const saved = options.indexStore!.indexNetworkTool({ tool, intent: request.intent, sourceThreadId: threadId })
        return { status: "indexed_draft", toolDigest: saved.tool.digest, toolId: saved.tool.definition.toolId,
          catalogPath: `/browse-harness/v1/index/${saved.tool.digest}`,
          intent: saved.intent, message: "Saved to the shared draft index. No approval, deployment or live execution was granted." }
      } catch { return { error: "index_store_unavailable", message: "Evidence was retained, but the shared bookmark was not confirmed. Do not claim it was saved." } }
    }
    try {
      let stream = await client.streamStatus()
      if (!stream.enabled) stream = await client.streamEnable()
      if (!stream.enabled || stream.port === null) throw new BrowseThreadError("browser_failed", "Agent-browser streaming was unavailable", "telemetry_incomplete")
      requireActiveRun(options.signal)
      await client.prepareViewport()
      requireActiveRun(options.signal)
      await client.connectTelemetry(stream.port)
      requireActiveRun(options.signal)
      await network.connect(await client.networkObservationEndpoint())
      await publisher.flush()
      requireActiveRun(options.signal)
      await client.open(targetUrl, options.browserAgent?.limits?.actionTimeMs ?? null, options.signal)
      await network.flush()
      await publisher.flush()
      if (backend === "cloakbrowser") {
        try { options.onDebug?.({ kind: "controller", text: CLOAK_BROWSER_VERIFIED_MESSAGE }) } catch { /* Optional display only. */ }
      }
      requireActiveRun(options.signal)
      await replacePrivatePolicy(files, AGENT_ACTION_POLICY_JSON)
      try {
        const agent = await runAgentBrowserAgent({
          initialUrl: targetUrl,
          prompt: options.prompt,
          taskStartedAt,
          allowedDomains,
          executor: {
            executeAgentAction: async (action, timeoutMs) => {
              // A model may receive an action result only after its matching
              // value-free trace events are durably appended, including failures.
              network.assertHealthy()
              try { return await browserClient.executeAgentAction(action, timeoutMs, options.signal) }
              finally { browserRevision += 1; await network.flush(); await publisher.flush() }
            }
          },
          apiKey: gatewayApiKey,
          ...(options.indexStore === undefined ? {} : { indexAction }),
          ...(options.onDebug === undefined ? {} : { onDebug: options.onDebug }),
          ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
          ...(gatewayModel === undefined ? {} : { model: gatewayModel }),
          ...(options.browserAgent?.fetch === undefined ? {} : { fetch: options.browserAgent.fetch }),
          ...(options.browserAgent?.limits === undefined ? {} : { limits: options.browserAgent.limits }),
          ...(options.browserAgent?.now === undefined ? {} : { now: options.browserAgent.now }),
          ...(options.signal === undefined ? {} : { signal: options.signal })
        })
        requireActiveRun(options.signal)
        agentToolCallCount = agent.toolCallCount
        try { options.onDebug?.({ kind: "controller", text: "Browser agent finished. Finalizing captured network evidence and isolated-browser cleanup; the run is not complete yet." }) } catch { /* Optional display only. */ }
      } finally {
        // Gateway requests are aborted at the total deadline and each browser
        // subprocess is awaited through bounded termination, so no model action
        // can overlap restoration or trusted lifecycle cleanup.
        await replacePrivatePolicy(files, CONTROLLER_ACTION_POLICY_JSON)
      }
    } catch (error) {
      primaryError = safeBrowserError(error)
      // A rejected durable append can make the browser adapter report missing
      // telemetry as a secondary symptom. Retain the writer's original failure
      // before emitting the debug error, as well as in the terminal outcome.
      try { await publisher.flush() } catch (publicationError) {
        primaryError = publicationError instanceof BrowseThreadError ? publicationError
          : errorOf("trace_append_failed", "Browser trace publication failed")
      }
      try { options.onDebug?.({ kind: "error", text: `${primaryError.code}: ${primaryError.message}` }) } catch { /* Optional display only. */ }
    } finally {
      try { finalNetworkEntries = await network.stopAndSnapshot(() => { finalNetworkSequence = networkSequence }) } catch {
        primaryError ??= errorOf("browser_failed", "The passive network observer could not settle")
      }
      try { await network.close() } catch {
        primaryError ??= errorOf("browser_failed", "The passive network observer could not close")
      }
      client.disconnectTelemetry()
      try {
        await client.closeAll()
      } catch {
        primaryError = primaryError === undefined
          ? errorOf("cleanup_failed", "Agent-browser cleanup failed")
          : errorOf("cleanup_failed", "Agent-browser failed and cleanup also failed")
      }
      try { await publisher.flush() } catch (error) {
        primaryError = error instanceof BrowseThreadError ? error : errorOf("trace_append_failed", "Browser trace publication failed")
      }
    }

    // Browser shutdown is mandatory cleanup for an active command. Once it
    // has settled, a disconnected remote caller must not start graph or tool
    // compilation work that was not already in flight.
    requireActiveRun(options.signal)
    if (primaryError === undefined && !client.telemetryComplete) {
      primaryError = new BrowseThreadError("browser_failed", "Agent-browser telemetry was incomplete", "telemetry_incomplete")
    }
    // Retain valid observations even on a failed task. They grant no success,
    // preparation or replay authority. Cancellation above starts no new import.
    if (finalNetworkEntries === undefined) throw primaryError ?? errorOf("browser_failed", "No network observation was produced")
    requireActiveRun(options.signal)
    const imported = await materializeNetwork(finalNetworkEntries, finalNetworkSequence).catch((error) => { throw primaryError ?? error })
    requireActiveRun(options.signal)
    await publisher.flush()
    requireActiveRun(options.signal)
    try { options.onDebug?.({ kind: "controller", text: `Playground network log · ${imported.preparation.trace.entries.length} captured requests retained in ${threadId}${primaryError ? " · incomplete task; observation only" : ""}` }) } catch { /* Optional display only. */ }

    if (primaryError === undefined && client.telemetryComplete) {
      const associations = publishAssociations(imported.preparation,
        inferBoundedHarAssociations(imported.preparation.trace.entries, client.callWindows, targetOrigin))
      const compiled = compileObservedReadNetworkTools(imported.preparation, targetOrigin, associations)
      compileFallbackCount = compiled.fallbacks.length
      for (const tool of compiled.prepared) {
        if (!publishPrepared(tool)) compileFallbackCount += 1
      }
      await publisher.flush()
      requireActiveRun(options.signal)
    }

    if (primaryError !== undefined) throw primaryError
    browserResult = {
      mode: "browser",
      success: true,
      traceThreadId: threadId,
      agentToolCallCount,
      telemetryComplete: client.telemetryComplete,
      capture: {
        captureId: imported.result.captureId,
        thread: imported.result.thread,
        importDigest: imported.result.importDigest,
        attemptedEvents: imported.result.attemptedEvents,
        requestCount: finalNetworkEntries.length
      },
      preparedToolCount,
      compileFallbackCount
    }
  } catch (error) {
    runError = error instanceof BrowseThreadError ? error : safeBrowserError(error)
  }

  publisher.closeEvidence()

  let privateCleanupFailed = false
  if (files !== undefined) {
    const removedDirectory = await settleBoundedOperation(
      () => options.removeTemporaryDirectory === undefined
        ? rm(files.directory, { recursive: true, force: true })
        : options.removeTemporaryDirectory(files.directory),
      privateCleanupTimeoutMs
    )
    if (removedDirectory.status !== "completed") privateCleanupFailed = true
  }
  if (privateCleanupFailed) {
    runError = runError === undefined
      ? errorOf("cleanup_failed", "The private browser run directory could not be removed")
      : errorOf("cleanup_failed", "The browser run failed and private cleanup also failed")
  }
  if (runError === undefined) {
    try { requireActiveRun(options.signal) } catch (error) {
      runError = error instanceof BrowseThreadError ? error : errorOf("cancelled", "The browser run was cancelled")
    }
  }

  try {
    publisher.publish(browserToolResultEventOf({
      threadId,
      sequence: publisher.nextSequence(),
      callId: runCallId,
      action: "other",
      success: runError === undefined
    }))
    await publisher.flush()
  } catch (error) {
    if (runError === undefined) {
      runError = error instanceof BrowseThreadError
        ? error
        : errorOf("trace_append_failed", "The browser run outcome could not be published")
    }
  }

  if (runError !== undefined) throw runError
  if (browserResult === undefined) throw errorOf("browser_failed", "The browser run produced no result")
  return {
    ...browserResult,
    ndjsonDeliveryComplete: publisher.ndjsonDeliveryComplete
  }
}

interface CliOptions {
  readonly targetUrl: string
  readonly allowedDomains: ReadonlyArray<string>
  readonly threadId: string
  readonly baseUrl: string
  readonly actor: string
  readonly model?: string
}

const usage = `Usage:
  printf '%s' '<prompt>' | bun run browse:thread --target <url> --allow <host[,host]> [options]

Options:
  --target <url>       Credential-free HTTP(S) target
  --allow <hosts>      Explicit comma-separated host patterns; repeatable
  --thread <id>        Opaque trace thread ID (default: random)
  --url <url>          Tardigrade server (default: http://127.0.0.1:4242)
  --actor <name>       Tardigrade actor instance (default: main)
  --model <name>       AI Gateway model

The prompt is accepted only on stdin. Tokens are read only from the environment.`

const cliValue = (args: ReadonlyArray<string>, index: number, flag: string): string => {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

export const parseBrowseThreadArgs = (args: ReadonlyArray<string>): CliOptions => {
  let targetUrl: string | undefined
  const allowedDomains: string[] = []
  let threadId = `browse-${crypto.randomUUID().replaceAll("-", "")}`
  let baseUrl = DEFAULT_BASE_URL
  let actor = DEFAULT_ACTOR
  let model: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--help" || arg === "-h") throw new Error(usage)
    if (arg === "--target") { targetUrl = cliValue(args, index, arg); index += 1; continue }
    if (arg === "--allow") {
      allowedDomains.push(...cliValue(args, index, arg).split(",").filter((value) => value.length > 0))
      index += 1
      continue
    }
    if (arg === "--thread") { threadId = cliValue(args, index, arg); index += 1; continue }
    if (arg === "--url") { baseUrl = cliValue(args, index, arg); index += 1; continue }
    if (arg === "--actor") { actor = cliValue(args, index, arg); index += 1; continue }
    if (arg === "--model") { model = cliValue(args, index, arg); index += 1; continue }
    throw new Error(`Unknown option: ${arg}`)
  }
  if (targetUrl === undefined || allowedDomains.length === 0) throw new Error(usage)
  return {
    targetUrl,
    allowedDomains,
    threadId,
    baseUrl,
    actor,
    ...(model === undefined ? {} : { model })
  }
}

/** Incremental CLI ingress: raw stdin can never be materialized beyond the prompt cap. */
export const readBrowseThreadPrompt = async (
  stream: ReadableStream<Uint8Array>
): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_AGENT_BROWSER_PROMPT_BYTES) {
        void reader.cancel().catch(() => {})
        throw errorOf("invalid_input", "The browser-agent prompt is invalid")
      }
      chunks.push(item.value)
    }
  } catch (error) {
    if (error instanceof BrowseThreadError) throw error
    throw errorOf("invalid_input", "The browser-agent prompt could not be read")
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let prompt: string
  try { prompt = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch {
    throw errorOf("invalid_input", "The browser-agent prompt is not valid UTF-8")
  }
  try { return validateAgentBrowserAgentPrompt(prompt) } catch {
    throw errorOf("invalid_input", "The browser-agent prompt is invalid")
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(usage)
  } else {
    try {
      const parsed = parseBrowseThreadArgs(Bun.argv.slice(2))
      const prompt = await readBrowseThreadPrompt(Bun.stdin.stream())
      const result = await browseThread({
        ...parsed,
        prompt,
        onNdjson: (line) => { console.log(line) },
        ...(process.env.TARDIGRADE_TOKEN === undefined ? {} : { token: process.env.TARDIGRADE_TOKEN })
      })
      console.log(JSON.stringify({ type: "BrowseThreadCompleted", result }))
    } catch (error) {
      const safe = error instanceof BrowseThreadError ? `${error.code}: ${error.message}` : "browse-thread failed"
      console.error(safe)
      process.exitCode = 1
    }
  }
}
