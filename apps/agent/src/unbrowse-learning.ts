import { createHash } from "node:crypto";
import {
  browserRequestEvidenceIdOf,
  decodeBrowserTraceEvent,
} from "@unbrowse/browser-runtime/trace";
import { canonicalStringify, sha256 } from "@unbrowse/browser-runtime/har";
import { validateLearningInput, type LearningInput } from "./learning.ts";
import type { BrowserLearningPending } from "./browser-learning.ts";

const digest = (value: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const pendingFields = [
  "type",
  "schemaVersion",
  "id",
  "threadId",
  "captureId",
  "requestId",
  "sourceRequestId",
  "sourceNetworkSequence",
  "sourceTraceDigest",
  "requestEvidenceId",
  "origin",
  "method",
  "path",
  "reason",
  "findings",
  "omittedFindings",
  "ready",
  "approved",
  "executable",
];
const pendingReasons = new Set([
  "association_missing",
  "evidence_incomplete",
  "prepared_tool_limit",
  "invalid_candidate",
  "artifact_digest_mismatch",
  "trace_digest_mismatch",
  "action_not_found",
  "mutating_request",
  "request_body_present",
  "unsafe_producer",
  "input_contract_mismatch",
  "dependency_evidence_missing",
  "dependency_mismatch",
  "ambiguous_dependency",
  "session_requirement_missing",
  "unresolved_finding",
]);
const findingCodes = new Set([
  "ambiguous_dependency",
  "array_selection_required",
  "dynamic_value_missing",
  "session_adapter_required",
  "site_control_dependency",
  "status_unknown",
]);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Strict host-only structural envelope. This does not assert an executable route or session readiness. */
export function learningFromPendingBrowserTrace(
  raw: unknown,
): LearningInput | undefined {
  try {
    if (
      !plain(raw) ||
      Object.keys(raw).some(
        (key) => !pendingFields.includes(key) && key !== "at",
      ) ||
      pendingFields.some((key) => !(key in raw)) ||
      Buffer.byteLength(JSON.stringify(raw)) > 12_000
    )
      return;
    const e = raw as unknown as BrowserLearningPending;
    if (
      e.type !== "AikoBrowserLearningPending" ||
      e.schemaVersion !== 1 ||
      e.ready !== false ||
      e.approved !== false ||
      e.executable !== false ||
      typeof e.threadId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.threadId) ||
      typeof e.captureId !== "string" ||
      !/^net-[a-f0-9]{20}$/.test(e.captureId) ||
      !/^req-\d{4}$/.test(e.requestId) ||
      !/^req-\d{4}$/.test(e.sourceRequestId) ||
      !Number.isSafeInteger(e.sourceNetworkSequence) ||
      e.sourceNetworkSequence < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(e.sourceTraceDigest) ||
      (e.at !== undefined && (!Number.isSafeInteger(e.at) || e.at < 0)) ||
      typeof e.origin !== "string" ||
      e.origin.length > 512 ||
      !["GET", "HEAD"].includes(e.method) ||
      typeof e.path !== "string" ||
      e.path.length > 1024 ||
      !/^(?:\/|(?:\/:segment)+)$/.test(e.path) ||
      !pendingReasons.has(e.reason) ||
      !Array.isArray(e.findings) ||
      e.findings.length > 8 ||
      !Number.isSafeInteger(e.omittedFindings) ||
      e.omittedFindings < 0 ||
      e.omittedFindings > 65_536
    )
      return;
    const origin = new URL(e.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== e.origin ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return;
    for (const finding of e.findings) {
      if (
        !plain(finding) ||
        Object.keys(finding).length !== 3 ||
        Object.keys(finding).some(
          (key) => !["stepId", "location", "code"].includes(key),
        ) ||
        !/^req-\d{4}$/.test(finding.stepId) ||
        !findingCodes.has(finding.code) ||
        typeof finding.location !== "string" ||
        finding.location.length > 180 ||
        !/^(?:response\.status|request\.path\.segment|request\.(?:header|cookie|query|body)\.[A-Za-z0-9_.:-]{1,128})$/.test(
          finding.location,
        )
      )
        return;
    }
    if (
      e.requestEvidenceId !==
      browserRequestEvidenceIdOf({
        captureId: e.captureId,
        importDigest: e.sourceTraceDigest,
        requestId: e.requestId,
      })
    )
      return;
    const { id, at: _at, ...fields } = e;
    if (id !== `pending-${sha256(canonicalStringify(fields))}`) return;
    // Run/capture/request IDs stay in the native event and learning producer receipt, not in
    // semantic memory content: observing the same blocker again must not churn the Merkle root.
    const findings = [
      ...new Map(
        e.findings.map(({ location, code }) => [
          `${location}\0${code}`,
          { location, code },
        ]),
      ).values(),
    ].sort(
      (a, b) =>
        a.location.localeCompare(b.location) || a.code.localeCompare(b.code),
    );
    return validateLearningInput({
      id: `unbrowse-${id}`,
      subject: `unbrowse/pending/${digest([e.origin, e.method, e.path])}`,
      title: `Pending browser read: ${origin.hostname} ${e.method} ${e.path}`,
      kind: "fact",
      type: "browser-learning-pending",
      payload: {
        producer: "unbrowse/browser-runtime",
        eventType: "AikoBrowserLearningPending",
        provenance:
          "Manifest-validated observed route shape with native compiler blockers; exact evidence retained in source event",
        ready: false,
        approved: false,
        executable: false,
        origin: e.origin,
        method: e.method,
        maskedPath: e.path,
        reason: e.reason,
        findings,
        omittedFindings: e.omittedFindings,
      },
    });
  } catch {
    return;
  }
}

/** The producer authenticates separately; a prepared tool is evidence, never an execution grant. */
export function learningFromBrowserTrace(
  raw: unknown,
): LearningInput | undefined {
  try {
    // The native decoder checks the definition digest, source digests, identities and exact summary.
    const event = decodeBrowserTraceEvent(raw);
    if (event?.type !== "BrowserNetworkToolPrepared") return;
    const summary = event.summary;
    return validateLearningInput({
      id: `unbrowse-${digest([event.threadId, event.sequence, event.toolDigest])}`,
      subject: `unbrowse/tool/${digest([summary.siteId, event.actionId])}`,
      title: `${summary.siteId} / ${event.actionId}`,
      kind: "skill",
      type: "browser-tool",
      payload: {
        producer: "unbrowse/browser-runtime",
        eventType: "BrowserNetworkToolPrepared",
        provenance:
          "Native validated tool preparation; execution and approval are separate events",
        toolId: event.toolId,
        actionId: event.actionId,
        toolDigest: event.toolDigest,
        sourceTraceDigest: event.sourceTraceDigest,
        sourceArtifactDigest: event.sourceArtifactDigest,
        summary: {
          siteId: summary.siteId,
          methods: [...summary.methods],
          stepCount: summary.stepCount,
          inputCount: summary.inputCount,
          callerInputCount: summary.callerInputCount,
          vaultInputCount: summary.vaultInputCount,
          dependencyCount: summary.dependencyCount,
          sessionRequirementCount: summary.sessionRequirementCount,
        },
      },
    });
  } catch {
    return;
  }
}
