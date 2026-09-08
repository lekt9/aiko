import { createHash } from "node:crypto"

import type { NormalizedHarEntry, NormalizedHarTrace } from "./har"
import {
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact,
  type HarnessAction,
  type HarnessInputType,
  type HarnessStep,
  type SiteHarnessArtifact,
  type ValueProducer
} from "./harness-artifact"
import type {
  HarnessJsonValue,
  HarnessTransportClassification,
  HarnessTransportRequest,
  HarnessTransportResponse
} from "./harness-runtime"
import { executeHarnessAction } from "./harness-runtime"
import type { HarnessEvalCase, HarnessEvalCaseKind, ScriptedHarnessExchange } from "./harness-eval"

const REDACTED = "[REDACTED]"
const SITE_CONTROL = /(?:anti[-_]?bot|captcha|challenge|fingerprint|proof[-_]?of[-_]?work|sensor)/iu
const TELEMETRY = /(?:analytics|beacon|pixel|telemetry|tracking)/iu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const MAX_GENERATED_DEPTH = 12
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])

type MutableJson = null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson }

const jsonValue = (value: unknown): value is HarnessJsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  if (typeof value !== "object") return false
  return Object.entries(value).every(([key, child]) =>
    !FORBIDDEN_OBJECT_KEYS.has(key) && jsonValue(child))
}

const jsonBody = (entry: NormalizedHarEntry, side: "request" | "response"): HarnessJsonValue | undefined => {
  const body = entry[side].body
  if (body?.text === undefined || !body.mimeType.includes("json")) return undefined
  try {
    const parsed: unknown = JSON.parse(body.text)
    return jsonValue(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const hashBytes = (seed: string): Uint8Array => new Uint8Array(createHash("sha256").update(seed).digest())

const variantString = (example: string, seed: string, variant = 0): string => {
  const bytes = hashBytes(seed)
  const hex = Buffer.from(bytes).toString("hex")
  if (example.length === 0 || example === REDACTED) return `variant-${hex.slice(0, 10)}`
  if (UUID.test(example)) return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 31)}${variant % 10}`
  if (EMAIL.test(example)) return `variant-${variant}-${hex.slice(0, 10)}@example.invalid`
  if (ISO_DATE.test(example)) {
    const year = 2030 + (variant > 0 ? variant : bytes[0]! % 20)
    const month = 1 + (bytes[1]! % 12)
    const day = 1 + (bytes[2]! % 28)
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00.000Z`
  }
  try {
    const url = new URL(example)
    if (url.protocol === "http:" || url.protocol === "https:") return `https://example.invalid/variant/${variant}-${hex.slice(0, 12)}`
  } catch {}

  let byteIndex = 0
  let shapedIndex = 0
  const next = (): number => bytes[byteIndex++ % bytes.length]!
  const generated = [...example].map((character) => {
    if (!/[a-zA-Z0-9]/u.test(character)) return character
    const forced = variant > 0 && shapedIndex === 0
    shapedIndex += 1
    if (/[a-z]/u.test(character)) return String.fromCharCode(97 + (forced ? character.charCodeAt(0) - 97 + variant : next()) % 26)
    if (/[A-Z]/u.test(character)) return String.fromCharCode(65 + (forced ? character.charCodeAt(0) - 65 + variant : next()) % 26)
    return String((forced ? Number(character) + variant : next()) % 10)
  }).join("")
  if (generated !== example) return generated
  return `${generated}${hex[0]}`
}

/** Generates a deterministic new value while retaining only the example's broad JSON shape. */
export const generateVariantLike = (
  example: HarnessJsonValue,
  seed: string,
  depth = 0,
  variant = 0
): HarnessJsonValue => {
  if (depth > MAX_GENERATED_DEPTH) return null
  if (typeof example === "string") return variantString(example, seed, variant)
  if (typeof example === "number") {
    const delta = variant > 0 ? variant : 1 + (hashBytes(seed)[0]! % 17)
    return Number.isInteger(example) ? example + delta : Number((example + delta / 10).toFixed(6))
  }
  if (typeof example === "boolean") return variant > 0 ? variant % 2 === 0 ? example : !example : !example
  if (example === null) return null
  if (Array.isArray(example)) return example.map((item, index) => generateVariantLike(item, `${seed}[${index}]`, depth + 1, variant))
  return Object.fromEntries(Object.entries(example).map(([key, value]) =>
    [key, generateVariantLike(value, `${seed}.${key}`, depth + 1, variant)]))
}

const fallbackFor = (type: HarnessInputType, seed: string, variant: number): HarnessJsonValue => {
  if (type === "boolean") return variant % 2 === 0
  if (type === "integer") return 100 + variant
  if (type === "number") return 10 + variant / 10
  if (type === "json") return { variant: `${variant}-${Buffer.from(hashBytes(seed)).toString("hex").slice(0, 10)}` }
  return `variant-${variant}-${Buffer.from(hashBytes(seed)).toString("hex").slice(0, 10)}`
}

const sameJson = (left: HarnessJsonValue, right: HarnessJsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const collectInputExample = (
  producer: ValueProducer,
  observed: HarnessJsonValue | undefined,
  found: Map<string, HarnessJsonValue>
): void => {
  if (producer.kind === "input") {
    if (observed === undefined || observed === REDACTED) return
    const existing = found.get(producer.name)
    if (existing === undefined || sameJson(existing, observed)) found.set(producer.name, observed)
    else found.delete(producer.name)
    return
  }
  if (producer.kind === "object") {
    if (observed === null || Array.isArray(observed) || typeof observed !== "object") return
    const record = observed as Readonly<Record<string, HarnessJsonValue>>
    for (const [name, child] of Object.entries(producer.fields)) collectInputExample(child, record[name], found)
    return
  }
  if (producer.kind === "array") {
    if (!Array.isArray(observed)) return
    producer.items.forEach((child, index) => collectInputExample(child, observed[index], found))
    return
  }
  if (producer.kind === "wasm" || producer.kind === "js") {
    producer.args.forEach((child) => collectInputExample(child, undefined, found))
  }
}

const pathExamples = (step: HarnessStep, entry: NormalizedHarEntry): Readonly<Record<string, string>> => {
  const template = step.path.split("/")
  const observed = entry.request.path.split("/")
  const found: Record<string, string> = Object.create(null) as Record<string, string>
  template.forEach((segment, index) => {
    const match = /^\{([^{}]+)\}$/u.exec(segment)
    const value = observed[index]
    if (match?.[1] === undefined || value === undefined) return
    try { found[match[1]] = decodeURIComponent(value) } catch { found[match[1]] = value }
  })
  return found
}

const inputExamples = (
  action: HarnessAction,
  entries: ReadonlyMap<string, NormalizedHarEntry>
): ReadonlyMap<string, HarnessJsonValue> => {
  const found = new Map<string, HarnessJsonValue>()
  for (const step of action.steps) {
    const entry = entries.get(step.id)
    if (entry === undefined) continue
    const paths = pathExamples(step, entry)
    for (const [name, producer] of Object.entries(step.pathParameters)) collectInputExample(producer, paths[name], found)
    for (const [name, producer] of Object.entries(step.query)) {
      collectInputExample(producer, entry.request.query.find((field) => field.name === name)?.value, found)
    }
    for (const [name, producer] of Object.entries(step.headers)) {
      collectInputExample(producer, entry.request.headers.find((field) => field.name.toLowerCase() === name.toLowerCase())?.value, found)
    }
    collectInputExample(step.body ?? { kind: "constant", value: null }, jsonBody(entry, "request"), found)
  }
  return found
}

interface ResponseNeeds {
  readonly pointers: Set<string>
  readonly headers: Set<string>
}

const responseNeedsFor = (action: HarnessAction): ReadonlyMap<string, ResponseNeeds> => {
  const needs = new Map<string, ResponseNeeds>()
  const visit = (producer: ValueProducer): void => {
    if (producer.kind === "response_json" || producer.kind === "response_header") {
      const current = needs.get(producer.stepId) ?? { pointers: new Set<string>(), headers: new Set<string>() }
      if (producer.kind === "response_json") current.pointers.add(producer.pointer)
      else current.headers.add(producer.name.toLowerCase())
      needs.set(producer.stepId, current)
      return
    }
    if (producer.kind === "object") Object.values(producer.fields).forEach(visit)
    else if (producer.kind === "array") producer.items.forEach(visit)
    else if (producer.kind === "wasm" || producer.kind === "js") producer.args.forEach(visit)
  }
  for (const step of action.steps) {
    Object.values(step.pathParameters).forEach(visit)
    Object.values(step.query).forEach(visit)
    Object.values(step.headers).forEach(visit)
    if (step.body !== undefined) visit(step.body)
  }
  return needs
}

const pointerSegments = (pointer: string): ReadonlyArray<string> | undefined => {
  if (pointer === "") return []
  if (!pointer.startsWith("/")) return undefined
  const segments = pointer.slice(1).split("/").map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"))
  return segments.some((segment) => FORBIDDEN_OBJECT_KEYS.has(segment)) ? undefined : segments
}

const valueAtPointer = (value: HarnessJsonValue, pointer: string): HarnessJsonValue | undefined => {
  const segments = pointerSegments(pointer)
  if (segments === undefined) return undefined
  let current: HarnessJsonValue | undefined = value
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Readonly<Record<string, HarnessJsonValue>>)[segment]
    if (current === undefined) return undefined
  }
  return current
}

const assignPointer = (root: MutableJson, segments: ReadonlyArray<string>, value: MutableJson): MutableJson => {
  if (segments.length === 0) return value
  let current = root
  segments.forEach((segment, index) => {
    if (current === null || typeof current !== "object") return
    const last = index === segments.length - 1
    const key: string | number = Array.isArray(current) ? Number(segment) : segment
    if (last) {
      const record = current as { [key: string]: MutableJson }
      record[key] = value
      return
    }
    const nextSegment = segments[index + 1]!
    const next = /^\d+$/u.test(nextSegment) ? [] : {}
    const record = current as { [key: string]: MutableJson }
    if (record[key] === undefined || record[key] === null || typeof record[key] !== "object") record[key] = next
    current = record[key]!
  })
  return root
}

const minimalResponseBody = (
  entry: NormalizedHarEntry,
  pointers: ReadonlySet<string>,
  seed: string,
  variant: number
): HarnessJsonValue | undefined => {
  if (pointers.size === 0) return undefined
  const source = jsonBody(entry, "response")
  if (source === undefined) return undefined
  let result: MutableJson = {}
  for (const pointer of [...pointers].sort()) {
    const segments = pointerSegments(pointer)
    const example = valueAtPointer(source, pointer)
    if (segments === undefined || example === undefined || example === REDACTED) continue
    const generated = generateVariantLike(example, `${seed}:${pointer}`, 0, variant) as MutableJson
    result = assignPointer(result, segments, generated)
  }
  return result
}

const classificationFor = (step: HarnessStep, entry: NormalizedHarEntry): HarnessTransportClassification => {
  const structure = [step.path, ...Object.keys(step.query), ...Object.keys(step.headers)].join(" ")
  if (SITE_CONTROL.test(structure)) return "site_control"
  if (step.purpose === "pixel" || TELEMETRY.test(structure)) return "telemetry_dependency"
  if (entry.response.status === 401 || entry.response.status === 403 || entry.response.status === 0) return "browser_session_required"
  return "application"
}

const responseFor = (
  step: HarnessStep,
  entry: NormalizedHarEntry,
  needs: ResponseNeeds | undefined,
  seed: string,
  variant: number
): HarnessTransportResponse & { readonly classification: HarnessTransportClassification } => {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of needs?.headers ?? []) {
    const example = entry.response.headers.find((header) => header.name.toLowerCase() === name)?.value
    if (example !== undefined && example !== REDACTED) headers[name] = variantString(example, `${seed}:header:${name}`, variant)
  }
  const body = minimalResponseBody(entry, needs?.pointers ?? new Set(), `${seed}:body`, variant)
  return {
    status: entry.response.status === 0 ? 503 : entry.response.status,
    headers,
    ...(body === undefined ? {} : { body }),
    classification: classificationFor(step, entry)
  }
}

const generatedClock = (variant: number, call: number): string =>
  new Date(Date.UTC(2030 + variant, 0, 1, 12) + call * 60_000).toISOString()

const generatedUuid = (variant: number, call: number): string =>
  `00000000-0000-4000-8${String(variant).padStart(3, "0")}-${String(call + 1).padStart(12, "0")}`

const caseFor = async (
  artifact: SiteHarnessArtifact,
  action: HarnessAction,
  entries: ReadonlyMap<string, NormalizedHarEntry>,
  examples: ReadonlyMap<string, HarnessJsonValue>,
  needs: ReadonlyMap<string, ResponseNeeds>,
  kind: HarnessEvalCaseKind,
  variant: number
): Promise<HarnessEvalCase> => {
  const seed = `${siteHarnessArtifactDigest(artifact)}:${action.id}:${kind}:${variant}`
  const input = Object.fromEntries(action.inputs.map((definition) => {
    const example = examples.get(definition.name)
    let generated: HarnessJsonValue
    if (example === undefined) generated = fallbackFor(definition.type, `${seed}:input:${definition.name}`, variant)
    else generated = generateVariantLike(example, `${seed}:input:${definition.name}`, 0, variant)
    return [definition.name, generated]
  }))
  const exchanges: ScriptedHarnessExchange[] = []
  const clockValues: Array<string> = []
  const uuidValues: Array<string> = []
  let clockCall = 0
  let uuidCall = 0
  await executeHarnessAction({
    artifact,
    actionId: action.id,
    input,
    adapters: {
      transport: {
        send: (request: HarnessTransportRequest) => {
          const step = action.steps.find((candidate) => candidate.id === request.stepId)
          const entry = entries.get(request.stepId)
          if (step === undefined || entry === undefined) throw new Error("Generated rehearsal cannot map a harness step to its HAR example")
          const response = responseFor(step, entry, needs.get(step.id), `${seed}:response:${step.id}`, variant)
          exchanges.push({
            request: {
              stepId: request.stepId,
              method: request.method,
              url: request.url,
              headers: { ...request.headers },
              ...(request.body === undefined ? {} : { body: request.body })
            },
            response
          })
          return response
        }
      },
      clock: {
        now: () => {
          const value = generatedClock(variant, clockCall++)
          clockValues.push(value)
          return value
        }
      },
      uuid: {
        next: () => {
          const value = generatedUuid(variant, uuidCall++)
          uuidValues.push(value)
          return value
        }
      }
    }
  })
  return {
    id: `generated-${createHash("sha256").update(action.id).digest("hex").slice(0, 10)}-${kind.replace("_", "-")}`,
    kind,
    actionId: action.id,
    input,
    exchanges,
    ...(clockValues.length === 0 ? {} : { clockValues }),
    ...(uuidValues.length === 0 ? {} : { uuidValues }),
    expected: { status: "completed", code: "completed", requests: action.steps.length }
  }
}

/**
 * Builds deterministic, diagnostic-only cases from sanitized in-memory HAR examples.
 * The returned concrete cases must never be logged, returned to actors, or persisted as promotion evidence.
 */
export const generateHarDevelopmentCases = async (
  trace: NormalizedHarTrace,
  artifactInput: SiteHarnessArtifact | unknown
): Promise<ReadonlyArray<HarnessEvalCase>> => {
  if (trace.errors.length > 0) throw new Error("Cannot generate rehearsal cases from an invalid HAR")
  const artifact = validateSiteHarnessArtifact(artifactInput)
  const entries = new Map(trace.entries.map((entry) => [entry.id, entry] as const))
  if (artifact.actions.some((action) => action.steps.some((step) => {
    const entry = entries.get(step.id)
    return entry === undefined || entry.request.origin !== step.origin || entry.request.method !== step.method
  }))) {
    throw new Error("Generated rehearsal requires artifact steps derived from this exact HAR")
  }
  const cases: HarnessEvalCase[] = []
  for (const action of artifact.actions) {
    const examples = inputExamples(action, entries)
    const needs = responseNeedsFor(action)
    cases.push(await caseFor(artifact, action, entries, examples, needs, "baseline", 1))
    cases.push(await caseFor(artifact, action, entries, examples, needs, "mutation", 2))
    cases.push(await caseFor(artifact, action, entries, examples, needs, "held_out", 3))
  }
  return cases
}
