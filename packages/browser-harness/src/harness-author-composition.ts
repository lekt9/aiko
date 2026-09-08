import {
  harnessAuthorFindingDisposition,
  harnessAuthorFindingKey,
  type HarnessAuthorDraftEvidence,
  type HarnessAuthorProposal
} from "./harness-author"
import { buildObservedReadHarnessDraft } from "./harness-builder"
import type { ValidatedHarCaptureFacts } from "./har-component"
import type { HarValueProfile } from "./har-value-profile"
import {
  combineCaptureLabDrafts,
  type CaptureLabCombinedDraft
} from "./harness-preview"

export interface CompiledHarnessAuthorComposition {
  readonly combined: CaptureLabCombinedDraft
  readonly draftParts: ReadonlyArray<HarnessAuthorDraftEvidence>
  readonly interfaceLabels: HarnessAuthorProposal["interfaceLabels"]
  readonly dependencyLabels: HarnessAuthorProposal["dependencyLabels"]
  readonly callerInputRepairs: number
  readonly externalSessionRequirements: number
}

/**
 * Trusted compiler for a model proposal. Request structure comes from the
 * validated capture; the proposal contributes only interface IDs, request
 * selections, and compatible finding dispositions.
 */
export const compileHarnessAuthorComposition = (input: {
  readonly capture: ValidatedHarCaptureFacts
  readonly baselineParts: ReadonlyArray<HarnessAuthorDraftEvidence>
  readonly proposal: HarnessAuthorProposal
  /** Optional trusted, value-free cardinality evidence for selected read headers. */
  readonly valueProfile?: HarValueProfile
}): CompiledHarnessAuthorComposition => {
  const baseline = input.baselineParts[0]?.artifact
  if (baseline === undefined && input.proposal.readInterfaces.length === 0) {
    throw new Error("An authored composition without a mutating baseline must select at least one read interface")
  }
  const readParts: HarnessAuthorDraftEvidence[] = []
  let siteId = baseline?.siteId
  let version = baseline?.version
  for (const proposal of input.proposal.readInterfaces) {
    const draft = buildObservedReadHarnessDraft(input.capture, {
      requestId: proposal.sourceRequestId,
      interfaceId: proposal.id,
      ...(siteId === undefined ? {} : { siteId }),
      ...(version === undefined ? {} : { version }),
      ...(input.valueProfile === undefined ? {} : { valueProfile: input.valueProfile })
    })
    siteId ??= draft.artifact.siteId
    version ??= draft.artifact.version
    readParts.push({
      actionCandidateId: draft.actionCandidate.id,
      artifact: draft.artifact,
      usedDependencies: draft.usedDependencies,
      unresolved: draft.unresolved.map(({ stepId, location, code }) => ({ stepId, location, code }))
    })
  }
  const disposition = harnessAuthorFindingDisposition(input.proposal)
  const draftParts = [...input.baselineParts, ...readParts].map((part): HarnessAuthorDraftEvidence => ({
    ...part,
    unresolved: part.unresolved.filter((finding) => !disposition.resolvedByCallerInput.has(
      harnessAuthorFindingKey({
        actionId: part.artifact.actions[0]!.id,
        stepId: finding.stepId,
        location: finding.location,
        code: finding.code
      })
    ))
  }))
  const combined = combineCaptureLabDrafts(draftParts.map((part) => ({
    artifact: part.artifact,
    findingCount: part.unresolved.length
  })))
  return Object.freeze({
    combined,
    draftParts: Object.freeze(draftParts),
    interfaceLabels: input.proposal.interfaceLabels,
    dependencyLabels: input.proposal.dependencyLabels,
    callerInputRepairs: disposition.resolvedByCallerInput.size,
    externalSessionRequirements: disposition.externalSessionActor.size
  })
}
