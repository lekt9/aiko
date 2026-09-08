import { Schema } from "effect"
import type { Event } from "tardie/core/log/event"
import type { KeyFragment } from "tardie/core/log"

import { canonicalStringify, compareText, sha256 } from "./har"
import {
  networkToolDigest,
  summarizeCompiledNetworkTool,
  validateNetworkToolDefinition,
  type CompiledNetworkTool,
  type NetworkToolDefinition,
  type NetworkToolSummary
} from "./network-tool-catalog"

/**
 * Durable browser traces are deliberately not command transcripts. The raw
 * agent-browser stream contains URLs, selectors, typed text, cookies, page
 * output, response bodies, and eval source. Only the bounded structural facts
 * declared in this file may cross into an event log.
 */
export const BROWSER_TRACE_SCHEMA_VERSION = 1 as const
export const BROWSER_TRACE_REDACTION_REVISION = "browser-trace-redaction/1" as const

export const MAX_BROWSER_TRACE_EVENTS = 4_096
export const MAX_BROWSER_TRACE_CALLS = 1_024
export const MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL = 128
export const MAX_BROWSER_PREPARED_TOOLS = 256
export const MAX_BROWSER_PREPARED_TOOL_STEPS = 32
export const MAX_BROWSER_PREPARED_TOOL_DEPENDENCIES = 256
export const MAX_BROWSER_PREPARED_TOOL_CHARS = 262_144
export const MAX_BROWSER_RAW_RECORD_CHARS = 1_000_000
export const MAX_BROWSER_PAYLOAD_NODES = 256
export const MAX_BROWSER_PAYLOAD_DEPTH = 6
export const MAX_BROWSER_PAYLOAD_FIELDS = 48
export const MAX_BROWSER_COLLECTION_ITEMS = 64
export const MAX_BROWSER_TOOL_DURATION_MS = 3_600_000

const KEY_PREFIX = "browsertrace1:"
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u

/** These names are never retained, and their subtrees are not inspected. */
const FORBIDDEN_FIELD = /(?:^|[_.-])(?:api[-_]?key|auth(?:entication|orization)?|bearer|body|code|content|cookie|credential|csrf|eval(?:uate)?|expression|function|html|instruction|javascript|message|output|password|prompt|reasoning|secret|session|source|stack|text|token|value|xsrf)(?:$|[_.-])/iu

export type BrowserToolCategory =
  | "navigation"
  | "observation"
  | "interaction"
  | "network"
  | "session"
  | "script"
  | "other"

const actionsByCategory: Readonly<Record<Exclude<BrowserToolCategory, "other">, ReadonlyArray<string>>> = {
  navigation: [
    "launch", "navigate", "read", "url", "cdp_url", "back", "forward", "reload", "tab_list",
    "tab_new", "tab_switch", "tab_close", "window_new", "frame", "mainframe", "bringtofront"
  ],
  observation: [
    "inspect", "title", "content", "snapshot", "screenshot", "gettext", "getattribute", "isvisible",
    "isenabled", "ischecked", "console", "errors", "pdf", "diff_snapshot", "diff_url", "boundingbox",
    "innertext", "innerhtml", "inputvalue", "count", "styles", "react_tree", "react_inspect",
    "react_renders_start", "react_renders_stop", "react_suspense", "vitals", "a11y", "pushstate",
    "diff_screenshot"
  ],
  interaction: [
    "click", "dblclick", "fill", "type", "press", "hover", "scroll", "select", "check", "uncheck",
    "wait", "mouse", "keyboard", "focus", "clear", "selectall", "scrollintoview", "highlight", "tap",
    "clipboard", "wheel", "waitforurl", "waitforloadstate", "getbyrole", "getbytext", "getbylabel",
    "getbyplaceholder", "getbyalttext", "getbytitle", "getbytestid", "nth", "find", "drag", "pause",
    "multiselect", "waitfordownload", "confirm", "deny", "swipe", "input_mouse", "input_keyboard",
    "input_touch", "keydown", "keyup", "inserttext", "mousemove", "mousedown", "mouseup", "upload",
    "download", "dialog"
  ],
  network: [
    "headers", "offline", "har_start", "har_stop", "route", "unroute", "requests", "request_detail",
    "responsebody"
  ],
  session: [
    "close", "cookies_get", "cookies_set", "cookies_clear", "storage_get", "storage_set", "storage_clear",
    "session_info", "state_save", "state_load", "state_list", "state_show", "state_clear", "state_clean",
    "state_rename", "trace_start", "trace_stop", "profiler_start", "profiler_stop", "recording_start",
    "recording_stop", "recording_restart", "viewport", "useragent", "user_agent", "set_media", "timezone",
    "locale", "geolocation", "permissions", "device", "device_list", "video_start", "video_stop",
    "screencast_start", "screencast_stop", "stream_enable", "stream_disable", "stream_status",
    "credentials", "credentials_set", "credentials_get", "credentials_delete", "credentials_list",
    "auth_save", "auth_login", "auth_list", "auth_delete", "auth_show"
  ],
  script: [
    "evaluate", "setcontent", "dispatch", "addscript", "addinitscript", "removeinitscript", "addstyle",
    "waitforfunction", "evalhandle", "expose", "webmcp_list", "webmcp_invoke", "webmcp_result",
    "webmcp_cancel"
  ]
}

const categoryByAction = new Map<string, BrowserToolCategory>([["other", "other"]])
for (const [category, actions] of Object.entries(actionsByCategory)) {
  for (const action of actions) categoryByAction.set(action, category as BrowserToolCategory)
}

export type BrowserToolAction = string

/**
 * Only daemon-owned v0.36 action identifiers survive. An unknown value is
 * collapsed to `other`; it is never copied into the durable fact.
 */
export const browserToolActionOf = (value: unknown): BrowserToolAction =>
  typeof value === "string" && categoryByAction.has(value) ? value : "other"

export const browserToolCategoryOf = (action: BrowserToolAction): BrowserToolCategory =>
  categoryByAction.get(action) ?? "other"

const PARAMETER_FIELDS_COMMON = ["action", "id"] as const
const PARAMETER_FIELDS_BY_ACTION: Readonly<Record<string, ReadonlyArray<string>>> = {
  navigate: ["url", "waitUntil", "timeout"],
  read: ["url", "filter", "outline", "llms", "requireMd", "raw", "maxOutput"],
  snapshot: ["interactive", "compact", "depth", "selector", "frame", "maxOutput"],
  screenshot: ["path", "selector", "fullPage", "format", "quality"],
  click: ["selector", "button", "clickCount", "timeout"],
  dblclick: ["selector", "button", "timeout"],
  fill: ["selector", "text", "timeout"],
  type: ["selector", "text", "delay", "timeout"],
  press: ["selector", "key", "modifiers", "timeout"],
  hover: ["selector", "timeout"],
  scroll: ["selector", "direction", "amount", "x", "y"],
  select: ["selector", "options", "timeout"],
  check: ["selector", "timeout"],
  uncheck: ["selector", "timeout"],
  wait: ["selector", "state", "timeout", "url", "loadState"],
  gettext: ["selector"],
  getattribute: ["selector", "name"],
  isvisible: ["selector"],
  isenabled: ["selector"],
  ischecked: ["selector"],
  find: ["by", "value", "subaction", "selector", "timeout"],
  requests: ["filter", "type", "method", "status"],
  request_detail: ["requestId"],
  har_start: ["content"],
  har_stop: ["path"],
  route: ["pattern", "abort", "status", "headers", "body"],
  unroute: ["pattern"],
  tab_new: ["url"],
  tab_switch: ["tabId", "targetId"],
  tab_close: ["tabId", "targetId"],
  evaluate: ["expression", "args"],
  waitforfunction: ["expression", "timeout", "polling"],
  cookies_get: ["url"],
  cookies_set: ["cookies", "url", "path"],
  auth_login: ["name", "url"],
  upload: ["selector", "paths"],
  download: ["selector", "path", "timeout"]
}

const SAFE_RESULT_FIELDS = new Set([
  "action", "attached", "checked", "count", "duration", "durationMs", "enabled", "engine", "format",
  "found", "height", "interactive", "itemCount", "method", "mimeType", "ok", "recording", "requestCount",
  "resourceType", "status", "statusCode", "success", "tabCount", "truncated", "type", "visible",
  "viewportHeight", "viewportWidth", "width"
])

export type BrowserPayloadRoot = "absent" | "array" | "boolean" | "null" | "number" | "object" | "string" | "other"

export interface BrowserPayloadShape {
  readonly root: BrowserPayloadRoot
  readonly fieldNames: ReadonlyArray<string>
  readonly counts: {
    readonly arrays: number
    readonly booleans: number
    readonly nulls: number
    readonly numbers: number
    readonly objects: number
    readonly strings: number
  }
  readonly maxDepth: number
  readonly truncated: boolean
}

type MutableCounts = {
  arrays: number
  booleans: number
  nulls: number
  numbers: number
  objects: number
  strings: number
}

const rootOf = (value: unknown): BrowserPayloadRoot => value === undefined ? "absent"
  : value === null ? "null"
    : Array.isArray(value) ? "array"
      : typeof value === "boolean" ? "boolean"
        : typeof value === "number" && Number.isFinite(value) ? "number"
          : typeof value === "string" ? "string"
            : typeof value === "object" ? "object" : "other"

const safeStructuralField = (field: string): boolean =>
  SAFE_FIELD.test(field) && !FORBIDDEN_FIELD.test(field)

/**
 * Reduces a JSON-like value to type counts. For objects, only explicitly
 * allowed top-level fields are entered. Child values are counted by type but
 * their keys and scalar contents are never retained.
 */
export const browserPayloadShapeOf = (
  value: unknown,
  allowedTopLevelFields: ReadonlySet<string> = new Set()
): BrowserPayloadShape => {
  const counts: MutableCounts = { arrays: 0, booleans: 0, nulls: 0, numbers: 0, objects: 0, strings: 0 }
  const fields = new Set<string>()
  const seen = new WeakSet<object>()
  let nodes = 0
  let maxDepth = 0
  let truncated = false

  const visit = (current: unknown, depth: number, topLevel: boolean): void => {
    if (nodes >= MAX_BROWSER_PAYLOAD_NODES || depth > MAX_BROWSER_PAYLOAD_DEPTH) {
      truncated = true
      return
    }
    nodes += 1
    maxDepth = Math.max(maxDepth, depth)
    const kind = rootOf(current)
    if (kind === "absent") return
    if (kind === "null") { counts.nulls += 1; return }
    if (kind === "boolean") { counts.booleans += 1; return }
    if (kind === "number") { counts.numbers += 1; return }
    if (kind === "string") { counts.strings += 1; return }
    if (kind === "other") { truncated = true; return }

    const object = current as object
    if (seen.has(object)) {
      truncated = true
      return
    }
    seen.add(object)
    if (Array.isArray(current)) {
      counts.arrays += 1
      if (current.length > MAX_BROWSER_COLLECTION_ITEMS) truncated = true
      for (const child of current.slice(0, MAX_BROWSER_COLLECTION_ITEMS)) visit(child, depth + 1, false)
      return
    }

    counts.objects += 1
    const entries: Array<readonly [string, unknown]> = []
    try {
      const record = current as Record<string, unknown>
      for (const field in record) {
        if (!Object.prototype.hasOwnProperty.call(record, field)) continue
        if (entries.length >= MAX_BROWSER_COLLECTION_ITEMS) {
          truncated = true
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, field)
        if (descriptor === undefined || !("value" in descriptor)) {
          // Never invoke accessors while reducing untrusted values.
          truncated = true
          continue
        }
        entries.push([field, descriptor.value])
      }
      entries.sort(([left], [right]) => compareText(left, right))
    } catch {
      truncated = true
      return
    }
    for (const [field, child] of entries) {
      if (topLevel) {
        if (!allowedTopLevelFields.has(field) || !safeStructuralField(field)) {
          truncated = true
          continue
        }
        if (fields.size < MAX_BROWSER_PAYLOAD_FIELDS) fields.add(field)
        else truncated = true
      }
      visit(child, depth + 1, false)
    }
  }

  visit(value, 0, true)
  return Object.freeze({
    root: rootOf(value),
    fieldNames: Object.freeze([...fields].sort(compareText)),
    counts: Object.freeze({ ...counts }),
    maxDepth,
    truncated
  })
}

const parameterFieldsFor = (action: BrowserToolAction): ReadonlySet<string> => new Set([
  ...PARAMETER_FIELDS_COMMON,
  ...(PARAMETER_FIELDS_BY_ACTION[action] ?? [])
])

export const browserToolParametersShapeOf = (action: BrowserToolAction, params: unknown): BrowserPayloadShape =>
  browserPayloadShapeOf(params, parameterFieldsFor(action))

export const browserToolResultShapeOf = (data: unknown): BrowserPayloadShape =>
  browserPayloadShapeOf(data, SAFE_RESULT_FIELDS)

export interface BrowserTraceIdentity {
  readonly [key: string]: unknown
  readonly threadId: string
  readonly sequence: number
}

export interface BrowserToolCallObserved extends BrowserTraceIdentity {
  readonly type: "BrowserToolCallObserved"
  readonly schemaVersion: typeof BROWSER_TRACE_SCHEMA_VERSION
  readonly redactionRevision: typeof BROWSER_TRACE_REDACTION_REVISION
  readonly callId: string
  readonly action: BrowserToolAction
  readonly category: BrowserToolCategory
  readonly parameters: BrowserPayloadShape
  readonly at?: number
  readonly traceparent?: string
}

export interface BrowserToolResultObserved extends BrowserTraceIdentity {
  readonly type: "BrowserToolResultObserved"
  readonly schemaVersion: typeof BROWSER_TRACE_SCHEMA_VERSION
  readonly redactionRevision: typeof BROWSER_TRACE_REDACTION_REVISION
  readonly callId: string
  readonly action: BrowserToolAction
  readonly category: BrowserToolCategory
  /** `unknown` is mandatory for uncorroborated agent-browser stream/chat results. */
  readonly success: boolean | "unknown"
  readonly durationMs?: number
  readonly result: BrowserPayloadShape
  readonly at?: number
  readonly traceparent?: string
}

export type BrowserNetworkRelation = "command_triggered_request" | "response_informed_result"
export type BrowserNetworkEvidence = "bounded_time_window"
export type BrowserNetworkConfidence = "low"

export interface BrowserRequestEvidenceRef {
  readonly captureId: string
  readonly importDigest: string
  readonly requestId: string
  readonly requestEvidenceId: string
}

export interface BrowserNetworkDependencyInferred extends BrowserTraceIdentity {
  readonly type: "BrowserNetworkDependencyInferred"
  readonly schemaVersion: typeof BROWSER_TRACE_SCHEMA_VERSION
  readonly redactionRevision: typeof BROWSER_TRACE_REDACTION_REVISION
  readonly callId: string
  readonly request: BrowserRequestEvidenceRef
  readonly relation: BrowserNetworkRelation
  readonly evidence: BrowserNetworkEvidence
  readonly confidence: BrowserNetworkConfidence
  readonly at?: number
  readonly traceparent?: string
}

export type BrowserNetworkToolSummary = NetworkToolSummary

export interface BrowserNetworkToolPrepared extends BrowserTraceIdentity {
  readonly type: "BrowserNetworkToolPrepared"
  readonly schemaVersion: typeof BROWSER_TRACE_SCHEMA_VERSION
  readonly redactionRevision: typeof BROWSER_TRACE_REDACTION_REVISION
  readonly toolId: string
  readonly toolDigest: string
  readonly sourceTraceDigest: string
  readonly sourceArtifactDigest: string
  readonly actionId: string
  readonly summary: BrowserNetworkToolSummary
  /** Canonical, value-free declarative data. This is not executable source. */
  readonly definition: NetworkToolDefinition
  readonly at?: number
  readonly traceparent?: string
}

export type BrowserNetworkReuseDecision = "network_tool" | "browser_fallback"
export type BrowserNetworkReuseReason =
  | "approved_exact_match"
  | "no_candidate"
  | "candidate_unapproved"
  | "input_shape_mismatch"
  | "dependency_unresolved"
  | "session_unavailable"
  | "policy_denied"
  | "candidate_failed"

export interface BrowserNetworkToolBinding {
  readonly toolId: string
  readonly toolDigest: string
  readonly sourceTraceDigest: string
  readonly sourceArtifactDigest: string
}

export interface BrowserNetworkToolReuseDecided extends BrowserTraceIdentity {
  readonly type: "BrowserNetworkToolReuseDecided"
  readonly schemaVersion: typeof BROWSER_TRACE_SCHEMA_VERSION
  readonly redactionRevision: typeof BROWSER_TRACE_REDACTION_REVISION
  readonly callId: string
  readonly decision: BrowserNetworkReuseDecision
  readonly reason: BrowserNetworkReuseReason
  readonly binding?: BrowserNetworkToolBinding
  readonly at?: number
  readonly traceparent?: string
}

export type BrowserTraceEvent =
  | BrowserToolCallObserved
  | BrowserToolResultObserved
  | BrowserNetworkDependencyInferred
  | BrowserNetworkToolPrepared
  | BrowserNetworkToolReuseDecided

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

export const BrowserTraceThreadIdSchema = matchingString(OPAQUE_ID, "opaque browser trace thread ID")
const OpaqueIdSchema = matchingString(OPAQUE_ID, "opaque identifier")
const DigestSchema = matchingString(DIGEST, "sha256 digest")
const SequenceSchema = boundedInteger(Number.MAX_SAFE_INTEGER, "non-negative safe trace sequence")
const SmallCountSchema = boundedInteger(MAX_BROWSER_PAYLOAD_NODES, "bounded payload count")
const ToolSummaryCountSchema = boundedInteger(1_024, "bounded tool summary count")
const FieldNamesSchema = Schema.Array(matchingString(SAFE_FIELD, "safe field name")).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<string>) => values.length <= MAX_BROWSER_PAYLOAD_FIELDS,
  { title: `at most ${MAX_BROWSER_PAYLOAD_FIELDS} field names` }
)))

export const BrowserPayloadShapeSchema = Schema.Struct({
  root: Schema.Literals(["absent", "array", "boolean", "null", "number", "object", "string", "other"]),
  fieldNames: FieldNamesSchema,
  counts: Schema.Struct({
    arrays: SmallCountSchema,
    booleans: SmallCountSchema,
    nulls: SmallCountSchema,
    numbers: SmallCountSchema,
    objects: SmallCountSchema,
    strings: SmallCountSchema
  }),
  maxDepth: boundedInteger(MAX_BROWSER_PAYLOAD_DEPTH, "bounded payload depth"),
  truncated: Schema.Boolean
})

const TransportFields = {
  at: Schema.optionalKey(SequenceSchema),
  traceparent: Schema.optionalKey(matchingString(TRACEPARENT, "W3C traceparent"))
}
const IdentityFields = {
  schemaVersion: Schema.Literal(BROWSER_TRACE_SCHEMA_VERSION),
  redactionRevision: Schema.Literal(BROWSER_TRACE_REDACTION_REVISION),
  threadId: BrowserTraceThreadIdSchema,
  sequence: SequenceSchema
}

export const BrowserToolCallObservedSchema = Schema.Struct({
  type: Schema.Literal("BrowserToolCallObserved"),
  ...IdentityFields,
  callId: OpaqueIdSchema,
  action: boundedString(64),
  category: Schema.Literals(["navigation", "observation", "interaction", "network", "session", "script", "other"]),
  parameters: BrowserPayloadShapeSchema,
  ...TransportFields
})

export const BrowserToolResultObservedSchema = Schema.Struct({
  type: Schema.Literal("BrowserToolResultObserved"),
  ...IdentityFields,
  callId: OpaqueIdSchema,
  action: boundedString(64),
  category: Schema.Literals(["navigation", "observation", "interaction", "network", "session", "script", "other"]),
  success: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
  durationMs: Schema.optionalKey(boundedInteger(MAX_BROWSER_TOOL_DURATION_MS, "bounded tool duration")),
  result: BrowserPayloadShapeSchema,
  ...TransportFields
})

const BrowserRequestEvidenceRefSchema = Schema.Struct({
  captureId: OpaqueIdSchema,
  importDigest: DigestSchema,
  requestId: OpaqueIdSchema,
  requestEvidenceId: boundedString(512)
})

export const BrowserNetworkDependencyInferredSchema = Schema.Struct({
  type: Schema.Literal("BrowserNetworkDependencyInferred"),
  ...IdentityFields,
  callId: OpaqueIdSchema,
  request: BrowserRequestEvidenceRefSchema,
  relation: Schema.Literals(["command_triggered_request", "response_informed_result"]),
  evidence: Schema.Literal("bounded_time_window"),
  confidence: Schema.Literal("low"),
  ...TransportFields
})

const BrowserNetworkToolSummarySchema = Schema.Struct({
  siteId: OpaqueIdSchema,
  methods: Schema.Array(Schema.Literals(["GET", "HEAD"])),
  stepCount: ToolSummaryCountSchema,
  inputCount: ToolSummaryCountSchema,
  callerInputCount: ToolSummaryCountSchema,
  vaultInputCount: ToolSummaryCountSchema,
  dependencyCount: ToolSummaryCountSchema,
  sessionRequirementCount: ToolSummaryCountSchema
})

export const BrowserNetworkToolPreparedSchema = Schema.Struct({
  type: Schema.Literal("BrowserNetworkToolPrepared"),
  ...IdentityFields,
  toolId: OpaqueIdSchema,
  toolDigest: DigestSchema,
  sourceTraceDigest: DigestSchema,
  sourceArtifactDigest: DigestSchema,
  actionId: OpaqueIdSchema,
  summary: BrowserNetworkToolSummarySchema,
  definition: Schema.Unknown,
  ...TransportFields
})

const BrowserNetworkToolBindingSchema = Schema.Struct({
  toolId: OpaqueIdSchema,
  toolDigest: DigestSchema,
  sourceTraceDigest: DigestSchema,
  sourceArtifactDigest: DigestSchema
})

export const BrowserNetworkToolReuseDecidedSchema = Schema.Struct({
  type: Schema.Literal("BrowserNetworkToolReuseDecided"),
  ...IdentityFields,
  callId: OpaqueIdSchema,
  decision: Schema.Literals(["network_tool", "browser_fallback"]),
  reason: Schema.Literals([
    "approved_exact_match", "no_candidate", "candidate_unapproved", "input_shape_mismatch",
    "dependency_unresolved", "session_unavailable", "policy_denied", "candidate_failed"
  ]),
  binding: Schema.optionalKey(BrowserNetworkToolBindingSchema),
  ...TransportFields
})

const schemasByType: Readonly<Record<BrowserTraceEvent["type"], Schema.ConstraintDecoder<unknown>>> = {
  BrowserToolCallObserved: BrowserToolCallObservedSchema,
  BrowserToolResultObserved: BrowserToolResultObservedSchema,
  BrowserNetworkDependencyInferred: BrowserNetworkDependencyInferredSchema,
  BrowserNetworkToolPrepared: BrowserNetworkToolPreparedSchema,
  BrowserNetworkToolReuseDecided: BrowserNetworkToolReuseDecidedSchema
}

const TRACE_TYPES = new Set<string>(Object.keys(schemasByType))

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] | undefined => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

const isCanonicalPayloadShape = (
  shape: BrowserPayloadShape,
  allowedFields: ReadonlySet<string>
): boolean => {
  const total = Object.values(shape.counts).reduce((sum, count) => sum + count, 0)
  if (
    total > MAX_BROWSER_PAYLOAD_NODES ||
    shape.fieldNames.some((field) => !safeStructuralField(field) || !allowedFields.has(field)) ||
    canonicalStringify(shape.fieldNames) !== canonicalStringify([...new Set(shape.fieldNames)].sort(compareText)) ||
    (shape.root !== "object" && shape.fieldNames.length > 0)
  ) return false
  switch (shape.root) {
    case "absent": return total === 0 && shape.maxDepth === 0 && shape.fieldNames.length === 0
    case "array": return shape.counts.arrays > 0
    case "boolean": return shape.counts.booleans > 0
    case "null": return shape.counts.nulls > 0
    case "number": return shape.counts.numbers > 0
    case "object": return shape.counts.objects > 0
    case "string": return shape.counts.strings > 0
    case "other": return total === 0 && shape.maxDepth === 0 && shape.fieldNames.length === 0 && shape.truncated
  }
}

/**
 * Reconstructs a result shape from only its fixed bounded fields. This lets an
 * injected executor return structural evidence without handing an arbitrary
 * website object to the recursive reducer or to excess-property enumeration.
 */
export const decodeBrowserToolResultShape = (value: unknown): BrowserPayloadShape | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fieldNames = record.fieldNames
  const counts = record.counts
  if (!Array.isArray(fieldNames) || fieldNames.length > MAX_BROWSER_PAYLOAD_FIELDS ||
    typeof counts !== "object" || counts === null || Array.isArray(counts)) return undefined
  const countRecord = counts as Record<string, unknown>
  const candidate = {
    root: record.root,
    fieldNames: fieldNames.slice(),
    counts: {
      arrays: countRecord.arrays,
      booleans: countRecord.booleans,
      nulls: countRecord.nulls,
      numbers: countRecord.numbers,
      objects: countRecord.objects,
      strings: countRecord.strings
    },
    maxDepth: record.maxDepth,
    truncated: record.truncated
  }
  const decoded = decode(BrowserPayloadShapeSchema, candidate) as BrowserPayloadShape | undefined
  if (decoded === undefined || !isCanonicalPayloadShape(decoded, SAFE_RESULT_FIELDS)) return undefined
  return Object.freeze({
    ...decoded,
    fieldNames: Object.freeze([...decoded.fieldNames]),
    counts: Object.freeze({ ...decoded.counts })
  })
}

const evidenceContract = (
  _relation: BrowserNetworkRelation,
  evidence: BrowserNetworkEvidence
): BrowserNetworkConfidence | undefined => {
  // agent-browser v0.36 exposes no request-id <-> tool-call-id join. Even an
  // underlying HAR initiator identifies another URL, not the surrounding CLI
  // command. Command-window association therefore remains explicitly weak.
  return evidence === "bounded_time_window" ? "low" : undefined
}

export const browserRequestEvidenceIdOf = (request: {
  readonly captureId: string
  readonly importDigest: string
  readonly requestId: string
}): string => `har2:req:${request.captureId}:${request.importDigest}:${request.requestId}`

const locallyValid = (event: Exclude<BrowserTraceEvent, BrowserNetworkToolPrepared>): boolean => {
  if (event.type === "BrowserToolCallObserved" || event.type === "BrowserToolResultObserved") {
    if (!categoryByAction.has(event.action) || browserToolCategoryOf(event.action) !== event.category) return false
    const shape = event.type === "BrowserToolCallObserved" ? event.parameters : event.result
    return isCanonicalPayloadShape(shape, event.type === "BrowserToolCallObserved"
      ? parameterFieldsFor(event.action)
      : SAFE_RESULT_FIELDS)
  }
  if (event.type === "BrowserNetworkDependencyInferred") {
    return browserRequestEvidenceIdOf(event.request) === event.request.requestEvidenceId &&
      evidenceContract(event.relation, event.evidence) === event.confidence
  }
  if (event.decision === "network_tool") {
    return event.reason === "approved_exact_match" && event.binding !== undefined
  }
  return event.reason !== "approved_exact_match" && event.binding === undefined
}

const normalizedPreparedToolEvent = (event: BrowserNetworkToolPrepared): BrowserNetworkToolPrepared | undefined => {
  try {
    const definition = validateNetworkToolDefinition(event.definition)
    const definitionJson = canonicalStringify(definition)
    if (
      definitionJson.length > MAX_BROWSER_PREPARED_TOOL_CHARS ||
      definition.steps.length > MAX_BROWSER_PREPARED_TOOL_STEPS ||
      definition.dependencies.length > MAX_BROWSER_PREPARED_TOOL_DEPENDENCIES ||
      definition.toolId !== event.toolId || definition.actionId !== event.actionId ||
      definition.sourceTraceDigest !== event.sourceTraceDigest ||
      definition.sourceArtifactDigest !== event.sourceArtifactDigest ||
      networkToolDigest(definition) !== event.toolDigest
    ) return undefined
    const summary = summarizeCompiledNetworkTool({ digest: event.toolDigest, definition })
    if (canonicalStringify(summary) !== canonicalStringify(event.summary)) return undefined
    return { ...event, summary, definition }
  } catch {
    return undefined
  }
}

/** Strictly decodes one already-sanitized durable event. */
export const decodeBrowserTraceEvent = (value: unknown): BrowserTraceEvent | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const type = (value as { readonly type?: unknown }).type
  if (typeof type !== "string" || !TRACE_TYPES.has(type)) return undefined
  const decoded = decode(schemasByType[type as BrowserTraceEvent["type"]], value) as BrowserTraceEvent | undefined
  if (decoded === undefined) return undefined
  if (decoded.type === "BrowserNetworkToolPrepared") return normalizedPreparedToolEvent(decoded)
  return locallyValid(decoded) ? decoded : undefined
}

const withoutTransport = (event: BrowserTraceEvent): BrowserTraceEvent => {
  const { at: _at, traceparent: _traceparent, ...durable } = event
  return durable as BrowserTraceEvent
}

export type BrowserTraceDigest = `sha256:${string}`

/** This digest covers only the canonical value-free event, never a raw value. */
export const browserTraceEventDigestOf = (value: unknown): BrowserTraceDigest => {
  const event = decodeBrowserTraceEvent(value)
  if (event === undefined) throw new Error("Browser trace event is outside the durable schema")
  return `sha256:${sha256(canonicalStringify(withoutTransport(event)))}`
}

export const browserTraceNdjsonLineOf = (value: unknown): string => {
  const event = decodeBrowserTraceEvent(value)
  if (event === undefined) throw new Error("Browser trace event is outside the durable schema")
  return canonicalStringify(withoutTransport(event))
}

const ensureEvent = <T extends BrowserTraceEvent>(event: T): T => {
  if (decodeBrowserTraceEvent(event) === undefined) {
    throw new Error("Generated browser trace event is outside the durable schema")
  }
  return event
}

const assertIdentity = (identity: BrowserTraceIdentity): void => {
  if (!OPAQUE_ID.test(identity.threadId) || !Number.isSafeInteger(identity.sequence) || identity.sequence < 0) {
    throw new Error("Browser trace identity is outside the bounded opaque-ID contract")
  }
}

const assertOpaqueId = (value: string): void => {
  if (!OPAQUE_ID.test(value)) throw new Error("Browser trace identifier is outside the opaque-ID contract")
}

const assertDigest = (value: string): void => {
  if (!DIGEST.test(value)) throw new Error("Browser trace binding requires a canonical sha256 digest")
}

export const browserToolCallEventOf = (input: BrowserTraceIdentity & {
  readonly callId: string
  readonly action: unknown
  readonly params?: unknown
}): BrowserToolCallObserved => {
  assertIdentity(input)
  assertOpaqueId(input.callId)
  const action = browserToolActionOf(input.action)
  return ensureEvent({
    type: "BrowserToolCallObserved",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId: input.threadId,
    sequence: input.sequence,
    callId: input.callId,
    action,
    category: browserToolCategoryOf(action),
    parameters: browserToolParametersShapeOf(action, input.params)
  })
}

export const browserToolResultEventOf = (input: BrowserTraceIdentity & {
  readonly callId: string
  readonly action: unknown
  readonly success: boolean | "unknown"
  readonly data?: unknown
  /** Already reduced at a bounded trusted-adapter boundary; mutually exclusive with data. */
  readonly resultShape?: unknown
  readonly durationMs?: number
}): BrowserToolResultObserved => {
  assertIdentity(input)
  assertOpaqueId(input.callId)
  const action = browserToolActionOf(input.action)
  if (input.durationMs !== undefined && (
    !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > MAX_BROWSER_TOOL_DURATION_MS
  )) throw new Error("Browser tool duration is outside the bounded contract")
  if (input.data !== undefined && input.resultShape !== undefined) {
    throw new Error("Browser tool result cannot supply both raw data and a structural shape")
  }
  const result = input.resultShape === undefined
    ? browserToolResultShapeOf(input.data)
    : decodeBrowserToolResultShape(input.resultShape)
  if (result === undefined) throw new Error("Browser tool result shape is outside the bounded contract")
  return ensureEvent({
    type: "BrowserToolResultObserved",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId: input.threadId,
    sequence: input.sequence,
    callId: input.callId,
    action,
    category: browserToolCategoryOf(action),
    success: input.success,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    result
  })
}

export const browserNetworkDependencyEventOf = (input: BrowserTraceIdentity & {
  readonly callId: string
  readonly captureId: string
  readonly importDigest: string
  readonly requestId: string
  readonly relation: BrowserNetworkRelation
  readonly evidence: BrowserNetworkEvidence
}): BrowserNetworkDependencyInferred => {
  assertIdentity(input)
  assertOpaqueId(input.callId)
  assertOpaqueId(input.captureId)
  assertOpaqueId(input.requestId)
  assertDigest(input.importDigest)
  const confidence = evidenceContract(input.relation, input.evidence)
  if (confidence === undefined) throw new Error("Browser network dependency evidence does not support its relation")
  const request = {
    captureId: input.captureId,
    importDigest: input.importDigest,
    requestId: input.requestId,
    requestEvidenceId: browserRequestEvidenceIdOf(input)
  }
  return ensureEvent({
    type: "BrowserNetworkDependencyInferred",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId: input.threadId,
    sequence: input.sequence,
    callId: input.callId,
    request,
    relation: input.relation,
    evidence: input.evidence,
    confidence
  })
}

export const browserNetworkToolPreparedEventOf = (input: BrowserTraceIdentity & {
  readonly tool: CompiledNetworkTool
}): BrowserNetworkToolPrepared => {
  assertIdentity(input)
  const definition = validateNetworkToolDefinition(input.tool.definition)
  const toolDigest = networkToolDigest(definition)
  if (input.tool.digest !== toolDigest) throw new Error("Prepared network tool digest does not match its definition")
  const summary = summarizeCompiledNetworkTool({ digest: toolDigest, definition })
  return ensureEvent({
    type: "BrowserNetworkToolPrepared",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId: input.threadId,
    sequence: input.sequence,
    toolId: definition.toolId,
    toolDigest,
    sourceTraceDigest: definition.sourceTraceDigest,
    sourceArtifactDigest: definition.sourceArtifactDigest,
    actionId: definition.actionId,
    summary,
    definition
  })
}

export const browserNetworkToolReuseEventOf = (input: BrowserTraceIdentity & {
  readonly callId: string
  readonly decision: BrowserNetworkReuseDecision
  readonly reason: BrowserNetworkReuseReason
  readonly binding?: BrowserNetworkToolBinding
}): BrowserNetworkToolReuseDecided => {
  assertIdentity(input)
  assertOpaqueId(input.callId)
  if (input.binding !== undefined) {
    assertOpaqueId(input.binding.toolId)
    assertDigest(input.binding.toolDigest)
    assertDigest(input.binding.sourceTraceDigest)
    assertDigest(input.binding.sourceArtifactDigest)
  }
  return ensureEvent({
    type: "BrowserNetworkToolReuseDecided",
    schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
    redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
    threadId: input.threadId,
    sequence: input.sequence,
    callId: input.callId,
    decision: input.decision,
    reason: input.reason,
    ...(input.binding === undefined ? {} : { binding: { ...input.binding } })
  })
}

export interface BrowserTraceFailure {
  readonly code:
    | "event_limit_exceeded"
    | "malformed_event"
    | "cross_thread_event"
    | "sequence_gap"
    | "duplicate_call"
    | "call_limit_exceeded"
    | "result_without_call"
    | "result_action_mismatch"
    | "duplicate_result"
    | "network_without_call"
    | "duplicate_network_request"
    | "network_limit_exceeded"
    | "duplicate_prepared_tool"
    | "prepared_tool_limit_exceeded"
    | "prepared_tool_evidence_missing"
    | "reuse_without_call"
    | "duplicate_reuse"
    | "reuse_binding_mismatch"
  readonly sequence?: number
  readonly callId?: string
}

export interface BrowserTraceCallView {
  readonly callId: string
  readonly action: BrowserToolAction
  readonly category: BrowserToolCategory
  readonly sequence: number
  readonly parameters: BrowserPayloadShape
  readonly result?: {
    readonly sequence: number
    readonly success: boolean | "unknown"
    readonly durationMs?: number
    readonly shape: BrowserPayloadShape
  }
  readonly network: ReadonlyArray<{
    readonly sequence: number
    readonly requestEvidenceId: string
    readonly relation: BrowserNetworkRelation
    readonly evidence: BrowserNetworkEvidence
    readonly confidence: BrowserNetworkConfidence
  }>
  readonly reuse?: {
    readonly sequence: number
    readonly decision: BrowserNetworkReuseDecision
    readonly reason: BrowserNetworkReuseReason
    readonly binding?: BrowserNetworkToolBinding
  }
}

export interface BrowserPreparedToolView {
  readonly sequence: number
  readonly toolId: string
  readonly toolDigest: string
  readonly sourceTraceDigest: string
  readonly sourceArtifactDigest: string
  readonly actionId: string
  readonly summary: BrowserNetworkToolSummary
  readonly definition: NetworkToolDefinition
}

export interface BrowserTraceProjection {
  readonly threadId: string
  readonly status: "not_found" | "streaming" | "completed" | "invalid"
  /** False for invalid, incomplete, failed, or uncorroborated tool outcomes. */
  readonly reusable: boolean
  readonly digest: BrowserTraceDigest
  readonly nextSequence: number
  readonly eventCount: number
  readonly events: ReadonlyArray<BrowserTraceEvent>
  readonly calls: ReadonlyArray<BrowserTraceCallView>
  readonly preparedTools: ReadonlyArray<BrowserPreparedToolView>
  readonly failure?: BrowserTraceFailure
}

type MutableCall = {
  call: BrowserToolCallObserved
  result?: BrowserToolResultObserved
  network: BrowserNetworkDependencyInferred[]
  reuse?: BrowserNetworkToolReuseDecided
}

const traceDigestOf = (
  threadId: string,
  events: ReadonlyArray<BrowserTraceEvent>,
  failure?: BrowserTraceFailure
): BrowserTraceDigest => `sha256:${sha256(canonicalStringify({
  schemaVersion: BROWSER_TRACE_SCHEMA_VERSION,
  redactionRevision: BROWSER_TRACE_REDACTION_REVISION,
  threadId,
  events: events.map(withoutTransport),
  ...(failure === undefined ? {} : { failure })
}))}`

const finalizedProjection = (
  threadId: string,
  events: ReadonlyArray<BrowserTraceEvent>,
  calls: ReadonlyMap<string, MutableCall>,
  prepared: ReadonlyArray<BrowserNetworkToolPrepared>,
  nextSequence: number,
  failure?: BrowserTraceFailure
): BrowserTraceProjection => {
  const callViews = [...calls.values()].sort((left, right) => left.call.sequence - right.call.sequence).map((entry) => ({
    callId: entry.call.callId,
    action: entry.call.action,
    category: entry.call.category,
    sequence: entry.call.sequence,
    parameters: entry.call.parameters,
    ...(entry.result === undefined ? {} : {
      result: {
        sequence: entry.result.sequence,
        success: entry.result.success,
        ...(entry.result.durationMs === undefined ? {} : { durationMs: entry.result.durationMs }),
        shape: entry.result.result
      }
    }),
    network: Object.freeze(entry.network.map((dependency) => ({
      sequence: dependency.sequence,
      requestEvidenceId: dependency.request.requestEvidenceId,
      relation: dependency.relation,
      evidence: dependency.evidence,
      confidence: dependency.confidence
    }))),
    ...(entry.reuse === undefined ? {} : {
      reuse: {
        sequence: entry.reuse.sequence,
        decision: entry.reuse.decision,
        reason: entry.reuse.reason,
        ...(entry.reuse.binding === undefined ? {} : { binding: entry.reuse.binding })
      }
    })
  }))
  const preparedTools = prepared.map((event) => ({
    sequence: event.sequence,
    toolId: event.toolId,
    toolDigest: event.toolDigest,
    sourceTraceDigest: event.sourceTraceDigest,
    sourceArtifactDigest: event.sourceArtifactDigest,
    actionId: event.actionId,
    summary: event.summary,
    definition: event.definition
  }))
  const status = failure !== undefined ? "invalid"
    : events.length === 0 ? "not_found"
      : [...calls.values()].some((entry) => entry.result === undefined) ? "streaming" : "completed"
  const reusable = failure === undefined && calls.size > 0 &&
    [...calls.values()].every((entry) => entry.result?.success === true)
  return Object.freeze({
    threadId,
    status,
    reusable,
    digest: traceDigestOf(threadId, events, failure),
    nextSequence,
    eventCount: events.length,
    events: Object.freeze(events.map(withoutTransport)),
    calls: Object.freeze(callViews),
    preparedTools: Object.freeze(preparedTools),
    ...(failure === undefined ? {} : { failure: Object.freeze(failure) })
  }) as BrowserTraceProjection
}

/**
 * Pure, prefix-safe projection. Unknown Tardigrade events are ignored; a known
 * browser trace type that fails schema validation invalidates the projection
 * without copying the offending payload into the returned view.
 */
export const browserTraceProjectionOf = (
  log: ReadonlyArray<Event>,
  threadId: string
): BrowserTraceProjection => {
  if (!OPAQUE_ID.test(threadId)) throw new Error("Browser trace projection requires an opaque thread ID")
  const traceRows = log.filter((event) => TRACE_TYPES.has(event.type))
  if (traceRows.length > MAX_BROWSER_TRACE_EVENTS) {
    return finalizedProjection(threadId, [], new Map(), [], 0, { code: "event_limit_exceeded" })
  }

  const events: BrowserTraceEvent[] = []
  const calls = new Map<string, MutableCall>()
  const prepared: BrowserNetworkToolPrepared[] = []
  const preparedById = new Map<string, BrowserNetworkToolPrepared>()
  const networkRefs = new Set<string>()
  let expectedSequence = 0

  const fail = (failure: BrowserTraceFailure): BrowserTraceProjection =>
    finalizedProjection(threadId, events, calls, prepared, expectedSequence, failure)

  for (const raw of traceRows) {
    const rawThread = (raw as Event & { readonly threadId?: unknown }).threadId
    if (rawThread !== threadId) return fail({ code: "cross_thread_event" })
    const event = decodeBrowserTraceEvent(raw)
    if (event === undefined) return fail({ code: "malformed_event" })
    if (event.sequence !== expectedSequence) {
      return fail({ code: "sequence_gap", sequence: event.sequence })
    }
    expectedSequence += 1
    events.push(event)

    if (event.type === "BrowserToolCallObserved") {
      if (calls.has(event.callId)) return fail({ code: "duplicate_call", sequence: event.sequence, callId: event.callId })
      if (calls.size >= MAX_BROWSER_TRACE_CALLS) return fail({ code: "call_limit_exceeded", sequence: event.sequence })
      calls.set(event.callId, { call: event, network: [] })
      continue
    }
    if (event.type === "BrowserToolResultObserved") {
      const call = calls.get(event.callId)
      if (call === undefined) return fail({ code: "result_without_call", sequence: event.sequence, callId: event.callId })
      if (call.call.action !== event.action || call.call.category !== event.category) {
        return fail({ code: "result_action_mismatch", sequence: event.sequence, callId: event.callId })
      }
      if (call.result !== undefined) return fail({ code: "duplicate_result", sequence: event.sequence, callId: event.callId })
      call.result = event
      continue
    }
    if (event.type === "BrowserNetworkDependencyInferred") {
      const call = calls.get(event.callId)
      if (call === undefined) return fail({ code: "network_without_call", sequence: event.sequence, callId: event.callId })
      if (networkRefs.has(event.request.requestEvidenceId)) {
        return fail({ code: "duplicate_network_request", sequence: event.sequence, callId: event.callId })
      }
      if (call.network.length >= MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL) {
        return fail({ code: "network_limit_exceeded", sequence: event.sequence, callId: event.callId })
      }
      networkRefs.add(event.request.requestEvidenceId)
      call.network.push(event)
      continue
    }
    if (event.type === "BrowserNetworkToolPrepared") {
      if (preparedById.has(event.toolId)) return fail({ code: "duplicate_prepared_tool", sequence: event.sequence })
      if (prepared.length >= MAX_BROWSER_PREPARED_TOOLS) {
        return fail({ code: "prepared_tool_limit_exceeded", sequence: event.sequence })
      }
      if (event.definition.evidence.some((evidence) => !networkRefs.has(evidence.traceEventId))) {
        return fail({ code: "prepared_tool_evidence_missing", sequence: event.sequence })
      }
      prepared.push(event)
      preparedById.set(event.toolId, event)
      continue
    }

    const call = calls.get(event.callId)
    if (call === undefined) return fail({ code: "reuse_without_call", sequence: event.sequence, callId: event.callId })
    if (call.reuse !== undefined) return fail({ code: "duplicate_reuse", sequence: event.sequence, callId: event.callId })
    if (event.binding !== undefined) {
      const known = preparedById.get(event.binding.toolId)
      if (known !== undefined && (
        known.toolDigest !== event.binding.toolDigest ||
        known.sourceTraceDigest !== event.binding.sourceTraceDigest ||
        known.sourceArtifactDigest !== event.binding.sourceArtifactDigest
      )) return fail({ code: "reuse_binding_mismatch", sequence: event.sequence, callId: event.callId })
    }
    call.reuse = event
  }

  return finalizedProjection(threadId, events, calls, prepared, expectedSequence)
}

export const browserTraceNdjsonOf = (projection: BrowserTraceProjection): string =>
  projection.events.length === 0 ? "" : `${projection.events.map(browserTraceNdjsonLineOf).join("\n")}\n`

export const browserTraceKeys: KeyFragment = {
  prefixes: [KEY_PREFIX],
  keyOf: (raw) => {
    const event = decodeBrowserTraceEvent(raw)
    if (event === undefined) return undefined
    const digest = browserTraceEventDigestOf(event)
    const base = `${KEY_PREFIX}${event.threadId}:${event.sequence}`
    if (event.type === "BrowserToolCallObserved") return `${base}:call:${event.callId}:${digest}`
    if (event.type === "BrowserToolResultObserved") return `${base}:result:${event.callId}:${digest}`
    if (event.type === "BrowserNetworkDependencyInferred") {
      return `${base}:network:${event.callId}:${digest}`
    }
    if (event.type === "BrowserNetworkToolPrepared") return `${base}:prepared:${event.toolId}:${digest}`
    return `${base}:reuse:${event.callId}:${digest}`
  }
}
