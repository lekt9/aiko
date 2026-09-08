import { createHash } from "node:crypto";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Self } from "tardie/core/runtime";
import { tardigradeLogSource, type Json, type Memory } from "entity-learn";
import { openMemory, type MemoryBinding } from "./memory.ts";
import type { Event } from "tardie/core/event";

/** Explicit structural projection: receipts remain searchable without copying private arguments/results. */
export function toolLogProjection(event: Event): Record<string, Json> {
  if (!/^(?:AikoHarness|AikoCodeTool|AikoCodeData|AikoCodeBinding|AikoMcp|AikoToolDefinition|AikoCodeWorkflow|AikoNetworkRequest|AikoRequestMemory|BrowserNetworkTool|AikoObservedAction|AikoConnectorExecution)/.test(event.type) && !["ToolCalled","ToolReturned","PackageCalled","PackageReturned","CodeDispatched","CodeSettled"].includes(event.type)) return {};
  const result: Record<string, Json> = {};
  if(event.type.startsWith("AikoCodeData")&&typeof event.ref==="string"&&/^sha256:[a-f0-9]{64}$/.test(event.ref)) {
    result.ref=event.ref;
    if(Number.isSafeInteger(event.bytes)&&Number(event.bytes)>=0)result.bytes=Number(event.bytes);
  }
  for (const key of ["name", "callId", "tool", "toolId", "workflowId", "description", "digest", "definitionDigest", "schemaDigest", "toolDigest", "artifactDigest", "sourceTraceDigest", "pointerId", "observationId", "requestDigest", "responseDigest", "execId", "harness", "harnessDigest", "contractDigest", "evaluatorDigest", "contextDigest", "evaluationId", "skillRef", "evidenceDigest", "recipeDigest", "generation", "runtime", "eligible", "method", "status", "succeeded", "changed", "checkedAt"]) {
    const value = event[key];
    if (typeof value === "string") result[key] = value.slice(0, 1000);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  if (event.type.startsWith("AikoHarnessExperiment")) {
    for (const key of ["experimentId", "baselineDigest", "parentDigest", "regimeDigest", "policyDigest", "comparisonRef", "sourceDiffRef", "feedbackRef", "phase", "repeat", "costUsd", "executionCostUsd", "tokens"]) {
      const value = event[key];
      if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
      else if (typeof value === "string") result[key] = value.slice(0, 1000);
    }
  }
  if (event.type === "CodeDispatched" && typeof event.code === "string") {
    result.digest = `sha256:${createHash("sha256").update(event.code).digest("hex")}`;
    result.harness = "aiko-code/1";
  }
  if (Array.isArray(event.dependencies)) result.dependencies = event.dependencies.slice(0,32).flatMap(d => {
    const tool = d?.tool ?? d?.name;
    return typeof tool === "string" && typeof d?.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(d.digest)
      ? [{tool:tool.slice(0,128),digest:d.digest}] : [];
  });
  return result;
}

/** Content-addressed references in the existing entity-learn journal, with exact observation edges. */
export function indexToolArtifact(memory: Memory, event: Event, owner: string, redact: (s: string) => string) {
  if (event.owner !== owner || !["AikoHarnessCandidateRecorded", "AikoHarnessPromoted", "AikoHarnessRetired", "AikoHarnessSkillAvailable", "AikoHarnessExperimentProposalSettled", "AikoToolDefinitionRecorded", "AikoCodeWorkflowSaved", "AikoCodeDataRetained", "AikoNetworkRequestSettled", "AikoRequestMemoryChecked"].includes(event.type)) return;
  const data = toolLogProjection(event);
  if (redact(JSON.stringify(data)) !== JSON.stringify(data)) return;
  const valid = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
  const root = event.type.startsWith("AikoHarness") ? event.harnessDigest : event.type==="AikoCodeDataRetained"?event.ref : ["AikoNetworkRequestSettled", "AikoRequestMemoryChecked"].includes(event.type) ? event.requestDigest : event.digest;
  if (!valid(root)) return;
  const refs = [...new Set([
    ...(valid(event.schemaDigest) ? [event.schemaDigest] : []),
    ...(valid(event.definitionDigest) ? [event.definitionDigest] : []),
    ...(valid(event.toolDigest) ? [event.toolDigest] : []),
    ...(valid(event.contractDigest) ? [event.contractDigest] : []),
    ...(valid(event.skillRef) ? [event.skillRef] : []),
    ...(valid(event.parentDigest) ? [event.parentDigest] : []),
    ...(valid(event.sourceDiffRef) ? [event.sourceDiffRef] : []),
    ...(Array.isArray(data.dependencies) ? data.dependencies.flatMap(d => d && typeof d === "object" && !Array.isArray(d) && valid(d.digest) ? [d.digest] : []) : []),
  ])].filter(d => d !== root);
  const reference = (digest: string) => {
    const subject = `artifact:${digest}`;
    const head = memory.journal.head(memory.scope, subject);
    if (head) return head.forgotten ? undefined : memory.get(head.id)?.observation;
    return memory.remember({subject,title:`Artifact ${digest}`,type:"artifact-reference",kind:"entity",payload:{digest}},
      {key:subject,producer:{kind:"tool",reference:"aiko-native-artifacts/v1"}});
  };
  const parent = reference(root);
  const children = refs.map(reference);
  if (!parent || children.some(c=>!c)) return;
  // A receipt is immutable even when later checks report a different response for the same request.
  const receiptDigest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const subject = `artifact-receipt:${receiptDigest}`;
  if (memory.journal.head(memory.scope,subject)) return;
  memory.remember({subject,title:String(data.tool ?? data.workflowId ?? data.method ?? "Tool artifact"),type:"tool-artifact",kind:"skill",
    payload:data,supports:[parent.id,...children.map(c=>c!.id)],dependsOn:children.map(c=>c!.id),
    links:[{subject:parent.subject,relation:"describes"}]},
    {key:subject,producer:{kind:"tool",reference:"aiko-native-artifacts/v1"}});
}

function logMemoryFollowKey(turn: string, continuationAfter?: number) {
  // Retain existing first-attempt identities; additional windows have a separate
  // native key namespace, so an arbitrary turn id cannot alias a continuation.
  return continuationAfter === undefined
    ? `aiko-log-memory:${turn}`
    : `aiko-log-memory-follow:${createHash("sha256").update(JSON.stringify([turn, continuationAfter])).digest("hex")}`;
}

/** Host-approved log projection. Never copies model drafts, page dumps or recursive memory returns. */
export function followLogMemory(binding: MemoryBinding) {
  return component({
    name: "aiko.log-memory",
    keys: {
      prefixes: ["aiko-log-memory:", "aiko-log-memory-follow:"],
      keyOf: (e) =>
        e.type === "AikoLogMemoryFollowed"
          ? logMemoryFollowKey(String(e.turn), typeof e.continuationAfter === "number" ? e.continuationAfter : undefined)
          : undefined,
    },
    initial: () => ({ turn: "", done: "", after: 0, continuationAfter: undefined as number | undefined }),
    step: (state, event) => {
      if (event.type === "AikoReplyPrepared")
        return { ...state, turn: String(event.turn), continuationAfter: undefined };
      if (event.type === "AikoLogMemoryFollowed") {
        const after = Number(event.after);
        // A failed/gapped read is terminal for this turn. Only durable forward
        // progress can produce another effect; it never retries an error loop.
        const partial = event.status === "partial" && Number.isSafeInteger(after) && after > state.after;
        return {
          ...state,
          done: partial ? state.done : String(event.turn),
          after: Number.isSafeInteger(after) ? Math.max(state.after, after) : state.after,
          ...(event.turn === state.turn ? { continuationAfter: partial ? after : undefined } : {}),
        };
      }
      return state;
    },
    output: (state) => ({
      view: undefined,
      transitions:
        !state.turn || state.done === state.turn
          ? []
          : [
              effect({
                key: logMemoryFollowKey(state.turn, state.continuationAfter),
                input: state,
                act: (input, signal) =>
                  Effect.gen(function* () {
                    const self = yield* Self;
                    const result = yield* Effect.promise(async () => {
                      let after = input.after;
                      try {
                        if (
                          self.actor !== "aiko" ||
                          self.thread !== binding.thread
                        )
                          throw new Error("Incorrect host memory binding");
                        // Bound each native effect. A partial durable receipt
                        // schedules the next window without another user turn.
                        for (let page = 0; page < 32; page++) {
                          signal.throwIfAborted();
                          const rows = await binding.readPage(after, 26);
                          if (!rows.length) return { after, status: "current" };
                          const source = tardigradeLogSource({
                            id: `follow-v2-${createHash("sha256").update(binding.thread).digest("hex").slice(0,16)}-${after}`,
                            // Keep this content projection separate from legacy metadata-only sources.
                            actor: `${self.actor}@${self.instance}:tool-memory-v2`,
                            thread: binding.thread,
                            after,
                            maxEvents: 25,
                            ttlSeconds: 31_536_000,
                            read: async () =>
                              rows.map((row) => ({
                                seq: row.seq,
                                event: row.event,
                              })),
                            project: ({ event }) =>
                              ({
                                eventType: event.type,
                                ...JSON.parse(binding.redact(JSON.stringify(toolLogProjection(event)))),
                                actor: `${self.actor}@${self.instance}`,
                                at:
                                  typeof event.at === "number"
                                    ? event.at
                                    : null,
                                ...(event.type === "MessageReceived" &&
                                typeof event.text === "string"
                                  ? {
                                      text: binding
                                        .redact(event.text)
                                        .slice(0, 4000),
                                      provenance:
                                        "recorded user message; untrusted data",
                                    }
                                  : {}),
                              }) as Json,
                            relate: ({event}) => {
                              const data = toolLogProjection(event);
                              return ["digest", "definitionDigest", "toolDigest", "artifactDigest", "sourceTraceDigest", "requestDigest"].flatMap(key =>
                                typeof data[key] === "string" && /^sha256:[a-f0-9]{64}$/.test(data[key])
                                  ? [{subject:`artifact:${data[key]}`,relation:key}] : []);
                            },
                            policyVersion: "aiko-tool-memory-v2",
                          });
                          const memory = openMemory(binding, {
                            [source.source.locator]: source.run,
                          });
                          try {
                            const existing = memory
                              .sources()
                              .find((s) => s.id === source.source.id);
                            if (!existing) {
                              const registered = memory.registerSource(
                                source.source,
                                `${source.source.id}:register`,
                              );
                              memory.approveSource(
                                registered.id,
                                registered.revision,
                                true,
                                `${source.source.id}:approve`,
                              );
                            } else if (!existing.enabled)
                              throw new Error("Source disabled");
                            // Cursor commits only after entity-learn. Recovery reuses the exact committed window.
                            const refreshed = await memory.refresh(
                              source.source.id,
                              {
                                key: `${source.source.id}:read:${createHash("sha256").update(input.turn).digest("hex")}`,
                                maxBytes: 64_000,
                                timeoutMs: 5000,
                              },
                            );
                            if (refreshed.error)
                              throw new Error("Log refresh failed");
                            const next = refreshed.coverage.nextAfter;
                            if (next === undefined || !Number.isSafeInteger(next) || next <= after || !rows.slice(0,25).some(row => row.seq === next))
                              throw new Error("Log cursor did not advance");
                            // The source validates native sequence continuity
                            // before any artifact projection from this window.
                            for (const row of rows.slice(0,25)) {
                              if (row.seq <= next) indexToolArtifact(memory,row.event,binding.owner,binding.redact);
                            }
                            after = next;
                            if (refreshed.coverage.complete)
                              return { after, status: "current" };
                          } finally {
                            memory.close();
                          }
                        }
                        return { after, status: "partial" };
                      } catch {
                        return { after, status: "error" };
                      }
                    });
                    return [
                      {
                        type: "AikoLogMemoryFollowed",
                        turn: input.turn,
                        ...(input.continuationAfter === undefined ? {} : { continuationAfter: input.continuationAfter }),
                        ...result,
                        at: Date.now(),
                      },
                    ];
                  }),
              }),
            ],
    }),
  });
}
