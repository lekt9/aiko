import { createHash } from "node:crypto"
import type {
  HarnessAction,
  HarnessStep,
  Sha256Digest,
  SiteHarnessArtifact,
  ValueProducer
} from "./harness-artifact"
import { validateSiteHarnessArtifact } from "./harness-artifact"

export type HarnessJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<HarnessJsonValue>
  | { readonly [key: string]: HarnessJsonValue }

export type HarnessExecutionStatus = "completed" | "failed" | "blocked"

export type HarnessExecutionCode =
  | "completed"
  | "invalid_artifact"
  | "invalid_limits"
  | "unknown_action"
  | "invalid_input"
  | "step_graph_invalid"
  | "budget_exceeded"
  | "origin_not_allowed"
  | "request_build_failed"
  | "clock_unavailable"
  | "uuid_unavailable"
  | "response_dependency_unavailable"
  | "response_header_unavailable"
  | "response_json_unavailable"
  | "wasm_adapter_unavailable"
  | "wasm_adapter_ambiguous"
  | "wasm_failed"
  | "js_adapter_unavailable"
  | "js_adapter_ambiguous"
  | "js_services_unavailable"
  | "js_failed"
  | "transport_failed"
  | "unexpected_status"
  | "redirect_budget_exceeded"
  | "cross_origin_redirect"
  | "mutating_redirect_blocked"
  | "unclassified_response"
  | "browser_session_required"
  | "site_control_encountered"
  | "forbidden_dependency"
  | "telemetry_dependency"

export type HarnessTransportClassification =
  | "application"
  | "browser_session_required"
  | "site_control"
  | "forbidden_dependency"
  | "telemetry_dependency"

export interface HarnessTransportRequest {
  readonly stepId: string
  readonly attempt: number
  readonly method: HarnessStep["method"]
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: HarnessJsonValue
  /** An injected transport must not automatically follow redirects. */
  readonly redirect: "manual"
}

export interface HarnessTransportResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body?: HarnessJsonValue
  /** Policy classification supplied by the trusted transport boundary. */
  readonly classification?: HarnessTransportClassification
}

export interface HarnessTransport {
  send(request: HarnessTransportRequest): HarnessTransportResponse | Promise<HarnessTransportResponse>
}

export interface HarnessJsServices {
  readonly now: () => Date | string | number
  readonly uuid: () => string
  readonly fetch: (
    url: string,
    init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown }
  ) => Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown }>
  readonly log: (line: string) => void
}

export interface ApprovedHarnessJsAdapter {
  readonly moduleDigest: string
  readonly entry: string
  invoke(
    args: ReadonlyArray<HarnessJsonValue>,
    context: { readonly stepId: string; readonly attempt: number; readonly services: HarnessJsServices }
  ): HarnessJsonValue | Promise<HarnessJsonValue>
}

export interface HarnessClock {
  now(): Date | string | number
}

export interface HarnessUuidSource {
  next(): string
}

export interface ApprovedHarnessWasmAdapter {
  readonly moduleDigest: string
  readonly exportName: string
  invoke(
    args: ReadonlyArray<HarnessJsonValue>,
    context: { readonly stepId: string; readonly attempt: number }
  ): HarnessJsonValue | Promise<HarnessJsonValue>
}

export interface HarnessRuntimeAdapters {
  readonly transport: HarnessTransport
  readonly clock: HarnessClock
  readonly uuid: HarnessUuidSource
  /** The presence of this exact digest/export pair is the approval boundary. */
  readonly wasm?: ReadonlyArray<ApprovedHarnessWasmAdapter>
  /** The presence of this exact digest/entry pair is the approval boundary. */
  readonly js?: ReadonlyArray<ApprovedHarnessJsAdapter>
  /**
   * Deterministic services for sandboxed modules in THIS run (clock, uuid,
   * scripted fetch, log). A js adapter without one fails closed.
   */
  readonly services?: HarnessJsServices
}

export interface HarnessRuntimeLimits {
  readonly maxSteps: number
  readonly maxRequests: number
  readonly maxRedirectsPerStep: number
  readonly maxProducerEvaluations: number
  readonly maxProducerDepth: number
  readonly maxWasmCalls: number
  readonly maxJsCalls: number
  readonly maxInputBytes: number
  readonly maxValueBytes: number
  readonly maxUrlBytes: number
  readonly maxRequestHeaderBytes: number
  readonly maxResponseHeaderBytes: number
  readonly maxResponseHeaderCount: number
}

export const DEFAULT_HARNESS_RUNTIME_LIMITS: HarnessRuntimeLimits = Object.freeze({
  maxSteps: 64,
  maxRequests: 96,
  maxRedirectsPerStep: 4,
  maxProducerEvaluations: 2_048,
  maxProducerDepth: 24,
  maxWasmCalls: 64,
  maxJsCalls: 64,
  maxInputBytes: 256_000,
  maxValueBytes: 1_000_000,
  maxUrlBytes: 16_384,
  maxRequestHeaderBytes: 65_536,
  maxResponseHeaderBytes: 65_536,
  maxResponseHeaderCount: 256
})

export type HarnessTraceEvent =
  | {
    readonly type: "action_started"
    readonly siteId: string
    readonly actionId: string
    readonly artifactVersion: string
  }
  | {
    readonly type: "step_started"
    readonly stepId: string
    readonly method: HarnessStep["method"]
    readonly origin: string
    readonly pathDigest: Sha256Digest
  }
  | {
    readonly type: "wasm_invoked"
    readonly stepId: string
    readonly attempt: number
    readonly moduleDigest: string
    readonly exportName: string
    readonly argumentCount: number
  }
  | {
    readonly type: "js_invoked"
    readonly stepId: string
    readonly attempt: number
    readonly moduleDigest: string
    readonly entry: string
    readonly argumentCount: number
  }
  | {
    readonly type: "request_sent"
    readonly stepId: string
    readonly attempt: number
    readonly requestIndex: number
    readonly method: HarnessStep["method"]
    readonly origin: string
    readonly pathDigest: Sha256Digest
    readonly headerNames: ReadonlyArray<string>
    readonly hasBody: boolean
    readonly redirectHop: number
  }
  | {
    readonly type: "response_received"
    readonly stepId: string
    readonly attempt: number
    readonly requestIndex: number
    readonly status: number
    readonly headerNames: ReadonlyArray<string>
    readonly hasBody: boolean
    readonly classifiedAs?: HarnessTransportClassification
  }
  | {
    readonly type: "redirect_followed"
    readonly stepId: string
    readonly attempt: number
    readonly redirectHop: number
    readonly origin: string
  }
  | {
    readonly type: "step_completed"
    readonly stepId: string
    readonly status: number
  }
  | {
    readonly type: "action_terminal"
    readonly status: HarnessExecutionStatus
    readonly code: HarnessExecutionCode
    readonly stepId?: string
  }

export interface HarnessExecutionCounts {
  readonly steps: number
  readonly requests: number
  readonly redirects: number
  readonly producerEvaluations: number
  readonly wasmCalls: number
  readonly jsCalls: number
}

export interface HarnessExecutionResult {
  readonly status: HarnessExecutionStatus
  readonly code: HarnessExecutionCode
  readonly artifact: {
    readonly siteId: string
    readonly version: string
  }
  readonly actionId: string
  readonly failedStepId?: string
  /** This trace contains structure and counts only; concrete values are omitted. */
  readonly trace: ReadonlyArray<HarnessTraceEvent>
  readonly counts: HarnessExecutionCounts
}

export interface ExecuteHarnessActionOptions {
  readonly artifact: SiteHarnessArtifact
  readonly actionId: string
  readonly input: Readonly<Record<string, HarnessJsonValue>>
  readonly adapters: HarnessRuntimeAdapters
  readonly limits?: Partial<HarnessRuntimeLimits>
}

type RuntimeFaultStatus = Exclude<HarnessExecutionStatus, "completed">

class HarnessRuntimeFault extends Error {
  readonly code: HarnessExecutionCode
  readonly status: RuntimeFaultStatus
  readonly stepId: string | undefined

  constructor(code: HarnessExecutionCode, status: RuntimeFaultStatus = "failed", stepId?: string) {
    super(code)
    this.name = "HarnessRuntimeFault"
    this.code = code
    this.status = status
    this.stepId = stepId
  }
}

interface RuntimeCounters {
  steps: number
  requests: number
  redirects: number
  producerEvaluations: number
  wasmCalls: number
  jsCalls: number
}

interface StepResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body?: HarnessJsonValue
}

interface ExecutionContext {
  readonly artifact: SiteHarnessArtifact
  readonly action: HarnessAction
  readonly input: Readonly<Record<string, HarnessJsonValue>>
  readonly adapters: HarnessRuntimeAdapters
  readonly limits: HarnessRuntimeLimits
  readonly counters: RuntimeCounters
  readonly trace: HarnessTraceEvent[]
  readonly responses: Map<string, StepResponse>
  readonly attemptValues: Map<ValueProducer, HarnessJsonValue>
}

const integerLimit = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  return value
}

export const resolveHarnessRuntimeLimits = (
  override: Partial<HarnessRuntimeLimits> | undefined
): HarnessRuntimeLimits => ({
  maxSteps: integerLimit(override?.maxSteps, DEFAULT_HARNESS_RUNTIME_LIMITS.maxSteps, "maxSteps"),
  maxRequests: integerLimit(override?.maxRequests, DEFAULT_HARNESS_RUNTIME_LIMITS.maxRequests, "maxRequests"),
  maxRedirectsPerStep: integerLimit(
    override?.maxRedirectsPerStep,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxRedirectsPerStep,
    "maxRedirectsPerStep"
  ),
  maxProducerEvaluations: integerLimit(
    override?.maxProducerEvaluations,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxProducerEvaluations,
    "maxProducerEvaluations"
  ),
  maxProducerDepth: integerLimit(
    override?.maxProducerDepth,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxProducerDepth,
    "maxProducerDepth"
  ),
  maxWasmCalls: integerLimit(override?.maxWasmCalls, DEFAULT_HARNESS_RUNTIME_LIMITS.maxWasmCalls, "maxWasmCalls"),
  maxJsCalls: integerLimit(override?.maxJsCalls, DEFAULT_HARNESS_RUNTIME_LIMITS.maxJsCalls, "maxJsCalls"),
  maxInputBytes: integerLimit(override?.maxInputBytes, DEFAULT_HARNESS_RUNTIME_LIMITS.maxInputBytes, "maxInputBytes"),
  maxValueBytes: integerLimit(override?.maxValueBytes, DEFAULT_HARNESS_RUNTIME_LIMITS.maxValueBytes, "maxValueBytes"),
  maxUrlBytes: integerLimit(override?.maxUrlBytes, DEFAULT_HARNESS_RUNTIME_LIMITS.maxUrlBytes, "maxUrlBytes"),
  maxRequestHeaderBytes: integerLimit(
    override?.maxRequestHeaderBytes,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxRequestHeaderBytes,
    "maxRequestHeaderBytes"
  ),
  maxResponseHeaderBytes: integerLimit(
    override?.maxResponseHeaderBytes,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxResponseHeaderBytes,
    "maxResponseHeaderBytes"
  ),
  maxResponseHeaderCount: integerLimit(
    override?.maxResponseHeaderCount,
    DEFAULT_HARNESS_RUNTIME_LIMITS.maxResponseHeaderCount,
    "maxResponseHeaderCount"
  )
})

const jsonText = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const assertJsonValue = (
  value: unknown,
  maxBytes: number,
  invalidCode: HarnessExecutionCode = "request_build_failed"
): HarnessJsonValue => {
  const serialized = jsonText(value)
  if (serialized === undefined) throw new HarnessRuntimeFault(invalidCode)
  if (byteLength(serialized) > maxBytes) {
    throw new HarnessRuntimeFault("budget_exceeded")
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes++
    if (nodes > maxBytes || current.depth > 64) throw new HarnessRuntimeFault("budget_exceeded")
    const nested = current.value
    if (nested === null || typeof nested === "string" || typeof nested === "boolean") continue
    if (typeof nested === "number") {
      if (!Number.isFinite(nested)) throw new HarnessRuntimeFault(invalidCode)
      continue
    }
    if (typeof nested !== "object") throw new HarnessRuntimeFault(invalidCode)
    if (Array.isArray(nested)) {
      for (const child of nested) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    const prototype = Object.getPrototypeOf(nested)
    if (prototype !== Object.prototype && prototype !== null) throw new HarnessRuntimeFault(invalidCode)
    for (const child of Object.values(nested)) pending.push({ value: child, depth: current.depth + 1 })
  }
  return value as HarnessJsonValue
}

const normalizeOrigin = (raw: string): string | undefined => {
  try {
    const parsed = new URL(raw)
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 || parsed.password.length > 0 ||
      parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

const allowedOrigin = (artifact: SiteHarnessArtifact, raw: string): string => {
  const origin = normalizeOrigin(raw)
  if (origin === undefined || !artifact.allowedOrigins.includes(origin)) {
    throw new HarnessRuntimeFault("origin_not_allowed", "blocked")
  }
  return origin
}

const headerNames = (headers: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.keys(headers).map((name) => name.toLowerCase()).sort()

const structuralDigest = (value: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

const normalizedResponseHeaders = (
  headers: Readonly<Record<string, string>>,
  limits: HarnessRuntimeLimits
): Readonly<Record<string, string>> => {
  const entries = Object.entries(headers)
  if (entries.length > limits.maxResponseHeaderCount) throw new HarnessRuntimeFault("budget_exceeded")
  const normalized: Record<string, string> = {}
  const seen = new Set<string>()
  let totalBytes = 0
  for (const [rawName, value] of entries) {
    const name = rawName.trim().toLowerCase()
    if (name.length === 0 || name.length > 128 || !HEADER_NAME.test(name) || seen.has(name) ||
      typeof value !== "string" || /[\u0000\r\n]/u.test(value) ||
      byteLength(value) > limits.maxValueBytes) {
      throw new HarnessRuntimeFault("transport_failed")
    }
    totalBytes += byteLength(name) + byteLength(value)
    if (totalBytes > limits.maxResponseHeaderBytes) throw new HarnessRuntimeFault("budget_exceeded")
    seen.add(name)
    normalized[name] = value
  }
  return normalized
}

const valueAsText = (value: HarnessJsonValue): string => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  const serialized = jsonText(value)
  if (serialized === undefined) throw new HarnessRuntimeFault("request_build_failed")
  return serialized
}

const decodePointerSegment = (value: string): string | undefined => {
  if (/~(?:[^01]|$)/u.test(value)) return undefined
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~")
}

const jsonPointer = (root: HarnessJsonValue, pointer: string): HarnessJsonValue | undefined => {
  if (pointer === "") return root
  if (!pointer.startsWith("/")) return undefined
  let current: HarnessJsonValue = root
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = decodePointerSegment(rawPart)
    if (part === undefined) return undefined
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(part)) return undefined
      const index = Number(part)
      const next = current[index]
      if (next === undefined) return undefined
      current = next
      continue
    }
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return undefined
    current = (current as { readonly [key: string]: HarnessJsonValue })[part] as HarnessJsonValue
  }
  return current
}

const inputValue = (
  input: Readonly<Record<string, HarnessJsonValue>>,
  name: string
): HarnessJsonValue | undefined => {
  if (name.startsWith("/")) return jsonPointer(input, name)
  return Object.hasOwn(input, name) ? input[name] : undefined
}

const POLICY_SECRET = /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\b[A-Za-z0-9_+/=-]{48,}\b)/iu
const POLICY_SITE_CONTROL = /(?:anti[-_]?bot|captcha|challenge|fingerprint|proof[-_]?of[-_]?work|sensor[-_]?data)/iu
const POLICY_TELEMETRY = /(?:analytics|beacon|pixel|telemetry|tracking)/iu

const policyCodeForText = (value: string): HarnessExecutionCode | undefined => {
  if (POLICY_SECRET.test(value) || POLICY_SITE_CONTROL.test(value)) return "forbidden_dependency"
  if (POLICY_TELEMETRY.test(value)) return "telemetry_dependency"
  return undefined
}

const policyCodeForJson = (value: HarnessJsonValue): HarnessExecutionCode | undefined => {
  if (typeof value === "string") return policyCodeForText(value)
  if (Array.isArray(value)) {
    for (const child of value) {
      const code = policyCodeForJson(child)
      if (code !== undefined) return code
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  for (const [name, child] of Object.entries(value)) {
    const code = policyCodeForText(name) ?? policyCodeForJson(child)
    if (code !== undefined) return code
  }
  return undefined
}

const dynamicPolicyCodeForJson = (value: HarnessJsonValue): HarnessExecutionCode | undefined => {
  if (typeof value === "string") {
    if (POLICY_SITE_CONTROL.test(value)) return "forbidden_dependency"
    if (POLICY_TELEMETRY.test(value)) return "telemetry_dependency"
    return undefined
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const code = dynamicPolicyCodeForJson(child)
      if (code !== undefined) return code
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  for (const [name, child] of Object.entries(value)) {
    if (POLICY_SITE_CONTROL.test(name)) return "forbidden_dependency"
    if (POLICY_TELEMETRY.test(name)) return "telemetry_dependency"
    const code = dynamicPolicyCodeForJson(child)
    if (code !== undefined) return code
  }
  return undefined
}

const policyCodeForProducer = (producer: ValueProducer): HarnessExecutionCode | undefined => {
  switch (producer.kind) {
    case "input": return policyCodeForText(producer.name)
    case "clock":
    case "uuid": return undefined
    case "response_header": return policyCodeForText(producer.name)
    case "response_json": return policyCodeForText(producer.pointer)
    case "constant": return policyCodeForJson(producer.value as HarnessJsonValue)
    case "object": {
      for (const [name, field] of Object.entries(producer.fields)) {
        const code = policyCodeForText(name) ?? policyCodeForProducer(field)
        if (code !== undefined) return code
      }
      return undefined
    }
    case "array": {
      for (const item of producer.items) {
        const code = policyCodeForProducer(item)
        if (code !== undefined) return code
      }
      return undefined
    }
    case "wasm": {
      const own = policyCodeForText(producer.export)
      if (own !== undefined) return own
      for (const argument of producer.args) {
        const code = policyCodeForProducer(argument)
        if (code !== undefined) return code
      }
      return undefined
    }
  }
}

const actionPolicyCode = (action: HarnessAction): HarnessExecutionCode | undefined => {
  const actionCode = policyCodeForText(action.id)
  if (actionCode !== undefined) return actionCode
  for (const input of action.inputs) {
    const code = policyCodeForText(input.name)
    if (code !== undefined) return code
  }
  for (const step of action.steps) {
    const structural = policyCodeForText(step.id) ?? policyCodeForText(step.origin) ?? policyCodeForText(step.path)
    if (structural !== undefined) return structural
    for (const collection of [step.pathParameters, step.query, step.headers]) {
      for (const [name, producer] of Object.entries(collection)) {
        const code = policyCodeForText(name) ?? policyCodeForProducer(producer)
        if (code !== undefined) return code
      }
    }
    if (step.body !== undefined) {
      const code = policyCodeForProducer(step.body)
      if (code !== undefined) return code
    }
  }
  return undefined
}

const dateFromClock = (value: Date | string | number): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new HarnessRuntimeFault("clock_unavailable")
  return date
}

const resolveProducer = async (
  producer: ValueProducer,
  context: ExecutionContext,
  step: HarnessStep,
  attempt: number,
  depth = 0
): Promise<HarnessJsonValue> => {
  if (context.attemptValues.has(producer)) return context.attemptValues.get(producer)!
  if (depth >= context.limits.maxProducerDepth) throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
  context.counters.producerEvaluations++
  if (context.counters.producerEvaluations > context.limits.maxProducerEvaluations) {
    throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
  }

  let value: HarnessJsonValue
  switch (producer.kind) {
    case "input": {
      const resolved = inputValue(context.input, producer.name)
      if (resolved === undefined) throw new HarnessRuntimeFault("invalid_input", "failed", step.id)
      value = resolved
      break
    }
    case "clock": {
      let now: Date
      try {
        now = dateFromClock(context.adapters.clock.now())
      } catch (error) {
        if (error instanceof HarnessRuntimeFault) throw error
        throw new HarnessRuntimeFault("clock_unavailable", "failed", step.id)
      }
      value = producer.format === "rfc1123"
        ? now.toUTCString()
        : producer.format === "iso8601"
          ? now.toISOString()
          : now.getTime()
      break
    }
    case "uuid": {
      let uuid: string
      try {
        uuid = context.adapters.uuid.next()
      } catch {
        throw new HarnessRuntimeFault("uuid_unavailable", "failed", step.id)
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uuid)) {
        throw new HarnessRuntimeFault("uuid_unavailable", "failed", step.id)
      }
      value = uuid.toLowerCase()
      break
    }
    case "response_header": {
      const response = context.responses.get(producer.stepId)
      if (response === undefined) {
        throw new HarnessRuntimeFault("response_dependency_unavailable", "failed", step.id)
      }
      const found = response.headers[producer.name.toLowerCase()]
      if (found === undefined) throw new HarnessRuntimeFault("response_header_unavailable", "failed", step.id)
      value = found
      break
    }
    case "response_json": {
      const response = context.responses.get(producer.stepId)
      if (response === undefined) {
        throw new HarnessRuntimeFault("response_dependency_unavailable", "failed", step.id)
      }
      if (response.body === undefined) throw new HarnessRuntimeFault("response_json_unavailable", "failed", step.id)
      const found = jsonPointer(response.body, producer.pointer)
      if (found === undefined) throw new HarnessRuntimeFault("response_json_unavailable", "failed", step.id)
      value = found
      break
    }
    case "constant":
      value = producer.value as HarnessJsonValue
      break
    case "object": {
      const fields: Record<string, HarnessJsonValue> = {}
      for (const name of Object.keys(producer.fields).sort()) {
        const field = producer.fields[name]
        if (field === undefined) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
        fields[name] = await resolveProducer(field, context, step, attempt, depth + 1)
      }
      value = fields
      break
    }
    case "array": {
      const items: HarnessJsonValue[] = []
      for (const item of producer.items) {
        items.push(await resolveProducer(item, context, step, attempt, depth + 1))
      }
      value = items
      break
    }
    case "wasm": {
      const matches = (context.adapters.wasm ?? []).filter((adapter) =>
        adapter.moduleDigest === producer.moduleDigest && adapter.exportName === producer.export)
      if (matches.length === 0) throw new HarnessRuntimeFault("wasm_adapter_unavailable", "blocked", step.id)
      if (matches.length !== 1) throw new HarnessRuntimeFault("wasm_adapter_ambiguous", "blocked", step.id)
      context.counters.wasmCalls++
      if (context.counters.wasmCalls > context.limits.maxWasmCalls) {
        throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
      }
      const args: HarnessJsonValue[] = []
      for (const argument of producer.args) {
        args.push(await resolveProducer(argument, context, step, attempt, depth + 1))
      }
      context.trace.push({
        type: "wasm_invoked",
        stepId: step.id,
        attempt,
        moduleDigest: producer.moduleDigest,
        exportName: producer.export,
        argumentCount: args.length
      })
      try {
        value = await matches[0]!.invoke(args, { stepId: step.id, attempt })
      } catch {
        throw new HarnessRuntimeFault("wasm_failed", "failed", step.id)
      }
      break
    }
    case "js": {
      const matches = (context.adapters.js ?? []).filter((adapter) =>
        adapter.moduleDigest === producer.moduleDigest && adapter.entry === producer.entry)
      if (matches.length === 0) throw new HarnessRuntimeFault("js_adapter_unavailable", "blocked", step.id)
      if (matches.length !== 1) throw new HarnessRuntimeFault("js_adapter_ambiguous", "blocked", step.id)
      context.counters.jsCalls++
      if (context.counters.jsCalls > context.limits.maxJsCalls) {
        throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
      }
      const args: HarnessJsonValue[] = []
      for (const argument of producer.args) {
        args.push(await resolveProducer(argument, context, step, attempt, depth + 1))
      }
      context.trace.push({
        type: "js_invoked",
        stepId: step.id,
        attempt,
        moduleDigest: producer.moduleDigest,
        entry: producer.entry,
        argumentCount: args.length
      })
      if (context.adapters.services === undefined) {
        throw new HarnessRuntimeFault("js_services_unavailable", "blocked", step.id)
      }
      try {
        value = await matches[0]!.invoke(args, { stepId: step.id, attempt, services: context.adapters.services })
      } catch {
        throw new HarnessRuntimeFault("js_failed", "failed", step.id)
      }
      break
    }
    default: {
      const unreachable: never = producer
      void unreachable
      throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    }
  }
  const resolved = assertJsonValue(value, context.limits.maxValueBytes)
  const dynamicPolicyCode = dynamicPolicyCodeForJson(resolved)
  if (dynamicPolicyCode !== undefined) {
    throw new HarnessRuntimeFault(dynamicPolicyCode, "blocked", step.id)
  }
  context.attemptValues.set(producer, resolved)
  return resolved
}

const resolveRecord = async (
  record: Readonly<Record<string, ValueProducer>>,
  context: ExecutionContext,
  step: HarnessStep,
  attempt: number
): Promise<Readonly<Record<string, HarnessJsonValue>>> => {
  const result: Record<string, HarnessJsonValue> = {}
  for (const name of Object.keys(record).sort()) {
    const producer = record[name]
    if (producer === undefined) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    result[name] = await resolveProducer(producer, context, step, attempt)
  }
  return result
}

const buildInitialUrl = async (
  step: HarnessStep,
  context: ExecutionContext,
  attempt: number
): Promise<string> => {
  const origin = allowedOrigin(context.artifact, step.origin)
  const pathValues = await resolveRecord(step.pathParameters, context, step, attempt)
  let path = step.path
  for (const [name, value] of Object.entries(pathValues)) {
    path = path.replaceAll(`{${name}}`, encodeURIComponent(valueAsText(value)))
    if (byteLength(path) > context.limits.maxUrlBytes) {
      throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
    }
  }
  if (/\{[^{}]+\}/u.test(path)) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
  let url: URL
  try {
    url = new URL(path, origin)
  } catch {
    throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
  }
  if (url.origin !== origin) throw new HarnessRuntimeFault("origin_not_allowed", "blocked", step.id)
  const query = await resolveRecord(step.query, context, step, attempt)
  for (const name of Object.keys(query).sort()) {
    const value = query[name]
    if (value === undefined) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    url.searchParams.set(name, valueAsText(value))
    if (byteLength(url.toString()) > context.limits.maxUrlBytes) {
      throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
    }
  }
  const serialized = url.toString()
  if (byteLength(serialized) > context.limits.maxUrlBytes) {
    throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
  }
  return serialized
}

const requestHeaders = async (
  step: HarnessStep,
  context: ExecutionContext,
  attempt: number
): Promise<Readonly<Record<string, string>>> => {
  const headers: Record<string, string> = {}
  let totalBytes = 0
  for (const name of Object.keys(step.headers).sort()) {
    const normalized = name.trim().toLowerCase()
    if (normalized.length === 0 || normalized.length > 128 || !HEADER_NAME.test(normalized)) {
      throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    }
    const producer = step.headers[name]
    if (producer === undefined) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    const value = await resolveProducer(producer, context, step, attempt)
    if (typeof value === "object") {
      throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    }
    const text = valueAsText(value)
    if (/[\u0000\r\n]/u.test(text)) throw new HarnessRuntimeFault("request_build_failed", "failed", step.id)
    totalBytes += byteLength(normalized) + byteLength(text)
    if (totalBytes > context.limits.maxRequestHeaderBytes) {
      throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
    }
    headers[normalized] = text
  }
  return headers
}

const transportCode = (
  classification: Exclude<HarnessTransportClassification, "application">
): HarnessExecutionCode => {
  switch (classification) {
    case "browser_session_required": return "browser_session_required"
    case "site_control": return "site_control_encountered"
    case "forbidden_dependency": return "forbidden_dependency"
    case "telemetry_dependency": return "telemetry_dependency"
  }
}

const redirectedMethod = (
  status: number,
  method: HarnessStep["method"]
): HarnessStep["method"] => {
  if (status === 303 && method !== "HEAD") return "GET"
  if ((status === 301 || status === 302) && method === "POST") return "GET"
  return method
}

const executeStep = async (step: HarnessStep, context: ExecutionContext): Promise<StepResponse> => {
  context.attemptValues.clear()
  context.counters.steps++
  if (context.counters.steps > context.limits.maxSteps) {
    throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
  }
  context.trace.push({
    type: "step_started",
    stepId: step.id,
    method: step.method,
    origin: step.origin,
    pathDigest: structuralDigest(step.path)
  })

  let redirectHop = 0
  let method = step.method
  let url = await buildInitialUrl(step, context, 1)

  while (true) {
    const attempt = redirectHop + 1
    // A redirect is another transport attempt. Pin shared producers within one
    // request, then recompute clocks, UUIDs, and WASM/header values for the next.
    context.attemptValues.clear()
    if (context.counters.requests >= context.limits.maxRequests) {
      throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
    }
    const body = method === "GET" || method === "HEAD" || step.body === undefined
      ? undefined
      : await resolveProducer(step.body, context, step, attempt)

    // Headers are deliberately the final values resolved before the transport effect.
    const headers = await requestHeaders(step, context, attempt)
    context.counters.requests++
    const requestIndex = context.counters.requests
    const origin = new URL(url).origin
    context.trace.push({
      type: "request_sent",
      stepId: step.id,
      attempt,
      requestIndex,
      method,
      origin,
      pathDigest: structuralDigest(step.path),
      headerNames: headerNames(headers),
      hasBody: body !== undefined,
      redirectHop
    })

    let response: HarnessTransportResponse
    try {
      const request: HarnessTransportRequest = {
        stepId: step.id,
        attempt,
        method,
        url,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body })
      }
      response = await context.adapters.transport.send(request)
    } catch {
      throw new HarnessRuntimeFault("transport_failed", "failed", step.id)
    }
    if (!Number.isSafeInteger(response.status) || response.status < 0 || response.status > 999) {
      throw new HarnessRuntimeFault("transport_failed", "failed", step.id)
    }
    const normalizedHeaders = normalizedResponseHeaders(response.headers, context.limits)
    const responseBody = response.body === undefined
      ? undefined
      : assertJsonValue(response.body, context.limits.maxValueBytes, "transport_failed")
    context.trace.push({
      type: "response_received",
      stepId: step.id,
      attempt,
      requestIndex,
      status: response.status,
      headerNames: headerNames(normalizedHeaders),
      hasBody: responseBody !== undefined,
      ...(response.classification === undefined ? {} : { classifiedAs: response.classification })
    })
    if (response.classification === undefined) {
      throw new HarnessRuntimeFault("unclassified_response", "blocked", step.id)
    }
    if (step.purpose !== "pixel" && response.classification !== "application") {
      throw new HarnessRuntimeFault(transportCode(response.classification), "blocked", step.id)
    }

    const location = normalizedHeaders.location
    const redirect = response.status >= 300 && response.status < 400 && location !== undefined
    if (!redirect) {
      if (!step.expectedStatuses.includes(response.status)) {
        throw new HarnessRuntimeFault("unexpected_status", "failed", step.id)
      }
      context.trace.push({ type: "step_completed", stepId: step.id, status: response.status })
      return {
        status: response.status,
        headers: normalizedHeaders,
        ...(responseBody === undefined ? {} : { body: responseBody })
      }
    }

    if (method !== "GET" && method !== "HEAD") {
      throw new HarnessRuntimeFault("mutating_redirect_blocked", "blocked", step.id)
    }

    redirectHop++
    context.counters.redirects++
    if (redirectHop > context.limits.maxRedirectsPerStep) {
      throw new HarnessRuntimeFault("redirect_budget_exceeded", "blocked", step.id)
    }
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new HarnessRuntimeFault("cross_origin_redirect", "blocked", step.id)
    }
    const previousOrigin = new URL(url).origin
    if (next.username.length > 0 || next.password.length > 0 ||
      next.origin !== previousOrigin || !context.artifact.allowedOrigins.includes(next.origin)) {
      throw new HarnessRuntimeFault("cross_origin_redirect", "blocked", step.id)
    }
    if (byteLength(next.toString()) > context.limits.maxUrlBytes) {
      throw new HarnessRuntimeFault("budget_exceeded", "failed", step.id)
    }
    method = redirectedMethod(response.status, method)
    url = next.toString()
    context.trace.push({
      type: "redirect_followed",
      stepId: step.id,
      attempt,
      redirectHop,
      origin: next.origin
    })
  }
}

const orderedSteps = (action: HarnessAction): ReadonlyArray<HarnessStep> => {
  const byId = new Map(action.steps.map((step) => [step.id, step] as const))
  if (byId.size !== action.steps.length) throw new HarnessRuntimeFault("step_graph_invalid")
  const remaining = new Set(action.steps.map((step) => step.id))
  const completed = new Set<string>()
  const ordered: HarnessStep[] = []
  while (remaining.size > 0) {
    let progressed = false
    for (const step of action.steps) {
      if (!remaining.has(step.id)) continue
      if (step.dependsOn.some((dependency) => !byId.has(dependency))) {
        throw new HarnessRuntimeFault("step_graph_invalid", "failed", step.id)
      }
      if (!step.dependsOn.every((dependency) => completed.has(dependency))) continue
      ordered.push(step)
      completed.add(step.id)
      remaining.delete(step.id)
      progressed = true
    }
    if (!progressed) throw new HarnessRuntimeFault("step_graph_invalid")
  }
  return ordered
}

const validateInputs = (
  action: HarnessAction,
  input: Readonly<Record<string, HarnessJsonValue>>,
  limits: HarnessRuntimeLimits
): void => {
  const serialized = jsonText(input)
  if (serialized === undefined) throw new HarnessRuntimeFault("invalid_input")
  if (byteLength(serialized) > limits.maxInputBytes) {
    throw new HarnessRuntimeFault("budget_exceeded")
  }
  try {
    assertJsonValue(input, limits.maxInputBytes, "invalid_input")
  } catch (error) {
    if (error instanceof HarnessRuntimeFault) throw error
    throw new HarnessRuntimeFault("invalid_input")
  }
  const declarations = new Map(action.inputs.map((item) => [item.name, item] as const))
  if (Object.keys(input).some((name) => !declarations.has(name))) throw new HarnessRuntimeFault("invalid_input")
  for (const declaration of action.inputs) {
    const value = input[declaration.name]
    if (value === undefined) {
      if (declaration.required) throw new HarnessRuntimeFault("invalid_input")
      continue
    }
    const matches = declaration.type === "json" ||
      (declaration.type === "string" && typeof value === "string") ||
      (declaration.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (declaration.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
      (declaration.type === "boolean" && typeof value === "boolean")
    if (!matches) throw new HarnessRuntimeFault("invalid_input")
  }
}

const countsOf = (counters: RuntimeCounters): HarnessExecutionCounts => ({ ...counters })

const terminalResult = (
  artifact: Pick<SiteHarnessArtifact, "siteId" | "version">,
  actionId: string,
  status: HarnessExecutionStatus,
  code: HarnessExecutionCode,
  trace: HarnessTraceEvent[],
  counters: RuntimeCounters,
  failedStepId?: string
): HarnessExecutionResult => {
  trace.push({
    type: "action_terminal",
    status,
    code,
    ...(failedStepId === undefined ? {} : { stepId: failedStepId })
  })
  return {
    status,
    code,
    artifact: { siteId: artifact.siteId, version: artifact.version },
    actionId,
    ...(failedStepId === undefined ? {} : { failedStepId }),
    trace: [...trace],
    counts: countsOf(counters)
  }
}

/**
 * Executes an approved declarative harness without any ambient I/O capability.
 * Concrete values exist only in this call and in the injected adapters; the
 * returned result deliberately contains no request, response, input, or header values.
 */
export const executeHarnessAction = async (
  options: ExecuteHarnessActionOptions
): Promise<HarnessExecutionResult> => {
  const trace: HarnessTraceEvent[] = []
  const counters: RuntimeCounters = {
    steps: 0,
    requests: 0,
    redirects: 0,
    producerEvaluations: 0,
    wasmCalls: 0,
    jsCalls: 0
  }
  let artifact: SiteHarnessArtifact
  try {
    artifact = validateSiteHarnessArtifact(options.artifact)
  } catch {
    return terminalResult(
      { siteId: "invalid-artifact", version: "invalid" },
      options.actionId,
      "failed",
      "invalid_artifact",
      trace,
      counters
    )
  }
  trace.push({
    type: "action_started",
    siteId: artifact.siteId,
    actionId: options.actionId,
    artifactVersion: artifact.version
  })
  const action = artifact.actions.find((candidate) => candidate.id === options.actionId)
  if (action === undefined) {
    return terminalResult(artifact, options.actionId, "failed", "unknown_action", trace, counters)
  }
  const policyCode = actionPolicyCode(action)
  if (policyCode !== undefined) {
    return terminalResult(artifact, options.actionId, "blocked", policyCode, trace, counters)
  }
  try {
    const limits = resolveHarnessRuntimeLimits(options.limits)
    validateInputs(action, options.input, limits)
    const steps = orderedSteps(action)
    if (steps.length > limits.maxSteps) throw new HarnessRuntimeFault("budget_exceeded")
    const context: ExecutionContext = {
      artifact,
      action,
      input: options.input,
      adapters: options.adapters,
      limits,
      counters,
      trace,
      responses: new Map(),
      attemptValues: new Map()
    }
    for (const step of steps) context.responses.set(step.id, await executeStep(step, context))
    return terminalResult(artifact, options.actionId, "completed", "completed", trace, counters)
  } catch (error) {
    const fault = error instanceof HarnessRuntimeFault
      ? error
      : error instanceof RangeError
        ? new HarnessRuntimeFault("invalid_limits")
        : new HarnessRuntimeFault("request_build_failed")
    return terminalResult(artifact, options.actionId, fault.status, fault.code, trace, counters, fault.stepId)
  }
}

export const runHarnessAction = executeHarnessAction
