import { randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { browserBackendOf, browserLaunchConfig, type BrowserBackend } from "./src/cloak-browser"
import { HarnessRegistry } from "./src/harness-registry"
import type { BrowserNetworkToolIndex } from "./src/network-tool-catalog"

import {
  runBrowserTask,
  BrowseThreadError,
  validateBrowseThreadBaseUrl,
  type BrowseThreadBrowserAgentOptions,
  type BrowseThreadResult
} from "./browser-harness"
import {
  AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS,
  DEFAULT_AGENT_BROWSER_AGENT_LIMITS,
  MAX_AGENT_BROWSER_REPORTED_TOKENS,
  MAX_AGENT_BROWSER_RUN_TIME_MS,
  AgentBrowserAgentError,
  selectBrowserTaskTarget,
  type AgentBrowserAgentLimits,
  validateAgentBrowserAgentPrompt
} from "./src/agent-browser-agent"
import {
  normalizeAgentBrowserAllowedDomains,
  isPublicAgentBrowserHost,
  validateAgentBrowserTarget,
  type AgentBrowserAgentToolDescriptor
} from "./src/agent-browser-client"
import {
  browserToolCategoryOf,
  decodeBrowserTraceEvent,
  type BrowserTraceEvent
} from "./src/browser-trace"
import {
  BROWSE_HARNESS_SCHEMA_VERSION,
  BROWSE_HARNESS_INDEX_TOOLS,
  BROWSE_HARNESS_STOP_MESSAGES,
  MAX_BROWSE_HARNESS_LINE_BYTES,
  MAX_BROWSE_HARNESS_PROGRESS_EVENTS,
  MAX_BROWSE_HARNESS_STREAM_BYTES,
  MAX_BROWSE_HARNESS_DEBUG_EVENTS,
  BROWSE_HARNESS_CHECKPOINT_PREFIX,
  MAX_BROWSE_HARNESS_CHECKPOINT_CHARS,
  MAX_BROWSE_HARNESS_DEBUG_BYTES,
  browseHarnessDebugText,
  type BrowseHarnessDebugEntry,
  type BrowseHarnessCapabilities,
  type BrowseHarnessCapabilitiesEnvelope,
  type BrowseHarnessErrorCode,
  type BrowseHarnessStopReason,
  type BrowseHarnessFailure,
  type BrowseHarnessProgressEvent,
  type BrowseHarnessStreamEnvelope,
  type BrowseHarnessSuccess,
  type BrowseHarnessToolCategory,
  type BrowseHarnessToolDescriptor
} from "./src/browse-harness-contract"

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u
const TOKEN = /^[\x21-\x7e]{24,512}$/u
const BASIC_CREDENTIAL = /^[A-Za-z0-9+/]+={0,2}$/u
const MAX_BASIC_CREDENTIAL_BYTES = 1_024
const DEFAULT_PORT = 4_344
const DEFAULT_MAX_CONCURRENT_RUNS = 2
const MAX_CONCURRENT_RUNS = 8
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000
const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000
const DEFAULT_TARDIGRADE_URL = "http://127.0.0.1:4242"
const DEFAULT_ACTOR = "main"
const AGENT_BROWSER_VERSION = "0.36.0"
const MAX_STATIC_ASSET_BYTES = 4 * 1_024 * 1_024
const STATIC_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}-[A-Za-z0-9_-]{8,}\.(?:css|js|png|svg|webp|woff|woff2)$/u

/** Enough for a maximally escaped 64 KiB prompt plus the bounded target URL. */
export const MAX_BROWSE_HARNESS_REQUEST_BYTES = 512 * 1_024

const META = Object.freeze({ schemaVersion: BROWSE_HARNESS_SCHEMA_VERSION })

const STATIC_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
})

const API_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
})

export interface BrowseHarnessRunnerOptions {
  readonly taskStartedAt?: number
  readonly indexStore?: BrowserNetworkToolIndex
  readonly browserBackend?: BrowserBackend
  readonly browserAgent?: Pick<BrowseThreadBrowserAgentOptions, "apiKey" | "gatewayUrl" | "limits">
  readonly prompt: string
  readonly targetUrl: string
  readonly allowedDomains: ReadonlyArray<string>
  readonly threadId: string
  readonly baseUrl: string
  readonly actor: string
  readonly token?: string
  readonly model?: string
  readonly onNdjson: (line: string) => void | Promise<void>
  readonly onDebug?: (entry: BrowseHarnessDebugEntry) => void
  /** Client cancellation is controller input, never an agent-selected option. */
  readonly signal: AbortSignal
}

export type BrowseHarnessRunner = (options: BrowseHarnessRunnerOptions) => Promise<BrowseThreadResult>

export interface BrowseHarnessServerConfig {
  readonly browserBackend?: BrowserBackend
  readonly browserAgent?: Pick<BrowseThreadBrowserAgentOptions, "apiKey" | "gatewayUrl" | "limits">
  readonly token: string
  readonly allowedDomains: ReadonlyArray<string>
  readonly baseUrl: string
  readonly actor: string
  readonly model?: string
  readonly tardigradeToken?: string
  readonly publicOrigin?: string
  readonly maxConcurrentRuns: number
  readonly port: number
}

export interface BrowseHarnessControllerOptions {
  readonly config: BrowseHarnessServerConfig
  readonly runner?: BrowseHarnessRunner
  readonly randomId?: () => string
  readonly staticAssets?: BrowseHarnessStaticAssetLoader
  /** Trusted test/embedding seam; remote callers cannot select this deadline. */
  readonly requestBodyTimeoutMs?: number
  /** Shared trusted-controller storage; remote callers cannot choose the database. */
  readonly indexStore?: BrowserNetworkToolIndex
  /** Trusted starting-page proposal seam; the result is always policy-validated. */
  readonly targetSelector?: typeof selectBrowserTaskTarget
}

export type BrowseHarnessStaticAssetPath = "remote.html" | `assets/${string}`
export type BrowseHarnessStaticAssetLoader = (
  path: BrowseHarnessStaticAssetPath
) => Promise<Uint8Array | undefined>

const validStaticAssetPath = (path: string): path is BrowseHarnessStaticAssetPath =>
  path === "remote.html" || STATIC_ASSET.test(path)

/**
 * Read only the production Vite entrypoint and content-hashed asset names.
 * `realpath` confinement also rejects symlinks that leave the trusted dist root.
 */
export const browseHarnessFileAssetLoader = (
  root = resolve(import.meta.dir, "ui/dist")
): BrowseHarnessStaticAssetLoader => async (path) => {
  if (!validStaticAssetPath(path)) return undefined
  let canonicalRoot: string
  let canonicalFile: string
  try {
    canonicalRoot = await realpath(root)
    canonicalFile = await realpath(resolve(canonicalRoot, path))
  } catch { return undefined }
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) return undefined
  try {
    const details = await stat(canonicalFile)
    if (!details.isFile() || details.size < 1 || details.size > MAX_STATIC_ASSET_BYTES) return undefined
    const bytes = await readFile(canonicalFile)
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_STATIC_ASSET_BYTES) return undefined
    return bytes
  } catch { return undefined }
}

class BrowseHarnessProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: BrowseHarnessErrorCode,
    readonly safeMessage: string,
    readonly retryable = false
  ) {
    super(safeMessage)
    this.name = "BrowseHarnessProblem"
  }
}

const success = <T>(data: T): BrowseHarnessSuccess<T> => ({ ok: true, data, meta: META })

const failure = (
  code: BrowseHarnessErrorCode,
  message: string,
  retryable = false,
  reason?: BrowseHarnessStopReason
): BrowseHarnessFailure => ({ ok: false, error: { code, message, retryable,
  ...(reason === undefined ? {} : { reason }) }, meta: META })

const jsonResponse = (
  value: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>
): Response => Response.json(value, {
  status,
  headers: { ...API_HEADERS, ...headers }
})

const failureResponse = (problem: BrowseHarnessProblem, authenticate = false): Response => jsonResponse(
  failure(problem.code, problem.safeMessage, problem.retryable),
  problem.status,
  authenticate ? { "www-authenticate": "Basic realm=\"Browse Harness\", charset=\"UTF-8\"" } : undefined
)

const secureEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

const basicAuthorization = (encoded: string, token: string): boolean => {
  if (
    encoded.length === 0 || encoded.length > MAX_BASIC_CREDENTIAL_BYTES ||
    !BASIC_CREDENTIAL.test(encoded)
  ) return false
  let decoded: Buffer
  try { decoded = Buffer.from(encoded, "base64") } catch { return false }
  if (decoded.byteLength > MAX_BASIC_CREDENTIAL_BYTES) return false
  const canonical = decoded.toString("base64")
  if (canonical.replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) return false
  return secureEqual(decoded.toString("utf8"), `harness:${token}`)
}

export const browseHarnessAuthorized = (request: Request, token: string): boolean => {
  const value = request.headers.get("authorization")
  if (value === null || value.length > MAX_BASIC_CREDENTIAL_BYTES + 16) return false
  const space = value.indexOf(" ")
  if (space < 1 || value.indexOf(" ", space + 1) !== -1) return false
  const scheme = value.slice(0, space).toLowerCase()
  const credential = value.slice(space + 1)
  if (scheme === "bearer") return secureEqual(credential, token)
  if (scheme === "basic") return basicAuthorization(credential, token)
  return false
}

const validatedOrigin = (value: string): string | undefined => {
  if (value.length === 0 || value.length > 2_048 || value !== value.trim()) return undefined
  try {
    const url = new URL(value)
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" || url.password !== "" || url.origin !== value ||
      url.pathname !== "/" || url.search !== "" || url.hash !== ""
    ) return undefined
    return url.origin
  } catch { return undefined }
}

const assertBrowserOrigin = (request: Request, configuredOrigin?: string): void => {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new BrowseHarnessProblem(403, "forbidden", "Cross-site browser requests are not accepted.")
  }
  const supplied = request.headers.get("origin")
  if (supplied === null) return
  const expected = configuredOrigin ?? new URL(request.url).origin
  if (validatedOrigin(supplied) !== expected) {
    throw new BrowseHarnessProblem(403, "forbidden", "Cross-site browser requests are not accepted.")
  }
}

const boundedInteger = (raw: string | undefined, fallback: number, maximum: number, name: string): number => {
  const resolved = raw === undefined || raw.length === 0 ? fallback : Number(raw)
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} is outside its bounded range`)
  }
  return resolved
}

const publicOriginOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const origin = validatedOrigin(raw.trim())
  if (origin === undefined) throw new Error("BROWSE_HARNESS_PUBLIC_ORIGIN must be an HTTP(S) origin")
  const url = new URL(origin)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" || url.hostname === "::1"
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("BROWSE_HARNESS_PUBLIC_ORIGIN must use HTTPS unless it is loopback")
  }
  return origin
}

export const browseHarnessServerConfigOf = (
  env: Readonly<Record<string, string | undefined>>
): BrowseHarnessServerConfig => {
  const token = env.BROWSE_HARNESS_TOKEN?.trim() ?? ""
  // An unset BROWSE_HARNESS_TOKEN disables the site's password prompt entirely.
  if (token.length > 0 && !TOKEN.test(token)) throw new Error("BROWSE_HARNESS_TOKEN must contain 24 to 512 visible ASCII characters")
  const configuredDomains = env.BROWSE_HARNESS_ALLOWED_DOMAINS?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? []
  const allowedDomains = configuredDomains.length === 1 && configuredDomains[0] === "*"
    ? Object.freeze(["*"])
    : normalizeAgentBrowserAllowedDomains(configuredDomains)
  const baseUrl = validateBrowseThreadBaseUrl(
    env.BROWSE_HARNESS_TARDIGRADE_URL?.trim() || DEFAULT_TARDIGRADE_URL
  )
  const actor = env.BROWSE_HARNESS_ACTOR?.trim() || DEFAULT_ACTOR
  if (!OPAQUE_ID.test(actor)) throw new Error("BROWSE_HARNESS_ACTOR must be an opaque identifier")
  const provider = env.BROWSE_HARNESS_PROVIDER?.trim() || "ai-gateway"
  if (provider !== "ai-gateway" && provider !== "cerebras") {
    throw new Error("BROWSE_HARNESS_PROVIDER must be ai-gateway or cerebras")
  }
  const model = env.BROWSE_HARNESS_MODEL?.trim() || (provider === "cerebras" ? "qwen-3.8-27b" : undefined)
  let browserAgent: BrowseHarnessServerConfig["browserAgent"]
  if (provider === "cerebras") {
    const apiKey = env.CEREBRAS_API_KEY?.trim() ?? ""
    if (apiKey.length === 0 || apiKey.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
      throw new Error("CEREBRAS_API_KEY is required for the Cerebras browser harness")
    }
    browserAgent = Object.freeze({ apiKey, gatewayUrl: "https://api.cerebras.ai" })
  }
  const limits: { -readonly [K in keyof AgentBrowserAgentLimits]: AgentBrowserAgentLimits[K] } = {}
  if (env.BROWSE_HARNESS_REPORTED_TOKEN_LIMIT !== undefined) {
    limits.reportedTokens = boundedInteger(
      env.BROWSE_HARNESS_REPORTED_TOKEN_LIMIT, DEFAULT_AGENT_BROWSER_AGENT_LIMITS.reportedTokens, MAX_AGENT_BROWSER_REPORTED_TOKENS, "BROWSE_HARNESS_REPORTED_TOKEN_LIMIT"
    )
  }
  for (const [name, key] of [
    ["BROWSE_HARNESS_MODEL_CALL_LIMIT", "modelCalls"],
    ["BROWSE_HARNESS_TOOL_CALL_LIMIT", "toolCalls"],
    ["BROWSE_HARNESS_RUN_TIME_LIMIT_MS", "wallTimeMs"],
    ["BROWSE_HARNESS_ACTION_TIME_LIMIT_MS", "actionTimeMs"],
    ["BROWSE_HARNESS_RESPONSE_BYTE_LIMIT", "responseBytes"]
  ] as const) {
    if (env[name] === undefined) continue
    const raw = env[name]!.trim()
    limits[key] = raw === "" || raw === "none" ? null : boundedInteger(raw, 1,
      key === "wallTimeMs" || key === "actionTimeMs" ? MAX_AGENT_BROWSER_RUN_TIME_MS : Number.MAX_SAFE_INTEGER, name)
  }
  if (Object.keys(limits).length > 0) {
    browserAgent = Object.freeze({ ...browserAgent, limits: Object.freeze(limits) })
  }
  if (model !== undefined && model.length > 0 && !MODEL_ID.test(model)) {
    throw new Error("BROWSE_HARNESS_MODEL is invalid")
  }
  const tardigradeToken = env.TARDIGRADE_TOKEN?.trim()
  return Object.freeze({
    token,
    browserBackend: browserBackendOf(env.BROWSE_HARNESS_BROWSER),
    allowedDomains,
    baseUrl,
    actor,
    ...(browserAgent === undefined ? {} : { browserAgent }),
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(tardigradeToken === undefined || tardigradeToken.length === 0 ? {} : { tardigradeToken }),
    ...(publicOriginOf(env.BROWSE_HARNESS_PUBLIC_ORIGIN) === undefined
      ? {}
      : { publicOrigin: publicOriginOf(env.BROWSE_HARNESS_PUBLIC_ORIGIN)! }),
    maxConcurrentRuns: boundedInteger(
      env.BROWSE_HARNESS_MAX_CONCURRENT_RUNS,
      DEFAULT_MAX_CONCURRENT_RUNS,
      MAX_CONCURRENT_RUNS,
      "BROWSE_HARNESS_MAX_CONCURRENT_RUNS"
    ),
    port: boundedInteger(env.BROWSE_HARNESS_PORT, DEFAULT_PORT, 65_535, "BROWSE_HARNESS_PORT")
  })
}

const contentLengthWithin = (request: Request): boolean => {
  const raw = request.headers.get("content-length")
  if (raw === null) return true
  return /^[0-9]+$/u.test(raw) && Number(raw) <= MAX_BROWSE_HARNESS_REQUEST_BYTES
}

const requestBodyProblem = (reason: "aborted" | "timed_out"): BrowseHarnessProblem => reason === "aborted"
  ? new BrowseHarnessProblem(499, "cancelled", "The remote browser request was cancelled.")
  : new BrowseHarnessProblem(408, "invalid_request", "The request body exceeded its read deadline.", true)

const readBoundedRequestBytes = async (
  request: Request,
  timeoutMs: number
): Promise<Uint8Array> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    throw new BrowseHarnessProblem(415, "invalid_request", "The run endpoint accepts only JSON.")
  }
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase()
  if (encoding !== undefined && encoding !== "identity") {
    throw new BrowseHarnessProblem(415, "invalid_request", "Compressed request bodies are not accepted.")
  }
  if (!contentLengthWithin(request)) {
    throw new BrowseHarnessProblem(413, "invalid_request", "The request body exceeds its byte limit.")
  }
  if (request.body === null) throw new BrowseHarnessProblem(400, "invalid_request", "A JSON request body is required.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  const wipeChunks = (): void => {
    for (const chunk of chunks) chunk.fill(0)
  }
  let total = 0
  let stopped: "aborted" | "timed_out" | undefined
  let interruptRead: ((problem: BrowseHarnessProblem) => void) | undefined
  const stopReading = (reason: "aborted" | "timed_out"): void => {
    stopped ??= reason
    void reader.cancel().catch(() => {})
    interruptRead?.(requestBodyProblem(stopped))
  }
  const onAbort = (): void => { stopReading("aborted") }
  if (request.signal.aborted) onAbort()
  else request.signal.addEventListener("abort", onAbort, { once: true })
  const timeoutHandle = setTimeout(() => { stopReading("timed_out") }, timeoutMs)
  try {
    while (true) {
      if (stopped !== undefined) throw requestBodyProblem(stopped)
      const item = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolveRead, rejectRead) => {
        interruptRead = rejectRead
        void reader.read().then(resolveRead, rejectRead)
      }).finally(() => { interruptRead = undefined })
      if (stopped !== undefined) {
        if (!item.done) item.value.fill(0)
        throw requestBodyProblem(stopped)
      }
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_BROWSE_HARNESS_REQUEST_BYTES) {
        item.value.fill(0)
        wipeChunks()
        void reader.cancel().catch(() => {})
        throw new BrowseHarnessProblem(413, "invalid_request", "The request body exceeds its byte limit.")
      }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    wipeChunks()
    return bytes
  } catch (error) {
    wipeChunks()
    if (error instanceof BrowseHarnessProblem) throw error
    throw new BrowseHarnessProblem(400, "invalid_request", "The request body could not be read.")
  } finally {
    clearTimeout(timeoutHandle)
    request.signal.removeEventListener("abort", onAbort)
  }
}

interface RunInput {
  readonly prompt: string
  readonly targetUrl: string
  readonly debug?: boolean
  readonly allowedDomains: ReadonlyArray<string>
}

type RawRunInput = Omit<RunInput, "allowedDomains">

const exactRunInput = (value: unknown): RawRunInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowseHarnessProblem(400, "invalid_request", "The run request is invalid.")
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (!keys.includes("prompt") || keys.some((key) => !["prompt", "targetUrl", "debug"].includes(key))) {
    throw new BrowseHarnessProblem(400, "invalid_request", "The run request is invalid.")
  }
  if (typeof record.prompt !== "string" || (record.targetUrl !== undefined && typeof record.targetUrl !== "string") || (record.debug !== undefined && typeof record.debug !== "boolean")) {
    throw new BrowseHarnessProblem(400, "invalid_request", "The run request is invalid.")
  }
  return { prompt: record.prompt, targetUrl: (record.targetUrl as string | undefined)?.trim() ?? "", ...(record.debug === undefined ? {} : { debug: record.debug as boolean }) }
}

// Operator-reviewed dependency, approved for the Eatigo diagnosis on 2026-09-06.
// The pinned daemon applies its allowlist to scripts as well as navigation.
// Never learn permissions from page/model output or widen a strict host config.
const REVIEWED_PUBLIC_SITE_DEPENDENCIES: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  "eatigo.com": Object.freeze(["cdn.myfunnow.com"])
})

const targetDomainScope = (targetUrl: string): ReadonlyArray<string> => {
  let url: URL
  try { url = new URL(targetUrl) } catch {
    throw new BrowseHarnessProblem(400, "invalid_target", "The target is outside the server domain policy.")
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "")
  if (!isPublicAgentBrowserHost(host)) throw new BrowseHarnessProblem(400, "invalid_target", "The target is outside the public-web policy.")
  try {
    const dependencies = Object.hasOwn(REVIEWED_PUBLIC_SITE_DEPENDENCIES, host) ? REVIEWED_PUBLIC_SITE_DEPENDENCIES[host]! : []
    const domains = normalizeAgentBrowserAllowedDomains([host, `*.${host}`, ...dependencies])
    validateAgentBrowserTarget(targetUrl, domains)
    return domains
  } catch {
    throw new BrowseHarnessProblem(400, "invalid_target", "The target is outside the public-web policy.")
  }
}

const runInputOf = async (
  request: Request,
  allowedDomains: ReadonlyArray<string>,
  requestBodyTimeoutMs: number
): Promise<RunInput> => {
  const bytes = await readBoundedRequestBytes(request, requestBodyTimeoutMs)
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch {
    bytes.fill(0)
    throw new BrowseHarnessProblem(400, "invalid_request", "The request body must be valid UTF-8 JSON.")
  }
  bytes.fill(0)
  let decoded: unknown
  try { decoded = JSON.parse(text) as unknown } catch {
    throw new BrowseHarnessProblem(400, "invalid_request", "The request body must be valid JSON.")
  }
  const input = exactRunInput(decoded)
  try { validateAgentBrowserAgentPrompt(input.prompt) } catch {
    throw new BrowseHarnessProblem(400, "invalid_request", "The browser prompt is invalid.")
  }
  if (input.targetUrl === "") return { ...input, allowedDomains }
  return validateRunTarget(input, allowedDomains)
}

const validateRunTarget = (input: RawRunInput, allowedDomains: ReadonlyArray<string>): RunInput => {
  const publicScope = targetDomainScope(input.targetUrl)
  const runDomains = allowedDomains.length === 1 && allowedDomains[0] === "*"
    ? publicScope
    : allowedDomains
  try { validateAgentBrowserTarget(input.targetUrl, runDomains) } catch {
    throw new BrowseHarnessProblem(400, "invalid_target", "The target is outside the server domain policy.")
  }
  return { ...input, allowedDomains: runDomains }
}

const remoteToolCategory = (descriptor: AgentBrowserAgentToolDescriptor): BrowseHarnessToolCategory => {
  const category = browserToolCategoryOf(descriptor.traceAction)
  if (category !== "interaction" && category !== "navigation" && category !== "observation") {
    throw new Error("The remote browser tool registry contains a forbidden category")
  }
  return category
}

const REMOTE_TOOL_DESCRIPTORS: ReadonlyArray<BrowseHarnessToolDescriptor> = Object.freeze(
  [...AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS.map((descriptor) => Object.freeze({
    name: descriptor.name,
    action: descriptor.action,
    category: remoteToolCategory(descriptor),
    description: descriptor.description,
    inputSchema: descriptor.parameters
  })), ...BROWSE_HARNESS_INDEX_TOOLS]
)

const REMOTE_TRACE_ACTIONS = new Set(AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.traceAction))
const remoteActionByToolName = new Map(AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor.action]))

const namesByTraceAction = new Map<string, string[]>()
for (const descriptor of AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS) {
  const names = namesByTraceAction.get(descriptor.traceAction) ?? []
  names.push(descriptor.name)
  namesByTraceAction.set(descriptor.traceAction, names)
}

const uniqueToolNameOf = (action: string): string | undefined => {
  const names = namesByTraceAction.get(action)
  if (names?.length === 1) return names[0]!
  return undefined
}

/** Project a strict durable event to a fixed summary; payload shapes and definitions are never copied. */
type BrowseHarnessTraceProgressEvent = Exclude<
  BrowseHarnessProgressEvent,
  { readonly type: "BrowseHarnessRunStarted" | "BrowseHarnessRunCompleted" }
>

interface RemoteToolCallIdentity {
  readonly name: string
  readonly action: string
  readonly category: BrowseHarnessToolCategory
}

const browseHarnessToolCategoryOf = (event: BrowserTraceEvent): BrowseHarnessToolCategory | undefined => {
  if (event.type !== "BrowserToolCallObserved" && event.type !== "BrowserToolResultObserved") return undefined
  return event.category === "interaction" || event.category === "navigation" || event.category === "observation"
    ? event.category
    : undefined
}

export const browseHarnessProgressOf = (
  value: unknown,
  expectedThreadId: string,
  toolNamesByCallId: Map<string, RemoteToolCallIdentity> = new Map()
): BrowseHarnessTraceProgressEvent | undefined => {
  const event = decodeBrowserTraceEvent(value)
  if (event === undefined || event.threadId !== expectedThreadId) return undefined
  switch (event.type) {
    case "BrowserToolCallObserved": {
      const category = browseHarnessToolCategoryOf(event)
      const toolName = event.action === "wait"
        ? event.parameters.fieldNames.includes("selector")
          ? "agent_browser_wait_for_selector"
          : "agent_browser_wait_milliseconds"
        : uniqueToolNameOf(event.action)
      if (category === undefined || toolName === undefined || toolNamesByCallId.has(event.callId)) return undefined
      toolNamesByCallId.set(event.callId, { name: toolName, action: event.action, category })
      return {
        type: "BrowseHarnessToolCalled",
        sequence: event.sequence,
        toolName,
        action: remoteActionByToolName.get(toolName)!,
        category
      }
    }
    case "BrowserToolResultObserved": {
      const category = browseHarnessToolCategoryOf(event)
      const call = toolNamesByCallId.get(event.callId)
      if (
        category === undefined || call === undefined ||
        call.action !== event.action || call.category !== category
      ) return undefined
      toolNamesByCallId.delete(event.callId)
      return {
        type: "BrowseHarnessToolReturned",
        sequence: event.sequence,
        toolName: call.name,
        action: remoteActionByToolName.get(call.name)!,
        category,
        outcome: event.success === true ? "succeeded" : event.success === false ? "failed" : "unknown",
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
      }
    }
    case "BrowserNetworkDependencyInferred": return {
      type: "BrowseHarnessNetworkLinked",
      sequence: event.sequence,
      relation: event.relation,
      confidence: event.confidence
    }
    case "BrowserNetworkToolPrepared": return {
      type: "BrowseHarnessToolPrepared",
      sequence: event.sequence,
      methods: event.summary.methods,
      stepCount: event.summary.stepCount,
      inputCount: event.summary.inputCount,
      dependencyCount: event.summary.dependencyCount,
      sessionRequirementCount: event.summary.sessionRequirementCount
    }
    case "BrowserNetworkToolReuseDecided": return {
      type: "BrowseHarnessReuseDecided",
      sequence: event.sequence,
      decision: event.decision,
      reason: event.reason
    }
  }
}

const traceEventOfLine = (line: string): BrowserTraceEvent | undefined => {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > 512 * 1_024) return undefined
  let decoded: unknown
  try { decoded = JSON.parse(line) as unknown } catch { return undefined }
  return decodeBrowserTraceEvent(decoded)
}

const terminalProgress = (result: BrowseThreadResult, threadId: string): BrowseHarnessProgressEvent => {
  if (result.traceThreadId !== threadId) throw new Error("The runner returned another trace thread")
  if (!result.ndjsonDeliveryComplete) {
    throw new BrowseThreadError("trace_append_failed", "The reduced browser progress stream was incomplete.", "progress_incomplete")
  }
  if (result.mode === "network_tool") {
    if (!result.success) throw new BrowseHarnessProblem(502, "upstream_failed", "The approved network tool failed.")
    return {
      type: "BrowseHarnessRunCompleted",
      threadId,
      mode: "network_tool",
      agentToolCallCount: 0,
      preparedToolCount: 0,
      compileFallbackCount: 0,
      telemetryComplete: false
    }
  }
  return {
    type: "BrowseHarnessRunCompleted",
    threadId,
    mode: "browser",
    agentToolCallCount: result.agentToolCallCount,
    preparedToolCount: result.preparedToolCount,
    compileFallbackCount: result.compileFallbackCount,
    telemetryComplete: result.telemetryComplete
  }
}

const safeRunFailure = (error: unknown, cancelled: boolean): BrowseHarnessFailure => {
  if (cancelled || (error instanceof BrowseThreadError && error.code === "cancelled")) {
    return failure("cancelled", "The remote browser run was cancelled.", false, "cancelled")
  }
  if (error instanceof BrowseHarnessProblem) return failure(error.code, error.safeMessage, error.retryable)
  if (error instanceof AgentBrowserAgentError) return failure("browser_failed", BROWSE_HARNESS_STOP_MESSAGES[error.reason], false, error.reason)
  if (error instanceof BrowseThreadError) {
    if (error.code === "invalid_input") return failure("invalid_request", "The remote browser run was rejected.")
    if (error.code === "browser_failed" || error.code === "har_capture_failed" || error.code === "cleanup_failed") {
      const reason = error.reason ?? (error.code === "browser_failed" ? "action_failed" : error.code)
      return failure("browser_failed", "The isolated browser run failed.", false, reason)
    }
    return failure("upstream_failed", "The durable browser trace could not be completed.", false,
      error.reason ?? (error.code === "har_import_failed" ? "har_import_failed" : "trace_failed"))
  }
  return failure("internal_error", "The remote browser harness failed.")
}

const defaultRunner: BrowseHarnessRunner = runBrowserTask

export class BrowseHarnessController {
  readonly config: BrowseHarnessServerConfig
  readonly runner: BrowseHarnessRunner
  readonly randomId: () => string
  readonly staticAssets: BrowseHarnessStaticAssetLoader
  readonly requestBodyTimeoutMs: number
  readonly indexStore: BrowserNetworkToolIndex
  readonly targetSelector: typeof selectBrowserTaskTarget
  #activeThreads = new Set<string>()
  #activeSlots = 0

  constructor(options: BrowseHarnessControllerOptions) {
    this.config = options.config
    this.runner = options.runner ?? defaultRunner
    this.randomId = options.randomId ?? randomUUID
    this.staticAssets = options.staticAssets ?? browseHarnessFileAssetLoader()
    // Embeddings/tests default to isolated memory. The service entry point
    // explicitly mounts the persistent host database below.
    this.indexStore = options.indexStore ?? new HarnessRegistry()
    this.targetSelector = options.targetSelector ?? selectBrowserTaskTarget
    const requestBodyTimeoutMs = options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS
    if (
      !Number.isSafeInteger(requestBodyTimeoutMs) || requestBodyTimeoutMs < 1 ||
      requestBodyTimeoutMs > MAX_REQUEST_BODY_TIMEOUT_MS
    ) throw new Error("The remote request-body deadline is outside its bounded range")
    this.requestBodyTimeoutMs = requestBodyTimeoutMs
  }

  get activeRunCount(): number { return this.#activeSlots }

  #reserveRunSlot(): () => void {
    if (this.#activeSlots >= this.config.maxConcurrentRuns) {
      throw new BrowseHarnessProblem(429, "busy", "The remote browser harness is at its run limit.", true)
    }
    this.#activeSlots += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#activeSlots -= 1
    }
  }

  async startRequest(request: Request): Promise<Response> {
    const releaseSlot = this.#reserveRunSlot()
    let handedOff = false
    try {
      const input = await runInputOf(request, this.config.allowedDomains, this.requestBodyTimeoutMs)
      const response = this.#startAcceptedRun(input, request.signal, releaseSlot)
      handedOff = true
      return response
    } finally {
      if (!handedOff) releaseSlot()
    }
  }

  capabilities(): BrowseHarnessCapabilitiesEnvelope {
    const data: BrowseHarnessCapabilities = {
      service: "remote-agent-browser-harness",
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      actor: this.config.actor,
      allowedDomains: this.config.allowedDomains,
      tools: REMOTE_TOOL_DESCRIPTORS
    }
    return success(data)
  }

  #startAcceptedRun(input: RunInput, requestSignal: AbortSignal, releaseSlot: () => void): Response {
    const taskStartedAt = Date.now()
    const threadId = `browse-${this.randomId().replaceAll("-", "")}`
    if (!OPAQUE_ID.test(threadId) || this.#activeThreads.has(threadId)) {
      throw new BrowseHarnessProblem(500, "internal_error", "A unique browser run could not be allocated.", true)
    }
    this.#activeThreads.add(threadId)
    const abort = new AbortController()
    let connected = true
    let progressCount = 0
    let traceBytes = 0
    let expectedSequence = 0
    let debugIndex = 0
    let checkpointDelivered = false
    let terminalDebugDelivered = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let debugBytes = 0
    let debugTruncated = false
    let initialNavigationIdentified = false
    let initialNavigationCallId: string | undefined
    const toolNamesByCallId = new Map<string, RemoteToolCallIdentity>()
    const onRequestAbort = (): void => { abort.abort() }
    if (requestSignal.aborted) abort.abort()
    else requestSignal.addEventListener("abort", onRequestAbort, { once: true })
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start: (stream) => {
        const emit = (envelope: BrowseHarnessStreamEnvelope, countsAsProgress: boolean): boolean => {
          if (!connected) return false
          const encoded = encoder.encode(`${JSON.stringify(envelope)}\n`)
          if (encoded.byteLength > MAX_BROWSE_HARNESS_LINE_BYTES) return false
          if (countsAsProgress && !(envelope.ok && envelope.data.type === "BrowseHarnessDebug")) {
            if (
              progressCount >= MAX_BROWSE_HARNESS_PROGRESS_EVENTS ||
              traceBytes + encoded.byteLength > MAX_BROWSE_HARNESS_STREAM_BYTES
            ) return false
            progressCount += 1
            traceBytes += encoded.byteLength
          }
          try { stream.enqueue(encoded); return true } catch { connected = false; return false }
        }
        const started: BrowseHarnessProgressEvent = {
          type: "BrowseHarnessRunStarted",
          threadId,
          actor: this.config.actor,
          toolCount: REMOTE_TOOL_DESCRIPTORS.length
        }
        emit(success(started), true)
        // Blank NDJSON lines are ignored by the client but keep HTTPS proxies
        // connected while a browser action or durable flush produces no rows.
        heartbeat = setInterval(() => {
          if (!connected) return
          if (traceBytes >= MAX_BROWSE_HARNESS_STREAM_BYTES - MAX_BROWSE_HARNESS_LINE_BYTES) { abort.abort(); return }
          try { stream.enqueue(encoder.encode("\n")); traceBytes += 1 } catch { connected = false; abort.abort() }
        }, 15_000)
        const debug = (entry: BrowseHarnessDebugEntry, terminal = false): void => {
          const checkpoint = entry.kind === "controller" && entry.text.startsWith(BROWSE_HARNESS_CHECKPOINT_PREFIX) &&
            entry.text.length <= BROWSE_HARNESS_CHECKPOINT_PREFIX.length + MAX_BROWSE_HARNESS_CHECKPOINT_CHARS
          if (input.debug !== true || !connected || (debugTruncated && !checkpoint && !terminal) ||
              (checkpoint && checkpointDelivered) || (terminal && terminalDebugDelivered)) return
          const text = browseHarnessDebugText(entry.text, [
            this.config.token, this.config.tardigradeToken ?? "",
            this.config.browserAgent?.apiKey ?? "", process.env.AI_GATEWAY_API_KEY ?? ""
          ])
          // Reserve a truncation notice, one checkpoint and one final answer/error.
          const overLimit = !checkpoint && !terminal && (debugIndex >= MAX_BROWSE_HARNESS_DEBUG_EVENTS - 3 || debugBytes > MAX_BROWSE_HARNESS_DEBUG_BYTES - 4 * MAX_BROWSE_HARNESS_LINE_BYTES)
          const event: BrowseHarnessProgressEvent = {
            type: "BrowseHarnessDebug", debugIndex,
            kind: overLimit ? "truncated" : entry.kind,
            text: overLimit ? "Debug transcript limit reached; durable activity continues. The final answer or stop reason will still appear." : checkpoint
              ? text.slice(0, BROWSE_HARNESS_CHECKPOINT_PREFIX.length + MAX_BROWSE_HARNESS_CHECKPOINT_CHARS) : text
          }
          if (emit(success(event), true)) {
            debugIndex += 1
            debugBytes += encoder.encode(`${JSON.stringify(success(event))}\n`).byteLength
            debugTruncated ||= overLimit
            checkpointDelivered ||= checkpoint
            terminalDebugDelivered ||= terminal
          }
        }
        debug({ kind: "controller", text: "Run accepted. Preparing the trace, isolated browser, and initial navigation." })
        void (async () => {
          try {
            let resolvedInput = input
            let browserAgent = this.config.browserAgent
            if (!input.targetUrl) {
              debug({ kind: "controller", text: "Choosing a starting website from your request." })
              const began = performance.now()
              const selected = await this.targetSelector({
                prompt: input.prompt,
                taskStartedAt,
                knownSites: Object.keys(REVIEWED_PUBLIC_SITE_DEPENDENCIES),
                allowedDomains: this.config.allowedDomains,
                apiKey: browserAgent?.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? "",
                ...(browserAgent?.gatewayUrl === undefined ? {} : { gatewayUrl: browserAgent.gatewayUrl }),
                ...(this.config.model === undefined ? {} : { model: this.config.model }),
                ...(browserAgent?.limits === undefined ? {} : { limits: browserAgent.limits }),
                signal: abort.signal
              })
              // Reviewed sites may redirect www to their canonical apex. Only
              // normalize that known alias; arbitrary hosts keep their identity.
              let selectedUrl: URL
              try { selectedUrl = new URL(selected.targetUrl) } catch {
                throw new BrowseHarnessProblem(400, "invalid_target", "The selected starting page is invalid.")
              }
              if (selectedUrl.hostname.startsWith("www.") && Object.hasOwn(REVIEWED_PUBLIC_SITE_DEPENDENCIES, selectedUrl.hostname.slice(4))) {
                selectedUrl.hostname = selectedUrl.hostname.slice(4)
              }
              resolvedInput = validateRunTarget({ ...input, targetUrl: selectedUrl.href }, this.config.allowedDomains)
              // An omitted domain asks us to choose a website. Start at its
              // validated homepage instead of an invented locale/deep path.
              // Callers can preserve an exact path with the explicit URL field.
              // A chosen starting page is not a user-supplied domain restriction.
              // Preserve host policy (* means cross-site); explicit input above
              // still derives its target-specific scope.
              resolvedInput = { ...resolvedInput, targetUrl: `${selectedUrl.origin}/`, allowedDomains: this.config.allowedDomains }
              const prior = browserAgent?.limits ?? {}
              const remaining: AgentBrowserAgentLimits = { ...prior,
                reportedTokens: (prior.reportedTokens ?? DEFAULT_AGENT_BROWSER_AGENT_LIMITS.reportedTokens) - selected.reportedTokens,
                ...(prior.modelCalls == null ? {} : { modelCalls: prior.modelCalls - 1 }),
                ...(prior.responseBytes == null ? {} : { responseBytes: prior.responseBytes - selected.responseBytes }),
                ...(prior.wallTimeMs == null ? {} : { wallTimeMs: prior.wallTimeMs - Math.ceil(performance.now() - began) })
              }
              if ([remaining.reportedTokens, remaining.modelCalls, remaining.responseBytes, remaining.wallTimeMs].some((value) => value != null && value <= 0)) {
                throw new AgentBrowserAgentError("limit_exceeded", "Starting-page selection exhausted the run allowance", "resource_limit")
              }
              browserAgent = { ...browserAgent, apiKey: browserAgent?.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? "", limits: remaining }
              debug({ kind: "controller", text: `Starting website selected: ${new URL(resolvedInput.targetUrl).origin}. Selection used ${selected.reportedTokens} reported tokens.` })
            }
            if (abort.signal.aborted) throw new AgentBrowserAgentError("cancelled", "The run was cancelled", "cancelled")
            const result = await this.runner({
              prompt: resolvedInput.prompt,
              taskStartedAt,
              targetUrl: resolvedInput.targetUrl,
              allowedDomains: resolvedInput.allowedDomains,
              threadId,
              baseUrl: this.config.baseUrl,
              actor: this.config.actor,
              browserBackend: this.config.browserBackend ?? "stock",
              ...(browserAgent === undefined ? {} : { browserAgent }),
              ...(this.config.tardigradeToken === undefined ? {} : { token: this.config.tardigradeToken }),
              ...(this.config.model === undefined ? {} : { model: this.config.model }),
              signal: abort.signal,
              indexStore: this.indexStore,
              ...(input.debug === true ? { onDebug: (entry: BrowseHarnessDebugEntry) =>
                debug(entry, entry.kind === "assistant" && entry.text.startsWith("Tardigrade TurnCompleted\n")) } : {}),
              onNdjson: (line) => {
                const event = traceEventOfLine(line)
                if (event === undefined || event.threadId !== threadId || event.sequence !== expectedSequence) {
                  throw new Error("The browser trace stream was invalid")
                }
                expectedSequence += 1
                // browseThread opens the submitted target before the model
                // runs. Keep that controller-owned navigation durable, but do
                // not count it as one of the model's published tool calls.
                if (
                  !initialNavigationIdentified && event.type === "BrowserToolCallObserved" &&
                  event.action === "navigate"
                ) {
                  initialNavigationIdentified = true
                  initialNavigationCallId = event.callId
                  debug({ kind: "controller", text: "Opening the submitted target before the first model request." })
                  return
                }
                if (
                  event.type === "BrowserToolResultObserved" &&
                  initialNavigationCallId !== undefined && event.callId === initialNavigationCallId
                ) {
                  initialNavigationCallId = undefined
                  debug({ kind: "controller", text: `Initial navigation outcome: ${String(event.success)}.` })
                  return
                }
                const projected = browseHarnessProgressOf(event, threadId, toolNamesByCallId)
                // Internal lifecycle/network/session calls remain durable but
                // are not part of the remote agent-facing CLI tool surface.
                if (projected === undefined) {
                  if (
                    (event.type === "BrowserToolCallObserved" || event.type === "BrowserToolResultObserved") &&
                    REMOTE_TRACE_ACTIONS.has(event.action)
                  ) {
                    throw new Error("The browser trace named a tool outside the published remote surface")
                  }
                  return
                }
                // Reserve one progress slot and one maximum-size line for the terminal row.
                const projectedBytes = encoder.encode(`${JSON.stringify(success(projected))}\n`).byteLength
                if (
                  progressCount >= MAX_BROWSE_HARNESS_PROGRESS_EVENTS - 1 ||
                  traceBytes + projectedBytes > MAX_BROWSE_HARNESS_STREAM_BYTES - MAX_BROWSE_HARNESS_LINE_BYTES
                ) throw new Error("The remote progress stream reached its limit")
                if (!emit(success(projected), true)) throw new Error("The remote progress stream could not be delivered")
              }
            })
            if (abort.signal.aborted) {
              emit(safeRunFailure(undefined, true), false)
            } else {
              emit(success(terminalProgress(result, threadId)), true)
            }
          } catch (error) {
            const stopped = safeRunFailure(error, abort.signal.aborted)
            const reason = stopped.error.reason
            debug({ kind: "error", text: `Controller stopped: ${stopped.error.code}${reason === undefined ? "" : ` / ${reason}`}. ${reason === undefined ? stopped.error.message : BROWSE_HARNESS_STOP_MESSAGES[reason]}` }, true)
            emit(stopped, false)
          } finally {
            clearInterval(heartbeat)
            requestSignal.removeEventListener("abort", onRequestAbort)
            this.#activeThreads.delete(threadId)
            releaseSlot()
            if (connected) {
              try { stream.close() } catch { connected = false }
            }
          }
        })()
      },
      cancel: () => {
        clearInterval(heartbeat)
        connected = false
        abort.abort()
      }
    })
    return new Response(body, {
      status: 200,
      headers: {
        ...API_HEADERS,
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-accel-buffering": "no"
      }
    })
  }
}

const staticContentType = (path: BrowseHarnessStaticAssetPath): string | undefined => {
  if (path === "remote.html") return "text/html; charset=utf-8"
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (path.endsWith(".css")) return "text/css; charset=utf-8"
  if (path.endsWith(".woff2")) return "font/woff2"
  if (path.endsWith(".woff")) return "font/woff"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".webp")) return "image/webp"
  return undefined
}

const staticAssetPathOf = (pathname: string): BrowseHarnessStaticAssetPath | undefined => {
  if (pathname === "/browse-harness/" || pathname === "/browse-harness/remote.html") return "remote.html"
  const prefix = "/browse-harness/"
  if (!pathname.startsWith(prefix)) return undefined
  const relative = pathname.slice(prefix.length)
  return validStaticAssetPath(relative) && relative !== "remote.html" ? relative : undefined
}

const staticResponse = (body: Uint8Array, contentType: string): Response => new Response(body, {
  status: 200,
  headers: { ...STATIC_HEADERS, "content-type": contentType }
})

const readStaticResponse = async (
  controller: BrowseHarnessController,
  path: BrowseHarnessStaticAssetPath
): Promise<Response | undefined> => {
  const contentType = staticContentType(path)
  if (contentType === undefined) return undefined
  let body: Uint8Array | undefined
  try { body = await controller.staticAssets(path) } catch { return undefined }
  if (body === undefined || body.byteLength < 1 || body.byteLength > MAX_STATIC_ASSET_BYTES) return undefined
  // Vite's `base: "./"` makes `./assets/*` in remote.html resolve to the
  // allowlisted /browse-harness/assets/* route without rewriting HTML bytes.
  return staticResponse(body, contentType)
}

export const browseHarnessFetch = async (
  request: Request,
  controller: BrowseHarnessController
): Promise<Response> => {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/browse-harness/healthz" && url.search === "") {
    return jsonResponse(success({ status: "ready" }))
  }
  try { assertBrowserOrigin(request, controller.config.publicOrigin) } catch (error) {
    return failureResponse(error as BrowseHarnessProblem)
  }
  if (controller.config.token.length > 0 && !browseHarnessAuthorized(request, controller.config.token)) {
    return failureResponse(
      new BrowseHarnessProblem(401, "unauthorized", "Valid browser harness credentials are required."),
      true
    )
  }
  if (request.method === "GET" && url.pathname === "/browse-harness/v1/index") {
    const cursor = url.searchParams.get("cursor") ?? "0"
    if ([...url.searchParams.keys()].some((key) => key !== "cursor") || url.searchParams.getAll("cursor").length > 1 || !/^(?:0|[1-9][0-9]{0,3})$/u.test(cursor) || Number(cursor) > 4096) {
      return failureResponse(new BrowseHarnessProblem(400, "invalid_request", "Invalid shared-index cursor."))
    }
    try { return jsonResponse(success(controller.indexStore.listIndexedNetworkTools({ cursor: Number(cursor) }))) }
    catch { return failureResponse(new BrowseHarnessProblem(503, "upstream_failed", "The shared draft index is unavailable.", true)) }
  }
  const indexedDigest = /^\/browse-harness\/v1\/index\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname)?.[1]
  if (request.method === "GET" && indexedDigest !== undefined && url.search === "") {
    try {
      const saved = controller.indexStore.getIndexedNetworkTool(indexedDigest)
      if (saved) return jsonResponse(success(saved))
      return failureResponse(new BrowseHarnessProblem(404, "not_found", "The shared draft was not found."))
    } catch { return failureResponse(new BrowseHarnessProblem(503, "upstream_failed", "The shared draft index is unavailable.", true)) }
  }
  if (url.search !== "") {
    return failureResponse(new BrowseHarnessProblem(404, "not_found", "No browser harness route matches this request."))
  }
  const staticPath = request.method === "GET" ? staticAssetPathOf(url.pathname) : undefined
  if (staticPath !== undefined) {
    const response = await readStaticResponse(controller, staticPath)
    if (response !== undefined) return response
    return failureResponse(new BrowseHarnessProblem(404, "not_found", "The browser harness asset is unavailable."))
  }
  if (request.method === "GET" && url.pathname === "/browse-harness/v1/tools") {
    return jsonResponse(controller.capabilities())
  }
  if (request.method === "POST" && url.pathname === "/browse-harness/v1/runs") {
    try {
      return await controller.startRequest(request)
    } catch (error) {
      if (error instanceof BrowseHarnessProblem) return failureResponse(error)
      return failureResponse(new BrowseHarnessProblem(500, "internal_error", "The browser harness request failed.", true))
    }
  }
  return failureResponse(new BrowseHarnessProblem(404, "not_found", "No browser harness route matches this request."))
}

if (import.meta.main) {
  const config = browseHarnessServerConfigOf(process.env)
  await browserLaunchConfig(config.browserBackend ?? "stock")
  const indexStore = new HarnessRegistry({ database: resolve(import.meta.dir, ".tardigrade/browser-index.sqlite") })
  const controller = new BrowseHarnessController({ config, indexStore })
  Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 255,
    fetch: (request) => browseHarnessFetch(request, controller)
  })
  console.log(JSON.stringify({
    service: "remote-agent-browser-harness",
    browserBackend: config.browserBackend ?? "stock",
    host: "127.0.0.1",
    port: config.port,
    reverseProxyRequired: true
  }))
}
