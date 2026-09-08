import type {AgentBrowserCallWindow} from "./agent-browser-client";
import {MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL,MAX_BROWSER_PREPARED_TOOLS,browserRequestEvidenceIdOf} from "./browser-trace";
import type {TrustedHarImportPreparation} from "./trusted-network";
import {buildObservedReadHarnessDraft} from "./harness-builder";
import {validateSiteHarnessArtifact,siteHarnessArtifactDigest,type Sha256Digest} from "./harness-artifact";
import {canonicalStringify,sha256,type NormalizedHarEntry} from "./har";
import {NETWORK_TOOL_COMPILER_REVISION,compileNetworkTool,type CompiledNetworkTool,type NetworkToolCompileFallbackReason} from "./network-tool-catalog";
export interface ImplicitBrowserSessionAdapter { readonly id: string; readonly origin: string }
// Browser fetch owns these fields; application authorization headers are deliberately absent.
const ambientHeader = /^(?:accept|accept-encoding|accept-language|connection|cookie|host|origin|referer|user-agent|sec-ch-ua(?:-mobile|-platform)?|sec-fetch-(?:dest|mode|site|user)|priority|upgrade-insecure-requests|cache-control|pragma)$/i;
export interface BrowserSessionResolution { requestId: string; stepId: string; location: string; code: string; resolution: "external_session_actor"; adapterId: string }
const MAX_ASSOCIATION_WINDOW_MS=60_000,ASSOCIATION_SETTLE_MS=500,ASSOCIATION_EARLY_SKEW_MS=50;
export interface HarAssociation {readonly entry:NormalizedHarEntry;readonly callId:string}
export interface BrowseThreadPreparedTools {readonly resolutions:ReadonlyArray<BrowserSessionResolution>;readonly prepared:ReadonlyArray<CompiledNetworkTool>;readonly fallbacks:ReadonlyArray<{readonly requestId:string;readonly reason:NetworkToolCompileFallbackReason|"association_missing"|"evidence_incomplete"|"prepared_tool_limit";readonly findings?:ReadonlyArray<{stepId:string;location:string;code:string}>;readonly omittedFindings?:number}>}
const eligibleFirstPartyRead = (entry: NormalizedHarEntry, targetOrigin: string): boolean =>
  entry.request.origin === targetOrigin && (entry.request.method === "GET" || entry.request.method === "HEAD")

/**
 * agent-browser v0.36 has no request-id/tool-call-id join. This intentionally
 * weak association uses only direct, reviewed command windows. Implicit daemon
 * launch/reuse checks can share a millisecond with the real command; they are
 * neither browser actions selected by the controller nor causal candidates.
 * Genuine clock reversal or tied direct actions still refuses the whole set.
 */
export const inferBoundedHarAssociations = (
  entries: ReadonlyArray<NormalizedHarEntry>,
  windows: ReadonlyArray<AgentBrowserCallWindow>,
  targetOrigin: string
): ReadonlyArray<HarAssociation> => {
  if (windows.some((window, index) => !window.resultObserved ||
    !Number.isFinite(window.startedAtMs) || window.startedAtMs < 0 ||
    (window.endedAtMs !== undefined && (!Number.isFinite(window.endedAtMs) || window.endedAtMs < window.startedAtMs)) ||
    (index > 0 && window.startedAtMs < windows[index - 1]!.startedAtMs))) return []
  const candidates = windows.filter((window) =>
    window.direct && window.action !== "launch" && window.action !== "cdp_url" && window.action !== "har_start" && window.action !== "har_stop" &&
    window.action !== "stream_status" && window.action !== "stream_enable" && window.action !== "stream_disable")
  if (candidates.some((window, index) => index > 0 && window.startedAtMs === candidates[index - 1]!.startedAtMs)) return []
  const associated: HarAssociation[] = []
  for (const entry of entries.filter((item) => eligibleFirstPartyRead(item, targetOrigin))) {
    const startedAt = Date.parse(entry.startedAt)
    if (!Number.isFinite(startedAt)) continue
    const matching = candidates.filter((window, index) => {
      const next = candidates[index + 1]
      const naturalEnd = window.endedAtMs ?? window.startedAtMs + MAX_ASSOCIATION_WINDOW_MS
      const upper = Math.min(
        naturalEnd + ASSOCIATION_SETTLE_MS,
        window.startedAtMs + MAX_ASSOCIATION_WINDOW_MS,
        next?.startedAtMs ?? Number.POSITIVE_INFINITY
      )
      return startedAt >= window.startedAtMs - ASSOCIATION_EARLY_SKEW_MS && startedAt < upper
    })
    if (matching.length === 1) associated.push({ entry, callId: matching[0]!.callId })
  }
  const countByCall = new Map<string, number>()
  for (const association of associated) countByCall.set(association.callId, (countByCall.get(association.callId) ?? 0) + 1)
  return Object.freeze(associated.filter((association) =>
    (countByCall.get(association.callId) ?? 0) <= MAX_BROWSER_NETWORK_DEPENDENCIES_PER_CALL))
}

const selectedRequestIds = (targetRequestId: string, dependencies: TrustedHarImportPreparation["authorFacts"]["dependencies"]): ReadonlySet<string> => {
  const ids = new Set<string>([targetRequestId])
  for (const dependency of dependencies) {
    ids.add(dependency.from)
    ids.add(dependency.to)
  }
  return ids
}

export const preparedNetworkToolIdOf = (input: {
  readonly sourceArtifactDigest: Sha256Digest
  readonly sourceTraceDigest: Sha256Digest
  readonly actionId: string
  readonly compilerRevision: string
}): string => `browser-read-${sha256(canonicalStringify({
  schemaVersion: 2,
  compilerRevision: input.compilerRevision,
  sourceArtifactDigest: input.sourceArtifactDigest,
  sourceTraceDigest: input.sourceTraceDigest,
  actionId: input.actionId
})).slice(0, 48)}`

export const compileObservedReadNetworkTools = (
  preparation: TrustedHarImportPreparation,
  targetOrigin: string,
  associations: ReadonlyArray<HarAssociation>,
  onlyRequestIds?: ReadonlySet<string>,
  browserSession?: ImplicitBrowserSessionAdapter
): BrowseThreadPreparedTools => {
  if (browserSession && (browserSession.origin !== targetOrigin || !/^[a-zA-Z0-9_-]{1,128}$/.test(browserSession.id))) throw new Error("Invalid browser session adapter");
  const resolutions: BrowserSessionResolution[] = [];
  const associatedByRequest = new Map(associations.map((association) => [association.entry.id, association.callId]))
  const prepared: CompiledNetworkTool[] = []
  const fallbacks: Array<BrowseThreadPreparedTools["fallbacks"][number]> = []
  const eligible = preparation.authorFacts.exchanges.filter((exchange) =>
    (onlyRequestIds === undefined || onlyRequestIds.has(exchange.requestId)) &&
    exchange.request.origin === targetOrigin &&
    (exchange.request.method === "GET" || exchange.request.method === "HEAD") &&
    exchange.response.mimeType.toLowerCase().includes("json"))
    .sort((left, right) => left.index - right.index || left.requestId.localeCompare(right.requestId))

  for (const exchange of eligible) {
    if (!associatedByRequest.has(exchange.requestId)) {
      fallbacks.push({ requestId: exchange.requestId, reason: "association_missing" })
      continue
    }
    let draft
    try {
      draft = buildObservedReadHarnessDraft(preparation.authorFacts, {
        requestId: exchange.requestId,
        interfaceId: `read-${String(exchange.index + 1).padStart(4, "0")}`,
        valueProfile: preparation.valueProfile
      })
    } catch {
      fallbacks.push({ requestId: exchange.requestId, reason: "evidence_incomplete" })
      continue
    }
    let unresolved = draft.unresolved;
    if (browserSession) {
      const sessionSteps = new Set(draft.artifact.actions.flatMap(action=>action.steps.filter(step=>step.origin===browserSession.origin).map(step=>step.id)));
      const covered = (location:string) => location.startsWith("request.cookie.") || (location.startsWith("request.header.") && ambientHeader.test(location.slice("request.header.".length)));
      unresolved = draft.unresolved.filter(finding => {
        if (!["session_adapter_required", "dynamic_value_missing"].includes(finding.code) || !sessionSteps.has(finding.stepId) || !covered(finding.location)) return true;
        resolutions.push({requestId:exchange.requestId,stepId:finding.stepId,location:finding.location,code:finding.code,resolution:"external_session_actor",adapterId:browserSession.id});
        return false;
      });
      // Delegation changes the executable artifact, never the captured evidence. Only implicit headers
      // without dependency producers can be delegated; exact value-flow bindings remain intact.
      draft = {...draft,artifact:validateSiteHarnessArtifact({...draft.artifact,actions:draft.artifact.actions.map(action=>({...action,steps:action.steps.map(step=>({...step,headers:Object.fromEntries(Object.entries(step.headers).filter(([name,producer])=>{
        if (step.origin !== browserSession.origin || !ambientHeader.test(name) || producer.kind !== "constant") return true;
        resolutions.push({requestId:exchange.requestId,stepId:step.id,location:`request.header.${name}`,code:"implicit_browser_header",resolution:"external_session_actor",adapterId:browserSession.id});return false;
      }))}))}))})};
    }
    const action = draft.artifact.actions[0]
    if (action === undefined) {
      fallbacks.push({ requestId: exchange.requestId, reason: "evidence_incomplete" })
      continue
    }
    const selectedIds = selectedRequestIds(exchange.requestId, draft.usedDependencies)
    const selected = preparation.authorFacts.exchanges
      .filter((candidate) => selectedIds.has(candidate.requestId))
      .sort((left, right) => left.index - right.index || left.requestId.localeCompare(right.requestId))
    if (
      selected.length !== action.steps.length ||
      selected.some((candidate, index) => {
        const step = action.steps[index]
        return step === undefined || step.method !== candidate.request.method || step.origin !== candidate.request.origin ||
          !associatedByRequest.has(candidate.requestId)
      })
    ) {
      fallbacks.push({ requestId: exchange.requestId, reason: "evidence_incomplete" })
      continue
    }
    const artifactDigest = siteHarnessArtifactDigest(draft.artifact)
    const compiled = compileNetworkTool({
      artifact: draft.artifact,
      artifactDigest,
      sourceTraceDigest: draft.artifact.sourceCaptureDigest,
      actionId: action.id,
      toolId: preparedNetworkToolIdOf({
        sourceArtifactDigest: artifactDigest,
        sourceTraceDigest: draft.artifact.sourceCaptureDigest,
        actionId: action.id,
        compilerRevision: NETWORK_TOOL_COMPILER_REVISION
      }),
      inputBindings: action.inputs.map((input) => ({ name: input.name, source: "caller" as const })),
      stepEvidence: action.steps.map((step, index) => ({
        stepId: step.id,
        requestId: selected[index]!.requestId,
        traceEventId: browserRequestEvidenceIdOf({
          captureId: draft.captureId,
          importDigest: draft.importDigest,
          requestId: selected[index]!.requestId
        })
      })),
      dependencies: draft.usedDependencies,
      sessionRequirements: browserSession ? [browserSession.id] : [],
      unresolvedFindings: unresolved.map((finding) => ({
        code: finding.code,
        stepId: finding.stepId,
        location: finding.location
      }))
    })
    if (compiled.status === "compiled") {
      if (prepared.length < MAX_BROWSER_PREPARED_TOOLS) prepared.push(compiled.tool)
      else fallbacks.push({ requestId: exchange.requestId, reason: "prepared_tool_limit" })
    } else fallbacks.push({ requestId: exchange.requestId, reason: compiled.reason,
      ...(draft.unresolved.length === 0 ? {} : {
        findings: draft.unresolved.slice(0, 8).map(({ stepId, location, code }) => ({ stepId, location, code })),
        omittedFindings: Math.max(0, draft.unresolved.length - 8)
      }) })
  }
  return Object.freeze({ resolutions:Object.freeze(resolutions), prepared: Object.freeze(prepared), fallbacks: Object.freeze(fallbacks) })
}


