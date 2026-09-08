import { createHash } from "node:crypto"

export const SITE_HARNESS_SCHEMA_VERSION = 2 as const
export const SITE_HARNESS_EXECUTOR_ABI = "site-harness/1" as const

export const SITE_HARNESS_LIMITS = Object.freeze({
  artifactBytes: 256 * 1024,
  actions: 64,
  inputsPerAction: 64,
  stepsPerAction: 128,
  totalSteps: 512,
  allowedOrigins: 16,
  bindingsPerStep: 128,
  dependenciesPerStep: 64,
  expectedStatusesPerStep: 32,
  producerDepth: 12,
  producerNodes: 8_192,
  moduleArgs: 32,
  constantBytes: 16 * 1024,
  jsonDepth: 16,
  jsonNodes: 4_096
} as const)

export type Sha256Digest = `sha256:${string}`
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }

export type HarnessInputType = "string" | "number" | "integer" | "boolean" | "json"

export interface HarnessInput {
  readonly name: string
  readonly type: HarnessInputType
  readonly required: boolean
}

export interface InputValueProducer {
  readonly kind: "input"
  readonly name: string
}

export interface ClockValueProducer {
  readonly kind: "clock"
  readonly format: "rfc1123" | "iso8601" | "epoch_ms"
}

export interface UuidValueProducer {
  readonly kind: "uuid"
}

export interface ResponseHeaderValueProducer {
  readonly kind: "response_header"
  readonly stepId: string
  readonly name: string
}

export interface ResponseJsonValueProducer {
  readonly kind: "response_json"
  readonly stepId: string
  readonly pointer: string
}

export interface ConstantValueProducer {
  readonly kind: "constant"
  readonly value: JsonValue
}

export interface ObjectValueProducer {
  readonly kind: "object"
  readonly fields: Readonly<Record<string, ValueProducer>>
}

export interface ArrayValueProducer {
  readonly kind: "array"
  readonly items: ReadonlyArray<ValueProducer>
}

export interface WasmValueProducer {
  readonly kind: "wasm"
  readonly moduleDigest: Sha256Digest
  readonly export: string
  readonly args: ReadonlyArray<ValueProducer>
}

export interface JsValueProducer {
  readonly kind: "js"
  readonly moduleDigest: Sha256Digest
  readonly entry: string
  readonly args: ReadonlyArray<ValueProducer>
}

export type ValueProducer =
  | InputValueProducer
  | ClockValueProducer
  | UuidValueProducer
  | ResponseHeaderValueProducer
  | ResponseJsonValueProducer
  | ConstantValueProducer
  | ObjectValueProducer
  | ArrayValueProducer
  | WasmValueProducer
  | JsValueProducer

export type HarnessHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"

export interface HarnessStep {
  readonly id: string
  readonly dependsOn: ReadonlyArray<string>
  readonly method: HarnessHttpMethod
  readonly origin: string
  /** Absolute-path route template. `{name}` placeholders are supplied by pathParameters. */
  readonly path: string
  readonly pathParameters: Readonly<Record<string, ValueProducer>>
  readonly query: Readonly<Record<string, ValueProducer>>
  readonly headers: Readonly<Record<string, ValueProducer>>
  readonly body?: ValueProducer
  readonly expectedStatuses: ReadonlyArray<number>
  /**
   * "pixel" marks a beacon the site would send anyway: the transport may
   * classify the scripted response telemetry_dependency and the step still
   * completes. Unmarked steps only accept application traffic.
   */
  readonly purpose?: "pixel"
}

export interface HarnessAction {
  readonly id: string
  readonly inputs: ReadonlyArray<HarnessInput>
  /** Steps must already be in topological order. */
  readonly steps: ReadonlyArray<HarnessStep>
}

export interface SiteHarnessArtifact {
  readonly schemaVersion: typeof SITE_HARNESS_SCHEMA_VERSION
  readonly executorAbi: typeof SITE_HARNESS_EXECUTOR_ABI
  readonly siteId: string
  readonly version: string
  readonly sourceCaptureDigest: Sha256Digest
  readonly allowedOrigins: ReadonlyArray<string>
  readonly actions: ReadonlyArray<HarnessAction>
}

export type SiteHarnessCandidateInput = Omit<SiteHarnessArtifact, "schemaVersion" | "executorAbi">

export interface HarnessArtifactValidationIssue {
  readonly path: string
  readonly message: string
}

export class HarnessArtifactValidationError extends Error {
  readonly issues: ReadonlyArray<HarnessArtifactValidationIssue>

  constructor(issues: ReadonlyArray<HarnessArtifactValidationIssue>) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    this.name = "HarnessArtifactValidationError"
    this.issues = Object.freeze([...issues])
  }
}

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const QUERY_NAME = /^[A-Za-z0-9_.\[\]-]+$/u
const WASM_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/u
const JS_ENTRY = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u
const PATH_PARAMETER = /\{([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\}/gu
const STATIC_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9._~-]{0,63}$/u
const SENSITIVE_STATIC_SEGMENT = /(?:^|[-_.])(?:bearer|secret|password|private[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|csrf[-_]?token|captcha|challenge|fingerprint)(?:$|[-_.])/iu
const OPAQUE_STATIC_SEGMENT = /^(?:[0-9a-f]{16,}|[A-Za-z0-9_-]{32,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/iu
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])

const FORBIDDEN_HEADER_NAMES = new Set([
  "accept-encoding",
  "accept-language",
  "authorization",
  "baggage",
  "connection",
  "content-length",
  "cookie",
  "dnt",
  "host",
  "priority",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "www-authenticate",
  "traceparent",
  "tracestate",
  "x-access-token",
  "x-api-key",
  "x-arkose",
  "x-auth-token",
  "x-bot",
  "x-browser",
  "x-captcha",
  "x-challenge",
  "x-client-data",
  "x-datadome",
  "x-device",
  "x-fingerprint",
  "x-kpsdk"
])

const FORBIDDEN_HEADER_PREFIXES = [
  "akamai-",
  "cf-",
  "proxy-",
  "sec-",
  "x-akamai-",
  "x-arkose-",
  "x-bot-",
  "x-browser-",
  "x-captcha-",
  "x-challenge-",
  "x-datadome-",
  "x-device-",
  "x-fingerprint-",
  "x-forwarded-",
  "x-amz-",
  "x-goog-",
  "x-kpsdk-"
] as const

const HTTP_METHODS = new Set<HarnessHttpMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
const INPUT_TYPES = new Set<HarnessInputType>(["string", "number", "integer", "boolean", "json"])
const CLOCK_FORMATS = new Set<ClockValueProducer["format"]>(["rfc1123", "iso8601", "epoch_ms"])

interface ValidationContext {
  readonly issues: HarnessArtifactValidationIssue[]
  producerNodes: number
  totalSteps: number
}

const issue = (context: ValidationContext, path: string, message: string): void => {
  if (context.issues.length < 128) context.issues.push({ path, message })
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const recordAt = (value: unknown, path: string, context: ValidationContext): Record<string, unknown> => {
  if (!isRecord(value)) {
    issue(context, path, "must be an object")
    return {}
  }
  return value
}

const exactFields = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string,
  context: ValidationContext
): void => {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(context, `${path}.${key}`, "is not an allowed field")
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) issue(context, `${path}.${key}`, "is required")
  }
}

const stringAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  options: { readonly min?: number; readonly max: number; readonly pattern?: RegExp }
): string => {
  if (typeof value !== "string") {
    issue(context, path, "must be a string")
    return ""
  }
  const min = options.min ?? 1
  if (value.length < min || value.length > options.max) {
    issue(context, path, `must contain between ${min} and ${options.max} characters`)
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) issue(context, path, "has an invalid format")
  return value
}

const idAt = (value: unknown, path: string, context: ValidationContext): string =>
  stringAt(value, path, context, { max: 64, pattern: ID })

export const isSha256Digest = (value: unknown): value is Sha256Digest =>
  typeof value === "string" && DIGEST.test(value)

const digestAt = (value: unknown, path: string, context: ValidationContext): Sha256Digest => {
  if (!isSha256Digest(value)) {
    issue(context, path, "must be a lowercase sha256:<64 hex characters> digest")
    return `sha256:${"0".repeat(64)}`
  }
  return value
}

const arrayAt = (value: unknown, path: string, context: ValidationContext, max: number, min = 0): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) {
    issue(context, path, "must be an array")
    return []
  }
  if (value.length < min || value.length > max) issue(context, path, `must contain between ${min} and ${max} entries`)
  return value
}

const unique = (values: ReadonlyArray<string>, path: string, context: ValidationContext): void => {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    if (seen.has(value)) issue(context, `${path}[${index}]`, `duplicates ${JSON.stringify(value)}`)
    seen.add(value)
  })
}

const forbiddenHeaderReason = (name: string): string | undefined => {
  const lower = name.toLowerCase()
  if (FORBIDDEN_HEADER_NAMES.has(lower)) return "is a transport, credential, or fingerprint header"
  if (FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return "is a credential, fingerprint, telemetry-challenge, or proxy-controlled header"
  }
  return undefined
}

export const isAllowedHarnessHeaderName = (name: string): boolean =>
  name.length <= 128 && HEADER_NAME.test(name) && forbiddenHeaderReason(name) === undefined

/** Static route text must be an ordinary public route label, never an opaque captured value. */
export const isSafeStaticHarnessPathSegment = (value: string): boolean =>
  STATIC_PATH_SEGMENT.test(value) && !SENSITIVE_STATIC_SEGMENT.test(value) && !OPAQUE_STATIC_SEGMENT.test(value)

const headerNameAt = (value: unknown, path: string, context: ValidationContext): string => {
  const name = stringAt(value, path, context, { max: 128, pattern: HEADER_NAME })
  const forbidden = forbiddenHeaderReason(name)
  if (forbidden !== undefined) issue(context, path, forbidden)
  return name
}

const validateHeaderProducer = (
  name: string,
  producer: ValueProducer,
  path: string,
  context: ValidationContext
): void => {
  const lower = name.toLowerCase()
  if (lower === "date" && (producer.kind !== "clock" || producer.format !== "rfc1123")) {
    issue(context, path, "Date must be produced by clock in rfc1123 format")
  }
  if (
    (lower === "idempotency-key" || lower === "x-request-id" || lower === "x-correlation-id") &&
    producer.kind !== "uuid"
  ) {
    issue(context, path, `${name} must be produced by uuid`)
  }
  if (
    (lower === "if-match" || lower === "if-none-match") &&
    producer.kind !== "response_header"
  ) {
    issue(context, path, `${name} must be produced by response_header`)
  }
  if (
    lower.startsWith("x-") &&
    /(?:csrf|xsrf|token|nonce|signature)/u.test(lower) &&
    producer.kind !== "response_header" &&
    producer.kind !== "response_json" &&
    producer.kind !== "wasm"
  ) {
    issue(context, path, `${name} must be response-derived or produced by an approved WASM module`)
  }
}

const originAt = (value: unknown, path: string, context: ValidationContext): string => {
  const origin = stringAt(value, path, context, { max: 512 })
  try {
    const parsed = new URL(origin)
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      issue(context, path, "must use https, except that http is allowed for loopback test origins")
    }
    if (parsed.username !== "" || parsed.password !== "") issue(context, path, "must not contain user information")
    if (parsed.origin !== origin || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      issue(context, path, "must be a canonical origin with no trailing slash, path, query, fragment, or user information")
    }
  } catch {
    issue(context, path, "must be an absolute URL origin")
  }
  return origin
}

const jsonValueAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set()
): JsonValue => {
  if (depth > SITE_HARNESS_LIMITS.jsonDepth) {
    issue(context, path, `exceeds JSON depth ${SITE_HARNESS_LIMITS.jsonDepth}`)
    return null
  }
  context.producerNodes += 1
  if (context.producerNodes > SITE_HARNESS_LIMITS.producerNodes) {
    issue(context, path, `artifact exceeds ${SITE_HARNESS_LIMITS.producerNodes} producer/constant nodes`)
    return null
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 16_384) issue(context, path, "string exceeds 16384 characters")
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(context, path, "number must be finite")
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== "object" || value === null) {
    issue(context, path, "must be JSON data")
    return null
  }
  if (ancestors.has(value)) {
    issue(context, path, "must not be cyclic")
    return null
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (Array.isArray(value)) {
    if (value.length > SITE_HARNESS_LIMITS.jsonNodes) issue(context, path, "array is too large")
    return value.map((entry, index) => jsonValueAt(entry, `${path}[${index}]`, context, depth + 1, nextAncestors))
  }
  if (!isRecord(value)) {
    issue(context, path, "must contain only plain JSON objects")
    return null
  }
  const keys = Object.keys(value)
  if (keys.length > 256) issue(context, path, "object contains too many keys")
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const key of keys) {
    if (key.length === 0 || key.length > 256) issue(context, `${path}.${key}`, "key must contain between 1 and 256 characters")
    if (FORBIDDEN_OBJECT_KEYS.has(key)) issue(context, `${path}.${key}`, "key is forbidden")
    result[key] = jsonValueAt(value[key], `${path}.${key}`, context, depth + 1, nextAncestors)
  }
  return result
}

interface ProducerReferences {
  readonly inputs: ReadonlySet<string>
  readonly priorSteps: ReadonlySet<string>
}

const producerAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  references: ProducerReferences,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set()
): ValueProducer => {
  if (depth > SITE_HARNESS_LIMITS.producerDepth) {
    issue(context, path, `producer nesting exceeds ${SITE_HARNESS_LIMITS.producerDepth}`)
    return { kind: "constant", value: null }
  }
  context.producerNodes += 1
  if (context.producerNodes > SITE_HARNESS_LIMITS.producerNodes) {
    issue(context, path, `artifact exceeds ${SITE_HARNESS_LIMITS.producerNodes} producer/constant nodes`)
    return { kind: "constant", value: null }
  }
  const record = recordAt(value, path, context)
  if (ancestors.has(record)) {
    issue(context, path, "producer graph must not contain object cycles")
    return { kind: "constant", value: null }
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(record)
  const kind = typeof record.kind === "string" ? record.kind : ""
  switch (kind) {
    case "input": {
      exactFields(record, ["kind", "name"], [], path, context)
      const name = idAt(record.name, `${path}.name`, context)
      if (!references.inputs.has(name)) issue(context, `${path}.name`, `does not name an input declared by this action: ${JSON.stringify(name)}`)
      return { kind, name }
    }
    case "clock": {
      exactFields(record, ["kind", "format"], [], path, context)
      const format = record.format
      if (typeof format !== "string" || !CLOCK_FORMATS.has(format as ClockValueProducer["format"])) {
        issue(context, `${path}.format`, "must be rfc1123, iso8601, or epoch_ms")
        return { kind, format: "iso8601" }
      }
      return { kind, format: format as ClockValueProducer["format"] }
    }
    case "uuid":
      exactFields(record, ["kind"], [], path, context)
      return { kind }
    case "response_header": {
      exactFields(record, ["kind", "stepId", "name"], [], path, context)
      const stepId = idAt(record.stepId, `${path}.stepId`, context)
      if (!references.priorSteps.has(stepId)) {
        issue(context, `${path}.stepId`, "must name a transitive prerequisite step")
      }
      const name = headerNameAt(record.name, `${path}.name`, context)
      return { kind, stepId, name }
    }
    case "response_json": {
      exactFields(record, ["kind", "stepId", "pointer"], [], path, context)
      const stepId = idAt(record.stepId, `${path}.stepId`, context)
      if (!references.priorSteps.has(stepId)) {
        issue(context, `${path}.stepId`, "must name a transitive prerequisite step")
      }
      const pointer = stringAt(record.pointer, `${path}.pointer`, context, { min: 0, max: 1024 })
      if (pointer !== "" && !pointer.startsWith("/")) issue(context, `${path}.pointer`, "must be an RFC 6901 JSON pointer")
      if (/(?:^|[^~])~(?:[^01]|$)/u.test(pointer)) issue(context, `${path}.pointer`, "contains an invalid JSON pointer escape")
      return { kind, stepId, pointer }
    }
    case "constant": {
      exactFields(record, ["kind", "value"], [], path, context)
      const constantContext: ValidationContext = { ...context, issues: context.issues }
      const parsed = jsonValueAt(record.value, `${path}.value`, constantContext)
      context.producerNodes = constantContext.producerNodes
      const encoded = canonicalJson(parsed)
      if (new TextEncoder().encode(encoded).byteLength > SITE_HARNESS_LIMITS.constantBytes) {
        issue(context, `${path}.value`, `constant exceeds ${SITE_HARNESS_LIMITS.constantBytes} encoded bytes`)
      }
      return { kind, value: parsed }
    }
    case "object": {
      exactFields(record, ["kind", "fields"], [], path, context)
      const fieldsRecord = recordAt(record.fields, `${path}.fields`, context)
      const entries = Object.entries(fieldsRecord)
      if (entries.length > SITE_HARNESS_LIMITS.bindingsPerStep) {
        issue(context, `${path}.fields`, `must contain at most ${SITE_HARNESS_LIMITS.bindingsPerStep} fields`)
      }
      const fields: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
      for (const [name, field] of entries) {
        if (name.length === 0 || name.length > 256) {
          issue(context, `${path}.fields.${name}`, "field name must contain between 1 and 256 characters")
        }
        if (FORBIDDEN_OBJECT_KEYS.has(name)) issue(context, `${path}.fields.${name}`, "field name is forbidden")
        fields[name] = producerAt(field, `${path}.fields.${name}`, context, references, depth + 1, nextAncestors)
      }
      return { kind, fields }
    }
    case "array": {
      exactFields(record, ["kind", "items"], [], path, context)
      const items = arrayAt(record.items, `${path}.items`, context, SITE_HARNESS_LIMITS.bindingsPerStep)
        .map((item, index) => producerAt(item, `${path}.items[${index}]`, context, references, depth + 1, nextAncestors))
      return { kind, items }
    }
    case "js": {
      exactFields(record, ["kind", "moduleDigest", "entry", "args"], [], path, context)
      const jsDigest = digestAt(record.moduleDigest, `${path}.moduleDigest`, context)
      const entry = stringAt(record.entry, `${path}.entry`, context, { max: 128, pattern: JS_ENTRY })
      const jsArgs = arrayAt(record.args, `${path}.args`, context, SITE_HARNESS_LIMITS.moduleArgs).map((argument, index) =>
        producerAt(argument, `${path}.args[${index}]`, context, references, depth + 1))
      return { kind: "js", moduleDigest: jsDigest, entry, args: jsArgs }
    }
    case "wasm": {
      exactFields(record, ["kind", "moduleDigest", "export", "args"], [], path, context)
      const moduleDigest = digestAt(record.moduleDigest, `${path}.moduleDigest`, context)
      const exportName = stringAt(record.export, `${path}.export`, context, { max: 128, pattern: WASM_EXPORT })
      const args = arrayAt(record.args, `${path}.args`, context, SITE_HARNESS_LIMITS.moduleArgs).map((argument, index) =>
        producerAt(argument, `${path}.args[${index}]`, context, references, depth + 1, nextAncestors))
      return { kind, moduleDigest, export: exportName, args }
    }
    default:
      exactFields(record, ["kind"], [], path, context)
      issue(context, `${path}.kind`, "must be input, clock, uuid, response_header, response_json, constant, object, array, wasm, or js")
      return { kind: "constant", value: null }
  }
}

const producerRecordAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  references: ProducerReferences,
  keyKind: "id" | "query" | "header"
): Readonly<Record<string, ValueProducer>> => {
  const record = recordAt(value, path, context)
  const entries = Object.entries(record)
  if (entries.length > SITE_HARNESS_LIMITS.bindingsPerStep) {
    issue(context, path, `must contain at most ${SITE_HARNESS_LIMITS.bindingsPerStep} bindings`)
  }
  const result: Record<string, ValueProducer> = Object.create(null) as Record<string, ValueProducer>
  const lowerNames = new Set<string>()
  for (const [key, producer] of entries) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) issue(context, `${path}.${key}`, "key is forbidden")
    if (keyKind === "id") idAt(key, `${path}.${key}`, context)
    if (keyKind === "query" && (key.length === 0 || key.length > 128 || !QUERY_NAME.test(key))) {
      issue(context, `${path}.${key}`, "query parameter name is invalid")
    }
    if (keyKind === "header") {
      headerNameAt(key, `${path}.${key}`, context)
      const lower = key.toLowerCase()
      if (lowerNames.has(lower)) issue(context, `${path}.${key}`, "duplicates a header name case-insensitively")
      lowerNames.add(lower)
    }
    const parsed = producerAt(producer, `${path}.${key}`, context, references)
    if (keyKind === "header") validateHeaderProducer(key, parsed, `${path}.${key}`, context)
    result[key] = parsed
  }
  return result
}

const pathAt = (
  value: unknown,
  parameters: Readonly<Record<string, ValueProducer>>,
  path: string,
  context: ValidationContext
): string => {
  const route = stringAt(value, path, context, { max: 1024 })
  if (!route.startsWith("/")) issue(context, path, "must start with /")
  if (route.startsWith("//") || route.includes("\\") || route.includes("?") || route.includes("#") || route.includes("://")) {
    issue(context, path, "must be an absolute-path route without an authority, query, fragment, or backslash")
  }
  if (/[\u0000-\u001f\u007f]/u.test(route)) issue(context, path, "must not contain control characters")

  const placeholders: string[] = []
  for (const match of route.matchAll(PATH_PARAMETER)) {
    const name = match[1]
    if (name !== undefined) placeholders.push(name)
  }
  const withoutPlaceholders = route.replace(PATH_PARAMETER, "x")
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) issue(context, path, "contains a malformed path placeholder")
  unique(placeholders, `${path}.placeholders`, context)
  const expected = [...new Set(placeholders)].sort()
  const actual = Object.keys(parameters).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    issue(context, path, "path placeholders must exactly match pathParameters keys")
  }
  for (const [index, segment] of withoutPlaceholders.split("/").entries()) {
    try {
      const decoded = decodeURIComponent(segment)
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
        issue(context, `${path}.segment[${index}]`, "must not be a dot segment or encode a slash/backslash")
      } else if (decoded.length > 0 && !isSafeStaticHarnessPathSegment(decoded)) {
        issue(context, `${path}.segment[${index}]`, "must be a public static route label or a declared path placeholder")
      }
    } catch {
      issue(context, `${path}.segment[${index}]`, "contains invalid percent encoding")
    }
  }
  return route
}

const inputAt = (value: unknown, path: string, context: ValidationContext): HarnessInput => {
  const record = recordAt(value, path, context)
  exactFields(record, ["name", "type", "required"], [], path, context)
  const name = idAt(record.name, `${path}.name`, context)
  const type = record.type
  if (typeof type !== "string" || !INPUT_TYPES.has(type as HarnessInputType)) {
    issue(context, `${path}.type`, "must be string, number, integer, boolean, or json")
  }
  if (typeof record.required !== "boolean") issue(context, `${path}.required`, "must be a boolean")
  return { name, type: INPUT_TYPES.has(type as HarnessInputType) ? type as HarnessInputType : "json", required: record.required === true }
}

const stepAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  inputs: ReadonlySet<string>,
  earlierSteps: ReadonlySet<string>,
  ancestorsByStep: ReadonlyMap<string, ReadonlySet<string>>,
  allowedOrigins: ReadonlySet<string>
): { readonly step: HarnessStep; readonly ancestors: ReadonlySet<string> } => {
  const record = recordAt(value, path, context)
  exactFields(
    record,
    ["id", "dependsOn", "method", "origin", "path", "pathParameters", "query", "headers", "expectedStatuses"],
    ["body", "purpose"],
    path,
    context
  )
  const id = idAt(record.id, `${path}.id`, context)
  const dependsOn = arrayAt(record.dependsOn, `${path}.dependsOn`, context, SITE_HARNESS_LIMITS.dependenciesPerStep)
    .map((dependency, index) => idAt(dependency, `${path}.dependsOn[${index}]`, context))
  unique(dependsOn, `${path}.dependsOn`, context)
  const ancestors = new Set<string>()
  for (const dependency of dependsOn) {
    if (!earlierSteps.has(dependency)) {
      issue(context, `${path}.dependsOn`, `dependency ${JSON.stringify(dependency)} must name an earlier step`)
      continue
    }
    ancestors.add(dependency)
    for (const ancestor of ancestorsByStep.get(dependency) ?? []) ancestors.add(ancestor)
  }

  const methodValue = record.method
  if (typeof methodValue !== "string" || !HTTP_METHODS.has(methodValue as HarnessHttpMethod)) {
    issue(context, `${path}.method`, "must be GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS")
  }
  const method = HTTP_METHODS.has(methodValue as HarnessHttpMethod) ? methodValue as HarnessHttpMethod : "GET"
  const origin = originAt(record.origin, `${path}.origin`, context)
  if (!allowedOrigins.has(origin)) issue(context, `${path}.origin`, "must exactly match an artifact allowedOrigins entry")
  const references: ProducerReferences = { inputs, priorSteps: ancestors }
  const pathParameters = producerRecordAt(record.pathParameters, `${path}.pathParameters`, context, references, "id")
  const route = pathAt(record.path, pathParameters, `${path}.path`, context)
  const query = producerRecordAt(record.query, `${path}.query`, context, references, "query")
  const headers = producerRecordAt(record.headers, `${path}.headers`, context, references, "header")
  const body = Object.hasOwn(record, "body")
    ? producerAt(record.body, `${path}.body`, context, references)
    : undefined
  const purpose = record.purpose === undefined ? undefined : (
    record.purpose === "pixel" ? "pixel" : (() => {
      issue(context, `${path}.purpose`, "must be 'pixel'")
      return undefined
    })()
  )
  const expectedStatuses = arrayAt(
    record.expectedStatuses,
    `${path}.expectedStatuses`,
    context,
    SITE_HARNESS_LIMITS.expectedStatusesPerStep,
    1
  ).map((status, index) => {
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      issue(context, `${path}.expectedStatuses[${index}]`, "must be an integer HTTP status from 100 through 599")
      return 200
    }
    return status
  })
  unique(expectedStatuses.map(String), `${path}.expectedStatuses`, context)

  const step: HarnessStep = {
    id,
    dependsOn,
    method,
    origin,
    path: route,
    pathParameters,
    query,
    headers,
    ...(body === undefined ? {} : { body }),
    expectedStatuses,
    ...(purpose === undefined ? {} : { purpose })
  }
  return { step, ancestors }
}

const actionAt = (
  value: unknown,
  path: string,
  context: ValidationContext,
  allowedOrigins: ReadonlySet<string>
): HarnessAction => {
  const record = recordAt(value, path, context)
  exactFields(record, ["id", "inputs", "steps"], [], path, context)
  const id = idAt(record.id, `${path}.id`, context)
  const inputs = arrayAt(record.inputs, `${path}.inputs`, context, SITE_HARNESS_LIMITS.inputsPerAction)
    .map((input, index) => inputAt(input, `${path}.inputs[${index}]`, context))
  unique(inputs.map((input) => input.name), `${path}.inputs`, context)
  const inputNames = new Set(inputs.map((input) => input.name))
  const stepValues = arrayAt(record.steps, `${path}.steps`, context, SITE_HARNESS_LIMITS.stepsPerAction, 1)
  context.totalSteps += stepValues.length
  if (context.totalSteps > SITE_HARNESS_LIMITS.totalSteps) {
    issue(context, `${path}.steps`, `artifact exceeds ${SITE_HARNESS_LIMITS.totalSteps} total steps`)
  }
  const earlierSteps = new Set<string>()
  const ancestorsByStep = new Map<string, ReadonlySet<string>>()
  const steps: HarnessStep[] = []
  stepValues.forEach((stepValue, index) => {
    const parsed = stepAt(
      stepValue,
      `${path}.steps[${index}]`,
      context,
      inputNames,
      earlierSteps,
      ancestorsByStep,
      allowedOrigins
    )
    if (earlierSteps.has(parsed.step.id)) issue(context, `${path}.steps[${index}].id`, "duplicates an earlier step ID")
    earlierSteps.add(parsed.step.id)
    ancestorsByStep.set(parsed.step.id, parsed.ancestors)
    steps.push(parsed.step)
  })
  return { id, inputs, steps }
}

const deepFreeze = <T>(value: T, seen: Set<object> = new Set()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

const canonicalJson = (value: JsonValue | SiteHarnessArtifact): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  const record = value as Readonly<Record<string, JsonValue | undefined>>
  return `{${Object.keys(record).sort().map((key) => {
    const nested = record[key]
    if (nested === undefined) throw new Error(`canonical JSON contains undefined at ${JSON.stringify(key)}`)
    return `${JSON.stringify(key)}:${canonicalJson(nested)}`
  }).join(",")}}`
}

export const validateSiteHarnessArtifact = (value: unknown): SiteHarnessArtifact => {
  const context: ValidationContext = { issues: [], producerNodes: 0, totalSteps: 0 }
  const record = recordAt(value, "$", context)
  exactFields(
    record,
    ["schemaVersion", "executorAbi", "siteId", "version", "sourceCaptureDigest", "allowedOrigins", "actions"],
    [],
    "$",
    context
  )
  if (record.schemaVersion !== SITE_HARNESS_SCHEMA_VERSION) {
    issue(context, "$.schemaVersion", `must equal ${SITE_HARNESS_SCHEMA_VERSION}`)
  }
  if (record.executorAbi !== SITE_HARNESS_EXECUTOR_ABI) {
    issue(context, "$.executorAbi", `must equal ${JSON.stringify(SITE_HARNESS_EXECUTOR_ABI)}`)
  }
  const siteId = idAt(record.siteId, "$.siteId", context)
  const version = stringAt(record.version, "$.version", context, { max: 64, pattern: VERSION })
  const sourceCaptureDigest = digestAt(record.sourceCaptureDigest, "$.sourceCaptureDigest", context)
  const allowedOrigins = arrayAt(
    record.allowedOrigins,
    "$.allowedOrigins",
    context,
    SITE_HARNESS_LIMITS.allowedOrigins,
    1
  ).map((origin, index) => originAt(origin, `$.allowedOrigins[${index}]`, context))
  unique(allowedOrigins, "$.allowedOrigins", context)
  const allowedOriginSet = new Set(allowedOrigins)
  const actions = arrayAt(record.actions, "$.actions", context, SITE_HARNESS_LIMITS.actions, 1)
    .map((action, index) => actionAt(action, `$.actions[${index}]`, context, allowedOriginSet))
  unique(actions.map((action) => action.id), "$.actions", context)

  const artifact: SiteHarnessArtifact = {
    schemaVersion: SITE_HARNESS_SCHEMA_VERSION,
    executorAbi: SITE_HARNESS_EXECUTOR_ABI,
    siteId,
    version,
    sourceCaptureDigest,
    allowedOrigins,
    actions
  }
  const encodedBytes = new TextEncoder().encode(canonicalJson(artifact)).byteLength
  if (encodedBytes > SITE_HARNESS_LIMITS.artifactBytes) {
    issue(context, "$", `canonical artifact exceeds ${SITE_HARNESS_LIMITS.artifactBytes} bytes`)
  }
  if (context.issues.length > 0) throw new HarnessArtifactValidationError(context.issues)
  return deepFreeze(artifact)
}

export const createSiteHarnessCandidate = (input: SiteHarnessCandidateInput): SiteHarnessArtifact =>
  validateSiteHarnessArtifact({
    schemaVersion: SITE_HARNESS_SCHEMA_VERSION,
    executorAbi: SITE_HARNESS_EXECUTOR_ABI,
    ...input
  })

export const canonicalSiteHarnessArtifact = (value: unknown): string =>
  canonicalJson(validateSiteHarnessArtifact(value))

export const siteHarnessArtifactDigest = (value: unknown): Sha256Digest =>
  `sha256:${createHash("sha256").update(canonicalSiteHarnessArtifact(value)).digest("hex")}`

export interface ArtifactModuleReference {
  readonly moduleDigest: string
  /** wasm export name or js entry name. */
  readonly name: string
  readonly kind: "wasm" | "js"
  /** How many producers in the artifact call this digest/name pair. */
  readonly uses: number
}

type MutableModuleRef = { moduleDigest: string; name: string; kind: "wasm" | "js"; uses: number }

const moduleRefsIn = (
  producer: ValueProducer,
  found: Map<string, MutableModuleRef>
): void => {
  switch (producer.kind) {
    case "constant":
    case "input":
    case "clock":
    case "uuid":
    case "response_header":
    case "response_json":
      return
    case "object":
      for (const field of Object.values(producer.fields)) moduleRefsIn(field, found)
      return
    case "array":
      for (const item of producer.items) moduleRefsIn(item, found)
      return
    case "wasm":
    case "js": {
      const name = producer.kind === "wasm" ? producer.export : producer.entry
      const key = `${producer.moduleDigest}:${name}`
      const existing = found.get(key)
      if (existing === undefined) {
        found.set(key, { moduleDigest: producer.moduleDigest, name, kind: producer.kind, uses: 1 })
      } else {
        existing.uses += 1
      }
      for (const argument of producer.args) moduleRefsIn(argument, found)
      return
    }
  }
}

/**
 * Lists every wasm digest/export pair the artifact's producers require, in
 * stable order. The store must contain exactly these modules before an eval
 * may run with `--wasm-store`; the artifact digest already binds them all.
 */
export const collectModuleRefs = (artifact: unknown): ArtifactModuleReference[] => {
  const validated = validateSiteHarnessArtifact(artifact)
  const found = new Map<string, MutableModuleRef>()
  for (const step of validated.actions.flatMap((action) => action.steps)) {
    for (const producer of [
      ...Object.values(step.pathParameters),
      ...Object.values(step.query),
      ...Object.values(step.headers),
      ...(step.body === undefined ? [] : [step.body])
    ]) {
      moduleRefsIn(producer, found)
    }
  }
  return [...found.values()]
    .map(({ moduleDigest, name, kind, uses }) => ({ moduleDigest, name, kind, uses }))
    .sort((left, right) =>
      left.moduleDigest < right.moduleDigest ? -1 : left.moduleDigest > right.moduleDigest ? 1
        : left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}
