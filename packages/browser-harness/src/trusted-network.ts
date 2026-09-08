import type { Event } from "tardie/core/log/event"
import { DEFAULT_HAR_POLICY, normalizeHar, type NormalizedHarTrace, type RequestDependency } from "./har"
import {
  profileHarSessionValues,
  reusableSessionSnapshotOf,
  type HarSessionValueObservation,
  type HarValueProfile,
  type ReusableSessionSnapshot
} from "./har-value-profile"
import {
  planHarImport,
  validatedHarCaptureFactsOf,
  type ValidatedHarCaptureFacts
} from "./har-facts"

export const MAX_HAR_FILE_BYTES = 64 * 1024 * 1024

export class HarImportInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HarImportInputError"
  }
}

export interface Options {
  readonly file: string
  readonly baseUrl: string
  readonly actor: string
  readonly captureId?: string
  readonly thread?: string
  readonly dryRun: boolean
  readonly includePathSegments: boolean
  readonly includePageMetadata: boolean
}

export interface HarImportResult {
  readonly captureId: string
  readonly thread: string
  readonly attemptedEvents: number
  readonly importDigest: string
  readonly dryRun: boolean
}

export type HarImportBytesOptions = Omit<Options, "file"> & {
  readonly expectedImportDigest?: string
  readonly token?: string
  /** Trusted browser capture only: inline resources are not HTTP exchanges. */
  readonly omitBrowserInlineResources?: true
}

export type HarImportPreparationOptions = Pick<HarImportBytesOptions,
  "captureId" | "thread" | "includePathSegments" | "includePageMetadata" | "omitBrowserInlineResources">

export interface HarImportPreview {
  readonly captureId: string
  readonly thread: string
  readonly importDigest: string
  readonly attemptedEvents: number
  readonly requests: number
  readonly responses: number
  readonly dependencies: number
  readonly actionCandidates: number
  readonly includePathSegments: boolean
  readonly includePageMetadata: boolean
}

interface PreparedHarImport {
  /** Raw parsed object stays inside this trusted module and is never returned by normal import APIs. */
  readonly raw: unknown
  readonly captureId: string
  readonly thread: string
  readonly importDigest: string
  readonly events: ReadonlyArray<Event>
  readonly trace: NormalizedHarTrace
}

export const prepareHarImportBytes = (
  bytes: Uint8Array,
  options: HarImportPreparationOptions
): PreparedHarImport => {
  if (bytes.byteLength > MAX_HAR_FILE_BYTES) {
    throw new HarImportInputError(`HAR payload is ${bytes.byteLength} bytes; the limit is ${MAX_HAR_FILE_BYTES} bytes`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
  } catch {
    throw new HarImportInputError("HAR payload is not valid UTF-8 JSON")
  }
  let inlineCount = 0
  if (options.omitBrowserInlineResources === true) {
    const root = recordOf(raw)
    const log = recordOf(root?.log)
    const entries = log?.entries
    // Check the ORIGINAL input count before dropping anything. Malformed,
    // file/other-scheme and invalid HTTP entries still fail normal validation.
    if (Array.isArray(entries) && entries.length > DEFAULT_HAR_POLICY.maxEntries) {
      throw new HarImportInputError("HAR payload failed structural validation")
    }
    if (Array.isArray(entries)) {
      const networkEntries = entries.filter((entry) => {
        const record = recordOf(entry)
        const request = recordOf(record?.request)
        const url = request?.url
        const inline = typeof url === "string" && /^(?:blob|data):/iu.test(url)
        if (inline) {
          const response = recordOf(record?.response)
          // Reuse strict non-URL validation without decoding inline bodies.
          // This placeholder exists only in a discarded validation trace;
          // it never enters evidence, session profiling or dependency inference.
          const checked = normalizeHar({ log: { entries: [{ ...record,
            request: { ...request, url: "https://inline.invalid/", postData: undefined },
            ...(response === undefined ? {} : { response: { ...response, content: undefined } })
          }] } })
          if (checked.errors.length > 0) throw new HarImportInputError("HAR payload failed structural validation")
          inlineCount += 1
        }
        return !inline
      })
      // Keep the raw/normalized index alignment used by session and semantic
      // extraction. Never parse the inline payload or use it as replay evidence.
      if (inlineCount > 0) raw = { ...root, log: { ...log, entries: networkEntries } }
    }
  }
  const normalized = normalizeHar(raw)
  const trace = inlineCount === 0 ? normalized : { ...normalized,
    warnings: [`agent-browser-inline/1: omitted ${inlineCount} blob/data resources; not HTTP exchanges.`, ...normalized.warnings] }
  if (trace.errors.length > 0) throw new HarImportInputError("HAR payload failed structural validation")
  const plan = planHarImport(trace, {
    includePathSegments: options.includePathSegments,
    includePageMetadata: options.includePageMetadata
  })
  const importDigest = plan.importDigest
  const captureId = options.captureId ?? `har-${importDigest.slice("sha256:".length, "sha256:".length + 20)}`
  const thread = options.thread ?? captureId
  return { raw, captureId, thread, importDigest, events: plan.events(captureId), trace }
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
const arrayOf = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []
const boundedRawText = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u
const sessionHeaderNameOf = (value: unknown): string | undefined => {
  const name = boundedRawText(value, 128)?.trim().toLowerCase()
  return name !== undefined && HEADER_NAME.test(name) ? name : undefined
}
const sessionCookieNameOf = (value: unknown): string | undefined => {
  const name = boundedRawText(value, 128)?.trim()
  return name !== undefined && HEADER_NAME.test(name) ? name : undefined
}
const siteIdOf = (value: string): string => {
  const siteId = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "")
  if (
    siteId.length === 0 || siteId.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(siteId) || siteId.includes("..")
  ) throw new HarImportInputError("Session profile site ID is invalid")
  return siteId
}
const originBelongsToSite = (origin: string, siteId: string): boolean => {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host === siteId || host.endsWith(`.${siteId}`)
  } catch {
    return false
  }
}
const cookiePairs = (value: string): ReadonlyArray<{ readonly name: string; readonly value: string }> =>
  value.split(";").slice(0, 256).flatMap((part) => {
    const delimiter = part.indexOf("=")
    if (delimiter <= 0) return []
    const name = sessionCookieNameOf(part.slice(0, delimiter))
    const cookieValue = part.slice(delimiter + 1).trim()
    return name === undefined || cookieValue.length === 0 || cookieValue.length > 4_096
      ? []
      : [{ name, value: cookieValue }]
  })

const sessionObservationsFromRaw = (
  raw: unknown,
  trace: NormalizedHarTrace,
  dependencies: ReadonlyArray<RequestDependency>,
  siteValue?: string
): ReadonlyArray<HarSessionValueObservation> => {
  const siteId = siteValue === undefined ? undefined : siteIdOf(siteValue)
  const rawEntries = arrayOf(recordOf(recordOf(raw)?.log)?.entries)
  const normalizedByIndex = new Map(trace.entries.map((entry) => [entry.index, entry] as const))
  const priorResponseTargets = new Set(dependencies
    .filter((dependency) => dependency.reason === "value-flow")
    .map((dependency) => `${dependency.to}\u0000${dependency.evidence.slice(dependency.evidence.indexOf(" -> ") + 4)}`))
  const observations: HarSessionValueObservation[] = []
  const seen = new Set<string>()
  const add = (observation: HarSessionValueObservation): void => {
    if (siteId !== undefined && !originBelongsToSite(observation.origin, siteId)) return
    const phase = observation.kind === "cookie" ? Math.floor(observation.order / 2) : observation.order
    const key = `${phase}\u0000${observation.kind}\u0000${observation.origin}\u0000${observation.name}\u0000${observation.value}`
    if (seen.has(key)) return
    seen.add(key)
    observations.push(Object.freeze(observation))
  }
  rawEntries.forEach((rawEntry, index) => {
    const normalized = normalizedByIndex.get(index)
    const entry = recordOf(rawEntry)
    const request = recordOf(entry?.request)
    const response = recordOf(entry?.response)
    if (normalized === undefined || request === undefined || response === undefined) return
    const origin = normalized.request.origin
    const requestFamily = `${normalized.request.method}\u0000${normalized.resourceType ?? ""}\u0000${normalized.request.path}`
    for (const rawHeader of arrayOf(request.headers)) {
      const header = recordOf(rawHeader)
      const name = sessionHeaderNameOf(header?.name)
      const value = boundedRawText(header?.value, 16_384)
      if (name === undefined || value === undefined) continue
      if (name === "cookie") {
        cookiePairs(value).forEach((cookie) => add({
          kind: "cookie",
          origin,
          requestId: normalized.id,
          requestFamily,
          order: normalized.index * 4,
          name: cookie.name,
          value: cookie.value,
          cookieRequestPath: normalized.request.path
        }))
      } else {
        add({
          kind: "header",
          origin,
          requestId: normalized.id,
          requestFamily,
          order: normalized.index * 4,
          name,
          value,
          ...(priorResponseTargets.has(`${normalized.id}\u0000request.header.${name}`)
            ? { responseDerived: true }
            : {})
        })
      }
    }
    for (const rawCookie of arrayOf(request.cookies)) {
      const cookie = recordOf(rawCookie)
      const name = sessionCookieNameOf(cookie?.name)
      const value = boundedRawText(cookie?.value, 4_096)
      if (name !== undefined && value !== undefined) add({
        kind: "cookie",
        origin,
        requestId: normalized.id,
        requestFamily,
        order: normalized.index * 4 + 1,
        name,
        value,
        cookieRequestPath: normalized.request.path
      })
    }
    for (const rawHeader of arrayOf(response.headers)) {
      const header = recordOf(rawHeader)
      if (sessionHeaderNameOf(header?.name) !== "set-cookie") continue
      const value = boundedRawText(header?.value, 16_384)
      const pair = value === undefined ? undefined : cookiePairs(value)[0]
      if (pair !== undefined) add({
        kind: "cookie",
        origin,
        requestId: normalized.id,
        requestFamily,
        order: normalized.index * 4 + 2,
        name: pair.name,
        value: pair.value,
        cookieRequestPath: normalized.request.path
      })
    }
    for (const rawCookie of arrayOf(response.cookies)) {
      const cookie = recordOf(rawCookie)
      const name = sessionCookieNameOf(cookie?.name)
      const value = boundedRawText(cookie?.value, 4_096)
      if (name !== undefined && value !== undefined) add({
        kind: "cookie",
        origin,
        requestId: normalized.id,
        requestFamily,
        order: normalized.index * 4 + 3,
        name,
        value,
        cookieRequestPath: normalized.request.path
      })
    }
  })
  return Object.freeze(observations)
}

export interface TrustedHarSessionPreparation {
  readonly preview: HarImportPreview
  /** Value-free classification only; safe for a local machine-readable report. */
  readonly profile: HarValueProfile
  /** Secret plaintext. Store only through LocalSessionVault and never serialize directly. */
  readonly snapshot: ReusableSessionSnapshot
}

export const prepareTrustedHarSessionBytes = (
  bytes: Uint8Array,
  options: Pick<HarImportBytesOptions, "captureId" | "thread" | "includePathSegments" | "includePageMetadata"> & {
    readonly siteId: string
  }
): TrustedHarSessionPreparation => {
  const prepared = prepareHarImportBytes(bytes, options)
  const projected = validatedHarCaptureFactsOf(prepared.events, prepared.captureId)
  if (projected.status !== "completed") throw new HarImportInputError("Prepared HAR facts failed manifest validation")
  const observations = sessionObservationsFromRaw(
    prepared.raw,
    prepared.trace,
    projected.capture.dependencies,
    options.siteId
  )
  const count = (type: string): number => prepared.events.filter((event) => event.type === type).length
  return {
    preview: {
      captureId: prepared.captureId,
      thread: prepared.thread,
      importDigest: prepared.importDigest,
      attemptedEvents: prepared.events.length,
      requests: count("HarRequestObserved"),
      responses: count("HarResponseObserved"),
      dependencies: count("HarDependencyInferred"),
      actionCandidates: count("HarActionCandidateProposed"),
      includePathSegments: options.includePathSegments,
      includePageMetadata: options.includePageMetadata
    },
    profile: profileHarSessionValues(observations),
    snapshot: reusableSessionSnapshotOf({
      siteId: siteIdOf(options.siteId),
      sourceImportDigest: prepared.importDigest,
      observations
    })
  }
}

export interface TrustedHarImportPreparation {
  readonly preview: HarImportPreview
  /** Sanitized but value-bearing transient data. Keep it outside logs, actor calls, reports, and UI responses. */
  readonly trace: NormalizedHarTrace
  /** Value-free capture cardinality/lineage evidence retained only by the trusted controller. */
  readonly valueProfile: HarValueProfile
  /** Exact manifest-validated, value-free facts suitable for a bounded author brief. Never expose this through the preview API. */
  readonly authorFacts: ValidatedHarCaptureFacts
}

export const prepareTrustedHarImportBytes = (
  bytes: Uint8Array,
  options: HarImportPreparationOptions
): TrustedHarImportPreparation => {
  const prepared = prepareHarImportBytes(bytes, options)
  const projected = validatedHarCaptureFactsOf(prepared.events, prepared.captureId)
  if (projected.status !== "completed") {
    throw new HarImportInputError("Prepared HAR facts failed manifest validation")
  }
  const count = (type: string): number => prepared.events.filter((event) => event.type === type).length
  return {
    preview: {
      captureId: prepared.captureId,
      thread: prepared.thread,
      importDigest: prepared.importDigest,
      attemptedEvents: prepared.events.length,
      requests: count("HarRequestObserved"),
      responses: count("HarResponseObserved"),
      dependencies: count("HarDependencyInferred"),
      actionCandidates: count("HarActionCandidateProposed"),
      includePathSegments: options.includePathSegments,
      includePageMetadata: options.includePageMetadata
    },
    trace: prepared.trace,
    valueProfile: profileHarSessionValues(sessionObservationsFromRaw(
      prepared.raw,
      prepared.trace,
      projected.capture.dependencies
    )),
    authorFacts: projected.capture
  }
}

export const previewHarImportBytes = (
  bytes: Uint8Array,
  options: HarImportPreparationOptions
): HarImportPreview => prepareTrustedHarImportBytes(bytes, options).preview

/** Live browser transport compatibility at the existing trusted normalization
 * boundary. No HAR pathname, writer, import, rotation or actor input is involved. */
export const prepareTrustedNetworkEntries = (entries: ReadonlyArray<unknown>): TrustedHarImportPreparation => {
  if (entries.length > DEFAULT_HAR_POLICY.maxEntries) throw new HarImportInputError("Network observation exceeded its entry bound")
  const bytes = new TextEncoder().encode(JSON.stringify({ log: { entries } }))
  try { return prepareTrustedHarImportBytes(bytes, { includePathSegments: false, includePageMetadata: false }) }
  finally { bytes.fill(0) }
}
