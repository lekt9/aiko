import { Schema } from "effect"
import type { Event } from "tardie/core/log/event"
import type { KeyFragment } from "tardie/core/log"
import {
  canonicalStringify,
  compareText,
  DEFAULT_HAR_POLICY,
  dependencyChains,
  describeWebsite,
  discoverActionCandidates,
  inferDependencyAnalysis,
  MAX_INFERENCE_MATCH_KEYS,
  MAX_INFERRED_DEPENDENCIES,
  sha256,
  type ActionCandidate,
  type BodyCapture,
  type NormalizedHarTrace,
  type RequestDependency,
  type WebsiteEvidence,
  type WebsiteInspection
} from "./har"

export const HAR_EVENT_SCHEMA_VERSION = 2 as const
export const HAR_NORMALIZER_VERSION = 2 as const
export const HAR_INFERENCE_VERSION = 3 as const
export const HAR_PRIVACY_VERSION = 3 as const

const KEY_PREFIX = "har2:"
const INSPECTION_KEY_PREFIX = "harinspect3:"
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u

export interface HarEventPolicy {
  readonly includePathSegments: boolean
  readonly includePageMetadata: boolean
}

export const DEFAULT_HAR_EVENT_POLICY: HarEventPolicy = {
  includePathSegments: false,
  includePageMetadata: false
}

export interface BodySummary {
  readonly mimeType: string
  readonly size: number
  readonly truncated: boolean
  readonly redactions: number
}

export interface RequestFact {
  readonly method: string
  readonly url: string
  readonly origin: string
  readonly path: string
  readonly queryFields: ReadonlyArray<string>
  readonly headerFields: ReadonlyArray<string>
  readonly cookieNames: ReadonlyArray<string>
  readonly body?: BodySummary
}

export interface ResponseFact {
  readonly status: number
  readonly mimeType: string
  readonly headerFields: ReadonlyArray<string>
  readonly cookieNames: ReadonlyArray<string>
  readonly redirectUrl?: string
  readonly body?: BodySummary
}

/** One request/response pair from a completed, digest-checked capture manifest. */
export interface ValidatedHarExchange {
  readonly requestId: string
  readonly index: number
  readonly resourceType?: string
  readonly request: RequestFact
  readonly response: ResponseFact
}

/**
 * The bounded structural facts that pure components may consume after an import
 * commits. This deliberately excludes request/response values and raw HAR data.
 */
export interface ValidatedHarCaptureFacts {
  readonly captureId: string
  readonly importDigest: string
  readonly exchanges: ReadonlyArray<ValidatedHarExchange>
  readonly dependencies: ReadonlyArray<RequestDependency>
  readonly actions: ReadonlyArray<ActionCandidate>
}

export type HarCaptureFactsProjection =
  | { readonly status: "capture_not_found" }
  | { readonly status: "capture_incomplete" }
  | { readonly status: "capture_invalid" }
  | { readonly status: "completed"; readonly capture: ValidatedHarCaptureFacts }

export type CapturedWebsiteInspection = Omit<WebsiteInspection, "traceDigest" | "source"> & {
  readonly captureId: string
  readonly importDigest: string
}

type DomainEvent = Event & {
  readonly schemaVersion?: number
  readonly captureId?: string
  readonly importDigest?: string
  readonly id?: string
  readonly requestId?: string
  readonly index?: number
  readonly request?: RequestFact
  readonly response?: ResponseFact
  readonly dependency?: RequestDependency
  readonly action?: ActionCandidate
  readonly evidence?: WebsiteEvidence
  readonly output?: CapturedWebsiteInspection
  readonly requestCount?: number
  readonly responseCount?: number
  readonly dependencyCount?: number
  readonly actionCandidateCount?: number
  readonly evidenceCount?: number
  readonly factCount?: number
  readonly warnings?: ReadonlyArray<string>
  readonly code?: string
  readonly error?: string
}

const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => value.length <= max,
  { title: `at most ${max} characters` }
)))
const matchingString = (pattern: RegExp, title: string) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => pattern.test(value),
  { title }
)))
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value >= 0,
  { title: "non-negative" }
)))
const Confidence = Schema.Number.pipe(Schema.check(Schema.makeFilter(
  (value: number) => Number.isFinite(value) && value >= 0 && value <= 1,
  { title: "between zero and one" }
)))

export const CaptureIdSchema = matchingString(CAPTURE_ID, "valid capture ID")
const DigestSchema = matchingString(DIGEST, "sha256 digest")
const SafeNameSchema = matchingString(SAFE_NAME, "safe field name")
const SafeNamesSchema = Schema.Array(SafeNameSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<string>) => values.length <= 256,
  { title: "at most 256 field names" }
)))
const RequestIdsSchema = Schema.Array(boundedString(128)).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<string>) => values.length <= 256,
  { title: "at most 256 request IDs" }
)))

const BodySummarySchema = Schema.Struct({
  mimeType: boundedString(127),
  size: NonNegativeInt,
  truncated: Schema.Boolean,
  redactions: NonNegativeInt
})
const RequestFactSchema = Schema.Struct({
  method: matchingString(/^[A-Z][A-Z0-9-]{0,31}$/u, "HTTP method"),
  url: boundedString(2_048),
  origin: boundedString(512),
  path: boundedString(1_024),
  queryFields: SafeNamesSchema,
  headerFields: SafeNamesSchema,
  cookieNames: SafeNamesSchema,
  body: Schema.optionalKey(BodySummarySchema)
})
const ResponseFactSchema = Schema.Struct({
  status: NonNegativeInt,
  mimeType: boundedString(127),
  headerFields: SafeNamesSchema,
  cookieNames: SafeNamesSchema,
  redirectUrl: Schema.optionalKey(boundedString(2_048)),
  body: Schema.optionalKey(BodySummarySchema)
})
const RequestDependencySchema = Schema.Struct({
  from: boundedString(128),
  to: boundedString(128),
  reason: Schema.Literals(["redirect", "initiator", "referer", "cookie", "value-flow"]),
  confidence: Confidence,
  evidence: boundedString(256)
})
const ActionCandidateSchema = Schema.Struct({
  id: boundedString(128),
  name: boundedString(128),
  requestId: boundedString(128),
  method: matchingString(/^[A-Z][A-Z0-9-]{0,31}$/u, "HTTP method"),
  origin: boundedString(512),
  pathTemplate: boundedString(1_024),
  dependsOn: RequestIdsSchema,
  inputFields: SafeNamesSchema,
  observedStatus: NonNegativeInt,
  observedOutcome: boundedString(64),
  confidence: Confidence
})
const WebsiteEvidenceSchema = Schema.Struct({
  kind: Schema.Literals(["page-title", "html-title", "meta-description", "primary-origin"]),
  value: boundedString(512),
  requestId: Schema.optionalKey(boundedString(128))
})
const DependencyChainSchema = Schema.Struct({
  requestIds: Schema.Array(boundedString(128)),
  confidence: Confidence
})

export const CapturedWebsiteInspectionSchema = Schema.Struct({
  captureId: CaptureIdSchema,
  importDigest: DigestSchema,
  site: Schema.Struct({
    origin: boundedString(512),
    host: boundedString(512),
    title: Schema.optionalKey(boundedString(512)),
    description: Schema.optionalKey(boundedString(512)),
    about: boundedString(1_024)
  }),
  counts: Schema.Struct({
    requests: NonNegativeInt,
    responses: NonNegativeInt,
    dependencies: NonNegativeInt,
    actionCandidates: NonNegativeInt
  }),
  hosts: Schema.Array(boundedString(512)),
  contentTypes: Schema.Array(boundedString(127)),
  evidence: Schema.Array(WebsiteEvidenceSchema),
  chains: Schema.Array(DependencyChainSchema),
  actions: Schema.Array(ActionCandidateSchema),
  warnings: Schema.Array(boundedString(512))
})

const PolicySchema = Schema.Struct({
  includePathSegments: Schema.Boolean,
  includePageMetadata: Schema.Boolean
})
const WarningsSchema = Schema.Array(boundedString(512)).pipe(Schema.check(Schema.makeFilter(
  (warnings: ReadonlyArray<string>) => warnings.length <= 256,
  { title: "at most 256 warnings" }
)))
const InvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: NonNegativeInt
})
const InvocationContextSchema = Schema.Struct({
  invocation: InvocationSchema,
  parent: Schema.optionalKey(InvocationSchema),
  deadlineAt: Schema.optionalKey(NonNegativeInt)
})
const RootTransportFields = {
  at: Schema.optionalKey(NonNegativeInt),
  traceparent: Schema.optionalKey(matchingString(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u,
    "W3C traceparent"
  ))
}
const MethodTransportFields = {
  ...RootTransportFields,
  call: Schema.optionalKey(InvocationContextSchema),
  link: Schema.optionalKey(Schema.Unknown)
}
const IdentityFields = {
  schemaVersion: Schema.Literal(HAR_EVENT_SCHEMA_VERSION),
  captureId: CaptureIdSchema,
  importDigest: DigestSchema
}
const HarCaptureDeclaredSchema = Schema.Struct({
  type: Schema.Literal("HarCaptureDeclared"),
  ...IdentityFields,
  normalizerVersion: Schema.Literal(HAR_NORMALIZER_VERSION),
  inferenceVersion: Schema.Literal(HAR_INFERENCE_VERSION),
  privacyVersion: Schema.Literal(HAR_PRIVACY_VERSION),
  policy: PolicySchema,
  requestCount: NonNegativeInt,
  factCount: NonNegativeInt,
  ...RootTransportFields
})
const HarRequestObservedSchema = Schema.Struct({
  type: Schema.Literal("HarRequestObserved"),
  ...IdentityFields,
  requestId: boundedString(128),
  index: NonNegativeInt,
  startedAt: boundedString(64),
  durationMs: NonNegativeInt,
  resourceType: Schema.optionalKey(SafeNameSchema),
  request: RequestFactSchema,
  ...RootTransportFields
})
const HarResponseObservedSchema = Schema.Struct({
  type: Schema.Literal("HarResponseObserved"),
  ...IdentityFields,
  requestId: boundedString(128),
  index: NonNegativeInt,
  response: ResponseFactSchema,
  ...RootTransportFields
})
const HarDependencyInferredSchema = Schema.Struct({
  type: Schema.Literal("HarDependencyInferred"),
  ...IdentityFields,
  id: boundedString(128),
  dependency: RequestDependencySchema,
  ...RootTransportFields
})
const HarActionCandidateProposedSchema = Schema.Struct({
  type: Schema.Literal("HarActionCandidateProposed"),
  ...IdentityFields,
  id: boundedString(128),
  action: ActionCandidateSchema,
  ...RootTransportFields
})
const HarWebsiteEvidenceObservedSchema = Schema.Struct({
  type: Schema.Literal("HarWebsiteEvidenceObserved"),
  ...IdentityFields,
  id: boundedString(128),
  evidence: WebsiteEvidenceSchema,
  ...RootTransportFields
})
const HarCaptureCompletedSchema = Schema.Struct({
  type: Schema.Literal("HarCaptureCompleted"),
  ...IdentityFields,
  requestCount: NonNegativeInt,
  responseCount: NonNegativeInt,
  dependencyCount: NonNegativeInt,
  actionCandidateCount: NonNegativeInt,
  evidenceCount: NonNegativeInt,
  factCount: NonNegativeInt,
  warnings: WarningsSchema,
  ...RootTransportFields
})
const WebsiteInspectionRequestedSchema = Schema.Struct({
  type: Schema.Literal("WebsiteInspectionRequested"),
  schemaVersion: Schema.Literal(HAR_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  captureId: CaptureIdSchema,
  ...MethodTransportFields
})
const WebsiteInspectionCompletedSchema = Schema.Struct({
  type: Schema.Literal("WebsiteInspectionCompleted"),
  schemaVersion: Schema.Literal(HAR_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  captureId: CaptureIdSchema,
  output: CapturedWebsiteInspectionSchema,
  ...MethodTransportFields
})
const WebsiteInspectionFailedSchema = Schema.Struct({
  type: Schema.Literal("WebsiteInspectionFailed"),
  schemaVersion: Schema.Literal(HAR_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  captureId: CaptureIdSchema,
  code: Schema.Literals(["capture_not_found", "capture_incomplete", "capture_invalid"]),
  error: boundedString(512),
  ...MethodTransportFields
})

const factSchemas = [
  HarRequestObservedSchema,
  HarResponseObservedSchema,
  HarDependencyInferredSchema,
  HarActionCandidateProposedSchema,
  HarWebsiteEvidenceObservedSchema
] as const

const is = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): value is S["Type"] => {
  try {
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
    return true
  } catch {
    return false
  }
}
const policyOf = (options: Partial<HarEventPolicy>): HarEventPolicy => ({
  ...DEFAULT_HAR_EVENT_POLICY,
  ...options
})
const uniqueSorted = (values: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(values)].filter((value) => value.length > 0).sort(compareText)
const safeName = (value: string): string => SAFE_NAME.test(value) ? value : "field"
const safeNames = (values: Iterable<string>): ReadonlyArray<string> =>
  uniqueSorted([...values].map(safeName)).slice(0, 256)
const safeHeaderNames = (values: Iterable<string>): ReadonlyArray<string> =>
  safeNames([...values].filter((value) => !value.startsWith(":")))
const bodySummary = (body: BodyCapture | undefined): BodySummary | undefined => body === undefined
  ? undefined
  : {
      mimeType: body.mimeType.slice(0, 127),
      size: body.size,
      truncated: body.truncated,
      redactions: body.redactions
    }

const metadataText = (value: string): string => value
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED]")
  .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/gu, "[REDACTED]")
  .replace(/\b[A-Za-z0-9_=-]{32,}\b/gu, "[REDACTED]")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 512)

const durableWarnings = (warnings: ReadonlyArray<string>): ReadonlyArray<string> => {
  const safe = warnings.map(metadataText).filter(Boolean)
  return safe.length <= 256 ? safe : [...safe.slice(0, 255), "Additional warnings omitted."]
}

const pathOf = (raw: string, includeSegments: boolean): string => {
  const parts = raw.split("/").filter(Boolean)
  if (parts.length === 0) return "/"
  const structural = `/${parts.map((part) => {
    if (!includeSegments) return ":segment"
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return ":value"
    }
    if (/^[a-z][a-z-]{0,31}$/u.test(decoded) || /^v\d{1,3}$/u.test(decoded)) return decoded
    return ":value"
  }).join("/")}`
  return structural.slice(0, 1_024)
}

const structuralUrl = (
  origin: string,
  path: string,
  fields: ReadonlyArray<{ readonly name: string; readonly redacted: boolean }>,
  includeSegments: boolean
): string => {
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    url.username = ""
    url.password = ""
    url.pathname = pathOf(path, includeSegments)
    url.search = ""
    for (const field of fields) url.searchParams.append(safeName(field.name), field.redacted ? "[REDACTED]" : "[VALUE]")
    const rendered = url.toString()
    if (rendered.length <= 2_048) return rendered
    url.search = ""
    return url.toString().slice(0, 2_048)
  } catch {
    return ""
  }
}

const safeDependency = (dependency: RequestDependency): RequestDependency => ({
  ...dependency,
  evidence: dependency.reason === "cookie"
    ? "same-origin cookie-name match"
    : metadataText(dependency.evidence).slice(0, 256)
})

const safeAction = (
  action: ActionCandidate,
  includePathSegments: boolean
): ActionCandidate => {
  const pathTemplate = pathOf(action.pathTemplate, includePathSegments)
  const tail = pathTemplate.split("/").filter(Boolean).at(-1)?.replace(/^:/u, "") ?? "request"
  return {
    ...action,
    id: `action-${action.requestId}`,
    name: `${action.method.toLowerCase()}_${safeName(tail)}_${action.requestId.replace(/[^A-Za-z0-9_]/gu, "_")}`.slice(0, 128),
    pathTemplate,
    dependsOn: action.dependsOn.slice(0, 256),
    inputFields: safeNames(action.inputFields),
    observedOutcome: action.observedOutcome.slice(0, 64)
  }
}

type FactDraft = Event & Record<string, unknown>

const factDraftsFromHar = (
  trace: NormalizedHarTrace,
  policy: HarEventPolicy
): {
  readonly facts: ReadonlyArray<FactDraft>
  readonly requestCount: number
  readonly responseCount: number
  readonly dependencyCount: number
  readonly actionCandidateCount: number
  readonly evidenceCount: number
  readonly inferenceTruncated: boolean
} => {
  const inference = inferDependencyAnalysis(trace.entries)
  const dependencies = inference.dependencies.map(safeDependency)
  const actions = discoverActionCandidates(trace.entries, dependencies)
    .map((action) => safeAction(action, policy.includePathSegments))
  const inspection = describeWebsite(trace, trace.entries, dependencies, actions)
  const evidence = inspection.evidence.flatMap((item): ReadonlyArray<WebsiteEvidence> => {
    if (item.kind === "primary-origin") return [{ ...item, value: item.value.slice(0, 512) }]
    if (!policy.includePageMetadata) return []
    const value = metadataText(item.value)
    return value.length === 0 ? [] : [{ ...item, value }]
  })
  const facts: FactDraft[] = []
  for (const entry of trace.entries) {
    const resourceType = safeName(entry.resourceType ?? "")
    facts.push({
      type: "HarRequestObserved",
      requestId: entry.id,
      index: entry.index,
      startedAt: entry.startedAt.slice(0, 64),
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      ...(resourceType === "field" || resourceType.length === 0 ? {} : { resourceType }),
      request: {
        method: entry.request.method,
        url: structuralUrl(entry.request.origin, entry.request.path, entry.request.query, policy.includePathSegments),
        origin: entry.request.origin.slice(0, 512),
        path: pathOf(entry.request.path, policy.includePathSegments),
        queryFields: safeNames(entry.request.query.map((field) => field.name)),
        headerFields: safeHeaderNames(entry.request.headers.map((header) => header.name)),
        cookieNames: safeNames(entry.request.cookies),
        ...(entry.request.body === undefined ? {} : { body: bodySummary(entry.request.body) })
      }
    })
    facts.push({
      type: "HarResponseObserved",
      requestId: entry.id,
      index: entry.index,
      response: {
        status: entry.response.status,
        mimeType: entry.response.mimeType.slice(0, 127),
        headerFields: safeHeaderNames(entry.response.headers.map((header) => header.name)),
        cookieNames: safeNames(entry.response.cookies),
        ...(entry.response.redirectUrl === undefined
          ? {}
          : {
              redirectUrl: structuralUrl(
                (() => {
                  try { return new URL(entry.response.redirectUrl).origin } catch { return "" }
                })(),
                (() => {
                  try { return new URL(entry.response.redirectUrl).pathname } catch { return "/" }
                })(),
                [],
                policy.includePathSegments
              )
            }),
        ...(entry.response.body === undefined ? {} : { body: bodySummary(entry.response.body) })
      }
    })
  }
  dependencies.forEach((dependency) => facts.push({
    type: "HarDependencyInferred",
    id: `dep-${sha256(`${HAR_INFERENCE_VERSION}\u0000${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`).slice(0, 16)}`,
    dependency
  }))
  actions.forEach((action) => facts.push({ type: "HarActionCandidateProposed", id: action.id, action }))
  evidence.forEach((item) => facts.push({
    type: "HarWebsiteEvidenceObserved",
    id: `web-${sha256(`${HAR_PRIVACY_VERSION}\u0000${item.kind}\u0000${item.requestId ?? ""}\u0000${item.value}`).slice(0, 16)}`,
    evidence: item
  }))
  return {
    facts,
    requestCount: trace.entries.length,
    responseCount: trace.entries.length,
    dependencyCount: dependencies.length,
    actionCandidateCount: actions.length,
    evidenceCount: evidence.length,
    inferenceTruncated: inference.truncated
  }
}

const warningsForImport = (
  trace: NormalizedHarTrace,
  planned: { readonly inferenceTruncated: boolean }
): ReadonlyArray<string> => durableWarnings([
  ...trace.warnings,
  ...(planned.inferenceTruncated
    ? [`Dependency inference reached its ${MAX_INFERENCE_MATCH_KEYS}-match-key or ${MAX_INFERRED_DEPENDENCIES}-edge limit and was truncated.`]
    : [])
])

const importDigestFor = (
  policy: HarEventPolicy,
  facts: ReadonlyArray<FactDraft>,
  warnings: ReadonlyArray<string>
): string =>
  `sha256:${sha256(canonicalStringify({
    schemaVersion: HAR_EVENT_SCHEMA_VERSION,
    normalizerVersion: HAR_NORMALIZER_VERSION,
    inferenceVersion: HAR_INFERENCE_VERSION,
    privacyVersion: HAR_PRIVACY_VERSION,
    policy,
    facts,
    warnings
  }))}`

export interface HarImportPlan {
  readonly importDigest: string
  readonly events: (captureId: string) => ReadonlyArray<Event>
}

export const planHarImport = (
  trace: NormalizedHarTrace,
  options: Partial<HarEventPolicy> = {}
): HarImportPlan => {
  if (trace.errors.length > 0) throw new Error(`HAR is invalid: ${trace.errors.join(" ")}`)
  const policy = policyOf(options)
  const planned = factDraftsFromHar(trace, policy)
  const warnings = warningsForImport(trace, planned)
  const importDigest = importDigestFor(policy, planned.facts, warnings)
  return {
    importDigest,
    events: (captureId): ReadonlyArray<Event> => {
      if (!CAPTURE_ID.test(captureId)) {
        throw new Error("captureId must contain 1-128 letters, digits, dots, underscores, or hyphens")
      }
      const identity = { schemaVersion: HAR_EVENT_SCHEMA_VERSION, captureId, importDigest }
      const events: ReadonlyArray<Event> = [{
        type: "HarCaptureDeclared",
        ...identity,
        normalizerVersion: HAR_NORMALIZER_VERSION,
        inferenceVersion: HAR_INFERENCE_VERSION,
        privacyVersion: HAR_PRIVACY_VERSION,
        policy,
        requestCount: planned.requestCount,
        factCount: planned.facts.length
      }, ...planned.facts.map((fact) => ({ ...fact, ...identity })), {
        type: "HarCaptureCompleted",
        ...identity,
        requestCount: planned.requestCount,
        responseCount: planned.responseCount,
        dependencyCount: planned.dependencyCount,
        actionCandidateCount: planned.actionCandidateCount,
        evidenceCount: planned.evidenceCount,
        factCount: planned.facts.length,
        warnings
      }]
      for (const event of events) {
        if (harKeys.keyOf(event) === undefined) {
          throw new Error(`generated ${JSON.stringify(event.type)} event does not satisfy the durable event schema`)
        }
      }
      return events
    }
  }
}

export const harImportDigestOf = (
  trace: NormalizedHarTrace,
  options: Partial<HarEventPolicy> = {}
): string => planHarImport(trace, options).importDigest

export const eventsFromHar = (
  trace: NormalizedHarTrace,
  captureId: string,
  options: Partial<HarEventPolicy> = {}
): ReadonlyArray<Event> => planHarImport(trace, options).events(captureId)

const schemaForFact = (type: string): Schema.ConstraintDecoder<unknown> | undefined => {
  switch (type) {
    case "HarRequestObserved": return HarRequestObservedSchema
    case "HarResponseObserved": return HarResponseObservedSchema
    case "HarDependencyInferred": return HarDependencyInferredSchema
    case "HarActionCandidateProposed": return HarActionCandidateProposedSchema
    case "HarWebsiteEvidenceObserved": return HarWebsiteEvidenceObservedSchema
    default: return undefined
  }
}

const factDraftOf = (event: Event): FactDraft | undefined => {
  const schema = schemaForFact(event.type)
  if (schema === undefined || !is(schema, event)) return undefined
  const decoded = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(event) as Record<string, unknown>
  const {
    schemaVersion: _schema,
    captureId: _capture,
    importDigest: _digest,
    at: _at,
    traceparent: _traceparent,
    call: _call,
    link: _link,
    ...fact
  } = decoded
  return fact as FactDraft
}

/** Additive live observation envelope. The inner fact uses the very same
 * bodyless schema as an imported capture; no raw CDP data enters the log. */
export const networkFactObservedEventOf = (threadId: string, sequence: number, source: Event): Event => {
  const fact = factDraftOf(source)
  if (!CAPTURE_ID.test(threadId) || !Number.isSafeInteger(sequence) || sequence < 0 ||
      !fact || !["HarRequestObserved", "HarResponseObserved"].includes(fact.type)) throw new Error("Invalid network fact")
  return { type: "NetworkFactObserved", schemaVersion: 1, threadId, sequence, fact }
}

export const networkFactOf = (event: Event): FactDraft | undefined => {
  if (event.type !== "NetworkFactObserved" || event.schemaVersion !== 1 || typeof event.threadId !== "string" ||
      !CAPTURE_ID.test(event.threadId) || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0 ||
      !validNetworkTransport(event) ||
      Object.keys(event).some((key) => !["type", "schemaVersion", "threadId", "sequence", "fact", "at", "traceparent"].includes(key))) return undefined
  try {
    const fact = event.fact as Event
    if (!fact || !["HarRequestObserved", "HarResponseObserved"].includes(fact.type)) return undefined
    const decoded = factDraftOf({ ...fact, schemaVersion: HAR_EVENT_SCHEMA_VERSION, captureId: "network-validation", importDigest: `sha256:${"0".repeat(64)}` })
    return decoded && canonicalStringify(decoded) === canonicalStringify(fact) ? decoded : undefined
  } catch { return undefined }
}

const validNetworkTransport = (event: Event): boolean =>
  (event.at === undefined || (Number.isSafeInteger(event.at) && Number(event.at) >= 0)) &&
  (event.traceparent === undefined || (typeof event.traceparent === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(event.traceparent)))

/** Confirm graph materialization against the listener's acknowledged event
 * prefix. Dependency inference is separate; it never upgrades observations. */
export const networkGraphCheckpointOf = (event: Event): Event | undefined => {
  if (event.type !== "NetworkGraphCheckpointPrepared" || event.schemaVersion !== 1 ||
      !CAPTURE_ID.test(String(event.threadId)) || !CAPTURE_ID.test(String(event.captureId)) ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(event.importDigest)) ||
      !Number.isSafeInteger(event.sourceNetworkSequence) || Number(event.sourceNetworkSequence) < 0 ||
      !Array.isArray(event.sourceRequestIds) || event.sourceRequestIds.length > 5_000 ||
      event.sourceRequestIds.some((id) => typeof id !== "string" || !/^req-[0-9]{4,6}$/u.test(id)) ||
      new Set(event.sourceRequestIds).size !== event.sourceRequestIds.length ||
      !validNetworkTransport(event) ||
      Object.keys(event).some((key) => !["type", "schemaVersion", "threadId", "captureId", "importDigest", "sourceNetworkSequence", "sourceRequestIds", "at", "traceparent"].includes(key))) return undefined
  return event
}

export const assertNetworkSnapshotBackedByLog = (log: ReadonlyArray<Event>, threadId: string, snapshot: ReadonlyArray<Event>, sourceRequestIds?: ReadonlyArray<string>, watermark?: number): void => {
  if (sourceRequestIds && (sourceRequestIds.length !== snapshot.filter((event) => event.type === "HarRequestObserved").length ||
      new Set(sourceRequestIds).size !== sourceRequestIds.length || sourceRequestIds.some((id) => !/^req-[0-9]{4,6}$/u.test(id)))) {
    throw new Error("Invalid network graph identity mapping")
  }
  const facts = new Map<string, FactDraft>()
  let expected = 0
  for (const event of log.filter((event) => event.type === "NetworkFactObserved")) {
    const fact = networkFactOf(event)
    if (!fact || event.threadId !== threadId || event.sequence !== expected++) throw new Error("Invalid network event prefix")
    facts.set(`${fact.type}:${fact.requestId}`, fact)
  }
  for (const event of snapshot) {
    const fact = factDraftOf(event)
    if (!fact || !["HarRequestObserved", "HarResponseObserved"].includes(fact.type)) continue
    const sourceId = sourceRequestIds ? sourceRequestIds[Number(fact.index)] : String(fact.requestId)
    if (sourceId === undefined) throw new Error("Network graph identity was not mapped")
    const observed = facts.get(`${fact.type}:${sourceId}`)
    const mapped = sourceRequestIds ? { ...fact, requestId: sourceId, index: Number(sourceId.slice(4)) - 1 } : fact
    if (!observed || canonicalStringify(mapped) !== canonicalStringify(observed)) throw new Error("Network graph was not backed by the acknowledged log")
  }
  if (watermark !== undefined && expected !== watermark) throw new Error("Network snapshot watermark was not acknowledged")
}

const matchingFacts = (
  log: ReadonlyArray<Event>,
  captureId: string,
  importDigest: string
): ReadonlyArray<DomainEvent> => log.filter((event) => {
  const schema = schemaForFact(event.type)
  return schema !== undefined && is(schema, event) &&
    (event as DomainEvent).captureId === captureId && (event as DomainEvent).importDigest === importDigest
}) as ReadonlyArray<DomainEvent>

const validManifest = (
  log: ReadonlyArray<Event>,
  declared: DomainEvent,
  completed: DomainEvent
): ReadonlyArray<DomainEvent> | undefined => {
  const captureId = String(declared.captureId)
  const importDigest = String(declared.importDigest)
  const facts = matchingFacts(log, captureId, importDigest)
  if (facts.length !== declared.factCount || facts.length !== completed.factCount) return undefined
  const policy = (declared as { readonly policy?: unknown }).policy
  if (!is(PolicySchema, policy)) return undefined
  const digest = importDigestFor(policy, facts.flatMap((event) => {
    const draft = factDraftOf(event)
    return draft === undefined ? [] : [draft]
  }), Array.isArray(completed.warnings) ? completed.warnings : [])
  if (digest !== importDigest || completed.importDigest !== importDigest) return undefined
  const keys = facts.map((event) => harKeys.keyOf(event))
  if (keys.some((key) => key === undefined) || new Set(keys).size !== facts.length) return undefined

  const requests = facts.filter((event) => event.type === "HarRequestObserved")
  const responses = facts.filter((event) => event.type === "HarResponseObserved")
  const dependencies = facts.filter((event) => event.type === "HarDependencyInferred")
  const actions = facts.filter((event) => event.type === "HarActionCandidateProposed")
  const evidence = facts.filter((event) => event.type === "HarWebsiteEvidenceObserved")
  if (requests.length !== declared.requestCount || requests.length !== completed.requestCount ||
    responses.length !== completed.responseCount || dependencies.length !== completed.dependencyCount ||
    actions.length !== completed.actionCandidateCount || evidence.length !== completed.evidenceCount) return undefined
  const requestIds = requests.map((event) => String(event.requestId))
  const indexes = requests.map((event) => Number(event.index)).sort((left, right) => left - right)
  if (new Set(requestIds).size !== requestIds.length ||
    indexes.some((index, position) => index !== position)) return undefined
  const responseIds = responses.map((event) => String(event.requestId))
  const requestIndexes = new Map(requests.map((event) => [String(event.requestId), Number(event.index)]))
  if (new Set(responseIds).size !== responseIds.length ||
    responseIds.some((id) => !requestIds.includes(id)) || responseIds.length !== requestIds.length ||
    responses.some((event) => requestIndexes.get(String(event.requestId)) !== Number(event.index))) return undefined
  if (dependencies.some((event) => event.dependency === undefined ||
    !requestIds.includes(event.dependency.from) || !requestIds.includes(event.dependency.to))) return undefined
  if (actions.some((event) => event.action === undefined || !requestIds.includes(event.action.requestId) ||
    event.action.dependsOn.some((id) => !requestIds.includes(id)))) return undefined
  return facts
}

const captureEnvelope = (
  log: ReadonlyArray<Event>,
  captureId: string
): { readonly declared?: DomainEvent; readonly completed?: DomainEvent; readonly facts?: ReadonlyArray<DomainEvent> } => {
  const declarations = log.filter((event) =>
    is(HarCaptureDeclaredSchema, event) && event.captureId === captureId) as ReadonlyArray<DomainEvent>
  if (declarations.length !== 1) return {}
  const declared = declarations[0]!
  const declarationIndex = log.indexOf(declared)
  const completionIndex = log.findIndex((event) =>
    is(HarCaptureCompletedSchema, event) && event.captureId === captureId && event.importDigest === declared.importDigest)
  if (completionIndex < 0) return { declared }
  const completed = log[completionIndex] as DomainEvent
  if (completionIndex <= declarationIndex) return { declared, completed }
  const facts = validManifest(log.slice(declarationIndex + 1, completionIndex), declared, completed)
  return facts === undefined ? { declared, completed } : { declared, completed, facts }
}

/**
 * Project only a complete, self-consistent sanitized capture from the durable
 * log. The projection is intentionally capped at the normalizer's hard input
 * bound so downstream pure derivations cannot be driven by an unbounded forged
 * manifest.
 */
export const validatedHarCaptureFactsOf = (
  log: ReadonlyArray<Event>,
  captureId: string
): HarCaptureFactsProjection => {
  const declarations = log.filter((event) =>
    is(HarCaptureDeclaredSchema, event) && event.captureId === captureId) as ReadonlyArray<DomainEvent>
  if (declarations.length === 0) return { status: "capture_not_found" }
  if (declarations.length !== 1) return { status: "capture_invalid" }

  const declared = declarations[0]!
  const completions = log.filter((event) =>
    is(HarCaptureCompletedSchema, event) && event.captureId === captureId &&
    event.importDigest === declared.importDigest) as ReadonlyArray<DomainEvent>
  if (completions.length === 0) return { status: "capture_incomplete" }
  if (completions.length !== 1) return { status: "capture_invalid" }

  const envelope = captureEnvelope(log, captureId)
  if (envelope.completed === undefined || envelope.facts === undefined) return { status: "capture_invalid" }
  const allFacts = matchingFacts(log, captureId, String(declared.importDigest))
  if (allFacts.length !== envelope.facts.length) return { status: "capture_invalid" }

  const requests = envelope.facts
    .filter((event): event is DomainEvent & {
      readonly requestId: string
      readonly index: number
      readonly request: RequestFact
    } => event.type === "HarRequestObserved" && typeof event.requestId === "string" &&
      typeof event.index === "number" && event.request !== undefined)
    .sort((left, right) => left.index - right.index)
  const responses = new Map(envelope.facts
    .filter((event): event is DomainEvent & {
      readonly requestId: string
      readonly index: number
      readonly response: ResponseFact
    } => event.type === "HarResponseObserved" && typeof event.requestId === "string" &&
      typeof event.index === "number" && event.response !== undefined)
    .map((event) => [event.requestId, event]))
  const dependencies = envelope.facts
    .filter((event) => event.type === "HarDependencyInferred")
    .flatMap((event) => event.dependency === undefined ? [] : [event.dependency])
  const actions = envelope.facts
    .filter((event) => event.type === "HarActionCandidateProposed")
    .flatMap((event) => event.action === undefined ? [] : [event.action])

  if (
    requests.length > DEFAULT_HAR_POLICY.maxEntries ||
    dependencies.length > MAX_INFERRED_DEPENDENCIES ||
    actions.length > DEFAULT_HAR_POLICY.maxEntries
  ) return { status: "capture_invalid" }

  const exchanges = requests.flatMap((request): ReadonlyArray<ValidatedHarExchange> => {
    const response = responses.get(request.requestId)
    return response === undefined || response.index !== request.index
      ? []
      : [{
          requestId: request.requestId,
          index: request.index,
          ...(typeof request.resourceType === "string" ? { resourceType: request.resourceType } : {}),
          request: request.request,
          response: response.response
        }]
  })
  if (exchanges.length !== requests.length) return { status: "capture_invalid" }

  const exchangeById = new Map(exchanges.map((exchange) => [exchange.requestId, exchange]))
  const dependencyKeys = dependencies.map((dependency) =>
    `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`)
  if (
    new Set(dependencyKeys).size !== dependencyKeys.length ||
    dependencies.some((dependency) => {
      const from = exchangeById.get(dependency.from)
      const to = exchangeById.get(dependency.to)
      return from === undefined || to === undefined || from.index >= to.index
    })
  ) return { status: "capture_invalid" }

  const actionIds = actions.map((action) => action.id)
  if (new Set(actionIds).size !== actionIds.length || actions.some((action) => {
    const exchange = exchangeById.get(action.requestId)
    return exchange === undefined || action.method !== exchange.request.method ||
      action.origin !== exchange.request.origin || action.observedStatus !== exchange.response.status
  })) return { status: "capture_invalid" }

  return {
    status: "completed",
    capture: {
      captureId,
      importDigest: String(declared.importDigest),
      exchanges,
      dependencies,
      actions
    }
  }
}

const hostOf = (origin: string): string => {
  try { return new URL(origin).host } catch { return origin }
}

export const websiteInspectionOf = (
  log: ReadonlyArray<Event>,
  captureId: string
): CapturedWebsiteInspection | undefined => {
  const envelope = captureEnvelope(log, captureId)
  if (envelope.declared === undefined || envelope.completed === undefined || envelope.facts === undefined) return undefined
  const requests = envelope.facts
    .filter((event): event is DomainEvent & { readonly requestId: string; readonly index: number; readonly request: RequestFact } =>
      event.type === "HarRequestObserved" && typeof event.requestId === "string" &&
      typeof event.index === "number" && event.request !== undefined)
    .sort((left, right) => left.index - right.index)
  const responses = envelope.facts
    .filter((event): event is DomainEvent & { readonly response: ResponseFact } =>
      event.type === "HarResponseObserved" && event.response !== undefined)
  const dependencies = envelope.facts
    .filter((event) => event.type === "HarDependencyInferred")
    .flatMap((event) => event.dependency === undefined ? [] : [event.dependency])
  const actions = envelope.facts
    .filter((event) => event.type === "HarActionCandidateProposed")
    .flatMap((event) => event.action === undefined ? [] : [event.action])
  const evidence = envelope.facts
    .filter((event) => event.type === "HarWebsiteEvidenceObserved")
    .flatMap((event) => event.evidence === undefined ? [] : [event.evidence])
  const origin = evidence.find((item) => item.kind === "primary-origin")?.value ?? requests[0]?.request.origin ?? ""
  const title = evidence.find((item) => item.kind === "page-title")?.value ??
    evidence.find((item) => item.kind === "html-title")?.value
  const description = evidence.find((item) => item.kind === "meta-description")?.value
  const host = hostOf(origin)
  const about = description ?? (title === undefined
    ? `Captured ${requests.length} network exchanges for ${host || "an unknown website"}.`
    : `${title}${host.length === 0 ? "" : ` at ${host}`}.`)
  const hostCounts = new Map<string, number>()
  requests.forEach((event) => {
    const candidate = hostOf(event.request.origin)
    if (candidate.length > 0) hostCounts.set(candidate, (hostCounts.get(candidate) ?? 0) + 1)
  })
  const hosts = [...hostCounts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([candidate]) => candidate)
  return {
    captureId,
    importDigest: String(envelope.declared.importDigest),
    site: {
      origin,
      host,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      about
    },
    counts: {
      requests: requests.length,
      responses: responses.filter((event) => event.response.status > 0).length,
      dependencies: dependencies.length,
      actionCandidates: actions.length
    },
    hosts,
    contentTypes: uniqueSorted(responses.map((event) => event.response.mimeType)),
    evidence,
    chains: dependencyChains(requests.map((event) => ({ id: event.requestId })), dependencies),
    actions,
    warnings: envelope.completed.warnings ?? []
  }
}

export interface CaptureView {
  readonly captureId: string
  readonly importDigest: string
  readonly status: "incomplete" | "completed" | "invalid"
  readonly requestCount: number
}
export interface HarView { readonly captures: ReadonlyArray<CaptureView> }

export const harViewOf = (log: ReadonlyArray<Event>): HarView => ({
  captures: log.filter((event) => is(HarCaptureDeclaredSchema, event)).flatMap((event) => {
    const declared = event as DomainEvent
    const captureId = String(declared.captureId)
    const envelope = captureEnvelope(log, captureId)
    return [{
      captureId,
      importDigest: String(declared.importDigest),
      status: envelope.completed === undefined
        ? "incomplete" as const
        : envelope.facts === undefined ? "invalid" as const : "completed" as const,
      requestCount: Number(declared.requestCount)
    }]
  }).sort((left, right) => compareText(left.captureId, right.captureId))
})

type InspectionFailure = {
  readonly code: "capture_not_found" | "capture_incomplete" | "capture_invalid"
  readonly error: string
}
type InspectionOutcome =
  | { readonly status: "completed"; readonly output: CapturedWebsiteInspection }
  | { readonly status: "failed"; readonly failure: InspectionFailure }

const inspectionOutcomeOf = (log: ReadonlyArray<Event>, captureId: string): InspectionOutcome => {
  const output = websiteInspectionOf(log, captureId)
  if (output !== undefined) return { status: "completed", output }
  const envelope = captureEnvelope(log, captureId)
  return {
    status: "failed",
    failure: envelope.declared === undefined
      ? { code: "capture_not_found", error: "No capture declaration exists." }
      : envelope.completed === undefined
      ? { code: "capture_incomplete", error: "The capture import has not completed." }
      : { code: "capture_invalid", error: "The capture manifest or fact stream is invalid." }
  }
}

const inspectionKeyBaseOf = (captureId: string, id: string): string =>
  `${INSPECTION_KEY_PREFIX}${captureId}:${sha256(id)}`
const inspectionCompletedKeyOf = (captureId: string, id: string, output: CapturedWebsiteInspection): string =>
  `${inspectionKeyBaseOf(captureId, id)}:completed:${sha256(canonicalStringify(output))}`
const inspectionFailedKeyOf = (captureId: string, id: string, failure: InspectionFailure): string =>
  `${inspectionKeyBaseOf(captureId, id)}:failed:${failure.code}:${sha256(failure.error)}`

const matchingInspectionCompletion = (
  log: ReadonlyArray<Event>,
  request: typeof WebsiteInspectionRequestedSchema.Type,
  output: CapturedWebsiteInspection
): typeof WebsiteInspectionCompletedSchema.Type | undefined => log.find((event) =>
  is(WebsiteInspectionCompletedSchema, event) && event.id === request.id &&
  event.captureId === request.captureId && event.output.captureId === request.captureId &&
  canonicalStringify(event.output) === canonicalStringify(output)) as
  typeof WebsiteInspectionCompletedSchema.Type | undefined

const matchingInspectionFailure = (
  log: ReadonlyArray<Event>,
  request: typeof WebsiteInspectionRequestedSchema.Type,
  failure: InspectionFailure
): typeof WebsiteInspectionFailedSchema.Type | undefined => log.find((event) =>
  is(WebsiteInspectionFailedSchema, event) && event.id === request.id &&
  event.captureId === request.captureId && event.code === failure.code && event.error === failure.error) as
  typeof WebsiteInspectionFailedSchema.Type | undefined

export const harKeys: KeyFragment = {
  prefixes: [KEY_PREFIX, INSPECTION_KEY_PREFIX, "net1:"],
  keyOf: (event) => {
    if (event.type === "NetworkFactObserved") {
      const fact = networkFactOf(event)
      return fact === undefined ? undefined : `net1:${event.threadId}:${event.sequence}:${sha256(canonicalStringify(fact))}`
    }
    if (networkGraphCheckpointOf(event)) return `net1:graph:${event.threadId}:${event.captureId}:${event.importDigest}:${event.sourceNetworkSequence}:${sha256(canonicalStringify(event.sourceRequestIds))}`
    if (is(HarCaptureDeclaredSchema, event)) return `${KEY_PREFIX}cap:${event.captureId}:declared`
    if (is(HarRequestObservedSchema, event)) return `${KEY_PREFIX}req:${event.captureId}:${event.importDigest}:${event.requestId}`
    if (is(HarResponseObservedSchema, event)) return `${KEY_PREFIX}res:${event.captureId}:${event.importDigest}:${event.requestId}`
    if (is(HarDependencyInferredSchema, event)) return `${KEY_PREFIX}dep:${event.captureId}:${event.importDigest}:${event.id}`
    if (is(HarActionCandidateProposedSchema, event)) return `${KEY_PREFIX}act:${event.captureId}:${event.importDigest}:${event.id}`
    if (is(HarWebsiteEvidenceObservedSchema, event)) return `${KEY_PREFIX}web:${event.captureId}:${event.importDigest}:${event.id}`
    if (is(HarCaptureCompletedSchema, event)) return `${KEY_PREFIX}cap:${event.captureId}:${event.importDigest}:completed`
    if (is(WebsiteInspectionRequestedSchema, event)) {
      return `${inspectionKeyBaseOf(event.captureId, event.id)}:request`
    }
    if (is(WebsiteInspectionCompletedSchema, event)) return inspectionCompletedKeyOf(event.captureId, event.id, event.output)
    if (is(WebsiteInspectionFailedSchema, event)) return inspectionFailedKeyOf(event.captureId, event.id, event)
    return undefined
  }
}


