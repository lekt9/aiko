import { Effect } from "effect"
import { toolList, type AgentComponent, type NativeTool } from "tardie"
import type { Event } from "tardie/core/log/event"

import {
  HARNESS_AUTHOR_ABI,
  MAX_AUTHOR_DEPENDENCIES,
  MAX_AUTHOR_EVIDENCE_CHARS,
  MAX_AUTHOR_FINDINGS,
  MAX_AUTHOR_REQUESTS,
  MAX_AUTHOR_RESPONSE_SEMANTIC_CONCEPTS,
  MAX_AUTHOR_RESPONSE_SEMANTIC_FIELDS,
  type HarnessAuthorBrief,
  type HarnessAuthorDependencyEvidence,
  type HarnessAuthorFindingEvidence,
  type HarnessAuthorRequestEvidence
} from "./harness-author"
import { canonicalStringify, compareText } from "./har"
import { HAR_RESPONSE_SEMANTICS_REVISION, type ResponseSemanticEvidence } from "./har-response-semantics"

const MAX_SEARCH_RESULTS = 8
const MAX_NEIGHBORS = 8
const MAX_FINDING_RESULTS = 8
const MAX_DETAIL_FIELDS = 16
const MAX_QUERY_TEXT = 64

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
const SEMANTIC_TYPES = new Set(["array", "boolean", "null", "number", "object", "string"])
const SEMANTIC_ROLES = new Set([
  "classification", "content_item", "count", "currency", "descriptive_text", "display_label",
  "geography", "identifier", "media", "monetary_value", "pagination", "rating", "status",
  "timestamp", "user_profile"
])
const SAFE_CONCEPT = /^[a-z][a-z0-9-]{1,31}$/u
const SAFE_SEMANTIC_PATH = /^\$(?:\[\]|\.[A-Za-z_][A-Za-z0-9_.-]{0,63})*(?:\[\])?$/u

const isResponseSemantics = (value: unknown): value is ResponseSemanticEvidence => {
  if (!isRecord(value) || value.revision !== HAR_RESPONSE_SEMANTICS_REVISION ||
    !["parsed_json", "truncated_json_keys", "unavailable"].includes(String(value.source)) ||
    !["collection", "record_with_collection", "record", "scalar", "empty", "unavailable"].includes(String(value.shape)) ||
    !strings(value.concepts) || value.concepts.length > MAX_AUTHOR_RESPONSE_SEMANTIC_CONCEPTS ||
    !Array.isArray(value.fields) || value.fields.length > MAX_AUTHOR_RESPONSE_SEMANTIC_FIELDS ||
    typeof value.truncated !== "boolean") return false
  return value.concepts.every((concept) => SAFE_CONCEPT.test(concept)) && value.fields.every((field) =>
    isRecord(field) && typeof field.path === "string" && field.path.length <= 256 && SAFE_SEMANTIC_PATH.test(field.path) &&
    strings(field.types) && field.types.length <= 6 && field.types.every((type) => SEMANTIC_TYPES.has(type)) &&
    strings(field.roles) && field.roles.length <= 16 && field.roles.every((role) => SEMANTIC_ROLES.has(role)) &&
    Number.isSafeInteger(field.occurrences) && Number(field.occurrences) > 0)
}

const isRequest = (value: unknown): value is HarnessAuthorRequestEvidence => {
  if (!isRecord(value)) return false
  return typeof value.id === "string" && typeof value.index === "number" &&
    typeof value.method === "string" && typeof value.resourceType === "string" &&
    typeof value.path === "string" && strings(value.queryFields) && strings(value.headerFields) &&
    strings(value.cookieNames) && typeof value.requestMimeType === "string" &&
    typeof value.responseStatus === "number" && typeof value.responseMimeType === "string" &&
    isResponseSemantics(value.responseSemantics) && typeof value.readInterfaceEligible === "boolean"
}

const isDependency = (value: unknown): value is HarnessAuthorDependencyEvidence => {
  if (!isRecord(value)) return false
  return typeof value.from === "string" && typeof value.to === "string" &&
    typeof value.reason === "string" && typeof value.evidence === "string" &&
    typeof value.confidence === "number"
}

const isFinding = (value: unknown): value is HarnessAuthorFindingEvidence => {
  if (!isRecord(value)) return false
  return typeof value.actionId === "string" && typeof value.stepId === "string" &&
    typeof value.location === "string" && typeof value.code === "string"
}

const briefFromLog = (log: ReadonlyArray<Event>): HarnessAuthorBrief | undefined => {
  const input = [...log].reverse().find((event) => event.type === "MessageReceived") as
    | (Event & { readonly input?: unknown })
    | undefined
  const value = input?.input
  if (!isRecord(value) || value.proposalAbi !== HARNESS_AUTHOR_ABI) return undefined
  if (!Array.isArray(value.requests) || value.requests.length > MAX_AUTHOR_REQUESTS || !value.requests.every(isRequest)) return undefined
  if (!Array.isArray(value.dependencies) || value.dependencies.length > MAX_AUTHOR_DEPENDENCIES || !value.dependencies.every(isDependency)) return undefined
  if (!Array.isArray(value.findings) || value.findings.length > MAX_AUTHOR_FINDINGS || !value.findings.every(isFinding)) return undefined
  if (!Array.isArray(value.existingInterfaces)) return undefined
  try {
    if (canonicalStringify(value).length > MAX_AUTHOR_EVIDENCE_CHARS) return undefined
  } catch {
    return undefined
  }
  return value as unknown as HarnessAuthorBrief
}

const positiveInteger = (value: unknown, fallback: number, maximum: number): number =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback

const nonNegativeInteger = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

const clipped = (value: string, maximum: number): string => value.slice(0, maximum)

const responseSemanticsSummary = (request: HarnessAuthorRequestEvidence, maximumFields: number) => ({
  source: request.responseSemantics.source,
  shape: request.responseSemantics.shape,
  concepts: request.responseSemantics.concepts,
  fields: request.responseSemantics.fields.slice(0, maximumFields),
  truncated: request.responseSemantics.truncated
})

const requestSummary = (request: HarnessAuthorRequestEvidence) => ({
  id: request.id,
  index: request.index,
  method: request.method,
  resourceType: clipped(request.resourceType, 48),
  path: clipped(request.path, 200),
  queryFields: request.queryFields.slice(0, 4).map((field) => clipped(field, 48)),
  requestMimeType: clipped(request.requestMimeType, 96),
  responseStatus: request.responseStatus,
  responseMimeType: clipped(request.responseMimeType, 96),
  responseSemantics: responseSemanticsSummary(request, 3),
  readInterfaceEligible: request.readInterfaceEligible
})

const endpointSummary = (request: HarnessAuthorRequestEvidence) => ({
  id: request.id,
  index: request.index,
  method: request.method,
  resourceType: clipped(request.resourceType, 48),
  responseMimeType: clipped(request.responseMimeType, 96),
  responseSemantics: {
    shape: request.responseSemantics.shape,
    concepts: request.responseSemantics.concepts.slice(0, 4)
  },
  readInterfaceEligible: request.readInterfaceEligible
})

export const searchHarnessAuthorGraph = (
  brief: HarnessAuthorBrief,
  input: unknown
): Readonly<Record<string, unknown>> => {
  const args = isRecord(input) ? input : {}
  const method = typeof args.method === "string" ? args.method.toUpperCase() : undefined
  const mimeType = typeof args.responseMimeType === "string" ? args.responseMimeType.toLowerCase().slice(0, MAX_QUERY_TEXT) : undefined
  const resourceType = typeof args.resourceType === "string" ? args.resourceType.toLowerCase().slice(0, MAX_QUERY_TEXT) : undefined
  const text = typeof args.text === "string" ? args.text.trim().toLowerCase().slice(0, MAX_QUERY_TEXT) : undefined
  const readInterfaceEligible = typeof args.readInterfaceEligible === "boolean" ? args.readInterfaceEligible : undefined
  const cursor = nonNegativeInteger(args.cursor)
  const limit = positiveInteger(args.limit, 6, MAX_SEARCH_RESULTS)
  const matches = brief.requests.filter((request) => {
    if (method !== undefined && request.method !== method) return false
    if (mimeType !== undefined && !request.responseMimeType.toLowerCase().includes(mimeType)) return false
    if (resourceType !== undefined && request.resourceType.toLowerCase() !== resourceType) return false
    if (readInterfaceEligible !== undefined && request.readInterfaceEligible !== readInterfaceEligible) return false
    if (text === undefined || text.length === 0) return true
    const haystack = [
      request.id,
      request.path,
      request.requestMimeType,
      request.responseMimeType,
      ...request.queryFields,
      ...request.headerFields,
      ...request.cookieNames,
      ...request.responseSemantics.concepts,
      ...request.responseSemantics.fields.flatMap((field) => [field.path, ...field.roles])
    ].join("\n").toLowerCase()
    return haystack.includes(text)
  }).sort((left, right) => left.index - right.index || compareText(left.id, right.id))
  const items = matches.slice(cursor, cursor + limit).map(requestSummary)
  const next = cursor + items.length
  return {
    items,
    matched: matches.length,
    ...(next < matches.length ? { nextCursor: next } : {})
  }
}

export const inspectHarnessAuthorRequest = (
  brief: HarnessAuthorBrief,
  input: unknown
): Readonly<Record<string, unknown>> => {
  const args = isRecord(input) ? input : {}
  const request = typeof args.requestId === "string"
    ? brief.requests.find((item) => item.id === args.requestId)
    : undefined
  if (request === undefined) return { error: "request_not_found" }
  return {
    ...requestSummary(request),
    queryFields: request.queryFields.slice(0, MAX_DETAIL_FIELDS).map((field) => clipped(field, 64)),
    headerFields: request.headerFields.slice(0, MAX_DETAIL_FIELDS).map((field) => clipped(field, 64)),
    cookieNames: request.cookieNames.slice(0, MAX_DETAIL_FIELDS).map((field) => clipped(field, 64)),
    responseSemantics: responseSemanticsSummary(request, MAX_AUTHOR_RESPONSE_SEMANTIC_FIELDS),
    omittedFields:
      Math.max(0, request.queryFields.length - MAX_DETAIL_FIELDS) +
      Math.max(0, request.headerFields.length - MAX_DETAIL_FIELDS) +
      Math.max(0, request.cookieNames.length - MAX_DETAIL_FIELDS)
  }
}

export const navigateHarnessAuthorGraph = (
  brief: HarnessAuthorBrief,
  input: unknown
): Readonly<Record<string, unknown>> => {
  const args = isRecord(input) ? input : {}
  const requestId = typeof args.requestId === "string" ? args.requestId : ""
  if (!brief.requests.some((request) => request.id === requestId)) return { error: "request_not_found" }
  const direction = args.direction === "outgoing" || args.direction === "both" ? args.direction : "incoming"
  const reason = typeof args.reason === "string" ? args.reason : undefined
  const limit = positiveInteger(args.limit, 8, MAX_NEIGHBORS)
  const matches = brief.dependencies.filter((dependency) => {
    const connected = direction === "incoming"
      ? dependency.to === requestId
      : direction === "outgoing"
      ? dependency.from === requestId
      : dependency.from === requestId || dependency.to === requestId
    return connected && (reason === undefined || dependency.reason === reason)
  }).sort((left, right) => compareText(
    `${left.from}\u0000${left.to}\u0000${left.reason}\u0000${left.evidence}`,
    `${right.from}\u0000${right.to}\u0000${right.reason}\u0000${right.evidence}`
  ))
  const requests = new Map(brief.requests.map((request) => [request.id, request]))
  return {
    edges: matches.slice(0, limit).map((dependency) => ({
      from: dependency.from,
      to: dependency.to,
      reason: clipped(dependency.reason, 64),
      evidence: clipped(dependency.evidence, 384),
      confidence: dependency.confidence,
      fromRequest: requests.get(dependency.from) === undefined ? undefined : endpointSummary(requests.get(dependency.from)!),
      toRequest: requests.get(dependency.to) === undefined ? undefined : endpointSummary(requests.get(dependency.to)!)
    })),
    matched: matches.length,
    omitted: Math.max(0, matches.length - limit)
  }
}

export const searchHarnessAuthorFindings = (
  brief: HarnessAuthorBrief,
  input: unknown
): Readonly<Record<string, unknown>> => {
  const args = isRecord(input) ? input : {}
  const actionId = typeof args.actionId === "string" ? args.actionId : undefined
  const code = typeof args.code === "string" ? args.code : undefined
  const cursor = nonNegativeInteger(args.cursor)
  const limit = positiveInteger(args.limit, 8, MAX_FINDING_RESULTS)
  const matches = brief.findings.filter((finding) =>
    (actionId === undefined || finding.actionId === actionId) &&
    (code === undefined || finding.code === code)
  )
  const items = matches.slice(cursor, cursor + limit)
  const next = cursor + items.length
  return {
    items,
    matched: matches.length,
    ...(next < matches.length ? { nextCursor: next } : {})
  }
}

const toolsFor = (brief: HarnessAuthorBrief | undefined): ReadonlyArray<NativeTool> => {
  const run = (query: (evidence: HarnessAuthorBrief, input: unknown) => Readonly<Record<string, unknown>>) =>
    (input: unknown) => Effect.succeed(brief === undefined ? { error: "author_evidence_unavailable" } : query(brief, input))
  return [
    {
      spec: {
        name: "har_graph_search",
        description: "Search the current capture's bounded request catalog. Before selecting an interface, set readInterfaceEligible=true and use only an item returned with that marker true. responseSemantics contains value-free concepts, field types, and semantic roles derived from captured response values; use it to name concrete capabilities. Omit resourceType unless matching an observed value. Paginate with nextCursor.",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            responseMimeType: { type: "string" },
            resourceType: { type: "string", description: "Optional exact observed resource type; do not guess values such as xhr." },
            readInterfaceEligible: { type: "boolean", description: "Set true to return only JSON GET/HEAD requests allowed as read interfaces." },
            text: { type: "string" },
            cursor: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS }
          },
          additionalProperties: false
        }
      },
      run: run(searchHarnessAuthorGraph)
    },
    {
      spec: {
        name: "har_graph_request",
        description: "Inspect one exact request ID without exposing values, origins, or response bodies. Use its value-free responseSemantics concepts and field roles as the evidence basis for a specific interface description.",
        inputSchema: {
          type: "object",
          properties: { requestId: { type: "string" } },
          required: ["requestId"],
          additionalProperties: false
        }
      },
      run: run(inspectHarnessAuthorRequest)
    },
    {
      spec: {
        name: "har_graph_neighbors",
        description: "Walk incoming or outgoing dependency edges for one exact request ID in the current capture.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
            reason: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_NEIGHBORS }
          },
          required: ["requestId"],
          additionalProperties: false
        }
      },
      run: run(navigateHarnessAuthorGraph)
    },
    {
      spec: {
        name: "har_graph_findings",
        description: "Search exact unresolved finding identities from the current capture for final disposition decisions.",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            code: { type: "string" },
            cursor: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: MAX_FINDING_RESULTS }
          },
          additionalProperties: false
        }
      },
      run: run(searchHarnessAuthorFindings)
    }
  ]
}

/**
 * A capture-scoped, read-only native tool surface. The complete evidence lives
 * in MessageReceived.input but is never rendered into the model prompt; each
 * bounded result is journaled through Tardigrade's normal ToolReturned event.
 */
export const harnessAuthorGraphTools = (): AgentComponent => ({
  name: "harness-author-graph-tools",
  derive: (log) => toolList(
    toolsFor(briefFromLog(log)),
    "Use the har_graph_* tools to search only the current immutable, value-free capture snapshot. Select a sourceRequestId only from a search result explicitly marked readInterfaceEligible true. Do not guess request IDs, resource types, or finding identities."
  ).derive(log)
})
