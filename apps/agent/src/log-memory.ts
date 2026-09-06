import { createHash } from "node:crypto";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Self } from "tardie/core/runtime";
import { tardigradeLogSource, type Json } from "entity-learn";
import { openMemory, type MemoryBinding } from "./memory.ts";

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
                            id: `follow-v1-${after}`,
                            // Keep this content projection separate from legacy metadata-only sources.
                            actor: `${self.actor}@${self.instance}:user-messages-v1`,
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
                            policyVersion: "aiko-user-messages-v1",
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
                                `follow-v1-register:${after}`,
                              );
                              memory.approveSource(
                                registered.id,
                                registered.revision,
                                true,
                                `follow-v1-approve:${after}`,
                              );
                            } else if (!existing.enabled)
                              throw new Error("Source disabled");
                            // Cursor commits only after entity-learn. Recovery reuses the exact committed window.
                            const refreshed = await memory.refresh(
                              source.source.id,
                              {
                                key: `follow-v1-read:${after}:${createHash("sha256").update(input.turn).digest("hex")}`,
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
