import { createHash } from "node:crypto"
import type {
  Sha256Digest,
  SiteHarnessArtifact,
  ValueProducer
} from "./harness-artifact"
import {
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact
} from "./harness-artifact"
import type {
  ApprovedHarnessJsAdapter,
  ApprovedHarnessWasmAdapter,
  HarnessExecutionCode,
  HarnessExecutionCounts,
  HarnessExecutionResult,
  HarnessExecutionStatus,
  HarnessJsonValue,
  HarnessJsServices,
  HarnessRuntimeAdapters,
  HarnessRuntimeLimits,
  HarnessTraceEvent,
  HarnessTransportClassification,
  HarnessTransportRequest,
  HarnessTransportResponse
} from "./harness-runtime"
import {
  DEFAULT_HARNESS_RUNTIME_LIMITS,
  executeHarnessAction,
  resolveHarnessRuntimeLimits
} from "./harness-runtime"

export type HarnessCapability = "api_capable" | "browser_assisted" | "unsupported"
export type HarnessEvalCaseKind = "baseline" | "mutation" | "held_out"
export const HARNESS_EVALUATION_REVISION = "eval-001" as const

export interface ScriptedHarnessRequest {
  readonly stepId?: string
  readonly method?: HarnessTransportRequest["method"]
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: HarnessJsonValue
}

export interface ScriptedHarnessExchange {
  readonly request: ScriptedHarnessRequest
  readonly response: HarnessTransportResponse & { readonly classification: HarnessTransportClassification }
}

export interface ScriptedHarnessFetchRequest {
  readonly url?: string
  readonly method?: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}

export interface ScriptedHarnessWasmCall {
  readonly args: ReadonlyArray<HarnessJsonValue>
  readonly result?: HarnessJsonValue
  readonly throws?: boolean
}

export interface ScriptedHarnessJsCall {
  readonly args: ReadonlyArray<HarnessJsonValue>
  readonly result?: HarnessJsonValue
  readonly throws?: boolean
}

export interface ScriptedHarnessWasmExport {
  readonly moduleDigest: string
  readonly exportName: string
  readonly calls: ReadonlyArray<ScriptedHarnessWasmCall>
}

export interface ScriptedHarnessJsEntry {
  readonly moduleDigest: string
  readonly entry: string
  readonly calls: ReadonlyArray<ScriptedHarnessJsCall>
}

export interface HarnessEvalExpectation {
  readonly status: HarnessExecutionStatus
  readonly code?: HarnessExecutionCode
  readonly requests?: number
}

export interface HarnessEvalCase {
  readonly id: string
  readonly kind: HarnessEvalCaseKind
  readonly actionId: string
  readonly input: Readonly<Record<string, HarnessJsonValue>>
  readonly exchanges: ReadonlyArray<ScriptedHarnessExchange>
  readonly clockValues?: ReadonlyArray<Date | string | number>
  readonly uuidValues?: ReadonlyArray<string>
  readonly wasm?: ReadonlyArray<ScriptedHarnessWasmExport>
  readonly js?: ReadonlyArray<ScriptedHarnessJsEntry>
  /** Scripted `services.fetch` queue consumed in order by bundle-initiated calls. */
  readonly fetch?: ReadonlyArray<ScriptedHarnessFetchRequest>
  readonly expected?: HarnessEvalExpectation
}

export interface HarnessEvalLimits {
  readonly maxCases: number
  readonly maxMutationCases: number
  readonly maxRuns: number
  readonly maxScriptedExchangesPerCase: number
  readonly maxCaseBytes: number
  readonly maxTotalCaseBytes: number
  readonly maxTotalRequests: number
  readonly maxTotalSteps: number
  readonly maxTotalProducerEvaluations: number
  readonly maxTotalWasmCalls: number
  readonly maxTotalJsCalls: number
  readonly requireBaselineCase: boolean
  readonly requireMutationCase: boolean
  readonly requireHeldOutCase: boolean
}

export const DEFAULT_HARNESS_EVAL_LIMITS: HarnessEvalLimits = Object.freeze({
  maxCases: 64,
  maxMutationCases: 48,
  maxRuns: 128,
  maxScriptedExchangesPerCase: 96,
  maxCaseBytes: 2 * 1024 * 1024,
  maxTotalCaseBytes: 32 * 1024 * 1024,
  maxTotalRequests: 2_048,
  maxTotalSteps: 4_096,
  maxTotalProducerEvaluations: 100_000,
  maxTotalWasmCalls: 2_048,
  maxTotalJsCalls: 2_048,
  requireBaselineCase: true,
  requireMutationCase: true,
  requireHeldOutCase: true
})

export interface EvaluateHarnessArtifactOptions {
  readonly artifact: SiteHarnessArtifact | unknown
  readonly cases: ReadonlyArray<HarnessEvalCase>
  readonly limits?: Partial<HarnessEvalLimits>
  readonly runtimeLimits?: Partial<HarnessRuntimeLimits>
  /**
   * Optional controller-supplied adapters (e.g. real modules from the store).
   * They merge with any scripted case wasm; a duplicate digest/export pair stays
   * ambiguous in the executor and fails closed.
   */
  readonly wasm?: ReadonlyArray<ApprovedHarnessWasmAdapter>
  /** Real site-js modules from the store, same merge rules as `wasm`. */
  readonly js?: ReadonlyArray<ApprovedHarnessJsAdapter>
}

export type HarnessSafetyFindingCode =
  | "embedded_secret"
  | "site_control_dependency"
  | "telemetry_dependency"
  | "forbidden_header"
  | "unreviewed_constant"

export interface HarnessSafetyFinding {
  readonly code: HarnessSafetyFindingCode
  /** Schema path only. The matching value is deliberately not returned. */
  readonly path: string
}

export type HarnessEvalCaseCode =
  | "passed"
  | "result_mismatch"
  | "request_count_mismatch"
  | "script_not_consumed"
  | "transport_expectation_mismatch"
  | "wasm_script_not_consumed"
  | "wasm_expectation_mismatch"
  | "js_script_not_consumed"
  | "js_expectation_mismatch"
  | "fetch_script_not_consumed"
  | "fetch_expectation_mismatch"
  | "nondeterministic_replay"
  | "evaluation_budget_exceeded"

export interface HarnessEvalCaseReport {
  readonly id: string
  readonly kind: HarnessEvalCaseKind
  readonly actionId: string
  readonly passed: boolean
  readonly deterministic: boolean
  readonly code: HarnessEvalCaseCode
  readonly execution: {
    readonly status: HarnessExecutionStatus
    readonly code: HarnessExecutionCode
    readonly counts: HarnessExecutionCounts
    readonly trace: ReadonlyArray<HarnessTraceEvent>
  }
}

export type HarnessEvalGateId =
  | "artifact_valid"
  | "no_forbidden_capabilities"
  | "case_set_within_budget"
  | "baseline_coverage"
  | "mutation_coverage"
  | "held_out_coverage"
  | "deterministic_replay"
  | "case_expectations"
  | "runtime_budget"

export interface HarnessEvalGate {
  readonly id: HarnessEvalGateId
  readonly passed: boolean
}

export interface HarnessEvaluationUsage {
  readonly runs: number
  readonly requests: number
  readonly steps: number
  readonly producerEvaluations: number
  readonly wasmCalls: number
  readonly jsCalls: number
}

export interface HarnessEvaluationReport {
  readonly evaluationRevision: typeof HARNESS_EVALUATION_REVISION
  readonly evidenceDigest: Sha256Digest
  readonly capability: HarnessCapability
  readonly eligibleForPromotion: boolean
  readonly contract: {
    readonly caseSetDigest: Sha256Digest
    readonly evalLimits: HarnessEvalLimits
    readonly runtimeLimits: HarnessRuntimeLimits
  }
  readonly artifact?: {
    readonly siteId: string
    readonly version: string
    readonly digest: Sha256Digest
  }
  readonly gates: ReadonlyArray<HarnessEvalGate>
  readonly safetyFindings: ReadonlyArray<HarnessSafetyFinding>
  readonly cases: ReadonlyArray<HarnessEvalCaseReport>
  readonly usage: HarnessEvaluationUsage
}

export interface HarnessEvaluationAttestation {
  readonly schemaVersion: 1
  readonly evaluationRevision: typeof HARNESS_EVALUATION_REVISION
  readonly evidenceDigest: Sha256Digest
  readonly capability: HarnessCapability
  readonly eligibleForPromotion: boolean
  readonly artifact: {
    readonly siteId: string
    readonly version: string
    readonly digest: Sha256Digest
  }
  readonly contract: HarnessEvaluationReport["contract"]
  readonly gates: ReadonlyArray<HarnessEvalGate>
  readonly safetyFindingCodes: ReadonlyArray<HarnessSafetyFindingCode>
  readonly cases: ReadonlyArray<{
    readonly caseDigest: Sha256Digest
    readonly kind: HarnessEvalCaseKind
    readonly passed: boolean
    readonly deterministic: boolean
    readonly code: HarnessEvalCaseCode
    readonly executionStatus: HarnessExecutionStatus
    readonly executionCode: HarnessExecutionCode
    readonly counts: HarnessExecutionCounts
    readonly traceDigest: Sha256Digest
  }>
  readonly usage: HarnessEvaluationUsage
}

interface ScriptAudit {
  readonly transportConsumed: boolean
  readonly transportFailure?: "transport_expectation_mismatch"
  readonly wasmConsumed: boolean
  readonly wasmFailure?: "wasm_expectation_mismatch"
  readonly jsConsumed: boolean
  readonly jsFailure?: "js_expectation_mismatch"
  readonly fetchConsumed: boolean
  readonly fetchFailure?: "fetch_expectation_mismatch"
}

export interface ScriptedHarnessEnvironment {
  readonly adapters: HarnessRuntimeAdapters
  audit(): ScriptAudit
}

class ScriptMismatch extends Error {
  constructor() {
    super("script mismatch")
    this.name = "ScriptMismatch"
  }
}

const integerLimit = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  return value
}
const booleanLimit = (value: boolean | undefined, fallback: boolean, name: string): boolean => {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new RangeError(`${name} must be a boolean`)
  return value
}

export const resolveHarnessEvalLimits = (override: Partial<HarnessEvalLimits> | undefined): HarnessEvalLimits => ({
  maxCases: integerLimit(override?.maxCases, DEFAULT_HARNESS_EVAL_LIMITS.maxCases, "maxCases"),
  maxMutationCases: integerLimit(
    override?.maxMutationCases,
    DEFAULT_HARNESS_EVAL_LIMITS.maxMutationCases,
    "maxMutationCases"
  ),
  maxRuns: integerLimit(override?.maxRuns, DEFAULT_HARNESS_EVAL_LIMITS.maxRuns, "maxRuns"),
  maxScriptedExchangesPerCase: integerLimit(
    override?.maxScriptedExchangesPerCase,
    DEFAULT_HARNESS_EVAL_LIMITS.maxScriptedExchangesPerCase,
    "maxScriptedExchangesPerCase"
  ),
  maxCaseBytes: integerLimit(override?.maxCaseBytes, DEFAULT_HARNESS_EVAL_LIMITS.maxCaseBytes, "maxCaseBytes"),
  maxTotalCaseBytes: integerLimit(
    override?.maxTotalCaseBytes,
    DEFAULT_HARNESS_EVAL_LIMITS.maxTotalCaseBytes,
    "maxTotalCaseBytes"
  ),
  maxTotalRequests: integerLimit(
    override?.maxTotalRequests,
    DEFAULT_HARNESS_EVAL_LIMITS.maxTotalRequests,
    "maxTotalRequests"
  ),
  maxTotalSteps: integerLimit(override?.maxTotalSteps, DEFAULT_HARNESS_EVAL_LIMITS.maxTotalSteps, "maxTotalSteps"),
  maxTotalProducerEvaluations: integerLimit(
    override?.maxTotalProducerEvaluations,
    DEFAULT_HARNESS_EVAL_LIMITS.maxTotalProducerEvaluations,
    "maxTotalProducerEvaluations"
  ),
  maxTotalWasmCalls: integerLimit(
    override?.maxTotalWasmCalls,
    DEFAULT_HARNESS_EVAL_LIMITS.maxTotalWasmCalls,
    "maxTotalWasmCalls"
  ),
  maxTotalJsCalls: integerLimit(
    override?.maxTotalJsCalls,
    DEFAULT_HARNESS_EVAL_LIMITS.maxTotalJsCalls,
    "maxTotalJsCalls"
  ),
  requireBaselineCase: booleanLimit(
    override?.requireBaselineCase,
    DEFAULT_HARNESS_EVAL_LIMITS.requireBaselineCase,
    "requireBaselineCase"
  ),
  requireMutationCase: booleanLimit(
    override?.requireMutationCase,
    DEFAULT_HARNESS_EVAL_LIMITS.requireMutationCase,
    "requireMutationCase"
  ),
  requireHeldOutCase: booleanLimit(
    override?.requireHeldOutCase,
    DEFAULT_HARNESS_EVAL_LIMITS.requireHeldOutCase,
    "requireHeldOutCase"
  )
})

const jsonText = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

const canonicalEvidence = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("evaluation evidence contains a non-finite number")
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`
  if (typeof value !== "object" || value === null) throw new Error("evaluation evidence is not JSON")
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map((key) => {
    const child = record[key]
    if (child === undefined) throw new Error("evaluation evidence contains undefined")
    return `${JSON.stringify(key)}:${canonicalEvidence(child)}`
  }).join(",")}}`
}

const comparableJson = (value: unknown): string | undefined => {
  const encoded = jsonText(value)
  if (encoded === undefined) return undefined
  try {
    return canonicalEvidence(JSON.parse(encoded))
  } catch {
    return undefined
  }
}

const sameJson = (left: unknown, right: unknown): boolean => comparableJson(left) === comparableJson(right)

const normalizedHeaders = (headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]): [string, string] => [name.toLowerCase(), value]).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0))

const requestMatches = (expected: ScriptedHarnessRequest, actual: HarnessTransportRequest): boolean => {
  if (expected.stepId !== undefined && expected.stepId !== actual.stepId) return false
  if (expected.method !== undefined && expected.method !== actual.method) return false
  if (expected.url !== undefined && expected.url !== actual.url) return false
  if (expected.headers !== undefined && !sameJson(normalizedHeaders(expected.headers), normalizedHeaders(actual.headers))) {
    return false
  }
  if (Object.hasOwn(expected, "body") && !sameJson(expected.body, actual.body)) return false
  return true
}

const generatedUuid = (index: number): string => {
  const suffix = Math.max(1, index + 1).toString(16).padStart(12, "0").slice(-12)
  return `00000000-0000-4000-8000-${suffix}`
}

/** Creates fresh, stateful fake adapters. It has no path to global fetch or ambient time/randomness. */
export const createScriptedHarnessEnvironment = (testCase: HarnessEvalCase): ScriptedHarnessEnvironment => {
  let exchangeIndex = 0
  let transportFailure = false
  let clockIndex = 0
  let uuidIndex = 0
  let fetchIndex = 0
  let fetchFailure = false
  const wasmIndices = new Map<number, number>()
  const jsIndices = new Map<number, number>()
  let wasmFailure = false
  let jsFailure = false

  const jsAdapters: ApprovedHarnessJsAdapter[] = (testCase.js ?? []).map((script, scriptIndex) => ({
    moduleDigest: script.moduleDigest,
    entry: script.entry,
    invoke: (args) => {
      const callIndex = jsIndices.get(scriptIndex) ?? 0
      const call = script.calls[callIndex]
      jsIndices.set(scriptIndex, callIndex + 1)
      if (call === undefined || !sameJson(call.args, args)) {
        jsFailure = true
        throw new ScriptMismatch()
      }
      if (call.throws === true) throw new ScriptMismatch()
      if (!Object.hasOwn(call, "result") || call.result === undefined) {
        jsFailure = true
        throw new ScriptMismatch()
      }
      return call.result
    }
  }))

  const scriptedFetch = async (url: string, init: { readonly method: string }): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown }> => {
    const item = testCase.fetch?.[fetchIndex]
    fetchIndex += 1
    if (item === undefined ||
      (item.url !== undefined && item.url !== url) ||
      (item.method !== undefined && item.method !== init.method)) {
      fetchFailure = true
      throw new ScriptMismatch()
    }
    return {
      status: item.status,
      headers: { ...(item.headers ?? {}) },
      ...(item.body === undefined ? {} : { body: item.body })
    }
  }

  const scriptedNow = (): Date | string | number => {
    if (testCase.clockValues === undefined) return "2000-01-01T00:00:00.000Z"
    const value = testCase.clockValues[clockIndex]
    clockIndex += 1
    if (value === undefined) throw new ScriptMismatch()
    return value
  }
  const scriptedUuid = (): string => {
    if (testCase.uuidValues === undefined) return generatedUuid(uuidIndex++)
    const value = testCase.uuidValues[uuidIndex]
    uuidIndex += 1
    if (value === undefined) throw new ScriptMismatch()
    return value
  }
  const services: HarnessJsServices = {
    now: scriptedNow,
    uuid: scriptedUuid,
    fetch: scriptedFetch,
    log: (line) => {
      void line
    }
  }

  const wasmAdapters: ApprovedHarnessWasmAdapter[] = (testCase.wasm ?? []).map((script, scriptIndex) => ({
    moduleDigest: script.moduleDigest,
    exportName: script.exportName,
    invoke: (args) => {
      const callIndex = wasmIndices.get(scriptIndex) ?? 0
      const call = script.calls[callIndex]
      wasmIndices.set(scriptIndex, callIndex + 1)
      if (call === undefined || !sameJson(call.args, args)) {
        wasmFailure = true
        throw new ScriptMismatch()
      }
      if (call.throws === true) throw new ScriptMismatch()
      if (!Object.hasOwn(call, "result") || call.result === undefined) {
        wasmFailure = true
        throw new ScriptMismatch()
      }
      return call.result
    }
  }))

  const adapters: HarnessRuntimeAdapters = {
    transport: {
      send: (request) => {
        const exchange = testCase.exchanges[exchangeIndex]
        exchangeIndex++
        if (exchange === undefined || !requestMatches(exchange.request, request)) {
          transportFailure = true
          throw new ScriptMismatch()
        }
        return exchange.response
      }
    },
    clock: {
      now: () => {
        if (testCase.clockValues === undefined) return "2000-01-01T00:00:00.000Z"
        const value = testCase.clockValues[clockIndex]
        clockIndex++
        if (value === undefined) throw new ScriptMismatch()
        return value
      }
    },
    uuid: {
      next: () => {
        if (testCase.uuidValues === undefined) return generatedUuid(uuidIndex++)
        const value = testCase.uuidValues[uuidIndex]
        uuidIndex++
        if (value === undefined) throw new ScriptMismatch()
        return value
      }
    },
    ...(jsAdapters.length === 0 ? {} : { js: jsAdapters }),
    ...(wasmAdapters.length === 0 ? {} : { wasm: wasmAdapters }),
    services
  }

  return {
    adapters,
    audit: () => ({
      transportConsumed: exchangeIndex === testCase.exchanges.length,
      ...(transportFailure ? { transportFailure: "transport_expectation_mismatch" as const } : {}),
      wasmConsumed: (testCase.wasm ?? []).every((script, index) =>
        (wasmIndices.get(index) ?? 0) === script.calls.length),
      ...(wasmFailure ? { wasmFailure: "wasm_expectation_mismatch" as const } : {}),
      jsConsumed: (testCase.js ?? []).every((script, index) =>
        (jsIndices.get(index) ?? 0) === script.calls.length),
      ...(jsFailure ? { jsFailure: "js_expectation_mismatch" as const } : {}),
      ...(testCase.fetch !== undefined
        ? {
            fetchConsumed: fetchIndex === testCase.fetch.length,
            ...(fetchFailure ? { fetchFailure: "fetch_expectation_mismatch" as const } : {})
          }
        : { fetchConsumed: fetchIndex === 0 })
    })
  }
}

const SECRET = /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b|\b[A-Za-z0-9_+/=-]{48,}\b)/iu
const SITE_CONTROL = /(?:anti[-_]?bot|captcha|challenge|fingerprint|proof[-_]?of[-_]?work|sensor[-_]?data)/iu
const TELEMETRY = /(?:analytics|beacon|pixel|telemetry|tracking)/iu
const SENSITIVE_LITERAL = /(?:^|[-_./])(?:bearer|secret|password|private[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|csrf[-_]?token)(?:$|[-_./])/iu
const FORBIDDEN_HEADER = /^(?:authorization|cookie|proxy-authorization|user-agent|x-api-key|x-client-data)$/iu
const FORBIDDEN_HEADER_PREFIX = /^(?:akamai-|cf-|sec-|x-(?:akamai|arkose|bot|browser|captcha|challenge|datadome|device|fingerprint|forwarded|kpsdk)-)/iu
const REVIEWED_PROTOCOL_CONSTANTS: Readonly<Record<string, ReadonlySet<string>>> = {
  accept: new Set(["*/*", "application/json", "application/problem+json", "text/plain"]),
  "content-type": new Set([
    "application/json",
    "application/json; charset=utf-8",
    "application/x-www-form-urlencoded",
    "text/plain",
    "text/plain; charset=utf-8"
  ])
}

const findingKey = (finding: HarnessSafetyFinding): string => `${finding.code}:${finding.path}`

const addTextFinding = (
  findings: HarnessSafetyFinding[],
  value: string,
  path: string
): void => {
  if (SECRET.test(value)) findings.push({ code: "embedded_secret", path })
  if (SENSITIVE_LITERAL.test(value)) findings.push({ code: "embedded_secret", path })
  if (SITE_CONTROL.test(value)) findings.push({ code: "site_control_dependency", path })
  if (TELEMETRY.test(value)) findings.push({ code: "telemetry_dependency", path })
}

const inspectConstant = (value: HarnessJsonValue, path: string, findings: HarnessSafetyFinding[]): void => {
  if (typeof value === "string") {
    addTextFinding(findings, value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectConstant(item, `${path}[${index}]`, findings))
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [index, [name, child]] of Object.entries(value).entries()) {
    const childPath = `${path}.fields[${index}]`
    addTextFinding(findings, name, childPath)
    inspectConstant(child, childPath, findings)
  }
}

const inspectProducer = (
  producer: ValueProducer,
  path: string,
  findings: HarnessSafetyFinding[],
  protocolHeader?: string
): void => {
  switch (producer.kind) {
    case "input":
      addTextFinding(findings, producer.name, `${path}.name`)
      return
    case "clock":
    case "uuid":
      return
    case "response_header":
      addTextFinding(findings, producer.name, `${path}.name`)
      return
    case "response_json":
      addTextFinding(findings, producer.pointer, `${path}.pointer`)
      return
    case "constant":
      if (typeof producer.value !== "string" || protocolHeader === undefined ||
        REVIEWED_PROTOCOL_CONSTANTS[protocolHeader]?.has(producer.value.toLowerCase()) !== true) {
        findings.push({ code: "unreviewed_constant", path })
      }
      inspectConstant(producer.value as HarnessJsonValue, `${path}.value`, findings)
      return
    case "object":
      for (const [index, [name, field]] of Object.entries(producer.fields).entries()) {
        const fieldPath = `${path}.fields[${index}]`
        addTextFinding(findings, name, fieldPath)
        inspectProducer(field, fieldPath, findings)
      }
      return
    case "array":
      producer.items.forEach((item, index) => inspectProducer(item, `${path}.items[${index}]`, findings))
      return
    case "wasm":
      addTextFinding(findings, producer.export, `${path}.export`)
      producer.args.forEach((item, index) => inspectProducer(item, `${path}.args[${index}]`, findings))
      return
    case "js":
      addTextFinding(findings, producer.entry, `${path}.entry`)
      producer.args.forEach((item, index) => inspectProducer(item, `${path}.args[${index}]`, findings))
      return
  }
}

/** A conservative static policy scan; findings are hard gates, never scoreable trade-offs. */
export const findHarnessSafetyViolations = (artifact: SiteHarnessArtifact): ReadonlyArray<HarnessSafetyFinding> => {
  const findings: HarnessSafetyFinding[] = []
  artifact.allowedOrigins.forEach((origin, index) => addTextFinding(findings, origin, `$.allowedOrigins[${index}]`))
  artifact.actions.forEach((action, actionIndex) => {
    addTextFinding(findings, action.id, `$.actions[${actionIndex}].id`)
    action.inputs.forEach((input, inputIndex) =>
      addTextFinding(findings, input.name, `$.actions[${actionIndex}].inputs[${inputIndex}].name`))
    action.steps.forEach((step, stepIndex) => {
      const base = `$.actions[${actionIndex}].steps[${stepIndex}]`
      addTextFinding(findings, step.id, `${base}.id`)
      addTextFinding(findings, step.path, `${base}.path`)
      for (const [index, [name, producer]] of Object.entries(step.pathParameters).entries()) {
        const bindingPath = `${base}.pathParameters[${index}]`
        addTextFinding(findings, name, bindingPath)
        inspectProducer(producer, bindingPath, findings)
      }
      for (const [index, [name, producer]] of Object.entries(step.query).entries()) {
        const bindingPath = `${base}.query[${index}]`
        addTextFinding(findings, name, bindingPath)
        inspectProducer(producer, bindingPath, findings)
      }
      for (const [index, [name, producer]] of Object.entries(step.headers).entries()) {
        const bindingPath = `${base}.headers[${index}]`
        if (FORBIDDEN_HEADER.test(name) || FORBIDDEN_HEADER_PREFIX.test(name)) {
          findings.push({ code: "forbidden_header", path: bindingPath })
        }
        addTextFinding(findings, name, bindingPath)
        const lower = name.toLowerCase()
        inspectProducer(producer, bindingPath, findings,
          lower === "accept" || lower === "content-type" ? lower : undefined)
      }
      if (step.body !== undefined) inspectProducer(step.body, `${base}.body`, findings)
    })
  })
  const unique = new Map(findings.map((finding) => [findingKey(finding), finding] as const))
  return [...unique.values()].sort((left, right) => findingKey(left).localeCompare(findingKey(right)))
}

const inspectCaseValue = (
  value: HarnessJsonValue,
  path: string,
  findings: HarnessSafetyFinding[]
): void => {
  if (typeof value === "string") {
    addTextFinding(findings, value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectCaseValue(item, `${path}[${index}]`, findings))
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [index, [name, child]] of Object.entries(value).entries()) {
    const childPath = `${path}.fields[${index}]`
    addTextFinding(findings, name, childPath)
    inspectCaseValue(child, childPath, findings)
  }
}

/** Scans concrete offline fixtures without ever returning their keys or values. */
export const findHarnessCaseSafetyViolations = (
  cases: ReadonlyArray<HarnessEvalCase>
): ReadonlyArray<HarnessSafetyFinding> => {
  const findings: HarnessSafetyFinding[] = []
  cases.forEach((testCase, caseIndex) => {
    const base = `$.cases[${caseIndex}]`
    inspectCaseValue(testCase.input, `${base}.input`, findings)
    testCase.exchanges.forEach((exchange, exchangeIndex) => {
      const exchangePath = `${base}.exchanges[${exchangeIndex}]`
      if (exchange.request.url !== undefined) addTextFinding(findings, exchange.request.url, `${exchangePath}.request.url`)
      Object.entries(exchange.request.headers ?? {}).forEach(([name, value], headerIndex) => {
        const headerPath = `${exchangePath}.request.headers[${headerIndex}]`
        addTextFinding(findings, name, headerPath)
        addTextFinding(findings, value, headerPath)
      })
      if (exchange.request.body !== undefined) inspectCaseValue(exchange.request.body, `${exchangePath}.request.body`, findings)
      Object.entries(exchange.response.headers).forEach(([name, value], headerIndex) => {
        const headerPath = `${exchangePath}.response.headers[${headerIndex}]`
        addTextFinding(findings, name, headerPath)
        addTextFinding(findings, value, headerPath)
      })
      if (exchange.response.body !== undefined) inspectCaseValue(exchange.response.body, `${exchangePath}.response.body`, findings)
    })
    testCase.wasm?.forEach((script, scriptIndex) => {
      const scriptPath = `${base}.wasm[${scriptIndex}]`
      addTextFinding(findings, script.exportName, `${scriptPath}.export`)
      script.calls.forEach((call, callIndex) => {
        call.args.forEach((argument, argumentIndex) =>
          inspectCaseValue(argument, `${scriptPath}.calls[${callIndex}].args[${argumentIndex}]`, findings))
        if (call.result !== undefined) inspectCaseValue(call.result, `${scriptPath}.calls[${callIndex}].result`, findings)
      })
    })
    testCase.fetch?.forEach((item, itemIndex) => {
      const fetchPath = `${base}.fetch[${itemIndex}]`
      if (item.url !== undefined) addTextFinding(findings, item.url, `${fetchPath}.url`)
      Object.entries(item.headers ?? {}).forEach(([name, value]) => {
        addTextFinding(findings, name, `${fetchPath}.headers.${name}`)
        addTextFinding(findings, value, `${fetchPath}.headers.${name}`)
      })
      if (item.body !== undefined) inspectCaseValue(item.body as HarnessJsonValue, `${fetchPath}.body`, findings)
    })
    testCase.js?.forEach((script, scriptIndex) => {
      const scriptPath = `${base}.js[${scriptIndex}]`
      addTextFinding(findings, script.entry, `${scriptPath}.entry`)
      script.calls.forEach((call, callIndex) => {
        call.args.forEach((argument, argumentIndex) =>
          inspectCaseValue(argument, `${scriptPath}.calls[${callIndex}].args[${argumentIndex}]`, findings))
        if (call.result !== undefined) inspectCaseValue(call.result, `${scriptPath}.calls[${callIndex}].result`, findings)
      })
    })
  })
  const unique = new Map(findings.map((finding) => [findingKey(finding), finding] as const))
  return [...unique.values()].sort((left, right) => findingKey(left).localeCompare(findingKey(right)))
}

interface SingleRun {
  readonly result: HarnessExecutionResult
  readonly audit: ScriptAudit
}

const runOnce = async (
  artifact: SiteHarnessArtifact,
  testCase: HarnessEvalCase,
  limits: Partial<HarnessRuntimeLimits> | undefined,
  extraWasm: ReadonlyArray<ApprovedHarnessWasmAdapter> | undefined,
  extraJs: ReadonlyArray<ApprovedHarnessJsAdapter> | undefined
): Promise<SingleRun> => {
  const environment = createScriptedHarnessEnvironment(testCase)
  const wasm = extraWasm === undefined || extraWasm.length === 0
    ? environment.adapters.wasm
    : [...(environment.adapters.wasm ?? []), ...extraWasm]
  const js = extraJs === undefined || extraJs.length === 0
    ? environment.adapters.js
    : [...(environment.adapters.js ?? []), ...extraJs]
  const adapters: HarnessRuntimeAdapters = {
    ...environment.adapters,
    ...(wasm === undefined ? {} : { wasm }),
    ...(js === undefined ? {} : { js })
  }
  const result = await executeHarnessAction({
    artifact,
    actionId: testCase.actionId,
    input: testCase.input,
    adapters,
    ...(limits === undefined ? {} : { limits })
  })
  return { result, audit: environment.audit() }
}

const expectedCode = (expected: HarnessEvalExpectation | undefined): HarnessExecutionCode | undefined => {
  if (expected?.code !== undefined) return expected.code
  return expected?.status === undefined || expected.status === "completed" ? "completed" : undefined
}

const auditCode = (audit: ScriptAudit): HarnessEvalCaseCode | undefined => {
  if (audit.transportFailure !== undefined) return audit.transportFailure
  if (!audit.transportConsumed) return "script_not_consumed"
  if (audit.wasmFailure !== undefined) return audit.wasmFailure
  if (!audit.wasmConsumed) return "wasm_script_not_consumed"
  if (audit.jsFailure !== undefined) return audit.jsFailure
  if (!audit.jsConsumed) return "js_script_not_consumed"
  if (audit.fetchFailure !== undefined) return audit.fetchFailure
  if (!audit.fetchConsumed) return "fetch_script_not_consumed"
  return undefined
}

const reportForCase = (
  testCase: HarnessEvalCase,
  first: SingleRun,
  second: SingleRun
): HarnessEvalCaseReport => {
  const deterministic = sameJson(first, second)
  const expectedStatus = testCase.expected?.status ?? "completed"
  const code = expectedCode(testCase.expected)
  let resultCode: HarnessEvalCaseCode = "passed"
  const firstAuditCode = auditCode(first.audit)
  const secondAuditCode = auditCode(second.audit)
  if (!deterministic) resultCode = "nondeterministic_replay"
  else if (firstAuditCode !== undefined) resultCode = firstAuditCode
  else if (secondAuditCode !== undefined) resultCode = secondAuditCode
  else if (first.result.status !== expectedStatus || (code !== undefined && first.result.code !== code)) {
    resultCode = "result_mismatch"
  } else if (testCase.expected?.requests !== undefined && first.result.counts.requests !== testCase.expected.requests) {
    resultCode = "request_count_mismatch"
  }
  return {
    id: testCase.id,
    kind: testCase.kind,
    actionId: testCase.actionId,
    passed: resultCode === "passed",
    deterministic,
    code: resultCode,
    execution: {
      status: first.result.status,
      code: first.result.code,
      counts: first.result.counts,
      trace: first.result.trace
    }
  }
}

const emptyUsage = (): HarnessEvaluationUsage => ({
  runs: 0,
  requests: 0,
  steps: 0,
  producerEvaluations: 0,
  wasmCalls: 0,
  jsCalls: 0
})

const addUsage = (usage: HarnessEvaluationUsage, counts: HarnessExecutionCounts): HarnessEvaluationUsage => ({
  runs: usage.runs + 1,
  requests: usage.requests + counts.requests,
  steps: usage.steps + counts.steps,
  producerEvaluations: usage.producerEvaluations + counts.producerEvaluations,
  wasmCalls: usage.wasmCalls + counts.wasmCalls,
  jsCalls: usage.jsCalls + counts.jsCalls
})

const withinRuntimeBudget = (usage: HarnessEvaluationUsage, limits: HarnessEvalLimits): boolean =>
  usage.runs <= limits.maxRuns &&
  usage.requests <= limits.maxTotalRequests &&
  usage.steps <= limits.maxTotalSteps &&
  usage.producerEvaluations <= limits.maxTotalProducerEvaluations &&
  usage.wasmCalls <= limits.maxTotalWasmCalls &&
  usage.jsCalls <= limits.maxTotalJsCalls

const encodedBytes = (value: unknown): number | undefined => {
  const encoded = jsonText(value)
  return encoded === undefined ? undefined : new TextEncoder().encode(encoded).byteLength
}

export const harnessEvaluationCaseSetDigest = (cases: ReadonlyArray<HarnessEvalCase>): Sha256Digest => {
  const canonical = comparableJson(cases) ?? "invalid-case-set"
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}

const caseSetWithinBudget = (cases: ReadonlyArray<HarnessEvalCase>, limits: HarnessEvalLimits): boolean => {
  const sizes = cases.map(encodedBytes)
  return cases.length > 0 &&
  cases.length <= limits.maxCases &&
  new Set(cases.map((testCase) => testCase.id)).size === cases.length &&
  cases.every((testCase) => testCase.id.length > 0 && testCase.id.length <= 128) &&
  sizes.every((size) => size !== undefined && size <= limits.maxCaseBytes) &&
  sizes.reduce<number>((total, size) => total + (size ?? limits.maxTotalCaseBytes + 1), 0) <= limits.maxTotalCaseBytes &&
  cases.filter((testCase) => testCase.kind === "mutation").length <= limits.maxMutationCases &&
  cases.length * 2 <= limits.maxRuns &&
  cases.every((testCase) => testCase.exchanges.length <= limits.maxScriptedExchangesPerCase) &&
  cases.reduce((total, testCase) => total + testCase.exchanges.length * 2, 0) <= limits.maxTotalRequests
}

const dynamicStimulusOf = (testCase: HarnessEvalCase): unknown => ({
  input: testCase.input,
  responses: testCase.exchanges.map((exchange) => exchange.response),
  clockValues: testCase.clockValues ?? [],
  uuidValues: testCase.uuidValues ?? [],
  wasm: testCase.wasm ?? []
})

const concreteRequestsOf = (testCase: HarnessEvalCase): unknown =>
  testCase.exchanges.map((exchange) => ({
    ...(exchange.request.url === undefined ? {} : { url: exchange.request.url }),
    ...(exchange.request.headers === undefined ? {} : { headers: normalizedHeaders(exchange.request.headers) }),
    ...(Object.hasOwn(exchange.request, "body") ? { body: exchange.request.body } : {})
  }))

const hasConcreteRequestExpectation = (testCase: HarnessEvalCase): boolean =>
  testCase.exchanges.some((exchange) => exchange.request.url !== undefined ||
    exchange.request.headers !== undefined || Object.hasOwn(exchange.request, "body"))

const baselineCoverageFor = (artifact: SiteHarnessArtifact, cases: ReadonlyArray<HarnessEvalCase>): boolean =>
  artifact.actions.every((action) => cases.some((testCase) =>
    testCase.kind === "baseline" && testCase.actionId === action.id))

const heldOutCoverageFor = (artifact: SiteHarnessArtifact, cases: ReadonlyArray<HarnessEvalCase>): boolean =>
  artifact.actions.every((action) => cases.some((testCase) =>
    testCase.kind === "held_out" && testCase.actionId === action.id))

type DynamicSink =
  | { readonly stepId: string; readonly location: "path"; readonly name: string }
  | { readonly stepId: string; readonly location: "query"; readonly name: string }
  | { readonly stepId: string; readonly location: "header"; readonly name: string }
  | { readonly stepId: string; readonly location: "body"; readonly path: ReadonlyArray<string | number> }

const dynamicProducersIn = (producer: ValueProducer): ReadonlyArray<ValueProducer> => {
  switch (producer.kind) {
    case "constant": return []
    case "object": return Object.values(producer.fields).flatMap(dynamicProducersIn)
    case "array": return producer.items.flatMap(dynamicProducersIn)
    case "wasm": return [producer, ...producer.args.flatMap(dynamicProducersIn)]
    case "js": return [producer, ...producer.args.flatMap(dynamicProducersIn)]
    default: return [producer]
  }
}

const hasDynamicProducer = (producer: ValueProducer): boolean => dynamicProducersIn(producer).length > 0

const bodyDynamicSinks = (
  stepId: string,
  producer: ValueProducer,
  path: ReadonlyArray<string | number> = []
): ReadonlyArray<DynamicSink> => {
  if (producer.kind === "constant") return []
  if (producer.kind === "object") return Object.entries(producer.fields)
    .flatMap(([name, field]) => bodyDynamicSinks(stepId, field, [...path, name]))
  if (producer.kind === "array") return producer.items
    .flatMap((item, index) => bodyDynamicSinks(stepId, item, [...path, index]))
  return [{ stepId, location: "body", path }]
}

const actionDynamicProducers = (action: SiteHarnessArtifact["actions"][number]): ReadonlyArray<ValueProducer> =>
  action.steps.flatMap((step) => [
    ...Object.values(step.pathParameters),
    ...Object.values(step.query),
    ...Object.values(step.headers),
    ...(step.body === undefined ? [] : [step.body])
  ].flatMap(dynamicProducersIn))

const actionDynamicSinks = (action: SiteHarnessArtifact["actions"][number]): ReadonlyArray<DynamicSink> =>
  action.steps.flatMap((step) => [
    ...Object.entries(step.pathParameters).flatMap(([name, producer]): ReadonlyArray<DynamicSink> =>
      hasDynamicProducer(producer) ? [{ stepId: step.id, location: "path", name }] : []),
    ...Object.entries(step.query).flatMap(([name, producer]): ReadonlyArray<DynamicSink> =>
      hasDynamicProducer(producer) ? [{ stepId: step.id, location: "query", name }] : []),
    ...Object.entries(step.headers).flatMap(([name, producer]): ReadonlyArray<DynamicSink> =>
      hasDynamicProducer(producer) ? [{ stepId: step.id, location: "header", name: name.toLowerCase() }] : []),
    ...(step.body === undefined ? [] : bodyDynamicSinks(step.id, step.body))
  ])

const exchangeForStep = (
  testCase: HarnessEvalCase,
  stepId: string
): ScriptedHarnessExchange | undefined => testCase.exchanges.find((exchange) => exchange.request.stepId === stepId)

const responseJsonPointer = (value: HarnessJsonValue, pointer: string): HarnessJsonValue | undefined => {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) return undefined
  let current = value
  for (const encoded of pointer.slice(1).split("/")) {
    if (/(?:^|[^~])~(?:[^01]|$)/u.test(encoded)) return undefined
    const part = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~")
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(part)) return undefined
      const next = current[Number(part)]
      if (next === undefined) return undefined
      current = next
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, part)) {
      current = (current as Readonly<Record<string, HarnessJsonValue>>)[part]!
    } else return undefined
  }
  return current
}

type ModuleSink =
  | { readonly stepId: string; readonly location: "path"; readonly name: string }
  | { readonly stepId: string; readonly location: "query"; readonly name: string }
  | { readonly stepId: string; readonly location: "header"; readonly name: string }
  | { readonly stepId: string; readonly location: "body"; readonly path: ReadonlyArray<string | number> }

const moduleBindingSink = (
  action: SiteHarnessArtifact["actions"][number],
  target: ValueProducer
): ModuleSink | undefined => {
  if (target.kind !== "wasm" && target.kind !== "js") return undefined
  const same = (candidate: ValueProducer): boolean => {
    if (candidate.kind === "wasm" && target.kind === "wasm") {
      return candidate.moduleDigest === target.moduleDigest && candidate.export === target.export &&
        sameJson(candidate.args, target.args)
    }
    if (candidate.kind === "js" && target.kind === "js") {
      return candidate.moduleDigest === target.moduleDigest && candidate.entry === target.entry &&
        sameJson(candidate.args, target.args)
    }
    return false
  }
  const inValue = (
    value: ValueProducer,
    stepId: string,
    location: "path" | "query" | "header" | "body",
    name: string | undefined,
    path: ReadonlyArray<string | number> | undefined
  ): ModuleSink | undefined => {
    if (same(value)) {
      return location === "body"
        ? { stepId, location, path: path ?? [] }
        : { stepId, location: location as "path" | "query" | "header", name: name ?? "" }
    }
    switch (value.kind) {
      case "object":
        for (const key of Object.keys(value.fields)) {
          const found: ModuleSink | undefined = inValue(
            value.fields[key]!,
            stepId,
            location,
            name,
            location === "body" ? [...(path ?? []), key] : path
          )
          if (found !== undefined) return found
        }
        return undefined
      case "array":
        for (const [index, item] of value.items.entries()) {
          const found: ModuleSink | undefined = inValue(
            item,
            stepId,
            location,
            name,
            location === "body" ? [...(path ?? []), index] : path
          )
          if (found !== undefined) return found
        }
        return undefined
      default:
        return undefined
    }
  }
  for (const step of action.steps) {
    for (const [name, producer] of Object.entries(step.pathParameters)) {
      const found: ModuleSink | undefined = inValue(producer, step.id, "path", name, undefined)
      if (found !== undefined) return found
    }
    for (const [name, producer] of Object.entries(step.query)) {
      const found: ModuleSink | undefined = inValue(producer, step.id, "query", name, undefined)
      if (found !== undefined) return found
    }
    for (const [name, producer] of Object.entries(step.headers)) {
      const found: ModuleSink | undefined = inValue(producer, step.id, "header", name.toLowerCase(), undefined)
      if (found !== undefined) return found
    }
    if (step.body !== undefined) {
      const found: ModuleSink | undefined = inValue(step.body, step.id, "body", undefined, [])
      if (found !== undefined) return found
    }
  }
  return undefined
}

const producerSource = (testCase: HarnessEvalCase, action: SiteHarnessArtifact["actions"][number], producer: ValueProducer): string | undefined => {
  let value: unknown
  switch (producer.kind) {
    case "input":
      value = testCase.input[producer.name]
      break
    case "clock":
      if (testCase.clockValues === undefined) return undefined
      value = testCase.clockValues
      break
    case "uuid":
      if (testCase.uuidValues === undefined) return undefined
      value = testCase.uuidValues
      break
    case "response_header": {
      const response = exchangeForStep(testCase, producer.stepId)?.response
      if (response === undefined) return undefined
      value = Object.entries(response.headers).find(([name]) => name.toLowerCase() === producer.name.toLowerCase())?.[1]
      break
    }
    case "response_json": {
      const response = exchangeForStep(testCase, producer.stepId)?.response
      if (response?.body === undefined) return undefined
      value = responseJsonPointer(response.body, producer.pointer)
      break
    }
    case "wasm": {
      const script = testCase.wasm?.find((item) =>
        item.moduleDigest === producer.moduleDigest && item.exportName === producer.export)
      if (script !== undefined) {
        if (script.calls.some((call) => call.result === undefined)) return undefined
        value = script.calls.map((call) => call.result)
      } else {
        // No scripted call: the only offline source of truth is where this
        // producer is bound inside the case's concrete expectations.
        const sink = moduleBindingSink(action, producer)
        return sink === undefined ? undefined : expectedSink(testCase, action, sink)
      }
      break
    }
    case "js": {
      const script = testCase.js?.find((item) =>
        item.moduleDigest === producer.moduleDigest && item.entry === producer.entry)
      if (script !== undefined) {
        if (script.calls.some((call) => call.result === undefined)) return undefined
        value = script.calls.map((call) => call.result)
      } else {
        const sink = moduleBindingSink(action, producer)
        return sink === undefined ? undefined : expectedSink(testCase, action, sink)
      }
      break
    }
    case "constant":
    case "object":
    case "array":
      return undefined
  }
  return value === undefined ? undefined : comparableJson(value)
}

const escapedRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const expectedPathParameter = (pathTemplate: string, urlText: string, name: string): string | undefined => {
  let cursor = 0
  const names: string[] = []
  let pattern = "^"
  for (const match of pathTemplate.matchAll(/\{([^{}]+)\}/gu)) {
    if (match.index === undefined || match[1] === undefined) return undefined
    pattern += escapedRegex(pathTemplate.slice(cursor, match.index)) + "([^/]*)"
    names.push(match[1])
    cursor = match.index + match[0].length
  }
  pattern += escapedRegex(pathTemplate.slice(cursor)) + "$"
  let pathname: string
  try {
    pathname = new URL(urlText).pathname
  } catch {
    return undefined
  }
  const matched = new RegExp(pattern, "u").exec(pathname)
  const index = names.indexOf(name)
  if (matched === null || index < 0 || matched[index + 1] === undefined) return undefined
  try {
    return decodeURIComponent(matched[index + 1]!)
  } catch {
    return undefined
  }
}

const bodyAt = (body: HarnessJsonValue | undefined, path: ReadonlyArray<string | number>): HarnessJsonValue | undefined => {
  let current = body
  for (const part of path) {
    if (current === undefined || current === null || typeof current !== "object") return undefined
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
    } else {
      if (Array.isArray(current) || !Object.hasOwn(current, part)) return undefined
      current = (current as Readonly<Record<string, HarnessJsonValue>>)[part]
    }
  }
  return current
}

const expectedSink = (
  testCase: HarnessEvalCase,
  action: SiteHarnessArtifact["actions"][number],
  sink: DynamicSink
): string | undefined => {
  const exchange = exchangeForStep(testCase, sink.stepId)
  const step = action.steps.find((item) => item.id === sink.stepId)
  if (exchange === undefined || step === undefined) return undefined
  let value: unknown
  if (sink.location === "path") {
    if (exchange.request.url === undefined) return undefined
    value = expectedPathParameter(step.path, exchange.request.url, sink.name)
  } else if (sink.location === "query") {
    if (exchange.request.url === undefined) return undefined
    try {
      value = new URL(exchange.request.url).searchParams.get(sink.name) ?? undefined
    } catch {
      return undefined
    }
  } else if (sink.location === "header") {
    if (exchange.request.headers === undefined) return undefined
    value = Object.entries(exchange.request.headers)
      .find(([name]) => name.toLowerCase() === sink.name)?.[1]
  } else {
    value = bodyAt(exchange.request.body, sink.path)
  }
  return value === undefined ? undefined : comparableJson(value)
}

const mutationCoverageFor = (artifact: SiteHarnessArtifact, cases: ReadonlyArray<HarnessEvalCase>): boolean => {
  return artifact.actions.every((action) => {
    const baselines = cases.filter((testCase) => testCase.kind === "baseline" && testCase.actionId === action.id)
    const mutations = cases.filter((testCase) => testCase.kind === "mutation" && testCase.actionId === action.id)
    const pairs = baselines.flatMap((baseline) => mutations.map((mutation) => ({ baseline, mutation })))
    const producers = actionDynamicProducers(action)
    const sinks = actionDynamicSinks(action)
    if (pairs.length === 0 || producers.length === 0 || sinks.length === 0) return false
    const globalRequestRotation = pairs.some(({ baseline, mutation }) =>
      hasConcreteRequestExpectation(baseline) && hasConcreteRequestExpectation(mutation) &&
      !sameJson(dynamicStimulusOf(baseline), dynamicStimulusOf(mutation)) &&
      !sameJson(concreteRequestsOf(baseline), concreteRequestsOf(mutation)))
    const everySourceRotated = producers.every((producer) => pairs.some(({ baseline, mutation }) => {
      const before = producerSource(baseline, action, producer)
      const after = producerSource(mutation, action, producer)
      return before !== undefined && after !== undefined && before !== after
    }))
    const everySinkRotated = sinks.every((sink) => pairs.some(({ baseline, mutation }) => {
      const before = expectedSink(baseline, action, sink)
      const after = expectedSink(mutation, action, sink)
      return before !== undefined && after !== undefined && before !== after
    }))
    return globalRequestRotation && everySourceRotated && everySinkRotated
  })
}

type HarnessEvaluationReportPayload = Omit<HarnessEvaluationReport, "evaluationRevision" | "evidenceDigest">

export const harnessEvaluationEvidenceDigest = (
  report: Omit<HarnessEvaluationReport, "evidenceDigest"> | HarnessEvaluationReport
): Sha256Digest => {
  const { evidenceDigest: omitted, ...payload } = report as HarnessEvaluationReport
  void omitted
  return `sha256:${createHash("sha256").update(canonicalEvidence(payload)).digest("hex")}`
}

const reportDigest = (value: unknown): Sha256Digest =>
  `sha256:${createHash("sha256").update(canonicalEvidence(value)).digest("hex")}`

const evaluationGateIds: ReadonlyArray<HarnessEvalGateId> = [
  "artifact_valid",
  "no_forbidden_capabilities",
  "case_set_within_budget",
  "baseline_coverage",
  "mutation_coverage",
  "held_out_coverage",
  "deterministic_replay",
  "case_expectations",
  "runtime_budget"
]
const capabilityValues = new Set<HarnessCapability>(["api_capable", "browser_assisted", "unsupported"])
const safetyFindingCodes = new Set<HarnessSafetyFindingCode>([
  "embedded_secret", "site_control_dependency", "telemetry_dependency", "forbidden_header", "unreviewed_constant"
])
const caseKinds = new Set<HarnessEvalCaseKind>(["baseline", "mutation", "held_out"])
const caseCodes = new Set<HarnessEvalCaseCode>([
  "passed", "result_mismatch", "request_count_mismatch", "script_not_consumed",
  "transport_expectation_mismatch", "wasm_script_not_consumed", "wasm_expectation_mismatch",
  "js_script_not_consumed", "js_expectation_mismatch", "fetch_script_not_consumed", "fetch_expectation_mismatch",
  "nondeterministic_replay", "evaluation_budget_exceeded"
])
const executionStatuses = new Set<HarnessExecutionStatus>(["completed", "failed", "blocked"])
const executionCodes = new Set<HarnessExecutionCode>([
  "completed", "invalid_artifact", "invalid_limits", "unknown_action", "invalid_input", "step_graph_invalid",
  "budget_exceeded", "origin_not_allowed", "request_build_failed", "clock_unavailable", "uuid_unavailable",
  "response_dependency_unavailable", "response_header_unavailable", "response_json_unavailable",
  "wasm_adapter_unavailable", "wasm_adapter_ambiguous", "wasm_failed", "transport_failed", "unexpected_status",
  "redirect_budget_exceeded", "cross_origin_redirect", "mutating_redirect_blocked", "unclassified_response",
  "browser_session_required", "site_control_encountered", "forbidden_dependency", "telemetry_dependency"
])

const nonNegativeCounts = (counts: HarnessExecutionCounts | HarnessEvaluationUsage): boolean =>
  Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)

/**
 * Converts a full evaluator report into the canonical, value-free witness the
 * registry is allowed to persist. The original evidence digest is recomputed,
 * and promotion eligibility is derived rather than trusted from the caller.
 */
export const harnessEvaluationAttestationOf = (
  report: HarnessEvaluationReport
): HarnessEvaluationAttestation => {
  if (report.evaluationRevision !== HARNESS_EVALUATION_REVISION || !capabilityValues.has(report.capability) ||
    harnessEvaluationEvidenceDigest(report) !== report.evidenceDigest ||
    report.artifact === undefined || !/^sha256:[0-9a-f]{64}$/u.test(report.artifact.digest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.contract.caseSetDigest) ||
    canonicalEvidence(resolveHarnessEvalLimits(report.contract.evalLimits)) !== canonicalEvidence(report.contract.evalLimits) ||
    canonicalEvidence(resolveHarnessRuntimeLimits(report.contract.runtimeLimits)) !== canonicalEvidence(report.contract.runtimeLimits) ||
    !nonNegativeCounts(report.usage)) {
    throw new TypeError("evaluation report failed its canonical witness contract")
  }
  const gateIds = report.gates.map((gate) => gate.id)
  if (gateIds.length !== evaluationGateIds.length ||
    new Set(gateIds).size !== evaluationGateIds.length ||
    evaluationGateIds.some((id) => !gateIds.includes(id)) ||
    report.gates.some((gate) => typeof gate.passed !== "boolean")) {
    throw new TypeError("evaluation report has an invalid gate set")
  }
  if (new Set(report.cases.map((item) => reportDigest({ id: item.id, actionId: item.actionId }))).size !== report.cases.length ||
    report.cases.some((item) => typeof item.passed !== "boolean" || typeof item.deterministic !== "boolean" ||
      !caseKinds.has(item.kind) || !caseCodes.has(item.code) ||
      !executionStatuses.has(item.execution.status) || !executionCodes.has(item.execution.code) ||
      !nonNegativeCounts(item.execution.counts)) ||
    report.safetyFindings.some((finding) => !safetyFindingCodes.has(finding.code))) {
    throw new TypeError("evaluation report has invalid case evidence")
  }
  const derivedEligible = report.capability === "api_capable" &&
    report.gates.every((gate) => gate.passed) && report.safetyFindings.length === 0 &&
    report.cases.length > 0 && report.cases.every((item) => item.passed && item.deterministic &&
      item.execution.status === "completed" && item.execution.code === "completed")
  if (report.eligibleForPromotion !== derivedEligible) {
    throw new TypeError("evaluation report eligibility does not match its evidence")
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    evaluationRevision: report.evaluationRevision,
    evidenceDigest: report.evidenceDigest,
    capability: report.capability,
    eligibleForPromotion: derivedEligible,
    artifact: { ...report.artifact },
    contract: {
      caseSetDigest: report.contract.caseSetDigest,
      evalLimits: { ...report.contract.evalLimits },
      runtimeLimits: { ...report.contract.runtimeLimits }
    },
    gates: report.gates.map((gate) => ({ ...gate })),
    safetyFindingCodes: [...new Set(report.safetyFindings.map((finding) => finding.code))].sort(),
    cases: report.cases.map((item) => ({
      caseDigest: reportDigest({ id: item.id, actionId: item.actionId }),
      kind: item.kind,
      passed: item.passed,
      deterministic: item.deterministic,
      code: item.code,
      executionStatus: item.execution.status,
      executionCode: item.execution.code,
      counts: { ...item.execution.counts },
      traceDigest: reportDigest(item.execution.trace)
    })),
    usage: { ...report.usage }
  })
}

export const canonicalHarnessEvaluationAttestation = (
  attestation: HarnessEvaluationAttestation
): string => canonicalEvidence(attestation)

const finalizedReport = (payload: HarnessEvaluationReportPayload): HarnessEvaluationReport => {
  const undigested = { evaluationRevision: HARNESS_EVALUATION_REVISION, ...payload }
  return { ...undigested, evidenceDigest: harnessEvaluationEvidenceDigest(undigested) }
}

const invalidReport = (
  caseBudgetPassed: boolean,
  baselineCoverage: boolean,
  mutationCoverage: boolean,
  heldOutCoverage: boolean,
  contract: HarnessEvaluationReport["contract"]
): HarnessEvaluationReport => finalizedReport({
  capability: "unsupported",
  eligibleForPromotion: false,
  contract,
  gates: [
    { id: "artifact_valid", passed: false },
    { id: "no_forbidden_capabilities", passed: false },
    { id: "case_set_within_budget", passed: caseBudgetPassed },
    { id: "baseline_coverage", passed: baselineCoverage },
    { id: "mutation_coverage", passed: mutationCoverage },
    { id: "held_out_coverage", passed: heldOutCoverage },
    { id: "deterministic_replay", passed: false },
    { id: "case_expectations", passed: false },
    { id: "runtime_budget", passed: false }
  ],
  safetyFindings: [],
  cases: [],
  usage: emptyUsage()
})

/**
 * Runs every offline case twice with fresh scripted adapters plus any
 * controller-supplied wasm module adapters. It never uses real network, ambient
 * time, ambient randomness, or an unapproved WASM implementation.
 */
export const evaluateHarnessArtifact = async (
  options: EvaluateHarnessArtifactOptions
): Promise<HarnessEvaluationReport> => {
  let limitConfigurationValid = true
  let limits: HarnessEvalLimits
  let runtimeLimits: HarnessRuntimeLimits
  try {
    limits = resolveHarnessEvalLimits(options.limits)
    runtimeLimits = resolveHarnessRuntimeLimits(options.runtimeLimits)
  } catch {
    limitConfigurationValid = false
    limits = resolveHarnessEvalLimits(undefined)
    runtimeLimits = resolveHarnessRuntimeLimits(undefined)
  }
  const contract: HarnessEvaluationReport["contract"] = {
    caseSetDigest: harnessEvaluationCaseSetDigest(options.cases),
    evalLimits: limits,
    runtimeLimits
  }
  const budgetedCaseSet = limitConfigurationValid && caseSetWithinBudget(options.cases, limits)
  let artifact: SiteHarnessArtifact
  try {
    artifact = validateSiteHarnessArtifact(options.artifact)
  } catch {
    return invalidReport(budgetedCaseSet, false, false, false, contract)
  }

  const safetyFindings = [
    ...findHarnessSafetyViolations(artifact),
    ...findHarnessCaseSafetyViolations(options.cases)
  ]
  const reports: HarnessEvalCaseReport[] = []
  let usage = emptyUsage()
  let runtimeBudgetPassed = limitConfigurationValid

  if (budgetedCaseSet && safetyFindings.length === 0) {
    for (const testCase of options.cases) {
      const first = await runOnce(artifact, testCase, runtimeLimits, options.wasm, options.js)
      usage = addUsage(usage, first.result.counts)
      if (!withinRuntimeBudget(usage, limits)) {
        runtimeBudgetPassed = false
        break
      }
      const second = await runOnce(artifact, testCase, runtimeLimits, options.wasm, options.js)
      usage = addUsage(usage, second.result.counts)
      if (!withinRuntimeBudget(usage, limits)) runtimeBudgetPassed = false
      reports.push(reportForCase(testCase, first, second))
      if (!runtimeBudgetPassed) break
    }
  } else if (!budgetedCaseSet) {
    runtimeBudgetPassed = false
  }

  if (reports.some((report) => report.execution.code === "budget_exceeded")) runtimeBudgetPassed = false
  const deterministic = reports.length === options.cases.length && reports.every((report) => report.deterministic)
  const expectationsPass = reports.length === options.cases.length && reports.every((report) => report.passed)
  const codes = new Set(reports.map((report) => report.execution.code))
  const browserAssisted = codes.has("browser_session_required")
  const unsupportedSignal = codes.has("site_control_encountered") ||
    codes.has("forbidden_dependency") || codes.has("telemetry_dependency")
  const completedCaseIds = new Set(reports.filter((report) => report.passed &&
    report.execution.status === "completed" && report.execution.code === "completed").map((report) => report.id))
  const completedCases = options.cases.filter((testCase) => completedCaseIds.has(testCase.id))
  const hasBaseline = !limits.requireBaselineCase || baselineCoverageFor(artifact, completedCases)
  const hasMutation = !limits.requireMutationCase || mutationCoverageFor(artifact, completedCases)
  const hasHeldOut = !limits.requireHeldOutCase || heldOutCoverageFor(artifact, completedCases)

  const gates: ReadonlyArray<HarnessEvalGate> = [
    { id: "artifact_valid", passed: true },
    { id: "no_forbidden_capabilities", passed: safetyFindings.length === 0 && !unsupportedSignal },
    { id: "case_set_within_budget", passed: budgetedCaseSet },
    { id: "baseline_coverage", passed: hasBaseline },
    { id: "mutation_coverage", passed: hasMutation },
    { id: "held_out_coverage", passed: hasHeldOut },
    { id: "deterministic_replay", passed: deterministic },
    { id: "case_expectations", passed: expectationsPass },
    { id: "runtime_budget", passed: runtimeBudgetPassed }
  ]
  const hardPass = gates.every((gate) => gate.passed)
  const capability: HarnessCapability = safetyFindings.length > 0 || unsupportedSignal || !expectationsPass
    ? "unsupported"
    : browserAssisted
      ? "browser_assisted"
      : hardPass
        ? "api_capable"
        : "unsupported"

  return finalizedReport({
    capability,
    eligibleForPromotion: capability === "api_capable" && hardPass,
    contract,
    artifact: {
      siteId: artifact.siteId,
      version: artifact.version,
      digest: siteHarnessArtifactDigest(artifact)
    },
    gates,
    safetyFindings,
    cases: reports,
    usage
  })
}

export const evaluateSiteHarnessArtifact = evaluateHarnessArtifact

/** Explicitly exported for controllers that want to pin the default runtime budget in an eval contract. */
export const DEFAULT_EVAL_RUNTIME_LIMITS = DEFAULT_HARNESS_RUNTIME_LIMITS
