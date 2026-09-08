import { Schema } from "effect"
import { actorMethod, type Component } from "tardie"
import type { Event } from "tardie/core/log/event"
import type { KeyFragment } from "tardie/core/log"
import { intent } from "tardie/core/reconciliation"

import {
  BROWSER_TRACE_SCHEMA_VERSION,
  BrowserNetworkDependencyInferredSchema,
  BrowserNetworkToolPreparedSchema,
  BrowserNetworkToolReuseDecidedSchema,
  BrowserPayloadShapeSchema,
  BrowserToolCallObservedSchema,
  BrowserToolResultObservedSchema,
  BrowserTraceThreadIdSchema,
  MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL,
  MAX_BROWSER_PREPARED_TOOL_CHARS,
  MAX_BROWSER_PREPARED_TOOLS,
  MAX_BROWSER_TRACE_CALLS,
  MAX_BROWSER_TRACE_EVENTS,
  browserTraceKeys,
  browserTraceProjectionOf,
  type BrowserTraceProjection
} from "./browser-trace"
import { canonicalStringify, sha256 } from "./har"

const INSPECTION_KEY_PREFIX = "browsertraceinspect1:"
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u

const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => value.length <= max,
  { title: `at most ${max} characters` }
)))
const matchingString = (pattern: RegExp, title: string) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => pattern.test(value),
  { title }
)))
const boundedInteger = (max: number, title: string) => Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= max,
  { title }
)))
const boundedArray = <S extends Schema.Top>(schema: S, max: number, title: string) =>
  Schema.Array(schema).pipe(Schema.check(Schema.makeFilter(
    (values: ReadonlyArray<S["Type"]>) => values.length <= max,
    { title }
  )))

const SequenceSchema = boundedInteger(Number.MAX_SAFE_INTEGER, "non-negative safe sequence")
const DigestSchema = matchingString(DIGEST, "sha256 digest")
const OpaqueIdSchema = BrowserTraceThreadIdSchema

const InvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: SequenceSchema
})
const InvocationContextSchema = Schema.Struct({
  invocation: InvocationSchema,
  parent: Schema.optionalKey(InvocationSchema),
  deadlineAt: Schema.optionalKey(SequenceSchema)
})
const RootTransportFields = {
  at: Schema.optionalKey(SequenceSchema),
  traceparent: Schema.optionalKey(matchingString(TRACEPARENT, "W3C traceparent"))
}
const MethodTransportFields = {
  ...RootTransportFields,
  call: Schema.optionalKey(InvocationContextSchema),
  link: Schema.optionalKey(Schema.Unknown)
}

export const BrowserTraceInspectionRequestedSchema = Schema.Struct({
  type: Schema.Literal("BrowserTraceInspectionRequested"),
  schemaVersion: Schema.Literal(BROWSER_TRACE_SCHEMA_VERSION),
  id: Schema.String,
  invocationEpoch: SequenceSchema,
  threadId: BrowserTraceThreadIdSchema,
  ...MethodTransportFields
})

const BrowserTraceEventSchema = Schema.Union([
  BrowserToolCallObservedSchema,
  BrowserToolResultObservedSchema,
  BrowserNetworkDependencyInferredSchema,
  BrowserNetworkToolPreparedSchema,
  BrowserNetworkToolReuseDecidedSchema
])

const BrowserNetworkToolSummarySchema = Schema.Struct({
  siteId: OpaqueIdSchema,
  methods: boundedArray(Schema.Literals(["GET", "HEAD"]), 2, "at most two read methods"),
  stepCount: boundedInteger(1_024, "bounded tool step count"),
  inputCount: boundedInteger(1_024, "bounded tool input count"),
  callerInputCount: boundedInteger(1_024, "bounded caller input count"),
  vaultInputCount: boundedInteger(1_024, "bounded vault input count"),
  dependencyCount: boundedInteger(1_024, "bounded tool dependency count"),
  sessionRequirementCount: boundedInteger(1_024, "bounded session requirement count")
})

const BrowserNetworkToolBindingSchema = Schema.Struct({
  toolId: OpaqueIdSchema,
  toolDigest: DigestSchema,
  sourceTraceDigest: DigestSchema,
  sourceArtifactDigest: DigestSchema
})

const BrowserTraceCallSchema = Schema.Struct({
  callId: OpaqueIdSchema,
  action: boundedString(64),
  category: Schema.Literals(["navigation", "observation", "interaction", "network", "session", "script", "other"]),
  sequence: SequenceSchema,
  parameters: BrowserPayloadShapeSchema,
  result: Schema.optionalKey(Schema.Struct({
    sequence: SequenceSchema,
    success: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
    durationMs: Schema.optionalKey(boundedInteger(3_600_000, "bounded tool duration")),
    shape: BrowserPayloadShapeSchema
  })),
  network: boundedArray(Schema.Struct({
    sequence: SequenceSchema,
    requestEvidenceId: boundedString(512),
    relation: Schema.Literals(["command_triggered_request", "response_informed_result"]),
    evidence: Schema.Literal("bounded_time_window"),
    confidence: Schema.Literal("low")
  }), MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL, "bounded browser network dependencies"),
  reuse: Schema.optionalKey(Schema.Struct({
    sequence: SequenceSchema,
    decision: Schema.Literals(["network_tool", "browser_fallback"]),
    reason: Schema.Literals([
      "approved_exact_match", "no_candidate", "candidate_unapproved", "input_shape_mismatch",
      "dependency_unresolved", "session_unavailable", "policy_denied", "candidate_failed"
    ]),
    binding: Schema.optionalKey(BrowserNetworkToolBindingSchema)
  }))
})

const BrowserPreparedToolSchema = Schema.Struct({
  sequence: SequenceSchema,
  toolId: OpaqueIdSchema,
  toolDigest: DigestSchema,
  sourceTraceDigest: DigestSchema,
  sourceArtifactDigest: DigestSchema,
  actionId: OpaqueIdSchema,
  summary: BrowserNetworkToolSummarySchema,
  definition: Schema.Unknown
}).pipe(Schema.check(Schema.makeFilter(
  (tool) => canonicalStringify(tool.definition).length <= MAX_BROWSER_PREPARED_TOOL_CHARS,
  { title: "bounded declarative network tool definition" }
)))

const BrowserTraceFailureSchema = Schema.Struct({
  code: Schema.Literals([
    "event_limit_exceeded", "malformed_event", "cross_thread_event", "sequence_gap", "duplicate_call",
    "call_limit_exceeded", "result_without_call", "result_action_mismatch", "duplicate_result",
    "network_without_call", "duplicate_network_request", "network_limit_exceeded", "duplicate_prepared_tool",
    "prepared_tool_limit_exceeded", "prepared_tool_evidence_missing", "reuse_without_call", "duplicate_reuse",
    "reuse_binding_mismatch"
  ]),
  sequence: Schema.optionalKey(SequenceSchema),
  callId: Schema.optionalKey(OpaqueIdSchema)
})

/**
 * The method returns the exact pure projection, including a prepared tool's
 * complete value-free declarative definition. Every collection and definition
 * remains bounded by the browser trace ledger's own limits.
 */
export const BrowserTraceInspectionOutputSchema = Schema.Struct({
  threadId: BrowserTraceThreadIdSchema,
  status: Schema.Literals(["not_found", "streaming", "completed", "invalid"]),
  reusable: Schema.Boolean,
  digest: DigestSchema,
  nextSequence: SequenceSchema,
  eventCount: boundedInteger(MAX_BROWSER_TRACE_EVENTS, "bounded browser trace event count"),
  events: boundedArray(BrowserTraceEventSchema, MAX_BROWSER_TRACE_EVENTS, "bounded browser trace events"),
  calls: boundedArray(BrowserTraceCallSchema, MAX_BROWSER_TRACE_CALLS, "bounded browser trace calls"),
  preparedTools: boundedArray(
    BrowserPreparedToolSchema,
    MAX_BROWSER_PREPARED_TOOLS,
    "bounded prepared network tools"
  ),
  failure: Schema.optionalKey(BrowserTraceFailureSchema)
})

export const BrowserTraceInspectionCompletedSchema = Schema.Struct({
  type: Schema.Literal("BrowserTraceInspectionCompleted"),
  schemaVersion: Schema.Literal(BROWSER_TRACE_SCHEMA_VERSION),
  id: Schema.String,
  invocationEpoch: SequenceSchema,
  threadId: BrowserTraceThreadIdSchema,
  outputDigest: DigestSchema,
  output: BrowserTraceInspectionOutputSchema,
  ...RootTransportFields
})

type InspectionRequest = typeof BrowserTraceInspectionRequestedSchema.Type

const isInspectionRequest = (value: unknown): value is InspectionRequest => {
  try {
    Schema.decodeUnknownSync(BrowserTraceInspectionRequestedSchema, { onExcessProperty: "error" })(value)
    return true
  } catch {
    return false
  }
}

const requestKeyOf = (request: InspectionRequest): string =>
  `${INSPECTION_KEY_PREFIX}${request.threadId}:${request.invocationEpoch}:${sha256(request.id)}:request`

const completionKeyOf = (completion: typeof BrowserTraceInspectionCompletedSchema.Type): string =>
  `${INSPECTION_KEY_PREFIX}${completion.threadId}:${completion.invocationEpoch}:${sha256(completion.id)}` +
  `:completed:${completion.outputDigest}`

const requestPrefixesFor = (
  log: ReadonlyArray<Event>,
  invocation: { readonly id: string; readonly epoch: number }
): ReadonlyArray<InspectionRequest> => {
  const requests: InspectionRequest[] = []
  for (let index = 0; index < log.length; index += 1) {
    const event = log[index]
    if (
      event !== undefined && isInspectionRequest(event) &&
      event.id === invocation.id && event.invocationEpoch === invocation.epoch
    ) requests.push(event)
  }
  return requests
}

const outputDigestOf = (output: BrowserTraceProjection): `sha256:${string}` =>
  `sha256:${sha256(canonicalStringify(output))}`

const expectedOutputFor = (
  log: ReadonlyArray<Event>,
  request: InspectionRequest
): BrowserTraceProjection | undefined => {
  const requestIndex = log.indexOf(request as Event)
  return requestIndex < 0 ? undefined : browserTraceProjectionOf(log.slice(0, requestIndex), request.threadId)
}

const matchingCompletion = (
  log: ReadonlyArray<Event>,
  request: InspectionRequest,
  output: BrowserTraceProjection
): typeof BrowserTraceInspectionCompletedSchema.Type | undefined => {
  const digest = outputDigestOf(output)
  return log.find((event) => {
    if (!isCompletion(event)) return false
    return event.id === request.id && event.invocationEpoch === request.invocationEpoch &&
      event.threadId === request.threadId && event.outputDigest === digest &&
      canonicalStringify(event.output) === canonicalStringify(output)
  }) as typeof BrowserTraceInspectionCompletedSchema.Type | undefined
}

const isCompletion = (value: unknown): value is typeof BrowserTraceInspectionCompletedSchema.Type => {
  try {
    Schema.decodeUnknownSync(BrowserTraceInspectionCompletedSchema, { onExcessProperty: "error" })(value)
    return true
  } catch {
    return false
  }
}

export const browserTraceComponentKeys: KeyFragment = {
  prefixes: [...browserTraceKeys.prefixes, INSPECTION_KEY_PREFIX],
  keyOf: (event) => {
    if (!event.type.startsWith("Browser")) return undefined
    const traceKey = browserTraceKeys.keyOf(event)
    if (traceKey !== undefined) return traceKey
    if (isInspectionRequest(event)) return requestKeyOf(event)
    return isCompletion(event) ? completionKeyOf(event) : undefined
  }
}

export const inspectBrowserTraceMethod = actorMethod({
  input: Schema.Struct({ threadId: BrowserTraceThreadIdSchema }),
  output: BrowserTraceInspectionOutputSchema,
  event: ({ invocation, input, at }): Event => ({
    type: "BrowserTraceInspectionRequested",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    id: invocation.id,
    invocationEpoch: invocation.epoch,
    threadId: input.threadId,
    at
  }),
  state: (log, invocation) => {
    const requests = requestPrefixesFor(log, invocation)
    if (requests.length === 0) return undefined
    if (requests.length !== 1) {
      return { status: "failed", error: "ambiguous_inspection_request: Multiple inspection requests share this invocation." }
    }
    const request = requests[0]!
    const output = expectedOutputFor(log, request)
    if (output === undefined) return { status: "pending" }
    const completed = matchingCompletion(log, request, output)
    return completed === undefined ? { status: "pending" } : { status: "completed", output }
  }
})

export interface BrowserTraceComponentView {
  readonly inspectionRequests: number
}

/** Read-only: projection is pure and this component schedules no transitions. */
export const browserTraceComponent: Component<BrowserTraceComponentView> = {
  name: "browser-traces",
  keys: browserTraceComponentKeys,
  derive: (log) => {
    const requests = log.filter((event): event is InspectionRequest => event.type === "BrowserTraceInspectionRequested" && isInspectionRequest(event))
    const transitions = requests.flatMap((request) => {
      const output = expectedOutputFor(log, request)
      if (output === undefined || matchingCompletion(log, request, output) !== undefined) return []
      const outputDigest = outputDigestOf(output)
      return [intent({
        key: `${INSPECTION_KEY_PREFIX}${request.threadId}:${request.invocationEpoch}:${sha256(request.id)}` +
          `:completed:${outputDigest}`,
        input: {
          id: request.id,
          invocationEpoch: request.invocationEpoch,
          threadId: request.threadId,
          output,
          outputDigest
        },
        events: (input, at): ReadonlyArray<Event> => [{
          type: "BrowserTraceInspectionCompleted",
          schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
          ...input,
          at
        }]
      })]
    })
    return {
      view: { inspectionRequests: requests.length },
      transitions
    }
  }
}
