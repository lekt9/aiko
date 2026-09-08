import { Schema } from "effect"
import { output } from "tardie"

import type { SiteHarnessArtifact } from "./harness-artifact"
import type { HarnessDraftIssue } from "./harness-builder"
import type { ValidatedHarCaptureFacts } from "./har-component"
import { canonicalStringify, compareText, sha256, type NormalizedHarTrace, type RequestDependency } from "./har"
import {
  responseSemanticEvidenceOf,
  responseSemanticsByRequest,
  type ResponseSemanticEvidence
} from "./har-response-semantics"

export const HARNESS_AUTHOR_ACTOR_NAME = "har-harness-author" as const
export const HARNESS_AUTHOR_SCHEMA_VERSION = 2 as const
export const HARNESS_AUTHOR_ABI = "harness-author-proposal/2" as const
export const HARNESS_AUTHOR_REVISION = "harness-author/7" as const
export const MAX_AUTHOR_REQUESTS = 64
export const MAX_AUTHOR_DEPENDENCIES = 128
export const MAX_AUTHOR_FINDINGS = 64
export const MAX_AUTHOR_READ_INTERFACES = 12
export const MAX_AUTHOR_INTERFACE_LABELS = 64
export const MAX_AUTHOR_DEPENDENCY_LABELS = 64
export const MAX_AUTHOR_LABEL_NAME_CHARS = 80
export const MAX_AUTHOR_LABEL_DESCRIPTION_CHARS = 280
export const MAX_AUTHOR_TOOL_CALLS = 8
export const MAX_AUTHOR_MODEL_CALLS = MAX_AUTHOR_TOOL_CALLS + 1
export const MAX_AUTHOR_EVIDENCE_CHARS = 128_000
export const MAX_AUTHOR_MESSAGE_CHARS = 4_000
export const MAX_AUTHOR_RESPONSE_SEMANTIC_FIELDS = 6
export const MAX_AUTHOR_RESPONSE_SEMANTIC_CONCEPTS = 8

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const SENSITIVE_INTERFACE_ID = /(?:^|[._-])(?:api[-_]?key|authorization|bearer|cookie|credential|csrf|password|private[-_]?key|secret|session|token|xsrf)(?:$|[._-])/iu
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => value.length <= max,
  { title: `at most ${max} characters` }
)))
const matchingString = (pattern: RegExp, max: number, title: string) => boundedString(max).pipe(
  Schema.check(Schema.makeFilter((value: string) => pattern.test(value), { title }))
)
const IdentifierSchema = matchingString(SAFE_ID, 64, "safe lowercase identifier")
const DigestSchema = matchingString(DIGEST, 71, "sha256 digest")
const RequestIdSchema = boundedString(128)
const safeSemanticText = (value: string): boolean =>
  value.trim() === value && value.length > 0 &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  !/(?:https?:\/\/|vault:v1:|sha256:|(?:^|\s)\/[A-Za-z0-9])/iu.test(value)
const SemanticNameSchema = boundedString(MAX_AUTHOR_LABEL_NAME_CHARS).pipe(Schema.check(Schema.makeFilter(
  safeSemanticText,
  { title: "non-empty value-free single-line semantic name" }
)))
const SemanticDescriptionSchema = boundedString(MAX_AUTHOR_LABEL_DESCRIPTION_CHARS).pipe(Schema.check(Schema.makeFilter(
  safeSemanticText,
  { title: "non-empty value-free single-line semantic description" }
)))
const DependencyReasonSchema = Schema.Literals(["redirect", "initiator", "referer", "cookie", "value-flow"])
const FindingCodeSchema = Schema.Literals([
  "ambiguous_dependency",
  "array_selection_required",
  "dynamic_value_missing",
  "session_adapter_required",
  "site_control_dependency",
  "status_unknown"
])
const ReadInterfaceSchema = Schema.Struct({
  id: IdentifierSchema,
  sourceRequestId: RequestIdSchema,
  intent: Schema.Literals(["list", "detail", "lookup"])
})
const InterfaceLabelSchema = Schema.Struct({
  interfaceId: IdentifierSchema,
  name: SemanticNameSchema,
  description: SemanticDescriptionSchema
})
const DependencyLabelSchema = Schema.Struct({
  from: RequestIdSchema,
  to: RequestIdSchema,
  reason: DependencyReasonSchema,
  evidence: boundedString(512),
  name: SemanticNameSchema,
  description: SemanticDescriptionSchema
})
const FindingDecisionSchema = Schema.Struct({
  actionId: IdentifierSchema,
  stepId: IdentifierSchema,
  location: boundedString(512),
  code: FindingCodeSchema,
  resolution: Schema.Literals(["caller_input", "external_session_actor", "unsupported"])
})

export const HarnessAuthorProposalSchema = Schema.Struct({
  schemaVersion: Schema.Literal(HARNESS_AUTHOR_SCHEMA_VERSION),
  proposalAbi: Schema.Literal(HARNESS_AUTHOR_ABI),
  captureId: boundedString(128),
  importDigest: DigestSchema,
  readInterfaces: Schema.Array(ReadInterfaceSchema).pipe(Schema.check(Schema.makeFilter(
    (values) => values.length <= MAX_AUTHOR_READ_INTERFACES,
    { title: `at most ${MAX_AUTHOR_READ_INTERFACES} read interfaces` }
  ))),
  interfaceLabels: Schema.Array(InterfaceLabelSchema).pipe(Schema.check(Schema.makeFilter(
    (values) => values.length <= MAX_AUTHOR_INTERFACE_LABELS,
    { title: `at most ${MAX_AUTHOR_INTERFACE_LABELS} interface labels` }
  ))),
  dependencyLabels: Schema.Array(DependencyLabelSchema).pipe(Schema.check(Schema.makeFilter(
    (values) => values.length <= MAX_AUTHOR_DEPENDENCY_LABELS,
    { title: `at most ${MAX_AUTHOR_DEPENDENCY_LABELS} dependency labels` }
  ))),
  findingDecisions: Schema.Array(FindingDecisionSchema).pipe(Schema.check(Schema.makeFilter(
    (values) => values.length <= MAX_AUTHOR_FINDINGS,
    { title: `at most ${MAX_AUTHOR_FINDINGS} finding decisions` }
  )))
})
export type HarnessAuthorProposal = typeof HarnessAuthorProposalSchema.Type

export const HARNESS_AUTHOR_OUTPUT_CONTRACT = output({
  name: "harness_author_proposal_v2",
  schema: {
    type: "object",
    description: "A value-free proposal selecting observed reads, semantically labeling interfaces and exact dependencies, and classifying draft findings.",
    properties: {
      schemaVersion: { type: "integer", description: "Always 2." },
      proposalAbi: { type: "string", enum: [HARNESS_AUTHOR_ABI] },
      captureId: { type: "string", description: "Copy the supplied captureId exactly." },
      importDigest: { type: "string", description: "Copy the supplied importDigest exactly." },
      readInterfaces: {
        type: "array",
        description: `At most ${MAX_AUTHOR_READ_INTERFACES} useful interfaces backed by offered GET or HEAD requests.`,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable lowercase semantic interface ID." },
            sourceRequestId: { type: "string", description: "An exact request ID returned with readInterfaceEligible true." },
            intent: { type: "string", enum: ["list", "detail", "lookup"] }
          },
          required: ["id", "sourceRequestId", "intent"],
          additionalProperties: false
        }
      },
      interfaceLabels: {
        type: "array",
        description: "Exactly one plain-language name and description for every existing interface and every ID proposed in readInterfaces.",
        items: {
          type: "object",
          properties: {
            interfaceId: { type: "string", description: "An exact existing or newly proposed interface ID." },
            name: { type: "string", description: `Non-empty single-line name; at most ${MAX_AUTHOR_LABEL_NAME_CHARS} characters.` },
            description: { type: "string", description: `Non-empty single-line description grounded in a supplied responseSemantics concept when available; at most ${MAX_AUTHOR_LABEL_DESCRIPTION_CHARS} characters.` }
          },
          required: ["interfaceId", "name", "description"],
          additionalProperties: false
        }
      },
      dependencyLabels: {
        type: "array",
        description: "Optional semantic labels for exact dependency edges returned by har_graph_neighbors. Never guess an edge; the controller ignores labels for dependencies the compiled harness does not use.",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            reason: { type: "string", enum: ["redirect", "initiator", "referer", "cookie", "value-flow"] },
            evidence: { type: "string" },
            name: { type: "string", description: `Non-empty single-line name; at most ${MAX_AUTHOR_LABEL_NAME_CHARS} characters.` },
            description: { type: "string", description: `Non-empty single-line description; at most ${MAX_AUTHOR_LABEL_DESCRIPTION_CHARS} characters.` }
          },
          required: ["from", "to", "reason", "evidence", "name", "description"],
          additionalProperties: false
        }
      },
      findingDecisions: {
        type: "array",
        description: "Zero or one disposition for an exact supplied finding. Omitted findings remain unresolved.",
        items: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            stepId: { type: "string" },
            location: { type: "string" },
            code: {
              type: "string",
              enum: [
                "ambiguous_dependency",
                "array_selection_required",
                "dynamic_value_missing",
                "session_adapter_required",
                "site_control_dependency",
                "status_unknown"
              ]
            },
            resolution: { type: "string", enum: ["caller_input", "external_session_actor", "unsupported"] }
          },
          required: ["actionId", "stepId", "location", "code", "resolution"],
          additionalProperties: false
        }
      }
    },
    required: ["schemaVersion", "proposalAbi", "captureId", "importDigest", "readInterfaces", "interfaceLabels", "dependencyLabels", "findingDecisions"],
    additionalProperties: false
  }
})

export interface HarnessAuthorRequestEvidence {
  readonly id: string
  readonly index: number
  readonly method: string
  readonly resourceType: string
  readonly path: string
  readonly queryFields: ReadonlyArray<string>
  readonly headerFields: ReadonlyArray<string>
  readonly cookieNames: ReadonlyArray<string>
  readonly requestMimeType: string
  readonly responseStatus: number
  readonly responseMimeType: string
  readonly responseSemantics: ResponseSemanticEvidence
  readonly readInterfaceEligible: boolean
}

export interface HarnessAuthorDependencyEvidence {
  readonly from: string
  readonly to: string
  readonly reason: RequestDependency["reason"]
  readonly evidence: string
  readonly confidence: number
}

export interface HarnessAuthorFindingEvidence {
  readonly actionId: string
  readonly stepId: string
  readonly location: string
  readonly code: HarnessDraftIssue["code"]
}

export interface HarnessAuthorExistingInterface {
  readonly id: string
  readonly sourceRequestId: string
  readonly method: string
}

export interface HarnessAuthorBrief {
  readonly schemaVersion: typeof HARNESS_AUTHOR_SCHEMA_VERSION
  readonly proposalAbi: typeof HARNESS_AUTHOR_ABI
  readonly authorRevision: typeof HARNESS_AUTHOR_REVISION
  readonly captureId: string
  readonly importDigest: string
  readonly siteId: string
  readonly primaryOrigin: string
  readonly maximumReadInterfaces: number
  readonly omittedRequests: number
  readonly omittedDependencies: number
  readonly omittedFindings: number
  readonly requests: ReadonlyArray<HarnessAuthorRequestEvidence>
  readonly dependencies: ReadonlyArray<HarnessAuthorDependencyEvidence>
  readonly existingInterfaces: ReadonlyArray<HarnessAuthorExistingInterface>
  readonly findings: ReadonlyArray<HarnessAuthorFindingEvidence>
}

export interface HarnessAuthorDraftEvidence {
  readonly actionCandidateId: string
  readonly artifact: SiteHarnessArtifact
  readonly usedDependencies: ReadonlyArray<Pick<RequestDependency, "from" | "to" | "reason" | "evidence">>
  readonly unresolved: ReadonlyArray<Pick<HarnessDraftIssue, "stepId" | "location" | "code">>
}

export class HarnessAuthorProposalError extends Error {
  constructor(readonly code: "output_invalid" | "identity_mismatch" | "evidence_mismatch" | "limit_exceeded", message: string) {
    super(message)
    this.name = "HarnessAuthorProposalError"
  }
}

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareText)

const readInterfaceEligible = (method: string, responseMimeType: string): boolean =>
  (method === "GET" || method === "HEAD") && responseMimeType.includes("json")

const firstPartyPriority = (
  requestId: string,
  method: string,
  responseMimeType: string,
  existingRequestIds: ReadonlySet<string>
): number => {
  if (existingRequestIds.has(requestId)) return 0
  if (readInterfaceEligible(method, responseMimeType)) return 1
  if (method === "GET" || method === "HEAD") return 2
  return 3
}

/**
 * Builds the model brief from manifest-validated identities plus bounded response semantics
 * derived from the exact retained trace. It contains allowlisted concepts, safe field paths,
 * types, roles, and counts, never request/response values, value hashes, or raw HAR bytes.
 * A trusted controller may select a page/neighborhood; the same bounds and origin
 * checks still apply. Omitting the selection preserves the author actor's priority order.
 */
export const harnessAuthorBriefOf = (
  capture: ValidatedHarCaptureFacts,
  primaryOrigin: string,
  drafts: ReadonlyArray<HarnessAuthorDraftEvidence>,
  maximumInterfaces: number,
  responseTrace?: NormalizedHarTrace,
  includedRequestIds?: ReadonlySet<string>
): HarnessAuthorBrief => {
  const existingRequestIds = new Set(drafts.map((draft) =>
    capture.actions.find((candidate) => candidate.id === draft.actionCandidateId)?.requestId
  ).filter((value): value is string => value !== undefined))
  const firstParty = capture.exchanges.filter((exchange) => exchange.request.origin === primaryOrigin)
  const selected = [...firstParty]
    .filter((exchange) => includedRequestIds === undefined || includedRequestIds.has(exchange.requestId))
    .sort((left, right) => {
      const leftPriority = firstPartyPriority(left.requestId, left.request.method, left.response.mimeType, existingRequestIds)
      const rightPriority = firstPartyPriority(right.requestId, right.request.method, right.response.mimeType, existingRequestIds)
      return leftPriority - rightPriority || left.index - right.index || compareText(left.requestId, right.requestId)
    })
    .slice(0, MAX_AUTHOR_REQUESTS)
    .sort((left, right) => left.index - right.index || compareText(left.requestId, right.requestId))
  const selectedIds = new Set(selected.map((exchange) => exchange.requestId))
  const responseSemantics = responseTrace === undefined
    ? undefined
    : responseSemanticsByRequest(responseTrace, selectedIds)
  const sourceDependencies = capture.dependencies.filter((dependency) =>
    selectedIds.has(dependency.from) && selectedIds.has(dependency.to))
  const dependencies = sourceDependencies.slice(0, MAX_AUTHOR_DEPENDENCIES).map((dependency) => ({
    from: dependency.from,
    to: dependency.to,
    reason: dependency.reason,
    evidence: dependency.evidence,
    confidence: dependency.confidence
  }))
  const sourceFindings = drafts.flatMap((draft) => {
    const actionId = draft.artifact.actions[0]?.id
    return actionId === undefined ? [] : draft.unresolved.map((finding) => ({ actionId, ...finding }))
  }).sort((left, right) => compareText(
    `${left.actionId}\u0000${left.stepId}\u0000${left.location}\u0000${left.code}`,
    `${right.actionId}\u0000${right.stepId}\u0000${right.location}\u0000${right.code}`
  ))
  const maximumReadInterfaces = Math.max(0, Math.min(
    MAX_AUTHOR_READ_INTERFACES,
    maximumInterfaces - drafts.length
  ))
  const brief: HarnessAuthorBrief = {
    schemaVersion: HARNESS_AUTHOR_SCHEMA_VERSION,
    proposalAbi: HARNESS_AUTHOR_ABI,
    authorRevision: HARNESS_AUTHOR_REVISION,
    captureId: capture.captureId,
    importDigest: capture.importDigest,
    siteId: drafts[0]?.artifact.siteId ?? "website",
    primaryOrigin,
    maximumReadInterfaces,
    omittedRequests: Math.max(0, firstParty.length - selected.length),
    omittedDependencies: Math.max(0, sourceDependencies.length - dependencies.length),
    omittedFindings: Math.max(0, sourceFindings.length - MAX_AUTHOR_FINDINGS),
    requests: selected.map((exchange) => ({
      id: exchange.requestId,
      index: exchange.index,
      method: exchange.request.method,
      resourceType: exchange.resourceType ?? "other",
      path: exchange.request.path,
      queryFields: uniqueSorted(exchange.request.queryFields),
      headerFields: uniqueSorted(exchange.request.headerFields),
      cookieNames: uniqueSorted(exchange.request.cookieNames),
      requestMimeType: exchange.request.body?.mimeType ?? "",
      responseStatus: exchange.response.status,
      responseMimeType: exchange.response.mimeType,
      responseSemantics: (() => {
        const semantics = responseSemantics?.get(exchange.requestId) ?? responseSemanticEvidenceOf({
          mimeType: exchange.response.mimeType,
          truncated: exchange.response.body?.truncated ?? false
        })
        return {
          ...semantics,
          concepts: semantics.concepts.slice(0, MAX_AUTHOR_RESPONSE_SEMANTIC_CONCEPTS),
          fields: semantics.fields.slice(0, MAX_AUTHOR_RESPONSE_SEMANTIC_FIELDS)
        }
      })(),
      readInterfaceEligible: readInterfaceEligible(exchange.request.method, exchange.response.mimeType)
    })),
    dependencies,
    existingInterfaces: drafts.flatMap((draft) => {
      const action = draft.artifact.actions[0]
      const candidate = capture.actions.find((item) => item.id === draft.actionCandidateId)
      return action === undefined || candidate === undefined ? [] : [{
        id: action.id,
        sourceRequestId: candidate.requestId,
        method: candidate.method
      }]
    }).sort((left, right) => compareText(left.id, right.id)),
    findings: sourceFindings.slice(0, MAX_AUTHOR_FINDINGS)
  }
  if (canonicalStringify(brief).length > MAX_AUTHOR_EVIDENCE_CHARS) {
    throw new HarnessAuthorProposalError("limit_exceeded", "The value-free author evidence exceeds its bounded snapshot budget.")
  }
  return Object.freeze(brief)
}

const findingKey = (finding: HarnessAuthorFindingEvidence): string =>
  `${finding.actionId}\u0000${finding.stepId}\u0000${finding.location}\u0000${finding.code}`
const dependencyKey = (dependency: Pick<HarnessAuthorDependencyEvidence, "from" | "to" | "reason" | "evidence">): string =>
  `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`

export const validateHarnessAuthorProposal = (
  value: unknown,
  brief: HarnessAuthorBrief
): HarnessAuthorProposal => {
  let proposal: HarnessAuthorProposal
  try {
    proposal = Schema.decodeUnknownSync(HarnessAuthorProposalSchema, { onExcessProperty: "error" })(value)
  } catch {
    throw new HarnessAuthorProposalError("output_invalid", "The author output does not satisfy the exact proposal schema.")
  }
  if (proposal.captureId !== brief.captureId || proposal.importDigest !== brief.importDigest) {
    throw new HarnessAuthorProposalError("identity_mismatch", "The author output does not match the requested capture identity.")
  }
  if (proposal.readInterfaces.length > brief.maximumReadInterfaces) {
    throw new HarnessAuthorProposalError("limit_exceeded", "The author proposed more read interfaces than the controller permits.")
  }
  const requests = new Map(brief.requests.map((request) => [request.id, request]))
  const existingIds = new Set(brief.existingInterfaces.map((item) => item.id))
  const interfaceIds = new Set<string>()
  const sourceIds = new Set<string>()
  for (const item of proposal.readInterfaces) {
    const request = requests.get(item.sourceRequestId)
    if (
      request === undefined || !request.readInterfaceEligible ||
      !readInterfaceEligible(request.method, request.responseMimeType)
    ) {
      throw new HarnessAuthorProposalError("evidence_mismatch", "A proposed interface is not backed by an offered JSON read request.")
    }
    if (existingIds.has(item.id) || interfaceIds.has(item.id) || sourceIds.has(item.sourceRequestId)) {
      throw new HarnessAuthorProposalError("evidence_mismatch", "The author proposal contains a duplicate interface identity or request binding.")
    }
    if (SENSITIVE_INTERFACE_ID.test(item.id)) {
      throw new HarnessAuthorProposalError("evidence_mismatch", "A proposed interface identity contains a blocked credential or session term.")
    }
    interfaceIds.add(item.id)
    sourceIds.add(item.sourceRequestId)
  }
  const expectedLabelIds = [...existingIds, ...interfaceIds].sort(compareText)
  const labelIds = proposal.interfaceLabels.map((label) => label.interfaceId).sort(compareText)
  if (
    new Set(labelIds).size !== labelIds.length ||
    canonicalStringify(labelIds) !== canonicalStringify(expectedLabelIds)
  ) {
    throw new HarnessAuthorProposalError(
      "evidence_mismatch",
      "Interface labels must name every existing and newly proposed interface exactly once."
    )
  }
  const sourceByInterface = new Map(brief.existingInterfaces.map((item) => [item.id, item.sourceRequestId]))
  proposal.readInterfaces.forEach((item) => sourceByInterface.set(item.id, item.sourceRequestId))
  const normalizedWord = (word: string): string => word.length > 5 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 4 && word.endsWith("s") && !/(?:ss|status|us)$/u.test(word) ? word.slice(0, -1)
      : word
  for (const label of proposal.interfaceLabels) {
    const sourceRequestId = sourceByInterface.get(label.interfaceId)
    const semantics = sourceRequestId === undefined ? undefined : requests.get(sourceRequestId)?.responseSemantics
    if (semantics === undefined || semantics.source === "unavailable" || semantics.concepts.length === 0) continue
    const descriptionWords = new Set((label.description.toLowerCase().match(/[a-z0-9]+/gu) ?? []).map(normalizedWord))
    if (!semantics.concepts.some((concept) => descriptionWords.has(normalizedWord(concept)))) {
      throw new HarnessAuthorProposalError(
        "evidence_mismatch",
        "An interface description is not grounded in any supplied response semantic concept."
      )
    }
  }
  const offeredDependencies = new Set(brief.dependencies.map(dependencyKey))
  const labeledDependencies = new Set<string>()
  for (const label of proposal.dependencyLabels) {
    const key = dependencyKey(label)
    if (!offeredDependencies.has(key) || labeledDependencies.has(key)) {
      throw new HarnessAuthorProposalError(
        "evidence_mismatch",
        "A dependency label does not name one exact offered dependency edge."
      )
    }
    labeledDependencies.add(key)
  }
  const findings = new Map(brief.findings.map((finding) => [findingKey(finding), finding]))
  const decisions = new Set<string>()
  for (const decision of proposal.findingDecisions) {
    const key = findingKey(decision)
    const finding = findings.get(key)
    if (finding === undefined || decisions.has(key)) {
      throw new HarnessAuthorProposalError("evidence_mismatch", "A finding decision does not name one exact offered finding.")
    }
    const compatible = decision.resolution === "unsupported" ||
      (decision.code === "array_selection_required" && decision.resolution === "caller_input") ||
      (decision.code === "session_adapter_required" && decision.resolution === "external_session_actor")
    if (!compatible) {
      throw new HarnessAuthorProposalError("evidence_mismatch", "A finding decision requests a producer that this compiler does not implement.")
    }
    decisions.add(key)
  }
  return Object.freeze({
    ...proposal,
    readInterfaces: Object.freeze(proposal.readInterfaces.map((item) => Object.freeze({ ...item }))),
    interfaceLabels: Object.freeze(proposal.interfaceLabels.map((item) => Object.freeze({ ...item }))),
    dependencyLabels: Object.freeze(proposal.dependencyLabels.map((item) => Object.freeze({ ...item }))),
    findingDecisions: Object.freeze(proposal.findingDecisions.map((item) => Object.freeze({ ...item })))
  })
}

export const harnessAuthorBriefDigest = (brief: HarnessAuthorBrief): `sha256:${string}` =>
  `sha256:${sha256(canonicalStringify(brief))}`

export const harnessAuthorProposalDigest = (proposal: HarnessAuthorProposal): `sha256:${string}` =>
  `sha256:${sha256(canonicalStringify(proposal))}`

export interface HarnessAuthorFindingDisposition {
  readonly resolvedByCallerInput: ReadonlySet<string>
  readonly externalSessionActor: ReadonlySet<string>
}

export const harnessAuthorFindingDisposition = (
  proposal: HarnessAuthorProposal
): HarnessAuthorFindingDisposition => {
  const resolvedByCallerInput = new Set<string>()
  const externalSessionActor = new Set<string>()
  for (const decision of proposal.findingDecisions) {
    const key = findingKey(decision)
    if (decision.resolution === "caller_input") resolvedByCallerInput.add(key)
    if (decision.resolution === "external_session_actor") externalSessionActor.add(key)
  }
  return { resolvedByCallerInput, externalSessionActor }
}

export const harnessAuthorFindingKey = findingKey
export const harnessAuthorDependencyKey = dependencyKey
