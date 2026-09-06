import { createHash } from "node:crypto"

import { canonicalStringify, compareText } from "./har"

export const HAR_VALUE_PROFILE_REVISION = "har-value-profile/8" as const
export const MAX_SESSION_VALUE_OBSERVATIONS = 100_000
export const MAX_SESSION_VALUE_PROFILES = 8_192
export const MAX_STORED_VARIANTS_PER_PROFILE = 64

export type HarSessionValueKind = "header" | "cookie"
export type HarValueStability =
  | "capture_static"
  | "request_family_static"
  | "grouped_dynamic"
  | "per_request_unique"
export type HarValueHandling =
  | "reuse_static"
  | "reuse_family_static"
  | "context_reinject"
  | "session_reinject"
  | "response_reinject"
  | "recompute"
  | "unresolved_dynamic"

/** Trusted-controller data. Values in this type must never enter events, prompts, reports, or UI DTOs. */
export interface HarSessionValueObservation {
  readonly kind: HarSessionValueKind
  readonly origin: string
  readonly requestId: string
  readonly requestFamily: string
  readonly order: number
  readonly name: string
  readonly value: string
  /** For cookies, exact observed request paths retained only inside encrypted ciphertext. */
  readonly cookieRequestPath?: string
  /** Exact trusted value-flow evidence linked this request field to a prior response. */
  readonly responseDerived?: boolean
}

/** Value-free evidence safe for a local inspection report. It contains no value digest. */
export interface HarValueProfileEntry {
  readonly kind: HarSessionValueKind
  readonly origin: string
  readonly name: string
  readonly observations: number
  readonly distinctValues: number
  readonly requestFamilies: number
  readonly repeatedRequestFamilies: number
  readonly priorResponseMatches: number
  readonly lineage: "response_derived" | "mixed" | "not_observed"
  readonly stability: HarValueStability
  readonly handling: HarValueHandling
}

export interface HarValueProfile {
  readonly revision: typeof HAR_VALUE_PROFILE_REVISION
  readonly observations: number
  readonly sessionMaterial: {
    readonly assessment: "candidate_material_observed" | "ambient_credentials_missing" | "not_observed"
    readonly cookieFields: number
    readonly credentialHeaderFields: number
    readonly csrfHeaderFields: number
  }
  readonly entries: ReadonlyArray<HarValueProfileEntry>
}

export interface ReusableSessionHeader {
  readonly origin: string
  readonly name: string
  readonly stability: HarValueStability
  readonly handling: HarValueHandling
  readonly variants: ReadonlyArray<{
    /** Digest of structural request-family identity, kept only inside the encrypted snapshot. */
    readonly requestFamilyDigest: `sha256:${string}`
    readonly value: string
  }>
}

export interface ReusableSessionCookie {
  readonly origin: string
  readonly name: string
  readonly value: string
  /** A future adapter must fail closed outside these exact observed paths. */
  readonly observedRequestPaths: ReadonlyArray<string>
}

/** This complete object is secret and may exist only in trusted memory or encrypted vault ciphertext. */
export interface ReusableSessionSnapshot {
  readonly formatVersion: 1
  readonly profileRevision: typeof HAR_VALUE_PROFILE_REVISION
  readonly siteId: string
  readonly sourceImportDigest: string
  readonly headers: ReadonlyArray<ReusableSessionHeader>
  readonly cookies: ReadonlyArray<ReusableSessionCookie>
}

const SENSITIVE_HEADER = /(?:^|[-_])(?:api[-_]?key|auth(?:entication|orization)?|cookie|csrf|password|secret|session|token)(?:[-_]|$)/iu
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|x-api-key)$/iu
const CSRF_HEADER = /^(?:x-csrf-token|x-xsrf-token)$/iu
const RECOMPUTED_HEADER = /^(?:content-length|date|idempotency-key|sentry-trace|traceparent|tracestate|x-correlation-id|x-request-id)$/iu

const groupKeyOf = (observation: Pick<HarSessionValueObservation, "kind" | "origin" | "name">): string =>
  `${observation.kind}\u0000${observation.origin}\u0000${observation.kind === "header" ? observation.name.toLowerCase() : observation.name}`

const stabilityOf = (observations: ReadonlyArray<HarSessionValueObservation>): HarValueStability => {
  const distinct = new Set(observations.map((item) => item.value)).size
  if (distinct <= 1) return "capture_static"
  if (distinct === observations.length) return "per_request_unique"
  const families = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const observation of observations) {
    const values = families.get(observation.requestFamily) ?? new Set<string>()
    values.add(observation.value)
    families.set(observation.requestFamily, values)
    counts.set(observation.requestFamily, (counts.get(observation.requestFamily) ?? 0) + 1)
  }
  const hasRepeatedFamily = [...counts.values()].some((count) => count > 1)
  if (hasRepeatedFamily && [...families.values()].every((values) => values.size === 1)) {
    return "request_family_static"
  }
  return "grouped_dynamic"
}

const handlingOf = (
  kind: HarSessionValueKind,
  name: string,
  stability: HarValueStability,
  priorResponseMatches: number,
  observations: number
): HarValueHandling => {
  if (kind === "cookie" || SENSITIVE_HEADER.test(name)) return "session_reinject"
  if (priorResponseMatches === observations && observations > 0) return "response_reinject"
  if (RECOMPUTED_HEADER.test(name)) return "recompute"
  if (stability === "per_request_unique") return "unresolved_dynamic"
  if (stability === "capture_static") return observations >= 2 ? "reuse_static" : "unresolved_dynamic"
  if (stability === "request_family_static") return "reuse_family_static"
  return "context_reinject"
}

const groupedObservations = (
  observations: ReadonlyArray<HarSessionValueObservation>
): ReadonlyMap<string, ReadonlyArray<HarSessionValueObservation>> => {
  if (observations.length > MAX_SESSION_VALUE_OBSERVATIONS) {
    throw new Error(`Session profile exceeds ${MAX_SESSION_VALUE_OBSERVATIONS} observations`)
  }
  const groups = new Map<string, HarSessionValueObservation[]>()
  for (const observation of observations) {
    if (
      observation.value.length === 0 || observation.value.length > 16_384 ||
      observation.name.length === 0 || observation.name.length > 128 ||
      !Number.isSafeInteger(observation.order) || observation.order < 0
    ) throw new Error("Session observation is outside the trusted value-profile bounds")
    const key = groupKeyOf(observation)
    const group = groups.get(key) ?? []
    group.push(observation)
    groups.set(key, group)
  }
  if (groups.size > MAX_SESSION_VALUE_PROFILES) {
    throw new Error(`Session profile exceeds ${MAX_SESSION_VALUE_PROFILES} fields`)
  }
  return groups
}

export const profileHarSessionValues = (
  observations: ReadonlyArray<HarSessionValueObservation>
): HarValueProfile => {
  const entries = [...groupedObservations(observations).values()].map((group): HarValueProfileEntry => {
    const stability = stabilityOf(group)
    const priorResponseMatches = group.filter((item) => item.responseDerived === true).length
    const familyCounts = new Map<string, number>()
    for (const observation of group) {
      familyCounts.set(observation.requestFamily, (familyCounts.get(observation.requestFamily) ?? 0) + 1)
    }
    return {
      kind: group[0]!.kind,
      origin: group[0]!.origin,
      name: group[0]!.kind === "header" ? group[0]!.name.toLowerCase() : group[0]!.name,
      observations: group.length,
      distinctValues: new Set(group.map((item) => item.value)).size,
      requestFamilies: familyCounts.size,
      repeatedRequestFamilies: [...familyCounts.values()].filter((count) => count > 1).length,
      priorResponseMatches,
      lineage: priorResponseMatches === 0
        ? "not_observed"
        : priorResponseMatches === group.length ? "response_derived" : "mixed",
      stability,
      handling: handlingOf(group[0]!.kind, group[0]!.name, stability, priorResponseMatches, group.length)
    }
  }).sort((left, right) =>
    compareText(left.origin, right.origin) || compareText(left.kind, right.kind) || compareText(left.name, right.name))
  const cookieFields = entries.filter((entry) => entry.kind === "cookie").length
  const credentialHeaderFields = entries.filter((entry) => entry.kind === "header" && CREDENTIAL_HEADER.test(entry.name)).length
  const csrfHeaderFields = entries.filter((entry) => entry.kind === "header" && CSRF_HEADER.test(entry.name)).length
  return Object.freeze({
    revision: HAR_VALUE_PROFILE_REVISION,
    observations: observations.length,
    sessionMaterial: Object.freeze({
      assessment: cookieFields + credentialHeaderFields > 0
        ? "candidate_material_observed"
        : csrfHeaderFields > 0
          ? "ambient_credentials_missing"
          : "not_observed",
      cookieFields,
      credentialHeaderFields,
      csrfHeaderFields
    }),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry)))
  })
}

const familyDigest = (family: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(family).digest("hex")}`

export const reusableSessionSnapshotOf = (input: {
  readonly siteId: string
  readonly sourceImportDigest: string
  readonly observations: ReadonlyArray<HarSessionValueObservation>
}): ReusableSessionSnapshot => {
  const groups = groupedObservations(input.observations)
  const headers: ReusableSessionHeader[] = []
  const cookies: ReusableSessionCookie[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.order - right.order)
    const latest = ordered.at(-1)!
    const stability = stabilityOf(ordered)
    const priorResponseMatches = ordered.filter((item) => item.responseDerived === true).length
    const handling = handlingOf(latest.kind, latest.name, stability, priorResponseMatches, ordered.length)
    if (latest.kind === "cookie") {
      const latestByPath = new Map<string, HarSessionValueObservation>()
      for (const observation of ordered) latestByPath.set(observation.cookieRequestPath ?? "/", observation)
      const pathsByValue = new Map<string, string[]>()
      for (const [path, observation] of latestByPath) {
        const paths = pathsByValue.get(observation.value) ?? []
        paths.push(path)
        pathsByValue.set(observation.value, paths)
      }
      for (const [value, paths] of pathsByValue) {
        cookies.push({
          origin: latest.origin,
          name: latest.name,
          value,
          observedRequestPaths: paths.sort(compareText)
        })
      }
      continue
    }
    if (handling === "response_reinject" || handling === "recompute" || handling === "unresolved_dynamic") continue
    const latestByFamily = new Map<string, HarSessionValueObservation>()
    for (const observation of ordered) latestByFamily.set(observation.requestFamily, observation)
    const candidates = stability === "capture_static"
      ? [latest]
      : [...latestByFamily.values()].sort((left, right) => compareText(left.requestFamily, right.requestFamily))
    if (candidates.length > MAX_STORED_VARIANTS_PER_PROFILE) {
      throw new Error(`Session header ${JSON.stringify(latest.name)} exceeds its reusable variant bound`)
    }
    headers.push({
      origin: latest.origin,
      name: latest.name,
      stability,
      handling,
      variants: candidates.map((item) => ({ requestFamilyDigest: familyDigest(item.requestFamily), value: item.value }))
    })
  }
  headers.sort((left, right) => compareText(left.origin, right.origin) || compareText(left.name, right.name))
  cookies.sort((left, right) => compareText(left.origin, right.origin) || compareText(left.name, right.name))
  const snapshot: ReusableSessionSnapshot = {
    formatVersion: 1,
    profileRevision: HAR_VALUE_PROFILE_REVISION,
    siteId: input.siteId,
    sourceImportDigest: input.sourceImportDigest,
    headers,
    cookies
  }
  // Exercise deterministic serialization here before this secret object reaches encrypted storage.
  canonicalStringify(snapshot)
  return snapshot
}

