import { createHash } from "node:crypto"

export const REDACTED = "[REDACTED]"

export interface HarPolicy {
  readonly maxBodyChars: number
  readonly maxHeaderChars: number
  readonly maxEntries: number
  readonly maxDecodedBodyChars: number
}

export const DEFAULT_HAR_POLICY: HarPolicy = {
  maxBodyChars: 32_768,
  maxHeaderChars: 2_048,
  maxEntries: 5_000,
  maxDecodedBodyChars: 1_000_000
}

export interface NameValue {
  readonly name: string
  readonly value: string
  readonly redacted: boolean
}

export interface BodyCapture {
  readonly mimeType: string
  readonly sha256: string
  readonly size: number
  readonly text?: string
  readonly truncated: boolean
  readonly redactions: number
}

export interface RequestSnapshot {
  readonly method: string
  readonly url: string
  readonly origin: string
  readonly path: string
  readonly query: ReadonlyArray<NameValue>
  readonly headers: ReadonlyArray<NameValue>
  readonly cookies: ReadonlyArray<string>
  readonly body?: BodyCapture
}

export interface ResponseSnapshot {
  readonly status: number
  readonly statusText: string
  readonly mimeType: string
  readonly headers: ReadonlyArray<NameValue>
  readonly cookies: ReadonlyArray<string>
  readonly redirectUrl?: string
  readonly body?: BodyCapture
}

export interface NormalizedHarEntry {
  readonly id: string
  readonly index: number
  readonly startedAt: string
  readonly durationMs: number
  readonly pageId?: string
  readonly resourceType?: string
  readonly initiatorUrl?: string
  readonly request: RequestSnapshot
  readonly response: ResponseSnapshot
}

export interface HarPage {
  readonly id: string
  readonly title?: string
}

export interface NormalizedHarTrace {
  readonly digest: string
  readonly source?: string
  readonly pages: ReadonlyArray<HarPage>
  readonly entries: ReadonlyArray<NormalizedHarEntry>
  readonly warnings: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

export type DependencyReason = "redirect" | "initiator" | "referer" | "cookie" | "value-flow"

export interface RequestDependency {
  readonly from: string
  readonly to: string
  readonly reason: DependencyReason
  readonly confidence: number
  readonly evidence: string
}

export interface DependencyChain {
  readonly requestIds: ReadonlyArray<string>
  readonly confidence: number
}

export interface ActionCandidate {
  readonly id: string
  readonly name: string
  readonly requestId: string
  readonly method: string
  readonly origin: string
  readonly pathTemplate: string
  readonly dependsOn: ReadonlyArray<string>
  readonly inputFields: ReadonlyArray<string>
  readonly observedStatus: number
  readonly observedOutcome: string
  readonly confidence: number
}

export interface WebsiteEvidence {
  readonly kind: "page-title" | "html-title" | "meta-description" | "primary-origin"
  readonly value: string
  readonly requestId?: string
}

export interface WebsiteInspection {
  readonly traceDigest: string
  readonly source?: string
  readonly site: {
    readonly origin: string
    readonly host: string
    readonly title?: string
    readonly description?: string
    readonly about: string
  }
  readonly counts: {
    readonly requests: number
    readonly responses: number
    readonly dependencies: number
    readonly actionCandidates: number
  }
  readonly hosts: ReadonlyArray<string>
  readonly contentTypes: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<WebsiteEvidence>
  readonly chains: ReadonlyArray<DependencyChain>
  readonly actions: ReadonlyArray<ActionCandidate>
  readonly warnings: ReadonlyArray<string>
}

type UnknownRecord = Record<string, unknown>

const recordOf = (value: unknown): UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : {}

const arrayOf = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

const stringOf = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback

const numberOf = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, stableValue(child)])
  )
}

export const canonicalStringify = (value: unknown): string => JSON.stringify(stableValue(value))

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

const uniqueSorted = (values: Iterable<string>): ReadonlyArray<string> =>
  [...new Set([...values].filter((value) => value.length > 0))].sort(compareText)

const MAX_HAR_COLLECTION_ITEMS = 256

const sensitiveName = (name: string): boolean =>
  /(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password|passwd|session|csrf|xsrf)/iu.test(name)

const redactSecrets = (value: string): { readonly text: string; readonly redactions: number } => {
  let redactions = 0
  const replace = (pattern: RegExp, input: string): string => input.replace(pattern, () => {
    redactions++
    return REDACTED
  })
  let text = replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, value)
  text = replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/gu, text)
  return { text, redactions }
}

const sanitizedUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    const userinfoRedacted = url.username.length > 0 || url.password.length > 0
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveName(key)) url.searchParams.set(key, REDACTED)
    }
    if (userinfoRedacted) url.searchParams.append("__userinfo", REDACTED)
    return url.toString()
  } catch {
    return ""
  }
}

const urlParts = (raw: string): { readonly origin: string; readonly path: string } => {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return { origin: "", path: "" }
    return { origin: url.origin, path: url.pathname }
  } catch {
    return { origin: "", path: "" }
  }
}

const boundedCookieName = (value: string): string | undefined => {
  if (value.length > 128) return undefined
  const name = value.trim()
  return name.length === 0 || name.length > 64 ? undefined : name
}

interface CookieNamesFromHeader {
  readonly names: ReadonlyArray<string>
  readonly overflow: boolean
}

const cookieNamesFromHeader = (name: string, value: string): CookieNamesFromHeader => {
  const lower = name.toLowerCase()
  if (lower === "set-cookie") {
    const delimiter = value.search(/[;=]/u)
    const cookie = boundedCookieName(value.slice(0, delimiter < 0 ? Math.min(value.length, 129) : delimiter))
    return { names: cookie === undefined ? [] : [cookie], overflow: false }
  }
  if (lower !== "cookie") return { names: [], overflow: false }
  const parts = value.split(";", MAX_HAR_COLLECTION_ITEMS + 1)
  return { names: parts.flatMap((part) => {
    const delimiter = part.indexOf("=")
    const cookie = boundedCookieName(part.slice(0, delimiter < 0 ? Math.min(part.length, 129) : delimiter))
    return cookie === undefined ? [] : [cookie]
  }), overflow: parts.length > MAX_HAR_COLLECTION_ITEMS }
}

const cookieNamesFromArray = (value: unknown): ReadonlyArray<string> =>
  arrayOf(value).slice(0, MAX_HAR_COLLECTION_ITEMS + 1).flatMap((item) => {
    const name = boundedCookieName(stringOf(recordOf(item).name))
    return name === undefined ? [] : [name]
  })

const normalizeHeaders = (
  value: unknown,
  policy: HarPolicy
): {
  readonly headers: ReadonlyArray<NameValue>
  readonly cookies: ReadonlyArray<string>
  readonly cookieOverflow: boolean
} => {
  const cookies: string[] = []
  let cookieOverflow = false
  const headers = arrayOf(value).slice(0, MAX_HAR_COLLECTION_ITEMS + 1).flatMap((item): ReadonlyArray<NameValue> => {
    const raw = recordOf(item)
    const name = stringOf(raw.name).trim().toLowerCase()
    if (name.length === 0) return []
    const original = stringOf(raw.value)
    const cookieNames = cookieNamesFromHeader(name, original)
    cookies.push(...cookieNames.names)
    cookieOverflow ||= cookieNames.overflow
    const protectedValue = sensitiveName(name)
      ? { text: REDACTED, redactions: original.length === 0 ? 0 : 1 }
      : name === "referer" || name === "location" || name === "content-location"
      ? { text: sanitizedUrl(original), redactions: sanitizedUrl(original) === original ? 0 : 1 }
      : redactSecrets(original)
    const value = protectedValue.text.slice(0, policy.maxHeaderChars)
    return [{ name, value, redacted: protectedValue.redactions > 0 || value.length < protectedValue.text.length }]
  })
  return {
    headers: [...headers].sort((left, right) => compareText(left.name, right.name) || compareText(left.value, right.value)),
    cookies: uniqueSorted(cookies),
    cookieOverflow
  }
}

const normalizeQuery = (request: UnknownRecord): ReadonlyArray<NameValue> => {
  const listed = arrayOf(request.queryString).slice(0, MAX_HAR_COLLECTION_ITEMS + 1).flatMap((item): ReadonlyArray<NameValue> => {
    const raw = recordOf(item)
    const name = stringOf(raw.name).trim()
    if (name.length === 0) return []
    const original = stringOf(raw.value)
    const protectedValue = sensitiveName(name) ? REDACTED : redactSecrets(original).text
    return [{ name, value: protectedValue, redacted: protectedValue !== original }]
  })
  if (listed.length > 0) return listed
  try {
    const url = new URL(stringOf(request.url))
    return [...url.searchParams.entries()].map(([name, original]) => {
      const value = sensitiveName(name) ? REDACTED : redactSecrets(original).text
      return { name, value, redacted: value !== original }
    })
  } catch {
    return []
  }
}

const sanitizeJson = (
  value: unknown,
  key: string | undefined,
  state: { redactions: number }
): unknown => {
  if (key !== undefined && sensitiveName(key)) {
    state.redactions++
    return REDACTED
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, undefined, state))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as UnknownRecord)
        .sort(([left], [right]) => compareText(left, right))
        .map(([childKey, child]) => [childKey, sanitizeJson(child, childKey, state)])
    )
  }
  if (typeof value === "string") {
    const protectedValue = redactSecrets(value)
    state.redactions += protectedValue.redactions
    return protectedValue.text
  }
  return value
}

const sanitizeForm = (text: string): { readonly text: string; readonly redactions: number } => {
  const params = new URLSearchParams(text)
  let redactions = 0
  for (const [name, original] of [...params.entries()]) {
    if (sensitiveName(name)) {
      params.set(name, REDACTED)
      redactions++
      continue
    }
    const protectedValue = redactSecrets(original)
    if (protectedValue.redactions > 0) params.set(name, protectedValue.text)
    redactions += protectedValue.redactions
  }
  return { text: params.toString(), redactions }
}

const sanitizeHtml = (text: string): { readonly text: string; readonly redactions: number } => {
  const generic = redactSecrets(text)
  let redactions = generic.redactions
  const protectedText = generic.text.replace(
    /(<input\b[^>]*\b(?:name|id)=["'][^"']*(?:token|secret|password|csrf|xsrf)[^"']*["'][^>]*\bvalue=["'])[^"']*(["'])/giu,
    (_match, before: string, after: string) => {
      redactions++
      return `${before}${REDACTED}${after}`
    }
  )
  return { text: protectedText, redactions }
}

const decodedText = (
  content: UnknownRecord,
  policy: HarPolicy
): { readonly text?: string; readonly originalSize?: number; readonly warning?: string } => {
  const raw = content.text
  if (typeof raw !== "string") return {}
  if (stringOf(content.encoding).toLowerCase() !== "base64") {
    return raw.length > policy.maxDecodedBodyChars
      ? {
          text: raw.slice(0, policy.maxDecodedBodyChars),
          originalSize: raw.length,
          warning: `A HAR body exceeded ${policy.maxDecodedBodyChars} characters and was clipped before inspection.`
        }
      : { text: raw, originalSize: raw.length }
  }
  const compact = raw.replace(/\s+/gu, "")
  if (compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) {
    return { warning: "A base64 HAR body was invalid and was omitted." }
  }
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8")
    return decoded.length > policy.maxDecodedBodyChars
      ? {
          text: decoded.slice(0, policy.maxDecodedBodyChars),
          originalSize: decoded.length,
          warning: `A decoded HAR body exceeded ${policy.maxDecodedBodyChars} characters and was clipped before inspection.`
        }
      : { text: decoded, originalSize: decoded.length }
  } catch {
    return { warning: "A base64 HAR body could not be decoded and was omitted." }
  }
}

const captureBody = (
  container: unknown,
  policy: HarPolicy
): { readonly body?: BodyCapture; readonly warning?: string } => {
  const raw = recordOf(container)
  const mimeType = stringOf(raw.mimeType).split(";", 1)[0]?.trim().toLowerCase() ?? ""
  const decoded = decodedText(raw, policy)
  if (decoded.text === undefined) return decoded.warning === undefined ? {} : { warning: decoded.warning }
  const original = decoded.text
  let sanitized: { readonly text: string; readonly redactions: number }
  if (mimeType.includes("json") || /^[\s\r\n]*[\[{]/u.test(original)) {
    try {
      const state = { redactions: 0 }
      sanitized = { text: JSON.stringify(sanitizeJson(JSON.parse(original), undefined, state)), redactions: state.redactions }
    } catch {
      sanitized = redactSecrets(original)
    }
  } else if (mimeType === "application/x-www-form-urlencoded") {
    sanitized = sanitizeForm(original)
  } else if (mimeType.includes("html")) {
    sanitized = sanitizeHtml(original)
  } else {
    sanitized = redactSecrets(original)
  }
  const text = sanitized.text.slice(0, policy.maxBodyChars)
  return {
    body: {
      mimeType,
      sha256: sha256(sanitized.text),
      size: decoded.originalSize ?? original.length,
      ...(text.length === 0 ? {} : { text }),
      truncated: (decoded.originalSize ?? original.length) > original.length || text.length < sanitized.text.length,
      redactions: sanitized.redactions
    },
    ...(decoded.warning === undefined ? {} : { warning: decoded.warning })
  }
}

const initiatorUrlOf = (entry: UnknownRecord): string | undefined => {
  const initiator = recordOf(entry._initiator)
  const direct = stringOf(initiator.url)
  if (direct.length > 0) return sanitizedUrl(direct)
  const stack = recordOf(initiator.stack)
  for (const frame of arrayOf(stack.callFrames)) {
    const url = stringOf(recordOf(frame).url)
    if (url.length > 0) return sanitizedUrl(url)
  }
  return undefined
}

const policyOf = (options: Partial<HarPolicy>): HarPolicy => {
  const policy = { ...DEFAULT_HAR_POLICY, ...options }
  if (!Number.isSafeInteger(policy.maxBodyChars) || policy.maxBodyChars < 1) {
    throw new Error("maxBodyChars must be a positive integer")
  }
  if (!Number.isSafeInteger(policy.maxHeaderChars) || policy.maxHeaderChars < 1) {
    throw new Error("maxHeaderChars must be a positive integer")
  }
  if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer")
  }
  if (!Number.isSafeInteger(policy.maxDecodedBodyChars) || policy.maxDecodedBodyChars < 1) {
    throw new Error("maxDecodedBodyChars must be a positive integer")
  }
  return policy
}

export const normalizeHar = (
  value: unknown,
  options: Partial<HarPolicy> & { readonly source?: string } = {}
): NormalizedHarTrace => {
  const policy = policyOf(options)
  const top = recordOf(value)
  const log = recordOf(top.log)
  const errors: string[] = []
  const warnings: string[] = []
  if (Object.keys(log).length === 0) errors.push("HAR input must contain a log object.")

  const pages = arrayOf(log.pages).flatMap((item): ReadonlyArray<HarPage> => {
    const raw = recordOf(item)
    const id = stringOf(raw.id).trim()
    if (id.length === 0) return []
    const title = stringOf(raw.title).trim()
    return [{ id, ...(title.length === 0 ? {} : { title }) }]
  })

  const rawEntries = arrayOf(log.entries)
  if (rawEntries.length === 0) errors.push("HAR log must contain at least one entry.")
  if (rawEntries.length > policy.maxEntries) {
    errors.push(`HAR log contains ${rawEntries.length} entries; the limit is ${policy.maxEntries}.`)
  }
  const entries = rawEntries.slice(0, policy.maxEntries).map((item, index): NormalizedHarEntry => {
    const raw = recordOf(item)
    const request = recordOf(raw.request)
    const response = recordOf(raw.response)
    const originalUrl = stringOf(request.url)
    const url = sanitizedUrl(originalUrl)
    const parts = urlParts(originalUrl)
    const requestQuery = normalizeQuery(request)
    if (Object.keys(request).length === 0) errors.push(`Entry ${index} must contain a request object.`)
    if (Object.keys(response).length === 0) errors.push(`Entry ${index} must contain a response object.`)
    if (parts.origin.length === 0 || url.length === 0) errors.push(`Entry ${index} must use a valid HTTP(S) request URL.`)
    if (parts.origin.length > 512) errors.push(`Entry ${index} has an origin longer than 512 characters.`)
    if (arrayOf(request.headers).length > MAX_HAR_COLLECTION_ITEMS ||
      arrayOf(response.headers).length > MAX_HAR_COLLECTION_ITEMS) {
      errors.push(`Entry ${index} exceeds the ${MAX_HAR_COLLECTION_ITEMS}-header limit.`)
    }
    if (arrayOf(request.queryString).length > MAX_HAR_COLLECTION_ITEMS ||
      requestQuery.length > MAX_HAR_COLLECTION_ITEMS) {
      errors.push(`Entry ${index} exceeds the ${MAX_HAR_COLLECTION_ITEMS}-query-field limit.`)
    }
    const requestHeaders = normalizeHeaders(request.headers, policy)
    const responseHeaders = normalizeHeaders(response.headers, policy)
    const requestBody = captureBody(request.postData, policy)
    const responseBody = captureBody(response.content, policy)
    if (requestBody.warning !== undefined) warnings.push(`Entry ${index} request: ${requestBody.warning}`)
    if (responseBody.warning !== undefined) warnings.push(`Entry ${index} response: ${responseBody.warning}`)
    const requestCookies = uniqueSorted([
      ...requestHeaders.cookies,
      ...cookieNamesFromArray(request.cookies)
    ])
    const responseCookies = uniqueSorted([
      ...responseHeaders.cookies,
      ...cookieNamesFromArray(response.cookies)
    ])
    if (requestHeaders.cookieOverflow || responseHeaders.cookieOverflow ||
      arrayOf(request.cookies).length > MAX_HAR_COLLECTION_ITEMS ||
      arrayOf(response.cookies).length > MAX_HAR_COLLECTION_ITEMS ||
      requestCookies.length > MAX_HAR_COLLECTION_ITEMS || responseCookies.length > MAX_HAR_COLLECTION_ITEMS) {
      errors.push(`Entry ${index} exceeds the ${MAX_HAR_COLLECTION_ITEMS}-cookie-name limit.`)
    }
    const method = stringOf(request.method).toUpperCase()
    if (!/^[A-Z][A-Z0-9-]{0,31}$/u.test(method)) errors.push(`Entry ${index} has an invalid request method.`)
    const rawStartedAt = stringOf(raw.startedDateTime)
    const startedMillis = Date.parse(rawStartedAt)
    if (!Number.isFinite(startedMillis)) errors.push(`Entry ${index} has an invalid startedDateTime.`)
    const startedAt = Number.isFinite(startedMillis) ? new Date(startedMillis).toISOString() : ""
    const rawDurationMs = numberOf(raw.time, -1)
    const durationMs = Math.round(rawDurationMs)
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) errors.push(`Entry ${index} has an invalid duration.`)
    const status = numberOf(response.status, -1)
    if (!Number.isSafeInteger(status) || status < 0 || status > 599) {
      errors.push(`Entry ${index} has an invalid response status.`)
    }
    const id = `req-${String(index + 1).padStart(4, "0")}`
    const pageId = stringOf(raw.pageref).trim()
    const resourceType = stringOf(raw._resourceType).trim()
    const initiatorUrl = initiatorUrlOf(raw)
    const redirect = stringOf(response.redirectURL).trim()
    const responseMime = stringOf(recordOf(response.content).mimeType)
      .split(";", 1)[0]?.trim().toLowerCase() ?? ""
    return {
      id,
      index,
      startedAt,
      durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0,
      ...(pageId.length === 0 ? {} : { pageId }),
      ...(resourceType.length === 0 ? {} : { resourceType }),
      ...(initiatorUrl === undefined ? {} : { initiatorUrl }),
      request: {
        method,
        url,
        origin: parts.origin,
        path: parts.path,
        query: requestQuery,
        headers: requestHeaders.headers,
        cookies: requestCookies,
        ...(requestBody.body === undefined ? {} : { body: requestBody.body })
      },
      response: {
        status: Math.max(0, status),
        statusText: stringOf(response.statusText),
        mimeType: responseMime,
        headers: responseHeaders.headers,
        cookies: responseCookies,
        ...(redirect.length === 0 ? {} : { redirectUrl: sanitizedUrl(redirect) }),
        ...(responseBody.body === undefined ? {} : { body: responseBody.body })
      }
    }
  })
  const digest = sha256(canonicalStringify({ pages, entries }))
  return {
    digest,
    ...(options.source === undefined ? {} : { source: options.source }),
    pages,
    entries,
    warnings: uniqueSorted(warnings),
    errors: uniqueSorted(errors)
  }
}

interface ScalarLocator {
  readonly value: string
  readonly locator: string
}

export const MAX_INFERENCE_LOCATORS_PER_EXCHANGE = 512
export const MAX_INFERENCE_MATCH_KEYS = 50_000
export const MAX_INFERRED_DEPENDENCIES = 20_000

const scalarAllowed = (value: string): boolean =>
  value !== REDACTED && value.length >= 4 && value.length <= 128 &&
  !/^(?:accepted|application|booked|cancelled|complete|completed|confirmed|created|error|failed|false|https?|null|ok|pending|success|succeeded|text|true|undefined)$/iu.test(value)

const locatorSegment = (value: string): string => {
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 64)
  return normalized.length === 0 ? "field" : normalized
}

const scalarLocators = (value: unknown, locator: string, out: ScalarLocator[], depth = 0): void => {
  if (out.length >= MAX_INFERENCE_LOCATORS_PER_EXCHANGE || depth > 32) return
  if (Array.isArray(value)) {
    for (const item of value) {
      scalarLocators(item, `${locator}[]`, out, depth + 1)
      if (out.length >= MAX_INFERENCE_LOCATORS_PER_EXCHANGE) break
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [name, item] of Object.entries(value as UnknownRecord).sort(([left], [right]) => compareText(left, right))) {
      scalarLocators(item, `${locator}.${locatorSegment(name)}`, out, depth + 1)
      if (out.length >= MAX_INFERENCE_LOCATORS_PER_EXCHANGE) break
    }
    return
  }
  if (typeof value !== "string" && typeof value !== "number") return
  const token = String(value)
  if (scalarAllowed(token)) out.push({ value: token, locator })
}

const responseTokenLocators = (entry: NormalizedHarEntry): ReadonlyArray<ScalarLocator> => {
  const body = entry.response.body
  if (body?.text === undefined || !body.mimeType.includes("json")) return []
  try {
    const found: ScalarLocator[] = []
    scalarLocators(JSON.parse(body.text), "response.body", found)
    const distinct = new Map(found.map((item) => [`${item.value}\u0000${item.locator}`, item]))
    return [...distinct.values()].sort((left, right) =>
      compareText(left.locator, right.locator) || compareText(left.value, right.value))
  } catch {
    return []
  }
}

const addRequestLocator = (
  map: Map<string, Set<string>>,
  value: string,
  locator: string,
  state: { count: number }
): void => {
  if (state.count >= MAX_INFERENCE_LOCATORS_PER_EXCHANGE) return
  if (!scalarAllowed(value)) return
  const locators = map.get(value) ?? new Set<string>()
  if (locators.has(locator)) return
  locators.add(locator)
  map.set(value, locators)
  state.count++
}

const requestTokenLocators = (entry: NormalizedHarEntry): ReadonlyMap<string, ReadonlySet<string>> => {
  const found = new Map<string, Set<string>>()
  const state = { count: 0 }
  entry.request.query.slice(0, MAX_HAR_COLLECTION_ITEMS).forEach((item) =>
    addRequestLocator(found, item.value, `request.query.${locatorSegment(item.name)}`, state))
  entry.request.headers.slice(0, MAX_HAR_COLLECTION_ITEMS)
    .filter((item) => !item.redacted)
    .forEach((item) => addRequestLocator(found, item.value, `request.header.${locatorSegment(item.name)}`, state))
  entry.request.path.split("/").filter(Boolean).forEach((segment) => {
    try {
      addRequestLocator(found, decodeURIComponent(segment), "request.path.segment", state)
    } catch {
      addRequestLocator(found, segment, "request.path.segment", state)
    }
  })
  const body = entry.request.body
  if (body?.text !== undefined && body.mimeType.includes("json")) {
    try {
      const locators: ScalarLocator[] = []
      scalarLocators(JSON.parse(body.text), "request.body", locators)
      locators.forEach((item) => addRequestLocator(found, item.value, item.locator, state))
    } catch {}
  } else if (body?.text !== undefined && body.mimeType === "application/x-www-form-urlencoded") {
    for (const [name, value] of new URLSearchParams(body.text)) {
      addRequestLocator(found, value, `request.body.${locatorSegment(name)}`, state)
    }
  }
  return found
}

const dependencyKey = (dependency: RequestDependency): string =>
  `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`

const comparableUrlKey = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined
  try {
    const url = new URL(value)
    if ([...url.searchParams.values()].includes(REDACTED)) return undefined
    url.hash = ""
    return url.toString()
  } catch {
    return undefined
  }
}

interface TimedSource {
  readonly entry: NormalizedHarEntry
  readonly availableAt: number
}

interface ValueProducer extends TimedSource {
  readonly locators: ReadonlyArray<string>
}

const rememberEarliestTwo = <T extends TimedSource>(
  map: Map<string, T[]>,
  key: string | undefined,
  value: T
): void => {
  if (key === undefined) return
  const existing = map.get(key) ?? []
  const distinct = existing.some((item) => item.entry.id === value.entry.id) ? existing : [...existing, value]
  map.set(key, distinct.sort((left, right) =>
    left.availableAt - right.availableAt || left.entry.index - right.entry.index).slice(0, 2))
}

const uniqueReady = <T extends TimedSource>(sources: ReadonlyArray<T> | undefined, startedAt: number): T | undefined => {
  const ready = (sources ?? []).filter((source) => source.availableAt <= startedAt)
  return ready.length === 1 ? ready[0] : undefined
}

const locatorConcept = (locator: string): string => {
  const tail = locator.split(".").at(-1)?.replace(/\[\]$/u, "") ?? ""
  return tail.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .replace(/^x(?=[a-z])/u, "")
    .replace(/^(?:available|current|default|requested|selected|new)/u, "")
}

const valueFlowCompatible = (source: string, target: string, value: string): boolean => {
  const sourceConcept = locatorConcept(source)
  const targetConcept = locatorConcept(target)
  if (sourceConcept.length > 1 && sourceConcept === targetConcept) return true
  return target === "request.path.segment" && sourceConcept.endsWith("id") && /[0-9]/u.test(value)
}

export interface DependencyInferenceResult {
  readonly dependencies: ReadonlyArray<RequestDependency>
  readonly truncated: boolean
}

export const inferDependencyAnalysis = (
  entries: ReadonlyArray<NormalizedHarEntry>
): DependencyInferenceResult => {
  const dependencies = new Map<string, RequestDependency>()
  const requestSources = new Map<string, TimedSource[]>()
  const redirectSources = new Map<string, TimedSource[]>()
  const cookieSources = new Map<string, TimedSource[]>()
  const valueSources = new Map<string, ValueProducer[]>()
  const consumerValues = new Set<string>()
  const consumerCookies = new Set<string>()
  let matchKeyCount = 0
  let truncated = false
  let edgeLimitReached = false

  const rememberConsumer = (set: Set<string>, value: string): void => {
    if (set.has(value)) return
    if (matchKeyCount >= MAX_INFERENCE_MATCH_KEYS) {
      truncated = true
      return
    }
    set.add(value)
    matchKeyCount++
  }

  for (const entry of entries) {
    for (const value of requestTokenLocators(entry).keys()) rememberConsumer(consumerValues, value)
    for (const cookie of entry.request.cookies.slice(0, MAX_HAR_COLLECTION_ITEMS)) {
      rememberConsumer(consumerCookies, `${entry.request.origin}\u0000${cookie}`)
    }
  }

  const add = (dependency: RequestDependency): void => {
    const key = dependencyKey(dependency)
    if (dependencies.has(key)) return
    if (dependencies.size >= MAX_INFERRED_DEPENDENCIES) {
      truncated = true
      edgeLimitReached = true
      return
    }
    dependencies.set(key, dependency)
  }

  for (const current of entries) {
    if (edgeLimitReached) break
    const currentStartedAt = Date.parse(current.startedAt)
    const currentUrl = comparableUrlKey(current.request.url)
    const redirectedFrom = currentUrl === undefined
      ? undefined
      : uniqueReady(redirectSources.get(currentUrl), currentStartedAt)
    if (redirectedFrom !== undefined) {
      add({
        from: redirectedFrom.entry.id,
        to: current.id,
        reason: "redirect",
        confidence: 1,
        evidence: "response.redirectURL"
      })
    }

    const initiatedBy = uniqueReady(requestSources.get(comparableUrlKey(current.initiatorUrl) ?? ""), currentStartedAt)
    if (initiatedBy !== undefined) {
      add({ from: initiatedBy.entry.id, to: current.id, reason: "initiator", confidence: 0.97, evidence: "entry._initiator.url" })
    }

    const referer = current.request.headers.find((header) => header.name === "referer")
    const referredBy = uniqueReady(requestSources.get(comparableUrlKey(referer?.value) ?? ""), currentStartedAt)
    if (referredBy !== undefined) {
      add({ from: referredBy.entry.id, to: current.id, reason: "referer", confidence: 0.94, evidence: "request.headers.referer" })
    }

    for (const cookie of current.request.cookies.slice(0, MAX_HAR_COLLECTION_ITEMS)) {
      const source = uniqueReady(cookieSources.get(`${current.request.origin}\u0000${cookie}`), currentStartedAt)
      if (source !== undefined) {
        add({
          from: source.entry.id,
          to: current.id,
          reason: "cookie",
          confidence: 0.72,
          evidence: `same-origin cookie-name:${cookie}`
        })
      }
    }

    const requestLocators = requestTokenLocators(current)
    for (const [value, targets] of requestLocators) {
      const producer = uniqueReady(valueSources.get(value), currentStartedAt)
      if (producer === undefined) continue
      for (const target of [...targets].sort(compareText)) {
        const source = producer.locators.find((locator) => valueFlowCompatible(locator, target, value))
        if (source !== undefined) {
          add({
            from: producer.entry.id,
            to: current.id,
            reason: "value-flow",
            confidence: 0.86,
            evidence: `${source} -> ${target}`
          })
        }
      }
    }

    const availableAt = currentStartedAt + current.durationMs
    const timed = { entry: current, availableAt }
    rememberEarliestTwo(requestSources, currentUrl, { entry: current, availableAt: currentStartedAt })
    const redirectTarget = comparableUrlKey(current.response.redirectUrl)
    if (redirectTarget !== undefined) rememberEarliestTwo(redirectSources, redirectTarget, timed)
    for (const cookie of current.response.cookies.slice(0, MAX_HAR_COLLECTION_ITEMS)) {
      const key = `${current.request.origin}\u0000${cookie}`
      if (consumerCookies.has(key)) rememberEarliestTwo(cookieSources, key, timed)
    }
    const grouped = new Map<string, Set<string>>()
    for (const scalar of responseTokenLocators(current)) {
      if (!consumerValues.has(scalar.value)) continue
      grouped.set(scalar.value, new Set([...(grouped.get(scalar.value) ?? []), scalar.locator]))
    }
    for (const [value, locators] of grouped) {
      rememberEarliestTwo(valueSources, value, {
        ...timed,
        locators: [...locators].sort(compareText)
      })
    }
  }

  const position = new Map(entries.map((entry) => [entry.id, entry.index]))
  return {
    dependencies: [...dependencies.values()].sort((left, right) =>
    (position.get(left.to) ?? 0) - (position.get(right.to) ?? 0) ||
    (position.get(left.from) ?? 0) - (position.get(right.from) ?? 0) ||
    right.confidence - left.confidence ||
    compareText(left.reason, right.reason)
    ),
    truncated
  }
}

export const inferDependencies = (
  entries: ReadonlyArray<NormalizedHarEntry>
): ReadonlyArray<RequestDependency> => inferDependencyAnalysis(entries).dependencies

export const dependencyChains = (
  entries: ReadonlyArray<{ readonly id: string }>,
  dependencies: ReadonlyArray<RequestDependency>,
  limit = 128
): ReadonlyArray<DependencyChain> => {
  const outgoing = new Map<string, RequestDependency[]>()
  const incoming = new Map<string, RequestDependency[]>()
  const strongestByPair = new Map<string, RequestDependency>()
  for (const edge of dependencies) {
    const key = `${edge.from}\u0000${edge.to}`
    const prior = strongestByPair.get(key)
    if (prior === undefined || edge.confidence > prior.confidence) strongestByPair.set(key, edge)
  }
  for (const edge of strongestByPair.values()) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge])
  }
  const starts = entries.filter((entry) => (incoming.get(entry.id)?.length ?? 0) === 0)
  const chains: DependencyChain[] = []
  const visit = (id: string, path: ReadonlyArray<string>, confidence: number): void => {
    if (chains.length >= limit) return
    const next = outgoing.get(id) ?? []
    if (next.length === 0) {
      chains.push({ requestIds: [...path, id], confidence: Number(confidence.toFixed(3)) })
      return
    }
    for (const edge of next) {
      if (path.includes(edge.to)) continue
      visit(edge.to, [...path, id], Math.min(confidence, edge.confidence))
    }
  }
  for (const start of starts) visit(start.id, [], 1)
  if (chains.length === 0) {
    return entries.slice(0, limit).map((entry) => ({ requestIds: [entry.id], confidence: 1 }))
  }
  const distinct = new Map<string, DependencyChain>()
  for (const chain of chains) distinct.set(chain.requestIds.join("\u0000"), chain)
  return [...distinct.values()].sort((left, right) =>
    right.requestIds.length - left.requestIds.length || compareText(left.requestIds.join("/"), right.requestIds.join("/"))
  )
}

const templatedPath = (path: string): string => path.split("/").map((segment) => {
  if (/^\d+$/u.test(segment)) return ":id"
  if (/^[0-9a-f]{16,}$/iu.test(segment)) return ":id"
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)) return ":id"
  return segment
}).join("/")

const inputFieldsOf = (entry: NormalizedHarEntry): ReadonlyArray<string> => {
  const fields = new Set(entry.request.query.map((item) => item.name).filter((name) => !sensitiveName(name)))
  const text = entry.request.body?.text
  if (text !== undefined && entry.request.body?.mimeType.includes("json")) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        Object.keys(parsed as UnknownRecord).filter((name) => !sensitiveName(name)).forEach((name) => fields.add(name))
      }
    } catch {}
  }
  return [...fields].sort()
}

const outcomeOf = (entry: NormalizedHarEntry): string => {
  const allowed = new Set([
    "accepted", "booked", "cancelled", "complete", "completed", "confirmed",
    "created", "error", "failed", "ok", "pending", "success", "succeeded"
  ])
  const text = entry.response.body?.text
  if (text !== undefined && entry.response.body?.mimeType.includes("json")) {
    try {
      const parsed = recordOf(JSON.parse(text))
      for (const field of ["status", "state", "result"]) {
        const value = parsed[field]
        const candidate = String(value)
        if ((typeof value === "string" || typeof value === "number") && allowed.has(candidate.toLowerCase())) {
          return `${field}:${candidate.toLowerCase()}`
        }
      }
    } catch {}
  }
  return `HTTP ${entry.response.status}`
}

const actionName = (entry: NormalizedHarEntry): string => {
  const tail = entry.request.path.split("/").filter(Boolean).at(-1) ?? "request"
  const normalized = `${entry.request.method.toLowerCase()}_${tail}`.replace(/[^a-z0-9_]+/gu, "_")
  return `${normalized}_${sha256(`${entry.request.method}:${entry.request.path}`).slice(0, 6)}`
}

export const discoverActionCandidates = (
  entries: ReadonlyArray<NormalizedHarEntry>,
  dependencies: ReadonlyArray<RequestDependency>
): ReadonlyArray<ActionCandidate> => entries
  .filter((entry) => !["GET", "HEAD", "OPTIONS"].includes(entry.request.method))
  .map((entry) => {
    const dependsOn = uniqueSorted(dependencies
      .filter((edge) => edge.to === entry.id && ["value-flow", "redirect", "initiator"].includes(edge.reason))
      .map((edge) => edge.from))
    const successful = entry.response.status >= 200 && entry.response.status < 300
    const confidence = Number(Math.min(0.95, (successful ? 0.8 : 0.55) + (dependsOn.length > 0 ? 0.05 : 0)).toFixed(2))
    return {
      id: `action-${sha256(entry.id).slice(0, 12)}`,
      name: actionName(entry),
      requestId: entry.id,
      method: entry.request.method,
      origin: entry.request.origin,
      pathTemplate: templatedPath(entry.request.path),
      dependsOn,
      inputFields: inputFieldsOf(entry),
      observedStatus: entry.response.status,
      observedOutcome: outcomeOf(entry),
      confidence
    }
  })

const firstMatch = (text: string, pattern: RegExp): string | undefined => {
  const value = pattern.exec(text)?.[1]?.replace(/\s+/gu, " ").trim()
  return value === undefined || value.length === 0 ? undefined : value
}

const htmlTitle = (html: string): string | undefined => firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/iu)

const metaDescription = (html: string): string | undefined => {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0]
    const name = firstMatch(tag, /\b(?:name|property)=["']?([^\s"'>]+)/iu)
    if (name?.toLowerCase() !== "description" && name?.toLowerCase() !== "og:description") continue
    const content = firstMatch(tag, /\bcontent=["']([^"']*)["']/iu) ?? firstMatch(tag, /\bcontent=([^\s>]+)/iu)
    if (content !== undefined) return content
  }
  return undefined
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export const describeWebsite = (
  trace: NormalizedHarTrace,
  entries: ReadonlyArray<NormalizedHarEntry> = trace.entries,
  dependencies: ReadonlyArray<RequestDependency> = inferDependencies(entries),
  actions: ReadonlyArray<ActionCandidate> = discoverActionCandidates(entries, dependencies)
): WebsiteInspection => {
  const primary = entries.find((entry) =>
    entry.resourceType === "document" && entry.response.status >= 200 && entry.response.status < 400
  ) ?? entries[0]
  const htmlEntry = primary !== undefined && primary.response.mimeType.includes("html") &&
      primary.response.body?.text !== undefined
    ? primary
    : entries.find((entry) =>
        entry.resourceType === "document" &&
        entry.request.origin === primary?.request.origin &&
        (primary?.pageId === undefined || entry.pageId === primary.pageId) &&
        entry.response.status >= 200 && entry.response.status < 300 &&
        entry.response.mimeType.includes("html") &&
        entry.response.body?.text !== undefined)
  const html = htmlEntry?.response.body?.text ?? ""
  const pageTitle = primary?.pageId === undefined
    ? trace.pages.find((page) => page.title !== undefined)?.title
    : trace.pages.find((page) => page.id === primary.pageId)?.title
  const extractedTitle = htmlTitle(html)
  const title = pageTitle ?? extractedTitle
  const description = metaDescription(html)
  const origin = primary?.request.origin ?? ""
  const host = hostOf(origin)
  const about = description ?? (title === undefined
    ? `Captured ${entries.length} network exchanges for ${host || "an unknown website"}.`
    : `${title}${host.length === 0 ? "" : ` at ${host}`}.`)
  const hostCounts = new Map<string, number>()
  for (const entry of entries) {
    const candidate = hostOf(entry.request.origin)
    if (candidate.length > 0) hostCounts.set(candidate, (hostCounts.get(candidate) ?? 0) + 1)
  }
  const hosts = [...hostCounts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([candidate]) => candidate)
  const evidence: WebsiteEvidence[] = []
  if (pageTitle !== undefined) evidence.push({ kind: "page-title", value: pageTitle })
  if (extractedTitle !== undefined && extractedTitle !== pageTitle) {
    evidence.push({ kind: "html-title", value: extractedTitle, ...(htmlEntry === undefined ? {} : { requestId: htmlEntry.id }) })
  }
  if (description !== undefined) {
    evidence.push({ kind: "meta-description", value: description, ...(htmlEntry === undefined ? {} : { requestId: htmlEntry.id }) })
  }
  if (origin.length > 0) {
    evidence.push({ kind: "primary-origin", value: origin, ...(primary === undefined ? {} : { requestId: primary.id }) })
  }
  return {
    traceDigest: trace.digest,
    ...(trace.source === undefined ? {} : { source: trace.source }),
    site: {
      origin,
      host,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      about
    },
    counts: {
      requests: entries.length,
      responses: entries.filter((entry) => entry.response.status > 0).length,
      dependencies: dependencies.length,
      actionCandidates: actions.length
    },
    hosts,
    contentTypes: uniqueSorted(entries.map((entry) => entry.response.mimeType)),
    evidence,
    chains: dependencyChains(entries, dependencies),
    actions,
    warnings: trace.warnings
  }
}
