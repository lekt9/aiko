import { createHash } from "node:crypto"
import {
  SITE_HARNESS_LIMITS,
  validateSiteHarnessArtifact,
  type HarnessInput,
  type HarnessInputType,
  type Sha256Digest,
  type SiteHarnessArtifact
} from "./harness-artifact"

export const SITE_INTERFACE_SCHEMA_VERSION = 1 as const
export const SITE_INTERFACE_ABI = "site-interface/1" as const
export const HARNESS_LIFECYCLE_EVENT_ID_VERSION = 1 as const

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const METHOD_NAME = /^[a-z][A-Za-z0-9-]{0,62}$/u
const INPUT_TYPES = new Set<HarnessInputType>(["string", "number", "integer", "boolean", "json"])
const MAX_CONTRACT_BYTES = 64 * 1024
const METHOD_SLUG_LENGTH = 42
const METHOD_HASH_LENGTH = 12

export interface SiteInterfaceInput {
  readonly name: string
  readonly type: HarnessInputType
  readonly required: boolean
}

export interface SiteInterfaceAction {
  readonly id: string
  readonly methodName: string
  readonly inputs: ReadonlyArray<SiteInterfaceInput>
}

export interface SiteInterfaceContract {
  readonly schemaVersion: typeof SITE_INTERFACE_SCHEMA_VERSION
  readonly interfaceAbi: typeof SITE_INTERFACE_ABI
  readonly siteId: string
  readonly actions: ReadonlyArray<SiteInterfaceAction>
}

export type HarnessLifecyclePhase =
  | "activation"
  | "generated"
  | "definition-approved"
  | "installed"
  | "load-failed"
  | "route"

export interface HarnessLifecycleEventIdentity {
  readonly harnessId: string
  readonly phase: HarnessLifecyclePhase
  readonly targetId?: string
  readonly loadId?: string
}

export interface SiteInterfaceValidationIssue {
  readonly path: string
  readonly message: string
}

export class SiteInterfaceValidationError extends Error {
  readonly issues: ReadonlyArray<SiteInterfaceValidationIssue>

  constructor(issues: ReadonlyArray<SiteInterfaceValidationIssue>) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    this.name = "SiteInterfaceValidationError"
    this.issues = Object.freeze([...issues])
  }
}

type UnknownRecord = Record<string, unknown>

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex")

export const harnessLifecycleEventId = (identity: HarnessLifecycleEventIdentity): string => {
  if (!/^sha256:[0-9a-f]{64}$/u.test(identity.harnessId)) {
    throw new Error("lifecycle harnessId must be a lowercase SHA-256 digest")
  }
  const targeted = identity.phase !== "activation" && identity.phase !== "generated"
  if (targeted !== (identity.targetId !== undefined && identity.loadId !== undefined)) {
    throw new Error(`lifecycle phase ${JSON.stringify(identity.phase)} has inconsistent target scope`)
  }
  return `hle${HARNESS_LIFECYCLE_EVENT_ID_VERSION}:${sha256Hex(canonicalJson({
    schemaVersion: HARNESS_LIFECYCLE_EVENT_ID_VERSION,
    harnessId: identity.harnessId,
    phase: identity.phase,
    targetId: identity.targetId ?? null,
    loadId: identity.loadId ?? null
  }))}`
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const deepFreeze = <T>(value: T, seen: Set<object> = new Set()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains a non-finite number")
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (!isRecord(value)) throw new Error("canonical JSON contains a non-JSON object")
  return `{${Object.keys(value).sort(compareText).map((key) => {
    const nested = value[key]
    if (nested === undefined) throw new Error(`canonical JSON contains undefined at ${JSON.stringify(key)}`)
    return `${JSON.stringify(key)}:${canonicalJson(nested)}`
  }).join(",")}}`
}

const issue = (issues: SiteInterfaceValidationIssue[], path: string, message: string): void => {
  issues.push({ path, message })
}

const recordAt = (
  value: unknown,
  path: string,
  issues: SiteInterfaceValidationIssue[]
): UnknownRecord => {
  if (isRecord(value)) return value
  issue(issues, path, "must be a plain object")
  return Object.create(null) as UnknownRecord
}

const exactFields = (
  value: UnknownRecord,
  required: ReadonlyArray<string>,
  path: string,
  issues: SiteInterfaceValidationIssue[]
): void => {
  const allowed = new Set(required)
  for (const field of required) {
    if (!Object.hasOwn(value, field)) issue(issues, `${path}.${field}`, "is required")
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issue(issues, `${path}.${field}`, "is not allowed")
  }
}

const identifierAt = (
  value: unknown,
  path: string,
  issues: SiteInterfaceValidationIssue[]
): string => {
  if (typeof value !== "string" || value.length > 64 || !IDENTIFIER.test(value)) {
    issue(issues, path, "must be a lowercase identifier of at most 64 characters")
    return "invalid"
  }
  return value
}

const sortedStrictly = (values: ReadonlyArray<string>): boolean =>
  values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0)

const methodSlugOf = (actionId: string): string =>
  actionId.replace(/[._]+/gu, "-").replace(/-+/gu, "-").slice(0, METHOD_SLUG_LENGTH)

const baseMethodNameOf = (actionId: string, hashLength = METHOD_HASH_LENGTH): string => {
  const digest = sha256Hex(actionId)
  const availableSlug = Math.max(1, 62 - "action--".length - hashLength)
  return `action-${methodSlugOf(actionId).slice(0, availableSlug)}-${digest.slice(0, hashLength)}`
}

/**
 * Maps artifact action identifiers onto Tardigrade's method-name alphabet. The
 * readable slug is not an identity: the digest prevents `a.b`, `a-b`, and
 * `a_b` from aliasing. The deterministic collision branch guarantees a unique
 * table even if two truncated SHA-256 suffixes happen to coincide.
 */
export const siteInterfaceMethodNames = (
  actionIds: ReadonlyArray<string>
): Readonly<Record<string, string>> => {
  const sorted = [...actionIds].sort(compareText)
  if (!sortedStrictly(sorted)) throw new Error("action IDs must be unique")
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  const used = new Set<string>()
  sorted.forEach((actionId, index) => {
    if (actionId.length > 64 || !IDENTIFIER.test(actionId)) {
      throw new Error(`invalid action ID ${JSON.stringify(actionId)}`)
    }
    let methodName = baseMethodNameOf(actionId)
    if (used.has(methodName)) {
      const ordinal = index.toString(36).padStart(2, "0")
      methodName = `action-c${ordinal}-${sha256Hex(actionId).slice(0, 48)}`
      let attempt = 0
      while (used.has(methodName)) {
        attempt += 1
        methodName = `action-c${ordinal}-${attempt.toString(36)}-${sha256Hex(actionId).slice(0, 44)}`
      }
    }
    if (!METHOD_NAME.test(methodName)) throw new Error(`generated invalid method name ${JSON.stringify(methodName)}`)
    used.add(methodName)
    result[actionId] = methodName
  })
  return deepFreeze(result)
}

export const siteInterfaceMethodName = (actionId: string): string =>
  siteInterfaceMethodNames([actionId])[actionId]!

const interfaceInputOf = (input: HarnessInput): SiteInterfaceInput => ({
  name: input.name,
  type: input.type,
  required: input.required
})

/**
 * Derives only the stable public API. Implementation versions, capture
 * digests, origins, request steps, producers, constants, and artifact digests
 * deliberately do not cross this boundary.
 */
export const siteInterfaceContractOf = (value: unknown): SiteInterfaceContract => {
  const artifact = validateSiteHarnessArtifact(value)
  const actions = [...artifact.actions].sort((left, right) => compareText(left.id, right.id))
  const names = siteInterfaceMethodNames(actions.map((action) => action.id))
  return deepFreeze({
    schemaVersion: SITE_INTERFACE_SCHEMA_VERSION,
    interfaceAbi: SITE_INTERFACE_ABI,
    siteId: artifact.siteId,
    actions: actions.map((action): SiteInterfaceAction => ({
      id: action.id,
      methodName: names[action.id]!,
      inputs: [...action.inputs].sort((left, right) => compareText(left.name, right.name)).map(interfaceInputOf)
    }))
  })
}

export const validateSiteInterfaceContract = (value: unknown): SiteInterfaceContract => {
  const issues: SiteInterfaceValidationIssue[] = []
  const root = recordAt(value, "$", issues)
  exactFields(root, ["schemaVersion", "interfaceAbi", "siteId", "actions"], "$", issues)
  if (root.schemaVersion !== SITE_INTERFACE_SCHEMA_VERSION) {
    issue(issues, "$.schemaVersion", `must equal ${SITE_INTERFACE_SCHEMA_VERSION}`)
  }
  if (root.interfaceAbi !== SITE_INTERFACE_ABI) {
    issue(issues, "$.interfaceAbi", `must equal ${JSON.stringify(SITE_INTERFACE_ABI)}`)
  }
  const siteId = identifierAt(root.siteId, "$.siteId", issues)
  const actionValues = Array.isArray(root.actions) ? root.actions : []
  if (!Array.isArray(root.actions)) issue(issues, "$.actions", "must be an array")
  if (actionValues.length < 1 || actionValues.length > SITE_HARNESS_LIMITS.actions) {
    issue(issues, "$.actions", `must contain between 1 and ${SITE_HARNESS_LIMITS.actions} actions`)
  }

  const actions = actionValues.map((value, actionIndex): SiteInterfaceAction => {
    const path = `$.actions[${actionIndex}]`
    const action = recordAt(value, path, issues)
    exactFields(action, ["id", "methodName", "inputs"], path, issues)
    const id = identifierAt(action.id, `${path}.id`, issues)
    const methodName = typeof action.methodName === "string" ? action.methodName : ""
    if (!METHOD_NAME.test(methodName)) issue(issues, `${path}.methodName`, "must be a valid Tardigrade method name")
    const inputValues = Array.isArray(action.inputs) ? action.inputs : []
    if (!Array.isArray(action.inputs)) issue(issues, `${path}.inputs`, "must be an array")
    if (inputValues.length > SITE_HARNESS_LIMITS.inputsPerAction) {
      issue(issues, `${path}.inputs`, `must contain at most ${SITE_HARNESS_LIMITS.inputsPerAction} inputs`)
    }
    const inputs = inputValues.map((value, inputIndex): SiteInterfaceInput => {
      const inputPath = `${path}.inputs[${inputIndex}]`
      const input = recordAt(value, inputPath, issues)
      exactFields(input, ["name", "type", "required"], inputPath, issues)
      const name = identifierAt(input.name, `${inputPath}.name`, issues)
      const type = typeof input.type === "string" && INPUT_TYPES.has(input.type as HarnessInputType)
        ? input.type as HarnessInputType
        : "string"
      if (type !== input.type) issue(issues, `${inputPath}.type`, "must be string, number, integer, boolean, or json")
      const required = typeof input.required === "boolean" ? input.required : false
      if (typeof input.required !== "boolean") issue(issues, `${inputPath}.required`, "must be boolean")
      return { name, type, required }
    })
    if (!sortedStrictly(inputs.map((input) => input.name))) {
      issue(issues, `${path}.inputs`, "must be uniquely sorted by name")
    }
    return { id, methodName, inputs }
  })

  if (!sortedStrictly(actions.map((action) => action.id))) issue(issues, "$.actions", "must be uniquely sorted by id")
  const expectedNames = (() => {
    try {
      return siteInterfaceMethodNames(actions.map((action) => action.id))
    } catch {
      return {} as Readonly<Record<string, string>>
    }
  })()
  for (const [index, action] of actions.entries()) {
    if (expectedNames[action.id] !== action.methodName) {
      issue(issues, `$.actions[${index}].methodName`, "does not match the deterministic action method name")
    }
  }

  const contract: SiteInterfaceContract = {
    schemaVersion: SITE_INTERFACE_SCHEMA_VERSION,
    interfaceAbi: SITE_INTERFACE_ABI,
    siteId,
    actions
  }
  const bytes = new TextEncoder().encode(canonicalJson(contract)).byteLength
  if (bytes > MAX_CONTRACT_BYTES) issue(issues, "$", `canonical contract exceeds ${MAX_CONTRACT_BYTES} bytes`)
  if (issues.length > 0) throw new SiteInterfaceValidationError(issues)
  return deepFreeze(contract)
}

export const canonicalSiteInterfaceContract = (value: unknown): string =>
  canonicalJson(validateSiteInterfaceContract(value))

export const siteInterfaceContractDigest = (value: unknown): Sha256Digest =>
  `sha256:${sha256Hex(canonicalSiteInterfaceContract(value))}`

export const interfaceContractMatchesArtifact = (
  artifact: SiteHarnessArtifact,
  contract: SiteInterfaceContract
): boolean => canonicalSiteInterfaceContract(contract) === canonicalSiteInterfaceContract(siteInterfaceContractOf(artifact))
