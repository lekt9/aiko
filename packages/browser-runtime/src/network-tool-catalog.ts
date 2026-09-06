import {
  canonicalStringify,
  compareText,
  sha256,
  type DependencyReason,
  type RequestDependency
} from "./har"
import {
  SITE_HARNESS_EXECUTOR_ABI,
  SITE_HARNESS_SCHEMA_VERSION,
  isSha256Digest,
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact,
  type HarnessHttpMethod,
  type HarnessInputType,
  type HarnessStep,
  type Sha256Digest,
  type SiteHarnessArtifact,
  type ValueProducer
} from "./harness-artifact"

/**
 * Network tools are immutable, value-free projections of already validated
 * site-harness actions. They are data, not source code and not execution
 * authority. Approval and verification are separate catalog facts.
 */
export const NETWORK_TOOL_SCHEMA_VERSION = 1 as const
export const NETWORK_TOOL_COMPILER_REVISION = "network-tool-compiler/1" as const
export const NETWORK_TOOL_CATALOG_SCHEMA_VERSION = 1 as const
export const NETWORK_TOOL_LIMITS = Object.freeze({
  inputs: 64,
  sessionRequirements: 64,
  steps: 128,
  dependencies: 8_192,
  dependenciesPerStep: 64,
  expectedStatusesPerStep: 32,
  producersPerLocation: 128,
  catalogEntries: 4_096
} as const)

export type NetworkToolBindingSource = "caller" | "vault"

export interface NetworkToolInput {
  readonly name: string
  readonly type: HarnessInputType
  readonly required: boolean
  readonly source: NetworkToolBindingSource
}

export type NetworkToolValueProducer =
  | {
    readonly kind: "input"
    readonly name: string
    readonly source: NetworkToolBindingSource
  }
  | {
    readonly kind: "clock"
    readonly format: "rfc1123" | "iso8601" | "epoch_ms"
  }
  | { readonly kind: "uuid" }
  | {
    readonly kind: "response_header"
    readonly stepId: string
    readonly name: string
  }
  | {
    readonly kind: "response_json"
    readonly stepId: string
    readonly pointer: string
  }

export interface NetworkToolStep {
  readonly id: string
  readonly dependsOn: ReadonlyArray<string>
  readonly method: "GET" | "HEAD"
  readonly origin: string
  readonly path: string
  readonly pathParameters: Readonly<Record<string, NetworkToolValueProducer>>
  readonly query: Readonly<Record<string, NetworkToolValueProducer>>
  readonly headers: Readonly<Record<string, NetworkToolValueProducer>>
  readonly expectedStatuses: ReadonlyArray<number>
}

/** Opaque identities for the durable, value-minimized trace facts used by a step. */
export interface NetworkToolStepEvidence {
  readonly stepId: string
  readonly requestId: string
  readonly traceEventId: string
}

/** A request dependency translated from trace request IDs to tool step IDs. */
export interface NetworkToolDependency {
  readonly fromStepId: string
  readonly toStepId: string
  readonly reason: DependencyReason
  readonly confidence: number
  readonly evidence: string
}

export interface NetworkToolDefinition {
  readonly schemaVersion: typeof NETWORK_TOOL_SCHEMA_VERSION
  readonly compilerRevision: typeof NETWORK_TOOL_COMPILER_REVISION
  readonly toolId: string
  readonly siteId: string
  readonly actionId: string
  readonly sourceTraceDigest: Sha256Digest
  readonly sourceArtifactDigest: Sha256Digest
  readonly inputs: ReadonlyArray<NetworkToolInput>
  /** Opaque adapter capability IDs only; never cookies, headers, or values. */
  readonly sessionRequirements: ReadonlyArray<string>
  readonly steps: ReadonlyArray<NetworkToolStep>
  readonly dependencies: ReadonlyArray<NetworkToolDependency>
  readonly evidence: ReadonlyArray<NetworkToolStepEvidence>
}

export interface CompiledNetworkTool {
  readonly digest: Sha256Digest
  readonly definition: NetworkToolDefinition
}

export interface NetworkToolInputBinding {
  readonly name: string
  readonly source: NetworkToolBindingSource
}

export interface NetworkToolFinding {
  readonly code: string
  readonly stepId?: string
  readonly location?: string
}

export interface CompileNetworkToolInput {
  readonly artifact: SiteHarnessArtifact
  /** The trusted caller must bind compilation to the exact immutable artifact. */
  readonly artifactDigest: Sha256Digest
  /** Must equal artifact.sourceCaptureDigest. */
  readonly sourceTraceDigest: Sha256Digest
  readonly actionId: string
  readonly toolId?: string
  readonly inputBindings: ReadonlyArray<NetworkToolInputBinding>
  readonly stepEvidence: ReadonlyArray<NetworkToolStepEvidence>
  readonly dependencies: ReadonlyArray<RequestDependency>
  /** Resolved external adapter capabilities; their concrete material stays outside this definition. */
  readonly sessionRequirements?: ReadonlyArray<string>
  /** Findings still present at compilation time are fail-closed. */
  readonly unresolvedFindings?: ReadonlyArray<NetworkToolFinding>
}

export type NetworkToolCompileFallbackReason =
  | "invalid_candidate"
  | "artifact_digest_mismatch"
  | "trace_digest_mismatch"
  | "action_not_found"
  | "mutating_request"
  | "request_body_present"
  | "unsafe_producer"
  | "input_contract_mismatch"
  | "evidence_incomplete"
  | "dependency_evidence_missing"
  | "dependency_mismatch"
  | "ambiguous_dependency"
  | "session_requirement_missing"
  | "unresolved_finding"

export type CompileNetworkToolResult =
  | { readonly status: "compiled"; readonly tool: CompiledNetworkTool }
  | { readonly status: "browser_fallback"; readonly reason: NetworkToolCompileFallbackReason }

export interface NetworkToolApproval {
  readonly toolDigest: Sha256Digest
  readonly approvalId: string
}

export interface NetworkToolVerification {
  readonly toolDigest: Sha256Digest
  readonly evaluationId: string
  readonly evidenceDigest: Sha256Digest
  readonly passed: boolean
}

export interface NetworkToolCatalogEntry {
  readonly tool: CompiledNetworkTool
  readonly approval?: NetworkToolApproval
  readonly verification?: NetworkToolVerification
}

export interface NetworkToolCatalog {
  readonly schemaVersion: typeof NETWORK_TOOL_CATALOG_SCHEMA_VERSION
  readonly digest: Sha256Digest
  readonly entries: ReadonlyArray<NetworkToolCatalogEntry>
}

/** Safe durable projection for trace events and observatory rows. */
export interface NetworkToolSummary {
  readonly siteId: string
  readonly methods: ReadonlyArray<"GET" | "HEAD">
  readonly stepCount: number
  readonly inputCount: number
  readonly callerInputCount: number
  readonly vaultInputCount: number
  readonly dependencyCount: number
  readonly sessionRequirementCount: number
}

export interface NetworkToolInvocationBinding {
  readonly name: string
  readonly type: HarnessInputType
  readonly required: boolean
  readonly source: NetworkToolBindingSource
}

/**
 * This request carries only an interface contract and capability availability.
 * Concrete caller/vault values are deliberately resolved by the outer executor.
 */
export interface NetworkToolInvocationRequest {
  readonly siteId: string
  readonly toolId: string
  readonly actionId: string
  readonly bindings: ReadonlyArray<NetworkToolInvocationBinding>
  readonly availableSessionRequirements: ReadonlyArray<string>
  readonly expectedToolDigest?: Sha256Digest
  readonly expectedSourceTraceDigest?: Sha256Digest
  readonly expectedSourceArtifactDigest?: Sha256Digest
}

export type NetworkToolShortCircuitFallbackReason =
  | "invalid_catalog"
  | "invalid_request"
  | "no_exact_match"
  | "tool_digest_mismatch"
  | "input_contract_mismatch"
  | "session_requirement_missing"
  | "ambiguous_match"
  | "tool_unapproved"
  | "tool_unverified"
  | "verification_failed"

export type NetworkToolShortCircuitDecision =
  | {
    readonly decision: "reuse"
    readonly toolDigest: Sha256Digest
    readonly tool: NetworkToolDefinition
    /** Canonical, deeply frozen request used for both hashing and execution. */
    readonly invocation: NetworkToolInvocationRequest
  }
  | {
    readonly decision: "browser_fallback"
    readonly reason: NetworkToolShortCircuitFallbackReason
  }

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const LOCATOR_SEGMENT = /^[A-Za-z0-9_.\[\]-]{1,512}$/u
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u
const INPUT_TYPES = new Set<HarnessInputType>(["string", "number", "integer", "boolean", "json"])
const BINDING_SOURCES = new Set<NetworkToolBindingSource>(["caller", "vault"])
const CLOCK_FORMATS = new Set(["rfc1123", "iso8601", "epoch_ms"] as const)
const DEPENDENCY_REASONS = new Set<DependencyReason>(["redirect", "initiator", "referer", "cookie", "value-flow"])
const READ_METHODS = new Set<HarnessHttpMethod>(["GET", "HEAD"])

const fallback = (reason: NetworkToolCompileFallbackReason): CompileNetworkToolResult => ({
  status: "browser_fallback",
  reason
})

const decisionFallback = (reason: NetworkToolShortCircuitFallbackReason): NetworkToolShortCircuitDecision => ({
  decision: "browser_fallback",
  reason
})

const deepFreeze = <T>(value: T, seen: Set<object> = new Set()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

const digestOf = (value: unknown): Sha256Digest => `sha256:${sha256(canonicalStringify(value))}`

const sortedUnique = (values: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareText)

const safeId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && ID.test(value)

const safeOpaqueId = (value: unknown): value is string =>
  typeof value === "string" && OPAQUE_ID.test(value)

interface HarRequestTraceReference {
  readonly sourceTraceDigest: Sha256Digest
  readonly requestId: string
}

/** Parse the exact immutable HarRequestObserved event key, never a caller label. */
const harRequestTraceReferenceOf = (value: unknown): HarRequestTraceReference | undefined => {
  if (typeof value !== "string" || value.length > 512) return undefined
  const parts = value.split(":")
  if (parts.length !== 6 || parts[0] !== "har2" || parts[1] !== "req" || parts[3] !== "sha256" ||
    !safeOpaqueId(parts[2]) || !safeOpaqueId(parts[5])) return undefined
  const sourceTraceDigest = `sha256:${parts[4]}`
  if (!isSha256Digest(sourceTraceDigest)) return undefined
  return { sourceTraceDigest, requestId: parts[5] }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const exactFields = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): boolean => {
  const allowed = new Set([...required, ...optional])
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    count += 1
    if (count > allowed.size || !allowed.has(key)) return false
  }
  return required.every((key) => Object.hasOwn(value, key))
}

const boundedOwnDataEntries = (
  value: Record<string, unknown>,
  limit: number
): ReadonlyArray<readonly [string, unknown]> | undefined => {
  const entries: Array<readonly [string, unknown]> = []
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (entries.length >= limit) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) return undefined
    entries.push([key, descriptor.value])
  }
  return entries
}

const entriesSorted = <T>(record: Readonly<Record<string, T>>): ReadonlyArray<readonly [string, T]> =>
  Object.entries(record).sort(([left], [right]) => compareText(left, right))

const recordSorted = <T>(entries: ReadonlyArray<readonly [string, T]>): Readonly<Record<string, T>> =>
  Object.fromEntries(entries) as Readonly<Record<string, T>>

const locatorSegment = (value: string): string => {
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 64)
  return normalized.length === 0 ? "field" : normalized
}

const pointerSourceLocator = (pointer: string): string | undefined => {
  if (pointer === "") return "response.body"
  if (!pointer.startsWith("/") || /(?:^|[^~])~(?:[^01]|$)/u.test(pointer)) return undefined
  const decoded: string[] = []
  for (const part of pointer.slice(1).split("/")) {
    const segment = part.replace(/~1/gu, "/").replace(/~0/gu, "~")
    if (/^\d+$/u.test(segment)) {
      if (decoded.length === 0) return undefined
      decoded[decoded.length - 1] = `${decoded.at(-1)}[]`
      continue
    }
    const safe = locatorSegment(segment)
    if (safe !== segment || !LOCATOR_SEGMENT.test(safe)) return undefined
    decoded.push(safe)
  }
  return decoded.length === 0 ? "response.body" : `response.body.${decoded.join(".")}`
}

interface ParsedValueFlowEvidence {
  readonly source: string
  readonly target: string
}

const parseValueFlowEvidence = (evidence: string): ParsedValueFlowEvidence | undefined => {
  if (evidence.length > 1_100 || evidence.includes("\u0000") || evidence.includes("[REDACTED]")) return undefined
  const parts = evidence.split(" -> ")
  if (parts.length !== 2) return undefined
  const [source, target] = parts
  if (source === undefined || target === undefined) return undefined
  const sourceValid = source === "response.body" ||
    (source.startsWith("response.body.") && LOCATOR_SEGMENT.test(source.slice("response.body.".length))) ||
    (source.startsWith("response.header.") && LOCATOR_SEGMENT.test(source.slice("response.header.".length)))
  const targetValid = target === "request.path.segment" ||
    (["request.query.", "request.header.", "request.body."].some((prefix) =>
      target.startsWith(prefix) && LOCATOR_SEGMENT.test(target.slice(prefix.length))))
  return sourceValid && targetValid ? { source, target } : undefined
}

const dependencyEvidenceSafe = (dependency: RequestDependency): boolean => {
  if (dependency.evidence.length === 0 || dependency.evidence.length > 1_100 || dependency.evidence.includes("\u0000")) return false
  switch (dependency.reason) {
    case "redirect": return dependency.evidence === "response.redirectURL"
    case "initiator": return dependency.evidence === "entry._initiator.url"
    case "referer": return dependency.evidence === "request.headers.referer"
    case "cookie": return /^same-origin cookie-name:[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/u.test(dependency.evidence)
    case "value-flow": return parseValueFlowEvidence(dependency.evidence) !== undefined
  }
}

class CompileFault extends Error {
  readonly reason: NetworkToolCompileFallbackReason

  constructor(reason: NetworkToolCompileFallbackReason) {
    super(reason)
    this.name = "CompileFault"
    this.reason = reason
  }
}

const throwCompile = (reason: NetworkToolCompileFallbackReason): never => {
  throw new CompileFault(reason)
}

const inputBindingsOf = (
  actionInputs: SiteHarnessArtifact["actions"][number]["inputs"],
  bindings: ReadonlyArray<NetworkToolInputBinding>
): ReadonlyArray<NetworkToolInput> => {
  const byName = new Map<string, NetworkToolBindingSource>()
  for (const binding of bindings) {
    if (!isRecord(binding) || !exactFields(binding, ["name", "source"]) || !safeId(binding.name) ||
      !BINDING_SOURCES.has(binding.source as NetworkToolBindingSource) || byName.has(binding.name)) {
      return throwCompile("input_contract_mismatch")
    }
    byName.set(binding.name, binding.source as NetworkToolBindingSource)
  }
  const expected = sortedUnique(actionInputs.map((input) => input.name))
  if (canonicalStringify(expected) !== canonicalStringify(sortedUnique(byName.keys()))) {
    return throwCompile("input_contract_mismatch")
  }
  return [...actionInputs]
    .sort((left, right) => compareText(left.name, right.name))
    .map((input) => ({ ...input, source: byName.get(input.name)! }))
}

interface DependencyContext {
  readonly dependencies: ReadonlyArray<NetworkToolDependency>
  readonly valueFlow: ReadonlyArray<NetworkToolDependency>
}

const dependencyContextOf = (
  steps: ReadonlyArray<HarnessStep>,
  evidence: ReadonlyArray<NetworkToolStepEvidence>,
  dependencies: ReadonlyArray<RequestDependency>,
  sourceTraceDigest: Sha256Digest
): DependencyContext => {
  const stepIds = new Set(steps.map((step) => step.id))
  const requestToStep = new Map<string, string>()
  const evidenceByStep = new Map<string, NetworkToolStepEvidence>()
  for (const item of evidence) {
    const traceReference = isRecord(item) ? harRequestTraceReferenceOf(item.traceEventId) : undefined
    if (!isRecord(item) || !exactFields(item, ["stepId", "requestId", "traceEventId"]) ||
      !safeId(item.stepId) || !safeOpaqueId(item.requestId) || typeof item.traceEventId !== "string" ||
      traceReference === undefined ||
      traceReference.requestId !== item.requestId || traceReference.sourceTraceDigest !== sourceTraceDigest ||
      !stepIds.has(item.stepId) || evidenceByStep.has(item.stepId) || requestToStep.has(item.requestId)) {
      return throwCompile("evidence_incomplete")
    }
    evidenceByStep.set(item.stepId, item)
    requestToStep.set(item.requestId, item.stepId)
  }
  if (evidenceByStep.size !== steps.length) return throwCompile("evidence_incomplete")

  const translated = new Map<string, NetworkToolDependency>()
  for (const dependency of dependencies) {
    if (!isRecord(dependency) || !exactFields(dependency, ["from", "to", "reason", "confidence", "evidence"]) ||
      !safeOpaqueId(dependency.from) || !safeOpaqueId(dependency.to) ||
      typeof dependency.reason !== "string" || !DEPENDENCY_REASONS.has(dependency.reason as DependencyReason) ||
      typeof dependency.confidence !== "number" || !Number.isFinite(dependency.confidence) ||
      dependency.confidence < 0 || dependency.confidence > 1 || typeof dependency.evidence !== "string" ||
      !dependencyEvidenceSafe(dependency as RequestDependency)) {
      return throwCompile("dependency_mismatch")
    }
    const fromStepId = requestToStep.get(dependency.from)
    const toStepId = requestToStep.get(dependency.to)
    if (fromStepId === undefined || toStepId === undefined || fromStepId === toStepId) {
      return throwCompile("dependency_mismatch")
    }
    const target = steps.find((step) => step.id === toStepId)
    if (target === undefined || !target.dependsOn.includes(fromStepId)) return throwCompile("dependency_mismatch")
    const translatedDependency: NetworkToolDependency = {
      fromStepId,
      toStepId,
      reason: dependency.reason as DependencyReason,
      confidence: Number(dependency.confidence.toFixed(6)),
      evidence: dependency.evidence
    }
    translated.set(canonicalStringify(translatedDependency), translatedDependency)
  }

  const result = [...translated.values()]
  const position = new Map(steps.map((step, index) => [step.id, index]))
  result.sort((left, right) =>
    (position.get(left.toStepId) ?? 0) - (position.get(right.toStepId) ?? 0) ||
    (position.get(left.fromStepId) ?? 0) - (position.get(right.fromStepId) ?? 0) ||
    compareText(left.reason, right.reason) || compareText(left.evidence, right.evidence) ||
    right.confidence - left.confidence)

  const pairKeys = new Set(result.map((dependency) => `${dependency.fromStepId}\u0000${dependency.toStepId}`))
  for (const step of steps) {
    for (const source of step.dependsOn) {
      if (!pairKeys.has(`${source}\u0000${step.id}`)) return throwCompile("dependency_evidence_missing")
    }
  }

  const ambiguous = new Map<string, Set<string>>()
  for (const dependency of result) {
    if (dependency.reason !== "value-flow") continue
    const parsed = parseValueFlowEvidence(dependency.evidence)
    if (parsed === undefined) return throwCompile("dependency_mismatch")
    const key = `${dependency.toStepId}\u0000${parsed.target}`
    const sources = ambiguous.get(key) ?? new Set<string>()
    sources.add(`${dependency.fromStepId}\u0000${parsed.source}`)
    ambiguous.set(key, sources)
  }
  if ([...ambiguous.values()].some((sources) => sources.size > 1)) return throwCompile("ambiguous_dependency")
  return { dependencies: result, valueFlow: result.filter((dependency) => dependency.reason === "value-flow") }
}

const targetLocator = (location: "path" | "query" | "header", name: string): string => {
  if (location === "path") return "request.path.segment"
  return `request.${location}.${locatorSegment(name)}`
}

const producerOf = (
  producer: ValueProducer,
  stepId: string,
  location: "path" | "query" | "header",
  name: string,
  sourceByInput: ReadonlyMap<string, NetworkToolBindingSource>,
  dependencyContext: DependencyContext
): NetworkToolValueProducer => {
  switch (producer.kind) {
    case "input": {
      const source = sourceByInput.get(producer.name)
      if (source === undefined) return throwCompile("input_contract_mismatch")
      return { kind: "input", name: producer.name, source }
    }
    case "clock": return { kind: "clock", format: producer.format }
    case "uuid": return { kind: "uuid" }
    case "response_json":
    case "response_header": {
      const sourceLocator = producer.kind === "response_json"
        ? pointerSourceLocator(producer.pointer)
        : `response.header.${locatorSegment(producer.name)}`
      if (sourceLocator === undefined) return throwCompile("dependency_mismatch")
      const sink = targetLocator(location, name)
      const matching = dependencyContext.valueFlow.filter((dependency) =>
        dependency.fromStepId === producer.stepId && dependency.toStepId === stepId &&
        dependency.evidence === `${sourceLocator} -> ${sink}`)
      if (matching.length === 0) return throwCompile("dependency_evidence_missing")
      if (matching.length > 1) return throwCompile("ambiguous_dependency")
      return producer.kind === "response_json"
        ? { kind: "response_json", stepId: producer.stepId, pointer: producer.pointer }
        : { kind: "response_header", stepId: producer.stepId, name: producer.name }
    }
    case "constant":
    case "object":
    case "array":
    case "wasm":
    case "js":
      return throwCompile("unsafe_producer")
  }
}

const producersOf = (
  producers: Readonly<Record<string, ValueProducer>>,
  stepId: string,
  location: "path" | "query" | "header",
  sourceByInput: ReadonlyMap<string, NetworkToolBindingSource>,
  dependencyContext: DependencyContext
): Readonly<Record<string, NetworkToolValueProducer>> => recordSorted(entriesSorted(producers).map(([name, producer]) => [
  name,
  producerOf(producer, stepId, location, name, sourceByInput, dependencyContext)
] as const))

const sessionRequirementsOf = (value: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > NETWORK_TOOL_LIMITS.sessionRequirements ||
    value.some((item) => !safeOpaqueId(item))) return throwCompile("invalid_candidate")
  return sortedUnique(value)
}

const evidenceSorted = (
  evidence: ReadonlyArray<NetworkToolStepEvidence>,
  steps: ReadonlyArray<HarnessStep>
): ReadonlyArray<NetworkToolStepEvidence> => {
  const position = new Map(steps.map((step, index) => [step.id, index]))
  return evidence.map((item) => ({ ...item })).sort((left, right) =>
    (position.get(left.stepId) ?? 0) - (position.get(right.stepId) ?? 0) ||
    compareText(left.requestId, right.requestId) || compareText(left.traceEventId, right.traceEventId))
}

export const compileNetworkTool = (input: CompileNetworkToolInput): CompileNetworkToolResult => {
  try {
    if (!isRecord(input) || !exactFields(input, [
      "artifact",
      "artifactDigest",
      "sourceTraceDigest",
      "actionId",
      "inputBindings",
      "stepEvidence",
      "dependencies"
    ], ["toolId", "sessionRequirements", "unresolvedFindings"])) return fallback("invalid_candidate")
    if (
      !Array.isArray(input.inputBindings) || input.inputBindings.length > NETWORK_TOOL_LIMITS.inputs ||
      !Array.isArray(input.stepEvidence) || input.stepEvidence.length > NETWORK_TOOL_LIMITS.steps ||
      !Array.isArray(input.dependencies) || input.dependencies.length > NETWORK_TOOL_LIMITS.dependencies ||
      (input.sessionRequirements !== undefined && (
        !Array.isArray(input.sessionRequirements) ||
        input.sessionRequirements.length > NETWORK_TOOL_LIMITS.sessionRequirements
      )) ||
      (input.unresolvedFindings !== undefined && (
        !Array.isArray(input.unresolvedFindings) ||
        input.unresolvedFindings.length > NETWORK_TOOL_LIMITS.dependencies
      ))
    ) return fallback("invalid_candidate")

    let artifact: SiteHarnessArtifact
    try {
      artifact = validateSiteHarnessArtifact(input.artifact)
    } catch {
      return fallback("invalid_candidate")
    }
    if (!isSha256Digest(input.artifactDigest) || siteHarnessArtifactDigest(artifact) !== input.artifactDigest) {
      return fallback("artifact_digest_mismatch")
    }
    if (!isSha256Digest(input.sourceTraceDigest) || artifact.sourceCaptureDigest !== input.sourceTraceDigest) {
      return fallback("trace_digest_mismatch")
    }
    if (!safeId(input.actionId)) return fallback("invalid_candidate")
    const action = artifact.actions.find((candidate) => candidate.id === input.actionId)
    if (action === undefined) return fallback("action_not_found")
    const toolId = input.toolId ?? action.id
    if (!safeId(toolId)) return fallback("invalid_candidate")

    if (input.unresolvedFindings !== undefined) {
      if (!Array.isArray(input.unresolvedFindings) || input.unresolvedFindings.some((finding) => !isRecord(finding) ||
        !exactFields(finding, ["code"], ["stepId", "location"]) || typeof finding.code !== "string")) {
        return fallback("invalid_candidate")
      }
      if (input.unresolvedFindings.some((finding) => finding.code === "session_adapter_required")) {
        return fallback("session_requirement_missing")
      }
      if (input.unresolvedFindings.some((finding) => finding.code === "ambiguous_dependency")) {
        return fallback("ambiguous_dependency")
      }
      if (input.unresolvedFindings.length > 0) return fallback("unresolved_finding")
    }

    if (action.steps.some((step) => !READ_METHODS.has(step.method))) return fallback("mutating_request")
    if (action.steps.some((step) => step.body !== undefined)) return fallback("request_body_present")
    const inputs = inputBindingsOf(action.inputs, input.inputBindings)
    const sourceByInput = new Map(inputs.map((item) => [item.name, item.source]))
    const dependencyContext = dependencyContextOf(
      action.steps,
      input.stepEvidence,
      input.dependencies,
      input.sourceTraceDigest
    )
    if (dependencyContext.dependencies.some((dependency) => dependency.reason === "cookie") &&
      (input.sessionRequirements?.length ?? 0) === 0) {
      return fallback("session_requirement_missing")
    }

    const steps: NetworkToolStep[] = action.steps.map((step) => ({
      id: step.id,
      dependsOn: [...step.dependsOn].sort((left, right) =>
        action.steps.findIndex((candidate) => candidate.id === left) -
        action.steps.findIndex((candidate) => candidate.id === right)),
      method: step.method as "GET" | "HEAD",
      origin: step.origin,
      path: step.path,
      pathParameters: producersOf(step.pathParameters, step.id, "path", sourceByInput, dependencyContext),
      query: producersOf(step.query, step.id, "query", sourceByInput, dependencyContext),
      headers: producersOf(step.headers, step.id, "header", sourceByInput, dependencyContext),
      expectedStatuses: [...step.expectedStatuses].sort((left, right) => left - right)
    }))

    const definition = validateNetworkToolDefinition({
      schemaVersion: NETWORK_TOOL_SCHEMA_VERSION,
      compilerRevision: NETWORK_TOOL_COMPILER_REVISION,
      toolId,
      siteId: artifact.siteId,
      actionId: action.id,
      sourceTraceDigest: input.sourceTraceDigest,
      sourceArtifactDigest: input.artifactDigest,
      inputs,
      sessionRequirements: sessionRequirementsOf(input.sessionRequirements),
      steps,
      dependencies: dependencyContext.dependencies,
      evidence: evidenceSorted(input.stepEvidence, action.steps)
    })
    return deepFreeze({ status: "compiled", tool: { digest: digestOf(definition), definition } })
  } catch (error) {
    return error instanceof CompileFault ? fallback(error.reason) : fallback("invalid_candidate")
  }
}

export class NetworkToolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NetworkToolValidationError"
  }
}

const invalid = (message: string): never => {
  throw new NetworkToolValidationError(message)
}

const parseProducer = (value: unknown): NetworkToolValueProducer => {
  if (!isRecord(value) || typeof value.kind !== "string") return invalid("network tool producer is invalid")
  switch (value.kind) {
    case "input":
      if (!exactFields(value, ["kind", "name", "source"]) || !safeId(value.name) ||
        !BINDING_SOURCES.has(value.source as NetworkToolBindingSource)) return invalid("network tool input producer is invalid")
      return { kind: "input", name: value.name, source: value.source as NetworkToolBindingSource }
    case "clock":
      if (!exactFields(value, ["kind", "format"]) || !CLOCK_FORMATS.has(value.format as never)) {
        return invalid("network tool clock producer is invalid")
      }
      return { kind: "clock", format: value.format as "rfc1123" | "iso8601" | "epoch_ms" }
    case "uuid":
      if (!exactFields(value, ["kind"])) return invalid("network tool uuid producer is invalid")
      return { kind: "uuid" }
    case "response_header":
      if (!exactFields(value, ["kind", "stepId", "name"]) || !safeId(value.stepId) ||
        typeof value.name !== "string" || !HEADER_NAME.test(value.name)) {
        return invalid("network tool response header producer is invalid")
      }
      return { kind: "response_header", stepId: value.stepId, name: value.name }
    case "response_json":
      if (!exactFields(value, ["kind", "stepId", "pointer"]) || !safeId(value.stepId) ||
        typeof value.pointer !== "string" || value.pointer.length > 1_024 || pointerSourceLocator(value.pointer) === undefined) {
        return invalid("network tool response JSON producer is invalid")
      }
      return { kind: "response_json", stepId: value.stepId, pointer: value.pointer }
    default: return invalid("network tool producer kind is not value-free")
  }
}

const parseProducerRecord = (value: unknown): Readonly<Record<string, NetworkToolValueProducer>> => {
  if (!isRecord(value)) return invalid("network tool producer map is invalid")
  const entries = boundedOwnDataEntries(value, NETWORK_TOOL_LIMITS.producersPerLocation)
  if (entries === undefined) return invalid("network tool producer map is invalid")
  return recordSorted([...entries].sort(([left], [right]) => compareText(left, right)).map(([name, producer]) => {
    if (name.length === 0 || name.length > 128) return invalid("network tool producer name is invalid")
    return [name, parseProducer(producer)] as const
  }))
}

const artifactProducerOf = (producer: NetworkToolValueProducer): ValueProducer => {
  switch (producer.kind) {
    case "input": return { kind: "input", name: producer.name }
    case "clock": return { kind: "clock", format: producer.format }
    case "uuid": return { kind: "uuid" }
    case "response_header": return { kind: "response_header", stepId: producer.stepId, name: producer.name }
    case "response_json": return { kind: "response_json", stepId: producer.stepId, pointer: producer.pointer }
  }
}

const artifactProducerRecordOf = (
  producers: Readonly<Record<string, NetworkToolValueProducer>>
): Readonly<Record<string, ValueProducer>> => recordSorted(entriesSorted(producers).map(([name, producer]) =>
  [name, artifactProducerOf(producer)] as const))

const parseDefinition = (value: unknown): NetworkToolDefinition => {
  if (!isRecord(value) || !exactFields(value, [
    "schemaVersion",
    "compilerRevision",
    "toolId",
    "siteId",
    "actionId",
    "sourceTraceDigest",
    "sourceArtifactDigest",
    "inputs",
    "sessionRequirements",
    "steps",
    "dependencies",
    "evidence"
  ])) return invalid("network tool definition has an invalid shape")
  if (value.schemaVersion !== NETWORK_TOOL_SCHEMA_VERSION || value.compilerRevision !== NETWORK_TOOL_COMPILER_REVISION ||
    !safeId(value.toolId) || !safeId(value.siteId) || !safeId(value.actionId) ||
    !isSha256Digest(value.sourceTraceDigest) || !isSha256Digest(value.sourceArtifactDigest)) {
    return invalid("network tool definition identity is invalid")
  }
  if (!Array.isArray(value.inputs) || value.inputs.length > NETWORK_TOOL_LIMITS.inputs) return invalid("network tool inputs are invalid")
  const inputs: NetworkToolInput[] = value.inputs.map((input) => {
    if (!isRecord(input) || !exactFields(input, ["name", "type", "required", "source"]) || !safeId(input.name) ||
      !INPUT_TYPES.has(input.type as HarnessInputType) || typeof input.required !== "boolean" ||
      !BINDING_SOURCES.has(input.source as NetworkToolBindingSource)) return invalid("network tool input is invalid")
    return {
      name: input.name,
      type: input.type as HarnessInputType,
      required: input.required,
      source: input.source as NetworkToolBindingSource
    }
  }).sort((left, right) => compareText(left.name, right.name))
  if (new Set(inputs.map((input) => input.name)).size !== inputs.length) return invalid("network tool inputs are duplicated")

  if (!Array.isArray(value.sessionRequirements) ||
    value.sessionRequirements.length > NETWORK_TOOL_LIMITS.sessionRequirements ||
    value.sessionRequirements.some((item) => !safeOpaqueId(item))) {
    return invalid("network tool session requirements are invalid")
  }
  const sessionRequirements = sortedUnique(value.sessionRequirements as string[])
  if (sessionRequirements.length !== value.sessionRequirements.length) return invalid("network tool session requirements are duplicated")

  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > NETWORK_TOOL_LIMITS.steps) {
    return invalid("network tool steps are invalid")
  }
  const steps: NetworkToolStep[] = value.steps.map((step) => {
    if (!isRecord(step) || !exactFields(step, [
      "id", "dependsOn", "method", "origin", "path", "pathParameters", "query", "headers", "expectedStatuses"
    ]) || !safeId(step.id) || (step.method !== "GET" && step.method !== "HEAD") ||
      typeof step.origin !== "string" || typeof step.path !== "string" || !Array.isArray(step.dependsOn) ||
      step.dependsOn.length > NETWORK_TOOL_LIMITS.dependenciesPerStep ||
      step.dependsOn.some((item) => !safeId(item)) || !Array.isArray(step.expectedStatuses) ||
      step.expectedStatuses.length > NETWORK_TOOL_LIMITS.expectedStatusesPerStep ||
      step.expectedStatuses.some((status) => typeof status !== "number" || !Number.isInteger(status))) {
      return invalid("network tool step is invalid")
    }
    return {
      id: step.id,
      dependsOn: [...step.dependsOn] as string[],
      method: step.method,
      origin: step.origin,
      path: step.path,
      pathParameters: parseProducerRecord(step.pathParameters),
      query: parseProducerRecord(step.query),
      headers: parseProducerRecord(step.headers),
      expectedStatuses: [...step.expectedStatuses] as number[]
    }
  })

  if (!Array.isArray(value.dependencies) || value.dependencies.length > NETWORK_TOOL_LIMITS.dependencies) {
    return invalid("network tool dependencies are invalid")
  }
  const dependencies: NetworkToolDependency[] = value.dependencies.map((dependency) => {
    if (!isRecord(dependency) || !exactFields(dependency, ["fromStepId", "toStepId", "reason", "confidence", "evidence"]) ||
      !safeId(dependency.fromStepId) || !safeId(dependency.toStepId) ||
      typeof dependency.reason !== "string" || !DEPENDENCY_REASONS.has(dependency.reason as DependencyReason) ||
      typeof dependency.confidence !== "number" || !Number.isFinite(dependency.confidence) ||
      dependency.confidence < 0 || dependency.confidence > 1 || typeof dependency.evidence !== "string") {
      return invalid("network tool dependency is invalid")
    }
    const requestDependency: RequestDependency = {
      from: "source",
      to: "target",
      reason: dependency.reason as DependencyReason,
      confidence: dependency.confidence,
      evidence: dependency.evidence
    }
    if (!dependencyEvidenceSafe(requestDependency)) return invalid("network tool dependency evidence is invalid")
    return {
      fromStepId: dependency.fromStepId,
      toStepId: dependency.toStepId,
      reason: dependency.reason as DependencyReason,
      confidence: dependency.confidence,
      evidence: dependency.evidence
    }
  })

  if (!Array.isArray(value.evidence) || value.evidence.length !== steps.length) {
    return invalid("network tool step evidence is invalid")
  }
  const evidence: NetworkToolStepEvidence[] = value.evidence.map((item) => {
    const traceReference = isRecord(item) ? harRequestTraceReferenceOf(item.traceEventId) : undefined
    if (!isRecord(item) || !exactFields(item, ["stepId", "requestId", "traceEventId"]) ||
      !safeId(item.stepId) || !safeOpaqueId(item.requestId) || typeof item.traceEventId !== "string" ||
      traceReference === undefined ||
      traceReference.requestId !== item.requestId || traceReference.sourceTraceDigest !== value.sourceTraceDigest) {
      return invalid("network tool step evidence is invalid")
    }
    return { stepId: item.stepId, requestId: item.requestId, traceEventId: item.traceEventId }
  })

  validateSiteHarnessArtifact({
    schemaVersion: SITE_HARNESS_SCHEMA_VERSION,
    executorAbi: SITE_HARNESS_EXECUTOR_ABI,
    siteId: value.siteId,
    version: "network-tool-validation-1",
    sourceCaptureDigest: value.sourceTraceDigest,
    allowedOrigins: sortedUnique(steps.map((step) => step.origin)),
    actions: [{
      id: value.actionId,
      inputs: inputs.map(({ name, type, required }) => ({ name, type, required })),
      steps: steps.map((step) => ({
        ...step,
        pathParameters: artifactProducerRecordOf(step.pathParameters),
        query: artifactProducerRecordOf(step.query),
        headers: artifactProducerRecordOf(step.headers)
      }))
    }]
  })
  const inputSource = new Map(inputs.map((input) => [input.name, input.source]))

  const parsedById = new Map(steps.map((step) => [step.id, step]))
  const artifactInputNames = new Set(inputs.map((input) => input.name))
  const validateProducerSources = (producer: NetworkToolValueProducer): void => {
    if (producer.kind === "input" && (!artifactInputNames.has(producer.name) || inputSource.get(producer.name) !== producer.source)) {
      invalid("network tool input producer source does not match its input")
    }
  }
  for (const step of steps) {
    for (const producer of [
      ...Object.values(step.pathParameters),
      ...Object.values(step.query),
      ...Object.values(step.headers)
    ]) validateProducerSources(producer)
  }

  const stepIdSet = new Set(steps.map((step) => step.id))
  if (stepIdSet.size !== steps.length || new Set(evidence.map((item) => item.stepId)).size !== evidence.length ||
    new Set(evidence.map((item) => item.requestId)).size !== evidence.length ||
    evidence.some((item) => !stepIdSet.has(item.stepId))) return invalid("network tool evidence does not exactly cover steps")
  const pairSet = new Set(dependencies.map((dependency) => `${dependency.fromStepId}\u0000${dependency.toStepId}`))
  for (const step of steps) {
    for (const source of step.dependsOn) {
      if (!pairSet.has(`${source}\u0000${step.id}`)) return invalid("network tool dependency evidence is incomplete")
    }
  }
  for (const dependency of dependencies) {
    const target = parsedById.get(dependency.toStepId)
    if (!stepIdSet.has(dependency.fromStepId) || target === undefined || !target.dependsOn.includes(dependency.fromStepId)) {
      return invalid("network tool dependency does not match the step graph")
    }
  }

  const dependencyKeys = dependencies.map((dependency) => canonicalStringify(dependency))
  if (new Set(dependencyKeys).size !== dependencyKeys.length) return invalid("network tool dependencies are duplicated")
  const ambiguous = new Map<string, Set<string>>()
  for (const dependency of dependencies) {
    if (dependency.reason !== "value-flow") continue
    const parsed = parseValueFlowEvidence(dependency.evidence)
    if (parsed === undefined) return invalid("network tool value-flow evidence is invalid")
    const key = `${dependency.toStepId}\u0000${parsed.target}`
    const sources = ambiguous.get(key) ?? new Set<string>()
    sources.add(`${dependency.fromStepId}\u0000${parsed.source}`)
    ambiguous.set(key, sources)
  }
  if ([...ambiguous.values()].some((sources) => sources.size > 1)) {
    return invalid("network tool dependency is ambiguous")
  }
  if (dependencies.some((dependency) => dependency.reason === "cookie") && sessionRequirements.length === 0) {
    return invalid("network tool cookie dependency is missing a session requirement")
  }

  const validateResponseBinding = (
    producer: NetworkToolValueProducer,
    stepId: string,
    location: "path" | "query" | "header",
    name: string
  ): void => {
    if (producer.kind !== "response_json" && producer.kind !== "response_header") return
    const source = producer.kind === "response_json"
      ? pointerSourceLocator(producer.pointer)
      : `response.header.${locatorSegment(producer.name)}`
    if (source === undefined) return invalid("network tool response binding is invalid")
    const expected = `${source} -> ${targetLocator(location, name)}`
    const matches = dependencies.filter((dependency) => dependency.reason === "value-flow" &&
      dependency.fromStepId === producer.stepId && dependency.toStepId === stepId && dependency.evidence === expected)
    if (matches.length !== 1) return invalid("network tool response binding lacks exact dependency evidence")
  }
  for (const step of steps) {
    for (const [name, producer] of Object.entries(step.pathParameters)) validateResponseBinding(producer, step.id, "path", name)
    for (const [name, producer] of Object.entries(step.query)) validateResponseBinding(producer, step.id, "query", name)
    for (const [name, producer] of Object.entries(step.headers)) validateResponseBinding(producer, step.id, "header", name)
  }

  const stepPosition = new Map(steps.map((step, index) => [step.id, index]))
  const normalizedDependencies = [...dependencies].sort((left, right) =>
    (stepPosition.get(left.toStepId) ?? 0) - (stepPosition.get(right.toStepId) ?? 0) ||
    (stepPosition.get(left.fromStepId) ?? 0) - (stepPosition.get(right.fromStepId) ?? 0) ||
    compareText(left.reason, right.reason) || compareText(left.evidence, right.evidence) ||
    right.confidence - left.confidence)
  const normalizedEvidence = [...evidence].sort((left, right) =>
    (stepPosition.get(left.stepId) ?? 0) - (stepPosition.get(right.stepId) ?? 0) ||
    compareText(left.requestId, right.requestId) || compareText(left.traceEventId, right.traceEventId))

  const normalized: NetworkToolDefinition = {
    schemaVersion: NETWORK_TOOL_SCHEMA_VERSION,
    compilerRevision: NETWORK_TOOL_COMPILER_REVISION,
    toolId: value.toolId,
    siteId: value.siteId,
    actionId: value.actionId,
    sourceTraceDigest: value.sourceTraceDigest,
    sourceArtifactDigest: value.sourceArtifactDigest,
    inputs,
    sessionRequirements,
    steps,
    dependencies: normalizedDependencies,
    evidence: normalizedEvidence
  }
  return deepFreeze(normalized)
}

export const validateNetworkToolDefinition = (value: unknown): NetworkToolDefinition => parseDefinition(value)

export const canonicalNetworkToolDefinition = (value: unknown): string =>
  canonicalStringify(validateNetworkToolDefinition(value))

export const networkToolDigest = (value: unknown): Sha256Digest =>
  `sha256:${sha256(canonicalNetworkToolDefinition(value))}`

const parsedCompiledTool = (value: unknown): CompiledNetworkTool => {
  if (!isRecord(value) || !exactFields(value, ["digest", "definition"]) || !isSha256Digest(value.digest)) {
    return invalid("compiled network tool is invalid")
  }
  const definition = validateNetworkToolDefinition(value.definition)
  const digest = networkToolDigest(definition)
  if (digest !== value.digest) return invalid("compiled network tool digest does not match its definition")
  return deepFreeze({ digest, definition })
}

export const summarizeCompiledNetworkTool = (value: unknown): NetworkToolSummary => {
  const tool = parsedCompiledTool(value)
  const methods = sortedUnique(tool.definition.steps.map((step) => step.method)) as ReadonlyArray<"GET" | "HEAD">
  return deepFreeze({
    siteId: tool.definition.siteId,
    methods,
    stepCount: tool.definition.steps.length,
    inputCount: tool.definition.inputs.length,
    callerInputCount: tool.definition.inputs.filter((input) => input.source === "caller").length,
    vaultInputCount: tool.definition.inputs.filter((input) => input.source === "vault").length,
    dependencyCount: tool.definition.dependencies.length,
    sessionRequirementCount: tool.definition.sessionRequirements.length
  })
}

const catalogEntryOf = (value: unknown): NetworkToolCatalogEntry => {
  if (!isRecord(value) || !exactFields(value, ["tool"], ["approval", "verification"])) {
    return invalid("network tool catalog entry is invalid")
  }
  const tool = parsedCompiledTool(value.tool)
  let approval: NetworkToolApproval | undefined
  if (value.approval !== undefined) {
    if (!isRecord(value.approval) || !exactFields(value.approval, ["toolDigest", "approvalId"]) ||
      value.approval.toolDigest !== tool.digest || !safeOpaqueId(value.approval.approvalId)) {
      return invalid("network tool approval does not bind the exact tool")
    }
    approval = { toolDigest: tool.digest, approvalId: value.approval.approvalId }
  }
  let verification: NetworkToolVerification | undefined
  if (value.verification !== undefined) {
    if (!isRecord(value.verification) || !exactFields(value.verification, [
      "toolDigest", "evaluationId", "evidenceDigest", "passed"
    ]) || value.verification.toolDigest !== tool.digest || !safeOpaqueId(value.verification.evaluationId) ||
      !isSha256Digest(value.verification.evidenceDigest) || typeof value.verification.passed !== "boolean") {
      return invalid("network tool verification does not bind the exact tool")
    }
    verification = {
      toolDigest: tool.digest,
      evaluationId: value.verification.evaluationId,
      evidenceDigest: value.verification.evidenceDigest,
      passed: value.verification.passed
    }
  }
  return deepFreeze({ tool, ...(approval === undefined ? {} : { approval }), ...(verification === undefined ? {} : { verification }) })
}

export const createNetworkToolCatalog = (values: ReadonlyArray<NetworkToolCatalogEntry>): NetworkToolCatalog => {
  if (!Array.isArray(values) || values.length > NETWORK_TOOL_LIMITS.catalogEntries) return invalid("network tool catalog entries are invalid")
  const byDigest = new Map<Sha256Digest, NetworkToolCatalogEntry>()
  for (const value of values) {
    const entry = catalogEntryOf(value)
    const prior = byDigest.get(entry.tool.digest)
    if (prior !== undefined && canonicalStringify(prior) !== canonicalStringify(entry)) {
      return invalid("network tool catalog contains conflicting records for one digest")
    }
    byDigest.set(entry.tool.digest, entry)
  }
  const entries = [...byDigest.values()].sort((left, right) =>
    compareText(left.tool.definition.siteId, right.tool.definition.siteId) ||
    compareText(left.tool.definition.toolId, right.tool.definition.toolId) ||
    compareText(left.tool.definition.actionId, right.tool.definition.actionId) ||
    compareText(left.tool.digest, right.tool.digest))
  const base = { schemaVersion: NETWORK_TOOL_CATALOG_SCHEMA_VERSION, entries } as const
  return deepFreeze({ ...base, digest: digestOf(base) })
}

const parsedInvocation = (value: unknown): NetworkToolInvocationRequest => {
  if (!isRecord(value) || !exactFields(value, [
    "siteId", "toolId", "actionId", "bindings", "availableSessionRequirements"
  ], ["expectedToolDigest", "expectedSourceTraceDigest", "expectedSourceArtifactDigest"]) ||
    !safeId(value.siteId) || !safeId(value.toolId) || !safeId(value.actionId) || !Array.isArray(value.bindings) ||
    value.bindings.length > NETWORK_TOOL_LIMITS.inputs || !Array.isArray(value.availableSessionRequirements) ||
    value.availableSessionRequirements.length > NETWORK_TOOL_LIMITS.sessionRequirements) {
    return invalid("network tool invocation request is invalid")
  }
  const bindings: NetworkToolInvocationBinding[] = value.bindings.map((binding) => {
    if (!isRecord(binding) || !exactFields(binding, ["name", "type", "required", "source"]) || !safeId(binding.name) ||
      !INPUT_TYPES.has(binding.type as HarnessInputType) || typeof binding.required !== "boolean" ||
      !BINDING_SOURCES.has(binding.source as NetworkToolBindingSource)) return invalid("network tool invocation binding is invalid")
    return {
      name: binding.name,
      type: binding.type as HarnessInputType,
      required: binding.required,
      source: binding.source as NetworkToolBindingSource
    }
  }).sort((left, right) => compareText(left.name, right.name))
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length ||
    value.availableSessionRequirements.some((item) => !safeOpaqueId(item))) {
    return invalid("network tool invocation contract is invalid")
  }
  for (const field of ["expectedToolDigest", "expectedSourceTraceDigest", "expectedSourceArtifactDigest"] as const) {
    if (value[field] !== undefined && !isSha256Digest(value[field])) return invalid("network tool invocation digest is invalid")
  }
  return deepFreeze({
    siteId: value.siteId,
    toolId: value.toolId,
    actionId: value.actionId,
    bindings,
    availableSessionRequirements: sortedUnique(value.availableSessionRequirements as string[]),
    ...(value.expectedToolDigest === undefined ? {} : { expectedToolDigest: value.expectedToolDigest as Sha256Digest }),
    ...(value.expectedSourceTraceDigest === undefined ? {} : { expectedSourceTraceDigest: value.expectedSourceTraceDigest as Sha256Digest }),
    ...(value.expectedSourceArtifactDigest === undefined ? {} : { expectedSourceArtifactDigest: value.expectedSourceArtifactDigest as Sha256Digest })
  })
}

const validatedCatalog = (catalog: NetworkToolCatalog): NetworkToolCatalog => {
  if (!isRecord(catalog) || !exactFields(catalog, ["schemaVersion", "digest", "entries"]) ||
    catalog.schemaVersion !== NETWORK_TOOL_CATALOG_SCHEMA_VERSION || !isSha256Digest(catalog.digest) ||
    !Array.isArray(catalog.entries)) return invalid("network tool catalog is invalid")
  const recreated = createNetworkToolCatalog(catalog.entries)
  if (recreated.digest !== catalog.digest) return invalid("network tool catalog digest does not match its entries")
  return recreated
}

export const decideNetworkToolShortCircuit = (
  catalogValue: NetworkToolCatalog,
  requestValue: NetworkToolInvocationRequest
): NetworkToolShortCircuitDecision => {
  let catalog: NetworkToolCatalog
  try {
    catalog = validatedCatalog(catalogValue)
  } catch {
    return decisionFallback("invalid_catalog")
  }
  let request: NetworkToolInvocationRequest
  try {
    request = parsedInvocation(requestValue)
  } catch {
    return decisionFallback("invalid_request")
  }

  let candidates = catalog.entries.filter((entry) => {
    const definition = entry.tool.definition
    return definition.siteId === request.siteId && definition.toolId === request.toolId &&
      definition.actionId === request.actionId &&
      (request.expectedSourceTraceDigest === undefined || definition.sourceTraceDigest === request.expectedSourceTraceDigest) &&
      (request.expectedSourceArtifactDigest === undefined || definition.sourceArtifactDigest === request.expectedSourceArtifactDigest)
  })
  if (candidates.length === 0) return decisionFallback("no_exact_match")
  if (request.expectedToolDigest !== undefined) {
    candidates = candidates.filter((entry) => entry.tool.digest === request.expectedToolDigest)
    if (candidates.length === 0) return decisionFallback("tool_digest_mismatch")
  }

  const requestedBindings = canonicalStringify(request.bindings)
  candidates = candidates.filter((entry) => canonicalStringify(entry.tool.definition.inputs) === requestedBindings)
  if (candidates.length === 0) return decisionFallback("input_contract_mismatch")

  const available = new Set(request.availableSessionRequirements)
  candidates = candidates.filter((entry) => entry.tool.definition.sessionRequirements.every((requirement) => available.has(requirement)))
  if (candidates.length === 0) return decisionFallback("session_requirement_missing")
  if (candidates.length !== 1) return decisionFallback("ambiguous_match")

  const [entry] = candidates
  if (entry === undefined) return decisionFallback("no_exact_match")
  if (entry.approval === undefined) return decisionFallback("tool_unapproved")
  if (entry.verification === undefined) return decisionFallback("tool_unverified")
  if (!entry.verification.passed) return decisionFallback("verification_failed")
  return deepFreeze({
    decision: "reuse",
    toolDigest: entry.tool.digest,
    tool: entry.tool.definition,
    invocation: request
  })
}
