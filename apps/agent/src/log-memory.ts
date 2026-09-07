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
  if (!/^(?:AikoCodeTool|AikoToolDefinition|AikoCodeWorkflow|AikoNetworkRequest|AikoRequestMemory|BrowserNetworkTool|AikoObservedAction|AikoConnectorExecution)/.test(event.type) && !["ToolCalled","ToolReturned","PackageCalled","PackageReturned","CodeDispatched","CodeSettled"].includes(event.type)) return {};
  const result: Record<string, Json> = {};
  for (const key of ["name", "callId", "tool", "toolId", "workflowId", "description", "digest", "definitionDigest", "schemaDigest", "toolDigest", "artifactDigest", "sourceTraceDigest", "pointerId", "observationId", "requestDigest", "responseDigest", "execId", "harness", "method", "status", "succeeded", "changed", "checkedAt"]) {
    const value = event[key];
    if (typeof value === "string") result[key] = value.slice(0, 1000);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  if (event.type === "CodeDispatched" && typeof event.code === "string") {
    result.digest = `sha256:${createHash("sha256").update(event.code).digest("hex")}`;
    result.harness = "aiko-code/1";
  }
  if (Array.isArray(event.dependencies)) result.dependencies = event.dependencies.slice(0,32).flatMap(d =>
    d && typeof d.tool === "string" && typeof d.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(d.digest)
      ? [{tool:d.tool.slice(0,128),digest:d.digest}] : []);
  return result;
}

/** Content-addressed references in the existing entity-learn journal, with exact observation edges. */
export function indexToolArtifact(memory: Memory, event: Event, owner: string, redact: (s: string) => string) {
  if (event.owner !== owner || !["AikoToolDefinitionRecorded", "AikoCodeWorkflowSaved", "AikoNetworkRequestSettled", "AikoRequestMemoryChecked"].includes(event.type)) return;
  const data = toolLogProjection(event);
  if (redact(JSON.stringify(data)) !== JSON.stringify(data)) return;
  const valid = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
  const root = ["AikoNetworkRequestSettled", "AikoRequestMemoryChecked"].includes(event.type) ? event.requestDigest : event.digest;
  if (!valid(root)) return;
  const refs = [...new Set([
    ...(valid(event.schemaDigest) ? [event.schemaDigest] : []),
    ...(valid(event.definitionDigest) ? [event.definitionDigest] : []),
    ...(valid(event.toolDigest) ? [event.toolDigest] : []),
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

/** Host-approved log projection. Never copies model drafts, page dumps or recursive memory returns. */
export function followLogMemory(binding: MemoryBinding) {
  return component({
    name: "aiko.log-memory",
    keys: {
      prefixes: ["aiko-log-memory:"],
      keyOf: (e) =>
        e.type === "AikoLogMemoryFollowed"
          ? `aiko-log-memory:${e.turn}`
          : undefined,
    },
    initial: () => ({ turn: "", done: "", after: 0 }),
    step: (state, event) => {
      if (event.type === "AikoReplyPrepared")
        return { ...state, turn: String(event.turn) };
      if (event.type === "AikoLogMemoryFollowed")
        return {
          ...state,
          done: String(event.turn),
          after: Number(event.after),
        };
      return state;
    },
    output: (state) => ({
      view: undefined,
      transitions:
        !state.turn || state.done === state.turn
          ? []
          : [
              effect({
                key: `aiko-log-memory:${state.turn}`,
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
                        // Bound catch-up per completed turn; a partial cursor is visible and resumes next turn.
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
                            for (const row of rows.slice(0,25)) indexToolArtifact(memory,row.event,binding.owner,binding.redact);
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
                            if (next === undefined || next <= after)
                              throw new Error("Log cursor did not advance");
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
