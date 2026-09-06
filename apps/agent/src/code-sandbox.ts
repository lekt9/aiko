import { Effect, Layer } from "effect";
import { Sandbox, type SandboxService, type SandboxCall } from "tardie/code/sandbox/service";
import { CODE_SEGMENT_MAX_BYTES, type CodeSegment, type CodeSegmentResult } from "./code-sandbox-protocol.ts";

export type CodeSegmentTransport = (segment: CodeSegment, signal: AbortSignal) => Promise<CodeSegmentResult>;
/** Tardigrade keeps package identities and outcomes; Codegraff executes pure JS segments. */
export function codegraffSandboxService(transport: CodeSegmentTransport): SandboxService {
  return {
    run: (code, bindings, ambient) => Effect.tryPromise({
      try: async signal => {
        const packages: Record<string, string[]> = Object.create(null), values: Record<string, unknown> = Object.create(null);
        for (const [name, binding] of Object.entries(bindings)) {
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error("Invalid sandbox binding");
          if (binding !== null && typeof binding === "object" && !Array.isArray(binding) && Object.values(binding).every(v => typeof v === "function"))
            packages[name] = Object.keys(binding);
          else values[name] = binding;
        }
        const input: CodeSegment = { version: 1, code, packages, values, ambient: ambient ?? { at: 0, seed: "aiko" }, history: [] };
        for (;;) {
          signal.throwIfAborted();
          if (JSON.stringify(input).length > CODE_SEGMENT_MAX_BYTES) return { error: "Code execution data exceeds 2 MiB; split into smaller execute calls" };
          const output = await transport(input, signal);
          if (output.settled) return { result: output.result, error: output.error, logs: output.logs };
          if (!output.calls?.length) throw new Error("Invalid code segment response");
          // Validate the entire batch before invoking any host effect.
          for (let index = 0; index < output.calls.length; index++) {
            const call = output.calls[index]!;
            if (call.ordinal !== input.history.length + index || !Object.hasOwn(packages, call.packageName) || !packages[call.packageName]!.includes(call.method))
              throw new Error("Invalid code package call");
          }
          const outcomes = await Promise.all(output.calls.map(async call => {
            signal.throwIfAborted();
            const fn = (bindings[call.packageName] as Record<string, SandboxCall>)[call.method]!;
            return { call, outcome: await fn(call.args, call.ordinal) };
          }));
          if (outcomes.some(item => item.outcome._tag === "Parked")) {
            // The native code reactor owns parking and interrupts this attempt.
            await new Promise<void>((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          for (const { call, outcome } of outcomes) if (outcome._tag === "Returned") input.history.push({ call, result: outcome.result ?? null });
        }
      },
      catch: error => ({ error: error instanceof Error ? error.message : "Code sandbox unavailable" }),
    }).pipe(Effect.catch(result => Effect.succeed(result))),
  };
}
export const codegraffSandboxLayer = (transport: CodeSegmentTransport) => Layer.succeed(Sandbox)(codegraffSandboxService(transport));
