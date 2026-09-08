import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import type { Event } from "tardie/core/event";
import type { Bindings, SandboxService } from "tardie/code/sandbox/service";
import { promiseCodeId, promiseExecutionOutcome, promiseState, promiseTurn } from "./promises.ts";

/** A frozen program uses the ordinary native execute tool, never another model request. */
export function withPromiseExecution<R>(base: Layer.Layer<Infer, never, R>, owner: string, read: () => Promise<readonly Event[]>) {
  return Layer.effect(Infer, Effect.gen(function* () {
    const model = yield* Infer;
    return { ...model,
      ...(model.compact ? { compact: (request: Parameters<NonNullable<typeof model.compact>>[0], key?: string, signal?: AbortSignal) =>
        request.identity.turn.startsWith("promise-execution:") ? Effect.succeed(undefined) : model.compact!(request, key, signal) } : {}),
      react: (request, key, signal) => Effect.gen(function* () {
      if (!request.identity.turn.startsWith("promise-execution:")) return yield* model.react(request, key, signal);
      const events = yield* Effect.promise(read);
      const id = request.identity.turn.slice("promise-execution:".length);
      const record = promiseState(events).records.get(id);
      const message = events.find(e => e.type === "MessageReceived" && e.id === request.identity.turn);
      const denied = () => ({ kind: "fail" as const, error: "This scheduled task is no longer authorized. Check its status before retrying." });
      if (request.identity.actor !== "aiko" || request.identity.thread !== `user-${owner}` ||
        !record || record.owner !== owner || record.thread !== request.identity.thread || record.state !== "dispatching" ||
        record.execution?.version !== 1 || record.execution.turn !== promiseTurn(id) ||
        message?.source !== "automation" || message.promiseId !== id || message.promiseHash !== record.hash) return denied();
      const execId = promiseCodeId(id);
      if (events.some(e => e.type === "CodeSettled" && e.execId === execId)) {
        const outcome = promiseExecutionOutcome(events, record);
        return outcome === "succeeded"
          ? { kind: "complete" as const, output: `Scheduled task completed: ${record.label}` }
          : { kind: "fail" as const, error: outcome === "unknown"
            ? "The scheduled task has unconfirmed actions. Check their status before retrying."
            : "The scheduled task could not complete. Review its tool receipts before trying again." };
      }
      if (!request.tools.some(t => t.name === "execute")) return denied();
      // Stable native call identity preserves every PackageCalled/Returned pair on recovery.
      return { kind: "call" as const, name: "execute", callId: execId, arguments: { code: record.payload.segment.code } };
    }) };
  })).pipe(Layer.provide(base));
}

/** The ordinary code harness owns private inputs/results and current tool policy.
 * Promise data only narrows its bindings; it cannot install a package or grant authority. */
export function promiseSandbox(base: SandboxService, owner: string, thread: string, read?: () => Promise<readonly Event[]>): SandboxService {
  return { ...base, run: (code, bindings, ambient) => {
    if (!ambient?.seed.startsWith("promise-code:")) return base.run(code, bindings, ambient);
    return Effect.gen(function* () {
      if (!read) return { error: "Scheduled task custody is unavailable" };
      const id = ambient.seed.slice("promise-code:".length);
      const current = () => Effect.gen(function* () {
        const events = yield* Effect.promise(read);
        const record = promiseState(events).records.get(id);
        const turn = promiseTurn(id);
        const dispatch = events.find(e => e.type === "CodeDispatched" && e.execId === ambient.seed);
        const message = events.find(e => e.type === "MessageReceived" && e.id === turn);
        const stopped = events.some(e => e.turn === turn && ["TurnCancelled", "TurnCompleted", "TurnFailed"].includes(e.type) ||
          e.type === "CancellationRequested" && (e.invocation as { method?: string; id?: string; epoch?: number } | undefined)?.method === "message" &&
          (e.invocation as { id?: string }).id === turn && ((e.invocation as { epoch?: number }).epoch ?? 0) === (dispatch?.epoch ?? 0));
        if (!record || record.owner !== owner || record.thread !== thread || record.state !== "dispatching" ||
          record.execution?.turn !== turn || record.payload.segment.code !== code || stopped ||
          dispatch?.turn !== turn || dispatch.code !== code || message?.source !== "automation" || message.promiseId !== id || message.promiseHash !== record.hash)
          return yield* Effect.die(Error("Scheduled task authority changed"));
        return record;
      });
      const record = yield* current();
      const requested = Object.keys(record.payload.segment.packages).length ? record.payload.segment.packages : { tools: ["search", "describe", "call", "retain", "query", "bind", "load", "drop"] };
      const scoped: Record<string, unknown> = { ...record.payload.segment.values };
      for (const [name, methods] of Object.entries(requested)) {
        const available = bindings[name];
        if (!available || typeof available !== "object" || Array.isArray(available)) return { error: "Scheduled task package is unavailable" };
        const selected: Record<string, unknown> = {};
        for (const method of methods) {
          const fn = (available as Record<string, unknown>)[method];
          if (!Object.hasOwn(available, method) || typeof fn !== "function") return { error: "Scheduled task method is unavailable" };
          selected[method] = async (...args: unknown[]) => {
            await Effect.runPromise(current());
            return fn(...args);
          };
        }
        scoped[name] = selected;
      }
      return yield* base.run(code, scoped as Bindings, { ...ambient, at: record.payload.segment.ambient.at });
    });
  } };
}
