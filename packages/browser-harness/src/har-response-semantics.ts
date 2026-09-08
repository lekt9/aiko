import { compareText, type NormalizedHarTrace } from "./har"

export const HAR_RESPONSE_SEMANTICS_REVISION = "har-response-semantics/1" as const
export const MAX_RESPONSE_SEMANTIC_FIELDS = 24
export const MAX_RESPONSE_SEMANTIC_CONCEPTS = 12
const MAX_SEMANTIC_NODES = 2_048
const MAX_SEMANTIC_DEPTH = 8
const MAX_SEMANTIC_PATH_CHARS = 256
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u
const BLOCKED_TERM = /(?:api[-_]?key|authorization|bearer|cookie|credential|csrf|password|private[-_]?key|secret|session|token|xsrf)/iu

export type ResponseSemanticShape =
  | "collection"
  | "record_with_collection"
  | "record"
  | "scalar"
  | "empty"
  | "unavailable"
export type ResponseSemanticValueType = "array" | "boolean" | "null" | "number" | "object" | "string"
export type ResponseSemanticRole =
  | "classification"
  | "content_item"
  | "count"
  | "currency"
  | "descriptive_text"
  | "display_label"
  | "geography"
  | "identifier"
  | "media"
  | "monetary_value"
  | "pagination"
  | "rating"
  | "status"
  | "timestamp"
  | "user_profile"

export interface ResponseSemanticField {
  readonly path: string
  readonly types: ReadonlyArray<ResponseSemanticValueType>
  readonly roles: ReadonlyArray<ResponseSemanticRole>
  readonly occurrences: number
}

/** Value-free shape evidence derived in trusted memory from one captured response. */
export interface ResponseSemanticEvidence {
  readonly revision: typeof HAR_RESPONSE_SEMANTICS_REVISION
  readonly source: "parsed_json" | "truncated_json_keys" | "unavailable"
  readonly shape: ResponseSemanticShape
  readonly concepts: ReadonlyArray<string>
  readonly fields: ReadonlyArray<ResponseSemanticField>
  readonly truncated: boolean
}

interface MutableField {
  readonly path: string
  readonly types: Set<ResponseSemanticValueType>
  readonly roles: Set<ResponseSemanticRole>
  occurrences: number
}

const valueTypeOf = (value: unknown): ResponseSemanticValueType =>
  value === null ? "null"
    : Array.isArray(value) ? "array"
      : typeof value === "boolean" ? "boolean"
        : typeof value === "number" ? "number"
          : typeof value === "string" ? "string"
            : "object"

const fieldTokens = (field: string): ReadonlyArray<string> => field
  .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
  .split(/[^A-Za-z0-9]+/u)
  .map((token) => token.toLowerCase())
  .filter((token) => (token.length >= 3 || token === "id") && token.length <= 32)

const GENERIC_CONCEPTS = new Set([
  "active", "api", "attributes", "available", "availability", "avg", "bid", "body", "code",
  "collection", "component", "count", "cover", "created", "cursor", "data", "date", "description",
  "distance", "edge", "edges", "enabled", "entry", "entries", "favorite", "field", "fields", "filter",
  "currency", "day", "has", "hot", "id", "image", "info", "item", "items", "key", "label", "lat",
  "list", "lng", "max", "media", "message", "meta", "metadata", "min", "mode", "more", "name", "new",
  "next", "node", "nodes", "object", "objects", "option", "price", "range",
  "page", "pagination", "payload", "photo", "previous", "query", "record", "records", "request", "response",
  "result", "results", "signed", "state", "status", "summary", "text", "time", "timestamp", "title", "total",
  "type", "updated", "url", "uuid", "value", "values"
])

const KNOWN_VALUE_CONCEPTS = new Set([
  "area", "booking", "category", "city", "country", "court", "cuisine", "district", "event", "hotel",
  "location", "order", "post", "product", "profile", "region", "reservation", "restaurant", "room", "slot",
  "tweet", "user", "venue"
])

// Body keys are not part of the normal durable HAR facts. Admit only reviewed
// vocabulary here so a custom key that embeds a person or account name cannot
// become durable author input merely because it is syntactically valid JSON.
const SAFE_RESPONSE_FIELD_TOKENS = new Set([
  ...GENERIC_CONCEPTS,
  ...KNOWN_VALUE_CONCEPTS,
  "address", "amount", "author", "average", "avatar", "boolean", "category", "closed", "content",
  "court", "cuisine", "deleted", "discount", "display", "district", "expires", "expiry", "fee", "full",
  "genre", "icon", "identifier", "kind", "language", "latitude", "logo", "longitude", "member", "number",
  "offset", "open", "owner", "quantity", "rating", "rank", "score", "size", "sport", "star", "stars",
  "subtotal", "subtitle", "tag", "tags", "thumbnail", "typename", "uri"
])

const rolesOf = (field: string, valueType: ResponseSemanticValueType, value?: unknown): ReadonlyArray<ResponseSemanticRole> => {
  const tokens = new Set(fieldTokens(field))
  const has = (...names: ReadonlyArray<string>): boolean => names.some((name) => tokens.has(name))
  const roles = new Set<ResponseSemanticRole>()
  if (has("id", "key", "uuid") || /(?:_id|Id)$/u.test(field)) roles.add("identifier")
  if (has("name", "title", "label", "display")) roles.add("display_label")
  if (has("description", "summary", "subtitle", "content", "text", "message")) roles.add("descriptive_text")
  if (has("status", "state", "available", "availability", "enabled", "active", "open", "closed")) roles.add("status")
  if (has("created", "updated", "deleted", "date", "time", "timestamp", "expires", "expiry")) roles.add("timestamp")
  if (has("price", "amount", "cost", "fee", "subtotal")) roles.add("monetary_value")
  if (has("currency")) roles.add("currency")
  if (has("latitude", "longitude", "lat", "lng", "address", "city", "country", "region", "location", "district", "area")) roles.add("geography")
  if (has("category", "categories", "type", "tag", "tags", "cuisine", "kind", "genre")) roles.add("classification")
  if (has("cursor", "offset", "limit", "page", "next", "previous") || (has("has") && has("more"))) roles.add("pagination")
  if (has("image", "avatar", "icon", "logo", "photo", "thumbnail", "media", "url", "uri")) roles.add("media")
  if (has("count", "quantity", "size") || (has("total") && !roles.has("monetary_value"))) roles.add("count")
  if (has("rating", "score", "rank", "stars")) roles.add("rating")
  if (has("user", "account", "author", "owner", "profile", "member")) roles.add("user_profile")
  if (has("tweet", "post", "article", "comment", "message", "story", "restaurant", "hotel", "venue", "booking", "reservation", "product", "order")) roles.add("content_item")
  if (valueType === "string" && typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u.test(value) || /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/u.test(value)) {
      roles.add("timestamp")
    }
    if (/^https?:\/\//iu.test(value) && !BLOCKED_TERM.test(field)) roles.add("media")
  }
  return [...roles].sort(compareText)
}

const singularConcept = (token: string): string =>
  token.length > 5 && token.endsWith("ies") ? `${token.slice(0, -3)}y`
    : token.length > 4 && token.endsWith("s") && !/(?:ss|status|us)$/u.test(token) ? token.slice(0, -1)
      : token

const conceptScoresOf = (
  fields: ReadonlyArray<MutableField>,
  valueConcepts: ReadonlyMap<string, number>
): ReadonlyMap<string, number> => {
  const scores = new Map<string, number>(valueConcepts)
  for (const field of fields) {
    const leaf = field.path.split(".").at(-1)?.replace(/\[\]$/u, "") ?? ""
    for (const token of fieldTokens(leaf)) {
      const singular = singularConcept(token)
      if (GENERIC_CONCEPTS.has(singular) || BLOCKED_TERM.test(singular)) continue
      scores.set(singular, (scores.get(singular) ?? 0) + Math.min(field.occurrences, 8))
    }
  }
  if (scores.has("cuisine")) {
    scores.set("restaurant", Math.max(scores.get("restaurant") ?? 0, (scores.get("cuisine") ?? 0) + 8))
  }
  return scores
}

const finalize = (
  source: ResponseSemanticEvidence["source"],
  shape: ResponseSemanticShape,
  fieldsByPath: ReadonlyMap<string, MutableField>,
  truncated: boolean,
  valueConcepts: ReadonlyMap<string, number> = new Map()
): ResponseSemanticEvidence => {
  const fields = [...fieldsByPath.values()]
    .sort((left, right) => right.occurrences - left.occurrences || compareText(left.path, right.path))
    .slice(0, MAX_RESPONSE_SEMANTIC_FIELDS)
  const concepts = [...conceptScoresOf(fields, valueConcepts)]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, MAX_RESPONSE_SEMANTIC_CONCEPTS)
    .map(([concept]) => concept)
  return Object.freeze({
    revision: HAR_RESPONSE_SEMANTICS_REVISION,
    source,
    shape,
    concepts: Object.freeze(concepts),
    fields: Object.freeze(fields.map((field) => Object.freeze({
      path: field.path,
      types: Object.freeze([...field.types].sort(compareText)),
      roles: Object.freeze([...field.roles].sort(compareText)),
      occurrences: field.occurrences
    }))),
    truncated
  })
}

const pathSegment = (value: string): string | undefined => {
  const tokens = fieldTokens(value)
  return SAFE_FIELD.test(value) && !BLOCKED_TERM.test(value) && tokens.length > 0 &&
    tokens.every((token) => SAFE_RESPONSE_FIELD_TOKENS.has(singularConcept(token)))
    ? value
    : undefined
}

const parsedSemantics = (value: unknown, truncated: boolean): ResponseSemanticEvidence => {
  const fields = new Map<string, MutableField>()
  const valueConcepts = new Map<string, number>()
  let nodes = 0
  let foundCollection = Array.isArray(value)
  const visit = (current: unknown, path: string, fieldName: string, depth: number): void => {
    if (nodes++ >= MAX_SEMANTIC_NODES || depth > MAX_SEMANTIC_DEPTH || path.length > MAX_SEMANTIC_PATH_CHARS) return
    const type = valueTypeOf(current)
    if (path !== "$") {
      const field = fields.get(path) ?? { path, types: new Set(), roles: new Set(), occurrences: 0 }
      field.types.add(type)
      const roles = rolesOf(fieldName, type, current)
      roles.forEach((role) => field.roles.add(role))
      if (typeof current === "string" && (roles.includes("display_label") || roles.includes("classification") || path.includes(".options[]"))) {
        for (const token of fieldTokens(current)) {
          const concept = singularConcept(token)
          if (KNOWN_VALUE_CONCEPTS.has(concept)) valueConcepts.set(concept, (valueConcepts.get(concept) ?? 0) + 12)
        }
      }
      field.occurrences++
      fields.set(path, field)
    }
    if (Array.isArray(current)) {
      if (current.length > 0) foundCollection = true
      current.slice(0, 32).forEach((item) => visit(item, `${path}[]`, fieldName, depth + 1))
      return
    }
    if (typeof current !== "object" || current === null) return
    Object.entries(current).slice(0, 64).forEach(([name, child]) => {
      const segment = pathSegment(name)
      if (segment !== undefined) visit(child, `${path}.${segment}`, segment, depth + 1)
    })
  }
  visit(value, "$", "root", 0)
  const shape: ResponseSemanticShape = value === null || value === ""
    ? "empty"
    : Array.isArray(value) ? "collection"
      : typeof value === "object" ? foundCollection ? "record_with_collection" : "record"
        : "scalar"
  return finalize("parsed_json", shape, fields, truncated, valueConcepts)
}

const truncatedSemantics = (text: string): ResponseSemanticEvidence => {
  const fields = new Map<string, MutableField>()
  const pattern = /"((?:\\.|[^"\\]){1,80})"\s*:\s*(["{\[tfn\-0-9])/gu
  let match: RegExpExecArray | null
  let count = 0
  let foundCollection = false
  while ((match = pattern.exec(text)) !== null && count++ < MAX_SEMANTIC_NODES) {
    let rawName: unknown
    try {
      rawName = JSON.parse(`"${match[1]}"`) as unknown
    } catch {
      continue
    }
    if (typeof rawName !== "string") continue
    const name = pathSegment(rawName)
    if (name === undefined) continue
    const marker = match[2]!
    const type: ResponseSemanticValueType = marker === "[" ? "array"
      : marker === "{" ? "object"
        : marker === "\"" ? "string"
          : marker === "t" || marker === "f" ? "boolean"
            : marker === "n" ? "null" : "number"
    if (type === "array") foundCollection = true
    const path = `$.${name}`
    const field = fields.get(path) ?? { path, types: new Set(), roles: new Set(), occurrences: 0 }
    field.types.add(type)
    rolesOf(name, type).forEach((role) => field.roles.add(role))
    field.occurrences++
    fields.set(path, field)
  }
  return finalize("truncated_json_keys", foundCollection ? "record_with_collection" : "record", fields, true)
}

export const responseSemanticEvidenceOf = (input: {
  readonly mimeType: string
  readonly text?: string
  readonly truncated: boolean
}): ResponseSemanticEvidence => {
  if (!input.mimeType.includes("json") || input.text === undefined || input.text.length === 0) {
    return finalize("unavailable", "unavailable", new Map(), input.truncated)
  }
  try {
    return parsedSemantics(JSON.parse(input.text) as unknown, input.truncated)
  } catch {
    return truncatedSemantics(input.text)
  }
}

export const responseSemanticsByRequest = (
  trace: NormalizedHarTrace,
  requestIds: ReadonlySet<string>
): ReadonlyMap<string, ResponseSemanticEvidence> => new Map(trace.entries.flatMap((entry) => {
  if (!requestIds.has(entry.id)) return []
  return [[entry.id, responseSemanticEvidenceOf({
    mimeType: entry.response.mimeType,
    ...(entry.response.body?.text === undefined ? {} : { text: entry.response.body.text }),
    truncated: entry.response.body?.truncated ?? false
  })] as const]
}))
