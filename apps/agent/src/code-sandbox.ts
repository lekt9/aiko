import { Effect, Layer } from "effect";
import { Sandbox, type SandboxService, type SandboxCall, type SandboxCallOutcome } from "tardie/code/sandbox/service";
import { CODE_SEGMENT_MAX_BYTES, codeCallKey, type CodeCall, type CodeSegment, type CodeSegmentResult } from "./code-sandbox-protocol.ts";

export type CodeSegmentTransport = (segment: CodeSegment, signal: AbortSignal) => Promise<CodeSegmentResult>;
/** Tardigrade keeps package identities and outcomes; Codegraff executes pure JS segments. */
export function codegraffSandboxService(transport: CodeSegmentTransport): SandboxService {
  return {
    managesParking: true,
    replayVersion: "aiko-code/2",
    run: (code, bindings, ambient) => Effect.tryPromise({
      try: async parentSignal => {
        const controller = new AbortController(), signal = controller.signal;
        const abort = () => controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", abort, { once: true });
        if (parentSignal.aborted) abort();
        try {
        if (ambient?.replayVersion !== undefined && !["aiko-code/1", "aiko-code/2"].includes(ambient.replayVersion))
          throw new Error("Unsupported code execution replay version");
        const packages: Record<string, string[]> = Object.create(null), values: Record<string, unknown> = Object.create(null);
        for (const [name, binding] of Object.entries(bindings)) {
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error("Invalid sandbox binding");
          if (binding !== null && typeof binding === "object" && !Array.isArray(binding) && Object.values(binding).every(v => typeof v === "function"))
            packages[name] = Object.keys(binding);
          else values[name] = binding;
        }
        const issued: CodeCall[] = [];
        const input: CodeSegment = { version: 1, code, packages, values, ambient: ambient ?? { at: 0, seed: "aiko" }, issued, history: [] };
        // Old unfinished executions predate completion-ordered delivery. Their
        // native marker selects the exact previous batch/microtask semantics so
        // an upgrade never changes the identities of already recorded effects.
        if (ambient?.replayVersion === "aiko-code/1") {
          delete input.issued;
          input.scheduling = "batch";
          for (;;) {
            signal.throwIfAborted();
            if (JSON.stringify(input).length > CODE_SEGMENT_MAX_BYTES)
              return { error: "Code execution data exceeds 2 MiB; split into smaller execute calls" };
            const output = await transport(input, signal);
            if (output.settled) return { result: output.result, error: output.error, logs: output.logs };
            if (!output.calls?.length || output.calls.length > 32) throw new Error("Invalid code segment response");
            for (let index = 0; index < output.calls.length; index++) {
              const call = output.calls[index]!;
              if (call.ordinal !== input.history.length + index || !Object.hasOwn(packages, call.packageName) || !packages[call.packageName]!.includes(call.method))
                throw new Error("Invalid code package call");
            }
            const outcomes = await Promise.all(output.calls.map(async call => {
              signal.throwIfAborted();
              const fn = (bindings[call.packageName] as Record<string, SandboxCall>)[call.method]!;
              return { call, outcome: await fn(call.args, call.ordinal, signal) };
            }));
            if (outcomes.some(({ outcome }) => outcome._tag === "Parked")) return {};
            for (const { call, outcome } of outcomes) if (outcome._tag === "Returned") input.history.push({ call, result: outcome.result ?? null });
          }
        }
        type Completion = { call: CodeCall; outcome: SandboxCallOutcome };
        const running = new Map<number, Promise<void>>(), parked = new Set<number>(), ready: Completion[] = [];
        let failed: unknown, didFail = false, notify: (() => void) | undefined;
        const launch = (call: CodeCall) => {
          // Every invocation still crosses the native package binding. This adapter
          // schedules pure JS; Tardie owns authorization, IDs, effects and recovery.
          const fn = (bindings[call.packageName] as Record<string, SandboxCall>)[call.method]!;
          const promise = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return fn(call.args, call.ordinal, signal);
          }).then(outcome => {
            if (outcome._tag === "Parked") parked.add(call.ordinal);
            else ready.push({ call, outcome });
          }, error => { failed = error; didFail = true; }).finally(() => {
            running.delete(call.ordinal);
            notify?.();
          });
          running.set(call.ordinal, promise);
        };
        const wait = () => new Promise<void>((resolve, reject) => {
          const stop = () => { notify = undefined; signal.removeEventListener("abort", cancel); };
          const cancel = () => { stop(); reject(signal.reason); };
          notify = () => { stop(); resolve(); };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
        for (;;) {
          signal.throwIfAborted();
          if (JSON.stringify(input).length > CODE_SEGMENT_MAX_BYTES) return { error: "Code execution data exceeds 2 MiB; split into smaller execute calls" };
          const output = await transport(input, signal);
          if (output.settled) {
            if (!output.error && issued.length !== input.history.length)
              throw new Error("Await every package call before returning");
            return { result: output.result, error: output.error, logs: output.logs };
          }
          if (!output.calls?.length) throw new Error("Invalid code segment response");
          // Validate the entire batch before invoking any host effect.
          const next = [...issued], seen = new Set<number>(), completed = new Set(input.history.map(entry => entry.call.ordinal));
          for (const call of output.calls) {
            if (!Number.isSafeInteger(call.ordinal) || call.ordinal < 0 || seen.has(call.ordinal) || completed.has(call.ordinal) ||
                !Object.hasOwn(packages, call.packageName) || !packages[call.packageName]!.includes(call.method))
              throw new Error("Invalid code package call");
            seen.add(call.ordinal);
            const prior = next[call.ordinal];
            if (prior ? codeCallKey(prior) !== codeCallKey(call) : call.ordinal !== next.length)
              throw new Error("Invalid code package call identity during replay");
            if (!prior) next.push(call);
          }
          if (seen.size > 32 || issued.some(call => !completed.has(call.ordinal) && !seen.has(call.ordinal)))
            throw new Error("Invalid pending code package calls");
          for (const call of next.slice(issued.length)) { issued.push(call); launch(call); }
          // Deliver exactly one completion, then execute the newly runnable guest
          // branches before consuming another. Native ranks also restore this order
          // when recorded promises arrive in a different order after a restart.
          for (;;) {
            signal.throwIfAborted();
            if (didFail) throw failed;
            const index = ready.findIndex(item => item.outcome._tag === "Returned" &&
              (item.outcome.completionOrder === undefined || item.outcome.completionOrder === input.history.length));
            if (index !== -1) {
              const { call, outcome } = ready.splice(index, 1)[0]!;
              if (outcome._tag === "Returned") input.history.push({ call, result: outcome.result ?? null });
              break;
            }
            if (!running.size) {
              if (ready.length) throw new Error("Invalid native package completion order");
              // The native reactor emits BlockedOn and resumes from its own log.
              // Returning only after runnable branches drain avoids parking before
              // a fast sibling has had a chance to launch its continuation.
              if (parked.size) return {};
              throw new Error("Code is waiting without a package call");
            }
            await wait();
          }
        }
        } finally {
          parentSignal.removeEventListener("abort", abort);
          controller.abort();
        }
      },
      catch: error => ({ error: error instanceof Error ? error.message : "Code sandbox unavailable" }),
    }).pipe(Effect.catch(result => Effect.succeed(result))),
  };
}
export const codegraffSandboxLayer = (transport: CodeSegmentTransport) => Layer.succeed(Sandbox)(codegraffSandboxService(transport));
