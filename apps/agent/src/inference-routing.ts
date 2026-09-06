import { Infer, type InferRequest } from "tardie";
import { Effect, Layer } from "effect";
export type InferenceRole = "conversation" | "rag" | "browser";
/** Select only from native tool-call provenance in this turn; page text cannot select a provider. */
export function inferenceRole(request: InferRequest): InferenceRole {
  const current = request.trajectory.filter(
    (e) => e.turn === request.identity.turn,
  );
  const returned = new Set(
    current.filter((e) => e.type === "ToolReturned").map((e) => e.callId),
  );
  for (const e of current.toReversed()) {
    if (e.type !== "ToolCalled" || !returned.has(e.callId)) continue;
    const name = String(e.name);
    if (name.startsWith("request_memory_") || name.startsWith("workflow_")) return "rag";
    if (name.startsWith("agent_browser_")) return "browser";
    return "conversation";
  }
  return "conversation";
}
export function withRoleInference(
  layerFor: (role: InferenceRole) => Layer.Layer<Infer>,
) {
  return Layer.effect(
    Infer,
    Effect.gen(function* () {
      const base = yield* Infer;
      return {
        ...base,
        react: (request: InferRequest, key?: string, signal?: AbortSignal) => {
          const role = inferenceRole(request);
          return Effect.gen(function* () {
            const model = yield* Infer;
            const selected = model.resolve?.().model;
            return yield* model.react(
              { ...request, model: selected },
              key,
              signal,
            );
          }).pipe(Effect.provide(layerFor(role)));
        },
      };
    }),
  ).pipe(Layer.provide(layerFor("conversation")));
}
