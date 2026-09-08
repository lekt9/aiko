import {
  discoverActionCandidates,
  inferDependencies,
  type ActionCandidate,
  type NormalizedHarEntry,
  type NormalizedHarTrace,
  type RequestDependency
} from "./har"
import type { Event } from "tardie/core/log/event"
import {
  validatedHarCaptureFactsOf,
  type ValidatedHarCaptureFacts,
  type ValidatedHarExchange
} from "./har-facts"
import type { HarValueProfile, HarValueProfileEntry } from "./har-value-profile"
import {
  createSiteHarnessCandidate,
  isSafeStaticHarnessPathSegment,
  type HarnessHttpMethod,
  type HarnessInput,
  type HarnessInputType,
  type HarnessStep,
  type SiteHarnessArtifact,
  type ValueProducer
} from "./harness-artifact"

export interface HarnessDraftIssue {
  readonly stepId: string
  readonly location: string
  readonly code:
    | "ambiguous_dependency"
    | "array_selection_required"
    | "dynamic_value_missing"
    | "session_adapter_required"
    | "site_control_dependency"
    | "status_unknown"
  readonly detail: string
}

export interface SiteHarnessDraft {
  readonly artifact: SiteHarnessArtifact
  readonly actionCandidate: ActionCandidate
  readonly usedDependencies: ReadonlyArray<RequestDependency>
  /** A candidate with any unresolved item must fail evaluation until it is explicitly repaired. */
  readonly unresolved: ReadonlyArray<HarnessDraftIssue>
}

export interface BuildSiteHarnessDraftOptions {
  readonly actionId?: string
  readonly siteId?: string
  readonly version?: string
}

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const SESSION_FIELD = /(?:auth(?:entication|orization)?|cookie|csrf|password|secret|session|token)/iu
const SITE_CONTROL_FIELD = /(?:bot|captcha|challenge|fingerprint|sensor)/iu
const SENSITIVE_FIELD = /(?:auth(?:entication|orization)?|bot|captcha|challenge|cookie|csrf|fingerprint|password|secret|sensor|session|token)/iu
const SESSION_HEADERS = new Set(["authorization", "cookie", "origin", "referer"])
const DYNAMIC_ID_HEADERS = new Set(["idempotency-key", "x-correlation-id", "x-request-id"])

const idOf = (value: string, fallback: string): string => {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/[-_.]+$/u, "")
    .slice(0, 64)
  if (SAFE_ID.test(normalized)) return normalized
  return fallback
}

const digestOfTrace = (trace: NormalizedHarTrace): `sha256:${string}` => {
  if (!/^[0-9a-f]{64}$/u.test(trace.digest)) throw new Error("Normalized HAR trace has an invalid digest")
  return `sha256:${trace.digest}`
}

const unique = <T>(values: Iterable<T>): ReadonlyArray<T> => [...new Set(values)]

const inputTypeOf = (value: unknown): HarnessInputType => {
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (typeof value === "string") return "string"
  return "json"
}

const jsonObjectOf = (entry: NormalizedHarEntry): Readonly<Record<string, unknown>> | undefined => {
  if (entry.request.body?.text === undefined || !entry.request.body.mimeType.includes("json")) return undefined
  try {
    const value: unknown = JSON.parse(entry.request.body.text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined
  } catch {
    return undefined
  }
}

const pointerFromResponseLocator = (locator: string): string | undefined => {
  if (!locator.startsWith("response.body.")) return undefined
  const tail = locator.slice("response.body.".length)
  if (tail.length === 0 || tail.includes("[]")) return undefined
  const segments = tail.split(".")
  if (segments.some((segment) => segment.length === 0)) return undefined
  return `/${segments.map((segment) => segment.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`
}

interface PathTemplate {
  readonly path: string
  readonly parameters: ReadonlyArray<{ readonly placeholder: string; readonly input: string }>
}

const pathTemplateOf = (entry: NormalizedHarEntry, preferred: string | undefined): PathTemplate => {
  const raw = preferred ?? entry.request.path
  const segments = raw.split("/")
  const parameters: Array<{ placeholder: string; input: string }> = []
  let placeholderIndex = 0
  const rendered = segments.map((rawSegment) => {
    if (rawSegment.length === 0) return ""
    const colon = /^:([A-Za-z][A-Za-z0-9_-]*)$/u.exec(rawSegment)
    const brace = /^\{([A-Za-z][A-Za-z0-9_-]*)\}$/u.exec(rawSegment)
    let decoded = rawSegment
    try { decoded = decodeURIComponent(rawSegment) } catch {}
    if (colon === null && brace === null && isSafeStaticHarnessPathSegment(decoded)) return rawSegment
    placeholderIndex += 1
    const suggested = colon?.[1] ?? brace?.[1] ?? `segment-${placeholderIndex}`
    const placeholder = idOf(`${suggested}-${placeholderIndex}`, `segment-${placeholderIndex}`)
    const input = idOf(`${entry.id}-${suggested}-${placeholderIndex}`, `path-${placeholderIndex}`)
    parameters.push({ placeholder, input })
    return `{${placeholder}}`
  })
  return { path: rendered.join("/") || "/", parameters }
}

interface ProducerMatch {
  readonly producer?: ValueProducer
  readonly dependency?: RequestDependency
  readonly issue?: HarnessDraftIssue
}

const producerFromDependency = (
  dependencies: ReadonlyArray<RequestDependency>,
  targetRequestId: string,
  targetLocator: string,
  stepIds: ReadonlyMap<string, string>
): ProducerMatch => {
  const matches = dependencies.filter((dependency) =>
    dependency.to === targetRequestId && dependency.reason === "value-flow" &&
    dependency.evidence.endsWith(` -> ${targetLocator}`))
  if (matches.length === 0) return {}
  if (matches.length > 1) {
    return {
      issue: {
        stepId: stepIds.get(targetRequestId) ?? targetRequestId,
        location: targetLocator,
        code: "ambiguous_dependency",
        detail: "More than one response can produce this request value."
      }
    }
  }
  const dependency = matches[0]!
  const sourceStepId = stepIds.get(dependency.from)
  if (sourceStepId === undefined) return {}
  const source = dependency.evidence.slice(0, dependency.evidence.indexOf(" -> "))
  const pointer = pointerFromResponseLocator(source)
  if (pointer === undefined) {
    return {
      dependency,
      issue: {
        stepId: stepIds.get(targetRequestId) ?? targetRequestId,
        location: targetLocator,
        code: source.includes("[]") ? "array_selection_required" : "dynamic_value_missing",
        detail: source.includes("[]")
          ? `The inferred producer ${source} needs an explicit, evaluated array-selection rule.`
          : `The inferred producer ${source} is not an executable JSON-pointer binding.`
      }
    }
  }
  return { producer: { kind: "response_json", stepId: sourceStepId, pointer }, dependency }
}

const closureFor = (
  action: ActionCandidate,
  dependencies: ReadonlyArray<RequestDependency>,
  entries: ReadonlyMap<string, NormalizedHarEntry>
): ReadonlySet<string> => {
  const selected = new Set<string>([action.requestId])
  const pending = [action.requestId]
  while (pending.length > 0) {
    const target = pending.pop()!
    for (const edge of dependencies) {
      if (edge.to !== target || !["value-flow", "redirect", "initiator"].includes(edge.reason)) continue
      const source = entries.get(edge.from)
      const consumer = entries.get(target)
      if (source === undefined || consumer === undefined || source.index >= consumer.index) continue
      if (source.request.origin !== consumer.request.origin || selected.has(edge.from)) continue
      selected.add(edge.from)
      pending.push(edge.from)
    }
  }
  return selected
}

export const buildSiteHarnessDraft = (
  trace: NormalizedHarTrace,
  options: BuildSiteHarnessDraftOptions = {}
): SiteHarnessDraft => {
  if (trace.errors.length > 0) throw new Error(`Cannot build a harness from an invalid HAR: ${trace.errors.join("; ")}`)
  const dependencies = inferDependencies(trace.entries)
  const candidates = discoverActionCandidates(trace.entries, dependencies)
  const action = options.actionId === undefined
    ? candidates[0]
    : candidates.find((candidate) => candidate.id === options.actionId || candidate.name === options.actionId)
  if (action === undefined) throw new Error("The capture does not contain the requested mutating action candidate")
  const byId = new Map(trace.entries.map((entry) => [entry.id, entry]))
  const target = byId.get(action.requestId)
  if (target === undefined) throw new Error("Action candidate references a missing request")
  const selected = closureFor(action, dependencies, byId)
  const entries = trace.entries.filter((entry) => selected.has(entry.id)).sort((left, right) => left.index - right.index)
  const stepIds = new Map(entries.map((entry, index) => [entry.id, idOf(entry.id, `step-${index + 1}`)]))
  const inputs = new Map<string, HarnessInput>()
  const unresolved: HarnessDraftIssue[] = []
  const usedDependencies: RequestDependency[] = []

  const useInput = (suggested: string, type: HarnessInputType = "string"): ValueProducer => {
    let name = idOf(suggested, "input")
    let suffix = 1
    while (inputs.has(name) && inputs.get(name)?.type !== type) {
      suffix += 1
      name = idOf(`${suggested}-${suffix}`, `input-${suffix}`)
    }
    inputs.set(name, { name, type, required: true })
    return { kind: "input", name }
  }

  const steps: HarnessStep[] = entries.map((entry) => {
    const stepId = stepIds.get(entry.id)!
    const preferredPath = entry.id === action.requestId ? action.pathTemplate : undefined
    const route = pathTemplateOf(entry, preferredPath)
    const pathParameters = Object.fromEntries(route.parameters.map((parameter) =>
      [parameter.placeholder, useInput(parameter.input)]))
    const incoming = unique(dependencies
      .filter((dependency) => dependency.to === entry.id && selected.has(dependency.from))
      .map((dependency) => stepIds.get(dependency.from))
      .filter((value): value is string => value !== undefined))
    const query: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
    for (const field of entry.request.query) {
      if (SENSITIVE_FIELD.test(field.name)) {
        unresolved.push({
          stepId,
          location: `request.query.${field.name}`,
          code: SITE_CONTROL_FIELD.test(field.name) ? "site_control_dependency" : "session_adapter_required",
          detail: "A sensitive query value requires an explicitly approved external adapter."
        })
        continue
      }
      const match = producerFromDependency(dependencies, entry.id, `request.query.${field.name}`, stepIds)
      if (match.dependency !== undefined) usedDependencies.push(match.dependency)
      if (match.issue !== undefined) unresolved.push(match.issue)
      query[field.name] = match.producer ?? useInput(`${stepId}-${field.name}`)
    }

    const headers: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
    for (const header of entry.request.headers) {
      const name = header.name.toLowerCase()
      if (name.startsWith(":")) continue
      if (SESSION_HEADERS.has(name)) {
        if (name === "authorization" || name === "cookie") {
          unresolved.push({
            stepId,
            location: `request.header.${name}`,
            code: "session_adapter_required",
            detail: "Credentials and cookies must come from an approved session adapter outside the artifact."
          })
        }
        continue
      }
      if (name === "content-type") {
        const mimeType = entry.request.body?.mimeType.includes("json")
          ? "application/json"
          : entry.request.body?.mimeType === "application/x-www-form-urlencoded"
          ? "application/x-www-form-urlencoded"
          : undefined
        if (mimeType !== undefined) headers[name] = { kind: "constant", value: mimeType }
        continue
      }
      if (name === "accept") {
        headers[name] = { kind: "constant", value: "application/json" }
        continue
      }
      if (name === "date") {
        headers[name] = { kind: "clock", format: "rfc1123" }
        continue
      }
      if (DYNAMIC_ID_HEADERS.has(name)) {
        headers[name] = { kind: "uuid" }
        continue
      }
      const match = producerFromDependency(dependencies, entry.id, `request.header.${name}`, stepIds)
      if (match.dependency !== undefined) usedDependencies.push(match.dependency)
      if (match.producer !== undefined) headers[name] = match.producer
      else {
        if (match.issue !== undefined) unresolved.push(match.issue)
        unresolved.push({
          stepId,
          location: `request.header.${name}`,
          code: SITE_CONTROL_FIELD.test(name)
            ? "site_control_dependency"
            : SESSION_FIELD.test(name) ? "session_adapter_required" : "dynamic_value_missing",
          detail: "The captured header was deliberately not copied; add a typed runtime producer and evaluate it."
        })
      }
    }

    const bodyObject = jsonObjectOf(entry)
    let body: ValueProducer | undefined
    if (bodyObject !== undefined) {
      const fields: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
      for (const [field, observed] of Object.entries(bodyObject)) {
        if (SENSITIVE_FIELD.test(field)) {
          unresolved.push({
            stepId,
            location: `request.body.${field}`,
            code: SITE_CONTROL_FIELD.test(field) ? "site_control_dependency" : "session_adapter_required",
            detail: "A sensitive body field requires an explicitly approved external adapter."
          })
          continue
        }
        const match = producerFromDependency(dependencies, entry.id, `request.body.${field}`, stepIds)
        if (match.dependency !== undefined) usedDependencies.push(match.dependency)
        if (match.issue !== undefined) unresolved.push(match.issue)
        fields[field] = match.producer ?? useInput(field, inputTypeOf(observed))
      }
      body = { kind: "object", fields }
    } else if (entry.request.body !== undefined) {
      body = useInput(`${stepId}-body`, "string")
    }

    const status = entry.response.status >= 100 && entry.response.status <= 599
      ? entry.response.status
      : 200
    if (entry.response.status === 0) {
      unresolved.push({
        stepId,
        location: "response.status",
        code: "status_unknown",
        detail: "The observed exchange had no HTTP response status; add an evaluated expectation."
      })
    }
    return {
      id: stepId,
      dependsOn: incoming,
      method: entry.request.method as HarnessHttpMethod,
      origin: entry.request.origin,
      path: route.path,
      pathParameters,
      query,
      headers,
      ...(body === undefined ? {} : { body }),
      expectedStatuses: [status]
    }
  })

  const siteId = options.siteId ?? idOf(target.request.origin.replace(/^https?:\/\//u, ""), "website")
  const artifact = createSiteHarnessCandidate({
    siteId,
    version: options.version ?? `capture-${trace.digest.slice(0, 12)}`,
    sourceCaptureDigest: digestOfTrace(trace),
    allowedOrigins: unique(entries.map((entry) => entry.request.origin)),
    actions: [{ id: idOf(action.name, "action"), inputs: [...inputs.values()], steps }]
  })
  const issueKey = (item: HarnessDraftIssue): string => `${item.stepId}\u0000${item.location}\u0000${item.code}`
  return {
    artifact,
    actionCandidate: action,
    usedDependencies: [...new Map(usedDependencies.map((dependency) => [
      `${dependency.from}\u0000${dependency.to}\u0000${dependency.evidence}`,
      dependency
    ])).values()],
    unresolved: [...new Map(unresolved.map((item) => [issueKey(item), item])).values()]
  }
}

export type HarnessDraftBuildFailureCode =
  | "capture_not_found"
  | "capture_incomplete"
  | "capture_invalid"
  | "action_not_found"
  | "draft_invalid"

export class HarnessDraftBuildError extends Error {
  readonly code: HarnessDraftBuildFailureCode

  constructor(code: HarnessDraftBuildFailureCode, message: string) {
    super(message)
    this.name = "HarnessDraftBuildError"
    this.code = code
  }
}

export interface LogSiteHarnessDraft extends SiteHarnessDraft {
  readonly captureId: string
  readonly importDigest: string
}

const STRUCTURAL_DEPENDENCY_REASONS = new Set(["value-flow", "redirect", "initiator"])

const closureForCapture = (
  action: ActionCandidate,
  dependencies: ReadonlyArray<RequestDependency>,
  exchanges: ReadonlyMap<string, ValidatedHarExchange>
): ReadonlySet<string> => {
  const selected = new Set<string>([action.requestId])
  const pending = [action.requestId]
  while (pending.length > 0) {
    const target = pending.pop()!
    for (const edge of dependencies) {
      if (edge.to !== target || !STRUCTURAL_DEPENDENCY_REASONS.has(edge.reason)) continue
      const source = exchanges.get(edge.from)
      const consumer = exchanges.get(target)
      if (source === undefined || consumer === undefined || source.index >= consumer.index) continue
      if (source.request.origin !== consumer.request.origin || selected.has(edge.from)) continue
      selected.add(edge.from)
      pending.push(edge.from)
    }
  }
  return selected
}

const pathTemplateFromFact = (
  exchange: ValidatedHarExchange,
  preferred: string | undefined
): PathTemplate => {
  const raw = preferred ?? exchange.request.path
  const parameters: Array<{ placeholder: string; input: string }> = []
  let placeholderIndex = 0
  const path = raw.split("/").map((rawSegment) => {
    if (rawSegment.length === 0) return ""
    const colon = /^:([A-Za-z][A-Za-z0-9_-]*)$/u.exec(rawSegment)
    const brace = /^\{([A-Za-z][A-Za-z0-9_-]*)\}$/u.exec(rawSegment)
    let decoded = rawSegment
    try { decoded = decodeURIComponent(rawSegment) } catch {}
    if (colon === null && brace === null && isSafeStaticHarnessPathSegment(decoded)) return rawSegment
    placeholderIndex += 1
    const suggested = colon?.[1] ?? brace?.[1] ?? `segment-${placeholderIndex}`
    const placeholder = idOf(`${suggested}-${placeholderIndex}`, `segment-${placeholderIndex}`)
    parameters.push({
      placeholder,
      input: idOf(`${exchange.requestId}-${suggested}-${placeholderIndex}`, `path-${placeholderIndex}`)
    })
    return `{${placeholder}}`
  }).join("/") || "/"
  return { path, parameters }
}

const targetBodyFieldsOf = (
  exchange: ValidatedHarExchange,
  action: ActionCandidate,
  dependencies: ReadonlyArray<RequestDependency>
): ReadonlyArray<string> => {
  const fields = new Set<string>()
  if (exchange.requestId === action.requestId) {
    const query = new Set(exchange.request.queryFields)
    action.inputFields.filter((field) => !query.has(field)).forEach((field) => fields.add(field))
  }
  for (const dependency of dependencies) {
    if (dependency.to !== exchange.requestId || dependency.reason !== "value-flow") continue
    const separator = dependency.evidence.indexOf(" -> ")
    const target = separator < 0 ? "" : dependency.evidence.slice(separator + 4)
    if (!target.startsWith("request.body.")) continue
    const field = target.slice("request.body.".length).split(/[.\[]/u, 1)[0]
    if (field !== undefined && field.length > 0) fields.add(field)
  }
  return [...fields].sort()
}

const valueProfileEntryForHeader = (
  profile: HarValueProfile | undefined,
  origin: string,
  name: string
): HarValueProfileEntry | undefined => profile?.entries.find((entry) =>
  entry.kind === "header" && entry.origin === origin && entry.name === name)

const missingHeaderIssue = (
  profile: HarValueProfile | undefined,
  origin: string,
  name: string
): Pick<HarnessDraftIssue, "code" | "detail"> => {
  if (SITE_CONTROL_FIELD.test(name)) {
    return {
      code: "site_control_dependency",
      detail: "A site-control field requires an independently reviewed producer."
    }
  }
  if (SESSION_FIELD.test(name)) {
    return {
      code: "session_adapter_required",
      detail: "A sensitive captured header requires an approved session adapter."
    }
  }
  const entry = valueProfileEntryForHeader(profile, origin, name)
  if (entry === undefined) {
    return {
      code: "dynamic_value_missing",
      detail: "The sanitized log has no executable producer or cardinality evidence for this captured header."
    }
  }
  if (["reuse_static", "reuse_family_static", "context_reinject", "session_reinject"].includes(entry.handling)) {
    return {
      code: "session_adapter_required",
      detail: entry.handling === "reuse_static"
        ? `Capture-local evidence observed one value across ${entry.observations} requests; keep it in the encrypted local adapter rather than labeling it dynamic.`
        : entry.handling === "reuse_family_static"
        ? `Capture-local evidence observed one value per request family across ${entry.observations} requests; select the encrypted family-bound variant at runtime.`
        : `Capture-local evidence observed ${entry.distinctValues} bounded contextual variants across ${entry.observations} requests; select one through an approved external adapter.`
    }
  }
  if (entry.handling === "recompute") {
    return {
      code: "dynamic_value_missing",
      detail: `Capture-local evidence classifies this field as ${entry.stability}; an evaluated recomputation producer is still required.`
    }
  }
  if (entry.handling === "response_reinject") {
    return {
      code: "dynamic_value_missing",
      detail: "Exact prior-response lineage was observed, but this draft has no executable response binding."
    }
  }
  return {
    code: "dynamic_value_missing",
    detail: `Capture-local evidence classifies this field as ${entry.stability}, but does not establish a reusable or executable producer.`
  }
}

/**
 * Reclassify only existing header findings. This cannot add a producer or clear a
 * finding; it corrects whether trusted compilation needs a static/context
 * adapter or a genuinely dynamic producer.
 */
export const applyHarValueProfileToDraftFindings = (
  artifact: SiteHarnessArtifact,
  findings: ReadonlyArray<Pick<HarnessDraftIssue, "stepId" | "location" | "code">>,
  profile: HarValueProfile
): ReadonlyArray<Pick<HarnessDraftIssue, "stepId" | "location" | "code">> => {
  const originByStep = new Map(artifact.actions.flatMap((action) =>
    action.steps.map((step) => [step.id, step.origin] as const)))
  return Object.freeze(findings.map((finding) => {
    if (finding.code !== "dynamic_value_missing" || !finding.location.startsWith("request.header.")) return finding
    const origin = originByStep.get(finding.stepId)
    if (origin === undefined) return finding
    const name = finding.location.slice("request.header.".length).toLowerCase()
    const classified = missingHeaderIssue(profile, origin, name)
    return classified.code === finding.code ? finding : Object.freeze({ ...finding, code: classified.code })
  }))
}

const buildSiteHarnessDraftFromCapture = (
  capture: ValidatedHarCaptureFacts,
  options: BuildSiteHarnessDraftOptions,
  actionOverride?: ActionCandidate,
  valueProfile?: HarValueProfile
): LogSiteHarnessDraft => {
  const action = actionOverride ?? (options.actionId === undefined
    ? capture.actions[0]
    : capture.actions.find((candidate) => candidate.id === options.actionId || candidate.name === options.actionId))
  if (action === undefined) {
    throw new HarnessDraftBuildError("action_not_found", "The capture does not contain the requested action candidate.")
  }

  const byId = new Map(capture.exchanges.map((exchange) => [exchange.requestId, exchange]))
  const target = byId.get(action.requestId)
  if (target === undefined) {
    throw new HarnessDraftBuildError("capture_invalid", "The action candidate references a missing exchange.")
  }
  const selected = closureForCapture(action, capture.dependencies, byId)
  const exchanges = capture.exchanges.filter((exchange) => selected.has(exchange.requestId))
    .sort((left, right) => left.index - right.index)
  if (exchanges.length === 0 || exchanges.length > 128) {
    throw new HarnessDraftBuildError("draft_invalid", "The selected dependency closure cannot fit in one bounded action.")
  }
  const stepIds = new Map(exchanges.map((exchange, index) =>
    [exchange.requestId, idOf(exchange.requestId, `step-${index + 1}`)]))
  if (new Set(stepIds.values()).size !== stepIds.size) {
    throw new HarnessDraftBuildError("draft_invalid", "The selected exchanges do not produce unique step identifiers.")
  }

  const inputs = new Map<string, HarnessInput>()
  const unresolved: HarnessDraftIssue[] = []
  const usedDependencies: RequestDependency[] = []
  const addIssue = (
    stepId: string,
    location: string,
    code: HarnessDraftIssue["code"],
    detail: string
  ): void => { unresolved.push({ stepId, location, code, detail }) }
  const useInput = (suggested: string, type: HarnessInputType = "string"): ValueProducer => {
    let name = idOf(suggested, "input")
    let suffix = 1
    while (inputs.has(name) && inputs.get(name)?.type !== type) {
      suffix += 1
      name = idOf(`${suggested}-${suffix}`, `input-${suffix}`)
    }
    inputs.set(name, { name, type, required: true })
    return { kind: "input", name }
  }

  const steps: HarnessStep[] = exchanges.map((exchange) => {
    const stepId = stepIds.get(exchange.requestId)!
    const route = pathTemplateFromFact(
      exchange,
      exchange.requestId === action.requestId ? action.pathTemplate : undefined
    )
    const incomingEdges = capture.dependencies.filter((dependency) =>
      dependency.to === exchange.requestId && selected.has(dependency.from) &&
      STRUCTURAL_DEPENDENCY_REASONS.has(dependency.reason))
    usedDependencies.push(...incomingEdges)
    const incoming = unique(incomingEdges
      .map((dependency) => stepIds.get(dependency.from))
      .filter((value): value is string => value !== undefined))

    const pathParameters: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
    const pathMatch = producerFromDependency(
      capture.dependencies,
      exchange.requestId,
      "request.path.segment",
      stepIds
    )
    if (pathMatch.dependency !== undefined) usedDependencies.push(pathMatch.dependency)
    if (route.parameters.length === 1 && pathMatch.producer !== undefined) {
      pathParameters[route.parameters[0]!.placeholder] = pathMatch.producer
    } else {
      if (pathMatch.issue !== undefined) unresolved.push(pathMatch.issue)
      if (route.parameters.length > 1 && pathMatch.dependency !== undefined) {
        addIssue(
          stepId,
          "request.path.segment",
          "ambiguous_dependency",
          "A structural value-flow does not identify which path placeholder it supplies."
        )
      }
      route.parameters.forEach((parameter) => {
        pathParameters[parameter.placeholder] = useInput(parameter.input)
      })
    }

    const query: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
    for (const field of exchange.request.queryFields) {
      if (SENSITIVE_FIELD.test(field)) {
        addIssue(
          stepId,
          `request.query.${field}`,
          SITE_CONTROL_FIELD.test(field) ? "site_control_dependency" : "session_adapter_required",
          "A sensitive query field requires an explicitly approved external adapter."
        )
        continue
      }
      const match = producerFromDependency(capture.dependencies, exchange.requestId, `request.query.${field}`, stepIds)
      if (match.dependency !== undefined) usedDependencies.push(match.dependency)
      if (match.issue !== undefined) unresolved.push(match.issue)
      query[field] = match.producer ?? useInput(`${stepId}-${field}`)
    }

    const headers: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
    for (const capturedName of exchange.request.headerFields) {
      const name = capturedName.toLowerCase()
      if (SESSION_HEADERS.has(name)) {
        if (name === "authorization" || name === "cookie") {
          addIssue(
            stepId,
            `request.header.${name}`,
            "session_adapter_required",
            "Credentials and cookies must come from an approved session adapter."
          )
        }
        continue
      }
      if (name === "content-type") {
        const mimeType = exchange.request.body?.mimeType.includes("json")
          ? "application/json"
          : exchange.request.body?.mimeType === "application/x-www-form-urlencoded"
          ? "application/x-www-form-urlencoded"
          : undefined
        if (mimeType !== undefined) headers[name] = { kind: "constant", value: mimeType }
        continue
      }
      if (name === "accept") {
        headers[name] = { kind: "constant", value: "application/json" }
        continue
      }
      if (name === "date") {
        headers[name] = { kind: "clock", format: "rfc1123" }
        continue
      }
      if (DYNAMIC_ID_HEADERS.has(name)) {
        headers[name] = { kind: "uuid" }
        continue
      }
      const match = producerFromDependency(capture.dependencies, exchange.requestId, `request.header.${name}`, stepIds)
      if (match.dependency !== undefined) usedDependencies.push(match.dependency)
      if (match.producer !== undefined) {
        headers[name] = match.producer
      } else {
        if (match.issue !== undefined) unresolved.push(match.issue)
        const issue = missingHeaderIssue(valueProfile, exchange.request.origin, name)
        addIssue(stepId, `request.header.${name}`, issue.code, issue.detail)
      }
    }
    for (const cookieName of exchange.request.cookieNames) {
      addIssue(
        stepId,
        `request.cookie.${cookieName}`,
        "session_adapter_required",
        "Cookies must come from an approved session adapter."
      )
    }

    let body: ValueProducer | undefined
    const bodyFields = targetBodyFieldsOf(exchange, action, capture.dependencies)
    if (exchange.request.body?.mimeType.includes("json") && bodyFields.length > 0) {
      const fields: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
      for (const field of bodyFields) {
        if (SENSITIVE_FIELD.test(field) || ["__proto__", "constructor", "prototype"].includes(field)) {
          addIssue(
            stepId,
            `request.body.${field}`,
            SITE_CONTROL_FIELD.test(field) ? "site_control_dependency" : "session_adapter_required",
            "This body field requires an explicitly approved producer."
          )
          continue
        }
        const match = producerFromDependency(capture.dependencies, exchange.requestId, `request.body.${field}`, stepIds)
        if (match.dependency !== undefined) usedDependencies.push(match.dependency)
        if (match.issue !== undefined) unresolved.push(match.issue)
        fields[field] = match.producer ?? useInput(`${stepId}-${field}`, "json")
      }
      body = { kind: "object", fields }
    } else if (exchange.request.body !== undefined) {
      body = useInput(
        `${stepId}-body`,
        exchange.request.body.mimeType.includes("json") ? "json" : "string"
      )
    }

    const status = exchange.response.status >= 100 && exchange.response.status <= 599
      ? exchange.response.status
      : 200
    if (exchange.response.status === 0) {
      addIssue(
        stepId,
        "response.status",
        "status_unknown",
        "The captured exchange had no HTTP response status."
      )
    }
    return {
      id: stepId,
      dependsOn: incoming,
      method: exchange.request.method as HarnessHttpMethod,
      origin: exchange.request.origin,
      path: route.path,
      pathParameters,
      query,
      headers,
      ...(body === undefined ? {} : { body }),
      expectedStatuses: [status]
    }
  })

  const siteId = options.siteId ?? idOf(target.request.origin.replace(/^https?:\/\//u, ""), "website")
  const artifact = createSiteHarnessCandidate({
    siteId,
    version: options.version ?? `capture-${capture.importDigest.slice(7, 19)}`,
    sourceCaptureDigest: capture.importDigest as `sha256:${string}`,
    allowedOrigins: unique(exchanges.map((exchange) => exchange.request.origin)),
    actions: [{
      id: idOf(action.name, idOf(action.id, "action")),
      inputs: [...inputs.values()],
      steps
    }]
  })
  const issueKey = (item: HarnessDraftIssue): string => `${item.stepId}\u0000${item.location}\u0000${item.code}`
  return {
    captureId: capture.captureId,
    importDigest: capture.importDigest,
    artifact,
    actionCandidate: action,
    usedDependencies: [...new Map(usedDependencies.map((dependency) => [
      `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`,
      dependency
    ])).values()],
    unresolved: [...new Map(unresolved.map((item) => [issueKey(item), item])).values()]
  }
}

/** Build the deterministic mutating-action baseline from already validated durable facts. */
export const buildSiteHarnessDraftFromValidatedCapture = (
  capture: ValidatedHarCaptureFacts,
  options: BuildSiteHarnessDraftOptions = {}
): LogSiteHarnessDraft => buildSiteHarnessDraftFromCapture(capture, options)

export interface BuildObservedReadHarnessDraftOptions {
  readonly requestId: string
  readonly interfaceId: string
  readonly siteId?: string
  readonly version?: string
  /** Trusted value-free evidence. Concrete values remain outside the builder and artifact. */
  readonly valueProfile?: HarValueProfile
}

/**
 * Compiles one model-selected read interface only after binding it back to an
 * exact manifest-validated GET/HEAD exchange. The model never supplies a route,
 * origin, field, producer, status, or dependency.
 */
export const buildObservedReadHarnessDraft = (
  capture: ValidatedHarCaptureFacts,
  options: BuildObservedReadHarnessDraftOptions
): LogSiteHarnessDraft => {
  if (!SAFE_ID.test(options.interfaceId) || options.interfaceId.length > 64) {
    throw new HarnessDraftBuildError("draft_invalid", "The proposed read interface ID is invalid.")
  }
  const exchange = capture.exchanges.find((item) => item.requestId === options.requestId)
  if (exchange === undefined) {
    throw new HarnessDraftBuildError("action_not_found", "The proposed read interface references an unknown request.")
  }
  if (exchange.request.method !== "GET" && exchange.request.method !== "HEAD") {
    throw new HarnessDraftBuildError("draft_invalid", "A model-selected read interface must bind to GET or HEAD evidence.")
  }
  if (!exchange.response.mimeType.includes("json")) {
    throw new HarnessDraftBuildError("draft_invalid", "A model-selected read interface must bind to a JSON response.")
  }
  const incoming = unique(capture.dependencies.filter((dependency) =>
    dependency.to === exchange.requestId && STRUCTURAL_DEPENDENCY_REASONS.has(dependency.reason)
  ).map((dependency) => dependency.from))
  const action: ActionCandidate = {
    id: `read-${exchange.requestId}`.slice(0, 128),
    name: options.interfaceId,
    requestId: exchange.requestId,
    method: exchange.request.method,
    origin: exchange.request.origin,
    pathTemplate: exchange.request.path,
    dependsOn: incoming,
    inputFields: [...exchange.request.queryFields],
    observedStatus: exchange.response.status,
    observedOutcome: "response-observed",
    confidence: 0.5
  }
  return buildSiteHarnessDraftFromCapture(capture, {
    actionId: action.id,
    ...(options.siteId === undefined ? {} : { siteId: options.siteId }),
    ...(options.version === undefined ? {} : { version: options.version })
  }, action, options.valueProfile)
}

/** Build a candidate solely from committed, manifest-validated sanitized facts. */
export const buildSiteHarnessDraftFromLog = (
  log: ReadonlyArray<Event>,
  captureId: string,
  options: BuildSiteHarnessDraftOptions = {}
): LogSiteHarnessDraft => {
  const projected = validatedHarCaptureFactsOf(log, captureId)
  if (projected.status !== "completed") {
    const message = projected.status === "capture_not_found"
      ? "No capture declaration exists."
      : projected.status === "capture_incomplete"
      ? "The capture import has not completed."
      : "The capture manifest or sanitized fact stream is invalid."
    throw new HarnessDraftBuildError(projected.status, message)
  }
  try {
    return buildSiteHarnessDraftFromCapture(projected.capture, options)
  } catch (cause) {
    if (cause instanceof HarnessDraftBuildError) throw cause
    throw new HarnessDraftBuildError("draft_invalid", "The sanitized capture could not produce a valid bounded artifact.")
  }
}
