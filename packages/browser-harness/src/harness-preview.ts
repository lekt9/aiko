import { createHash } from "node:crypto"

import {
  generatedHarnessActionPlanOf,
  generatedHarnessActorIdentity,
  type GeneratedHarnessProducerKind
} from "./generated-harness-actor"
import {
  createSiteHarnessCandidate,
  type HarnessInputType,
  type SiteHarnessArtifact
} from "./harness-artifact"

export const CAPTURE_LAB_HARNESS_PREVIEW_SCHEMA_VERSION = 1 as const

export interface CaptureLabHarnessInputPreview {
  readonly name: string
  readonly type: HarnessInputType
  readonly required: boolean
}

export interface CaptureLabHarnessStepPreview {
  readonly id: string
  readonly method: string
  readonly path: string
  readonly dependsOn: ReadonlyArray<string>
  readonly expectedStatuses: ReadonlyArray<number>
  readonly producerKinds: ReadonlyArray<GeneratedHarnessProducerKind>
}

export interface CaptureLabHarnessDependencyPreview {
  readonly id: string
  readonly fromStepId: string
  readonly toStepId: string
  readonly reason: "redirect" | "initiator" | "referer" | "cookie" | "value-flow"
  readonly evidence: string
  readonly name: string
  readonly description: string
  readonly labelSource: "model" | "structural"
}

export interface CaptureLabHarnessInterfacePreview {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly labelSource: "model" | "structural"
  readonly methodName: string
  readonly inputs: ReadonlyArray<CaptureLabHarnessInputPreview>
  readonly steps: ReadonlyArray<CaptureLabHarnessStepPreview>
  readonly dependencies: ReadonlyArray<CaptureLabHarnessDependencyPreview>
  readonly producerKinds: ReadonlyArray<GeneratedHarnessProducerKind>
  readonly findingCount: number
}

export interface CaptureLabDraftPart {
  readonly artifact: SiteHarnessArtifact
  readonly findingCount: number
}

export interface CaptureLabCombinedDraft {
  readonly artifact: SiteHarnessArtifact
  readonly findingsByAction: ReadonlyMap<string, number>
  readonly findingCount: number
}

export interface CaptureLabHarnessAuthorshipPreview {
  readonly mode: "model_authored_composition"
  readonly authorActor: string
  readonly authorRevision: string
  readonly proposalDigest: string
  readonly selectedReadInterfaces: number
  readonly callerInputRepairs: number
  readonly externalSessionRequirements: number
}

export interface CaptureLabRequiredActorPreview {
  readonly role: "session_adapter"
  readonly status: "not_mounted"
  readonly findingCount: number
}

export interface CaptureLabInterfaceLabel {
  readonly interfaceId: string
  readonly name: string
  readonly description: string
}

export interface CaptureLabDependencyLabel {
  readonly from: string
  readonly to: string
  readonly reason: CaptureLabHarnessDependencyPreview["reason"]
  readonly evidence: string
  readonly name: string
  readonly description: string
}

export interface CaptureLabUsedDependency {
  readonly from: string
  readonly to: string
  readonly reason: CaptureLabHarnessDependencyPreview["reason"]
  readonly evidence: string
}

export interface CaptureLabHarnessPreview {
  readonly schemaVersion: typeof CAPTURE_LAB_HARNESS_PREVIEW_SCHEMA_VERSION
  readonly mode: "generated_harness_preview"
  readonly buildStatus: "not_built"
  readonly liveExecution: false
  readonly approvalRequired: true
  readonly actorName: string
  readonly siteId: string
  readonly artifactDigest: string
  readonly interfaceDigest: string
  readonly generatorRevision: string
  readonly interfaces: ReadonlyArray<CaptureLabHarnessInterfacePreview>
  readonly authorship?: CaptureLabHarnessAuthorshipPreview
  readonly requiredActors?: ReadonlyArray<CaptureLabRequiredActorPreview>
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const dependencyKeyOf = (dependency: CaptureLabUsedDependency): string =>
  `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`
const humanize = (value: string): string => {
  const words = value
    .replace(/\[\]/gu, " items ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase()
  return words.length === 0 ? "Request" : `${words[0]!.toUpperCase()}${words.slice(1)}`
}
const evidenceLocatorsOf = (evidence: string): { readonly source: string; readonly target: string } | undefined => {
  const separator = " -> "
  const index = evidence.indexOf(separator)
  if (index <= 0 || evidence.indexOf(separator, index + separator.length) !== -1) return undefined
  const source = evidence.slice(0, index).trim()
  const target = evidence.slice(index + separator.length).trim()
  return source.length === 0 || target.length === 0 ? undefined : { source, target }
}
const structuralDependencyLabelOf = (dependency: CaptureLabUsedDependency): Pick<CaptureLabHarnessDependencyPreview, "name" | "description"> => {
  const locators = evidenceLocatorsOf(dependency.evidence)
  if (dependency.reason === "value-flow" && locators !== undefined) {
    return {
      name: `${humanize(locators.target.split(".").at(-1) ?? "value")} response binding`,
      description: `Step ${dependency.from} supplies ${locators.source} to ${locators.target} on step ${dependency.to}.`
    }
  }
  const labels: Readonly<Record<Exclude<CaptureLabHarnessDependencyPreview["reason"], "value-flow">, string>> = {
    redirect: "Redirect continuation",
    initiator: "Initiator prerequisite",
    referer: "Referrer prerequisite",
    cookie: "Cookie-context prerequisite"
  }
  return {
    name: dependency.reason === "value-flow" ? "Response value dependency" : labels[dependency.reason],
    description: `Step ${dependency.from} must precede step ${dependency.to} based on ${dependency.reason} evidence.`
  }
}
const clipped = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
const dependencyPreviewOf = (
  dependency: CaptureLabUsedDependency,
  modelLabel: CaptureLabDependencyLabel | undefined
): CaptureLabHarnessDependencyPreview => {
  const structural = structuralDependencyLabelOf(dependency)
  return {
    id: `dependency-${createHash("sha256").update(dependencyKeyOf(dependency)).digest("hex").slice(0, 20)}`,
    fromStepId: dependency.from,
    toStepId: dependency.to,
    reason: dependency.reason,
    evidence: dependency.evidence,
    name: clipped(modelLabel?.name ?? structural.name, 80),
    description: clipped(modelLabel?.description ?? structural.description, 280),
    labelSource: modelLabel === undefined ? "structural" : "model"
  }
}

const deepFreeze = <T>(value: T, seen: Set<object> = new Set()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export const combineCaptureLabDrafts = (
  parts: ReadonlyArray<CaptureLabDraftPart>
): CaptureLabCombinedDraft => {
  const first = parts[0]?.artifact
  if (first === undefined) throw new Error("Cannot combine an empty Capture Lab draft set")
  if (parts.some(({ artifact }) =>
    artifact.actions.length !== 1 || artifact.siteId !== first.siteId ||
    artifact.version !== first.version || artifact.sourceCaptureDigest !== first.sourceCaptureDigest)) {
    throw new Error("Capture Lab drafts do not share one immutable capture identity")
  }
  const actions = parts.flatMap((part) => part.artifact.actions)
    .sort((left, right) => compareText(left.id, right.id))
  if (new Set(actions.map((action) => action.id)).size !== actions.length) {
    throw new Error("Capture Lab drafts contain duplicate interface identifiers")
  }
  const artifact = createSiteHarnessCandidate({
    siteId: first.siteId,
    version: first.version,
    sourceCaptureDigest: first.sourceCaptureDigest,
    allowedOrigins: [...new Set(parts.flatMap((part) => part.artifact.allowedOrigins))].sort(compareText),
    actions
  })
  const findingsByAction = new Map(parts.map((part) => [
    part.artifact.actions[0]!.id,
    part.findingCount
  ]))
  return deepFreeze({
    artifact,
    findingsByAction,
    findingCount: parts.reduce((total, part) => total + part.findingCount, 0)
  })
}

/**
 * Generates the immutable actor identity in memory, then projects only its
 * value-free public methods and structural plans. Source and producer values
 * never cross the Capture Lab API boundary.
 */
export const captureLabHarnessPreviewOf = (
  artifact: SiteHarnessArtifact,
  findingsByAction: ReadonlyMap<string, number> = new Map(),
  composition?: {
    readonly authorship: CaptureLabHarnessAuthorshipPreview
    readonly requiredActors: ReadonlyArray<CaptureLabRequiredActorPreview>
    readonly interfaceLabels?: ReadonlyArray<CaptureLabInterfaceLabel>
    readonly dependencyLabels?: ReadonlyArray<CaptureLabDependencyLabel>
    readonly usedDependencies?: ReadonlyArray<CaptureLabUsedDependency>
  }
): CaptureLabHarnessPreview => {
  const identity = generatedHarnessActorIdentity(artifact)
  const interfaceLabels = new Map((composition?.interfaceLabels ?? []).map((label) => [label.interfaceId, label] as const))
  const dependencyLabels = new Map((composition?.dependencyLabels ?? []).map((label) => [dependencyKeyOf(label), label] as const))
  const usedDependencies = [...new Map((composition?.usedDependencies ?? []).map((dependency) => [
    dependencyKeyOf(dependency),
    dependency
  ] as const)).values()]
  const interfaces = identity.interfaceContract.actions.map((action): CaptureLabHarnessInterfacePreview => {
    const plan = generatedHarnessActionPlanOf(artifact, identity.interfaceContract, action.id)
    const label = interfaceLabels.get(action.id)
    const stepIds = new Set(plan.steps.map((step) => step.id))
    const dependencies = usedDependencies.filter((dependency) =>
      stepIds.has(dependency.from) && stepIds.has(dependency.to)
    ).map((dependency) => dependencyPreviewOf(dependency, dependencyLabels.get(dependencyKeyOf(dependency))))
      .sort((left, right) => compareText(left.id, right.id))
    return {
      id: action.id,
      name: label?.name ?? humanize(action.id),
      description: label?.description ?? `Structural ${plan.steps.at(-1)?.method ?? "HTTP"} interface compiled from observed request evidence.`,
      labelSource: label === undefined ? "structural" : "model",
      methodName: action.methodName,
      inputs: action.inputs.map((input) => ({ ...input })),
      steps: plan.steps.map((step) => ({
        id: step.id,
        method: step.method,
        path: step.path,
        dependsOn: [...step.dependsOn],
        expectedStatuses: [...step.expectedStatuses],
        producerKinds: [...new Set([
          ...step.pathParameters.flatMap((binding) => binding.producerKinds),
          ...step.query.flatMap((binding) => binding.producerKinds),
          ...step.headers.flatMap((binding) => binding.producerKinds),
          ...(step.bodyProducerKinds ?? [])
        ])].sort(compareText)
      })),
      dependencies,
      producerKinds: [...plan.producerKinds],
      findingCount: findingsByAction.get(action.id) ?? 0
    }
  })
  return deepFreeze({
    schemaVersion: CAPTURE_LAB_HARNESS_PREVIEW_SCHEMA_VERSION,
    mode: "generated_harness_preview",
    buildStatus: "not_built",
    liveExecution: false,
    approvalRequired: true,
    actorName: identity.actorName,
    siteId: identity.interfaceContract.siteId,
    artifactDigest: identity.artifactDigest,
    interfaceDigest: identity.interfaceDigest,
    generatorRevision: identity.generatorRevision,
    interfaces,
    ...(composition === undefined ? {} : {
      authorship: { ...composition.authorship },
      requiredActors: composition.requiredActors.map((required) => ({ ...required }))
    })
  })
}
