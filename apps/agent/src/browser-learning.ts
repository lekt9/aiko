import type { Event } from "tardie/core/log/event";
import type { AgentBrowserCallWindow } from "@unbrowse/browser-harness/client";
import { prepareTrustedNetworkEntries } from "@unbrowse/browser-harness/network-observation";
import {
  compileObservedReadNetworkTools,
  type ImplicitBrowserSessionAdapter,
  inferBoundedHarAssociations,
} from "@unbrowse/browser-harness/network-compiler";
import {
  assertNetworkSnapshotBackedByLog,
  networkFactObservedEventOf,
  planHarImport,
  validatedHarCaptureFactsOf,
} from "@unbrowse/browser-harness/network-facts";
import {
  browserNetworkDependencyEventOf,
  browserNetworkToolPreparedEventOf,
  browserRequestEvidenceIdOf,
} from "@unbrowse/browser-harness/trace";
import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { responseSemanticsByRequest, type ResponseSemanticEvidence } from "@unbrowse/browser-harness/response-semantics";
import type { BrowserNetworkToolPrepared } from "@unbrowse/browser-harness/trace";
import type { NetworkEntry } from "@unbrowse/browser-harness/network-listener";

export interface BrowserLearningPending {
  type: "AikoBrowserLearningPending";
  schemaVersion: 1;
  id: string;
  threadId: string;
  captureId: string;
  requestId: string;
  sourceRequestId: string;
  sourceNetworkSequence: number;
  sourceTraceDigest: string;
  requestEvidenceId: string;
  origin: string;
  method: "GET" | "HEAD";
  path: string;
  reason: string;
  findings: { stepId: string; location: string; code: string }[];
  omittedFindings: number;
  ready: false;
  approved: false;
  executable: false;
  at?: number;
}

/** Thin composition of the playground's native observer/compiler. Raw traffic remains transient in the owner VM. */
export class BrowserLearning {
  private networkSequence = 0;
  private observed = new Map<string, string>();
  private snapshots = new Set<string>();
  private prepared = new Set<string>();
  private pending = new Set<string>();
  private evidence = new Set<string>();
  private facts: Event[] = [];
  constructor(
    private options: {
      threadId: string;
      nextSequence(): number;
      browserSession?(origin: string): ImplicitBrowserSessionAdapter | undefined;
      emit(event: Event): Promise<void>;
      /** Trusted VM callback only. Response bodies must NEVER be emitted or persisted. */
      onPrepared?(event: BrowserNetworkToolPrepared, responses: Record<string, unknown>, semantics: ReadonlyMap<string, ResponseSemanticEvidence>): Promise<void>;
    },
  ) {}

  async observe(entry: NetworkEntry, index: number, complete: boolean) {
    const single = prepareTrustedNetworkEntries([entry]);
    const trace = {
      ...single.trace,
      entries: single.trace.entries.map((item) => ({
        ...item,
        index,
        id: `req-${String(index + 1).padStart(4, "0")}`,
      })),
    };
    for (const fact of planHarImport(trace)
      .events("live-network")
      .filter(
        (event) =>
          event.type === "HarRequestObserved" ||
          (complete && event.type === "HarResponseObserved"),
      )) {
      const candidate = networkFactObservedEventOf(
        this.options.threadId,
        this.networkSequence,
        fact,
      );
      const identity = `${fact.type}:${fact.requestId}`,
        content = canonicalStringify(candidate.fact);
      if (this.observed.get(identity) === content) continue;
      await this.options.emit(candidate);
      this.facts.push(candidate);
      this.networkSequence++;
      this.observed.set(identity, content);
    }
  }

  async compile(
    entries: readonly NetworkEntry[],
    windows: readonly AgentBrowserCallWindow[],
    targetOrigin: string,
  ) {
    const completed = entries.flatMap((entry, index) =>
      entry._observationComplete === true
        ? [{ entry, sourceId: `req-${String(index + 1).padStart(4, "0")}` }]
        : [],
    );
    if (!completed.length) return { prepared: 0, pending: entries.length };
    const sourceRequestIds = completed.map((item) => item.sourceId);
    const preparation = prepareTrustedNetworkEntries(
      completed.map((item) => item.entry),
    );
    const plan = planHarImport(preparation.trace);
    const captureId = `net-${sha256(canonicalStringify({ digest: plan.importDigest, sourceRequestIds })).slice(0, 20)}`;
    const events = plan.events(captureId);
    assertNetworkSnapshotBackedByLog(
      this.facts,
      this.options.threadId,
      events,
      sourceRequestIds,
      this.networkSequence,
    );
    if (!this.snapshots.has(captureId)) {
      await this.options.emit({
        type: "NetworkGraphCheckpointPrepared",
        schemaVersion: 1,
        threadId: this.options.threadId,
        captureId,
        importDigest: plan.importDigest,
        sourceNetworkSequence: this.networkSequence,
        sourceRequestIds,
      });
      for (const event of events) await this.options.emit(event);
      this.snapshots.add(captureId);
    }
    const validated = validatedHarCaptureFactsOf(events, captureId);
    if (validated.status !== "completed")
      throw new Error("Native network graph failed manifest validation");
    const prepared = {
      ...preparation,
      authorFacts: validated.capture,
      preview: {
        ...preparation.preview,
        captureId,
        thread: this.options.threadId,
      },
    };
    const associations = inferBoundedHarAssociations(
      prepared.trace.entries,
      windows,
      targetOrigin,
    );
    for (const association of associations) {
      const evidenceId = browserRequestEvidenceIdOf({
        captureId,
        importDigest: plan.importDigest,
        requestId: association.entry.id,
      });
      if (this.evidence.has(evidenceId)) continue;
      await this.options.emit(
        browserNetworkDependencyEventOf({
          threadId: this.options.threadId,
          sequence: this.options.nextSequence(),
          callId: association.callId,
          captureId,
          importDigest: plan.importDigest,
          requestId: association.entry.id,
          relation: "command_triggered_request",
          evidence: "bounded_time_window",
        }),
      );
      this.evidence.add(evidenceId);
    }
    const compiled = compileObservedReadNetworkTools(
      prepared,
      targetOrigin,
      associations,
      undefined,
      this.options.browserSession?.(targetOrigin),
    );
    for (const resolution of compiled.resolutions) await this.options.emit({type:"AikoBrowserSessionFindingResolved",threadId:this.options.threadId,captureId,sourceTraceDigest:plan.importDigest,...resolution});
    for (const fallback of compiled.fallbacks) {
      const exchange = validated.capture.exchanges.find(
        (item) => item.requestId === fallback.requestId,
      );
      const sourceRequestId = exchange && sourceRequestIds[exchange.index];
      if (
        !exchange ||
        !sourceRequestId ||
        !["GET", "HEAD"].includes(exchange.request.method)
      )
        continue;
      // This is a fact about a blocked draft, never a prepared tool or execution grant.
      // Only manifest-validated structural fields leave the VM; native default paths are masked.
      const fields: Omit<BrowserLearningPending, "id" | "at"> = {
        type: "AikoBrowserLearningPending",
        schemaVersion: 1,
        threadId: this.options.threadId,
        captureId,
        requestId: exchange.requestId,
        sourceRequestId,
        sourceNetworkSequence: this.networkSequence,
        sourceTraceDigest: plan.importDigest,
        requestEvidenceId: browserRequestEvidenceIdOf({
          captureId,
          importDigest: plan.importDigest,
          requestId: exchange.requestId,
        }),
        origin: exchange.request.origin,
        method: exchange.request.method as "GET" | "HEAD",
        path: exchange.request.path,
        reason: fallback.reason,
        findings: (fallback.findings ?? []).map(
          ({ stepId, location, code }) => ({ stepId, location, code }),
        ),
        omittedFindings: fallback.omittedFindings ?? 0,
        ready: false,
        approved: false,
        executable: false,
      };
      const id = `pending-${sha256(canonicalStringify(fields))}`;
      if (this.pending.has(id)) continue;
      await this.options.emit({ ...fields, id });
      this.pending.add(id);
    }
    let count = 0;
    for (const tool of compiled.prepared) {
      if (this.prepared.has(tool.digest)) continue;
      // Decoder validation runs in the original constructor before anything is sent to the host.
      const event = browserNetworkToolPreparedEventOf({
        threadId: this.options.threadId,
        sequence: this.options.nextSequence(),
        tool,
      });
      await this.options.emit(event);
      if (this.options.onPrepared) {
        const responses: Record<string, unknown> = {};
        for (const evidence of tool.definition.evidence) {
          const entry = prepared.trace.entries.find(e => e.id === evidence.requestId);
          if (!entry?.response.mimeType.includes("json") || !entry.response.body?.text || entry.response.body.truncated) continue;
          try { responses[evidence.stepId] = JSON.parse(entry.response.body.text); } catch { /* No fabricated body. */ }
        }
        await this.options.onPrepared(event, responses, responseSemanticsByRequest(prepared.trace, new Set(tool.definition.evidence.map(e => e.requestId))));
      }
      this.prepared.add(tool.digest);
      count++;
    }
    return {
      prepared: count,
      pending: entries.length - completed.length,
      fallbacks: compiled.fallbacks.map((item) => ({
        requestId: item.requestId,
        reason: item.reason,
        // Native compiler already bounds these value-free identities to eight findings.
        // Preserve the actual blocker without publishing header/session values or draft prose.
        ...(item.findings === undefined ? {} : { findings: item.findings }),
        ...(item.omittedFindings === undefined
          ? {}
          : { omittedFindings: item.omittedFindings }),
      })),
    };
  }
}
