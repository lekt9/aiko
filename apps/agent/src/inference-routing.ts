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
    let name = String(e.name);
    if (name === "execute" || name === "code_workflow_run") {
      const execId =
        name === "execute" ? String(e.callId) : `workflow:${e.callId}`;
      const receipt = current.findLast(
        (row) =>
          row.type === "AikoCodeToolSettled" &&
          String(row.callId).startsWith(`${execId}.`),
      );
      if (receipt) name = String(receipt.tool);
    }
    if (name.startsWith("request_memory_") || name.startsWith("workflow_"))
      return "rag";
    if (name.startsWith("agent_browser_")) return "browser";
    return "conversation";
  }
  return "conversation";
}
export function withRoleInference(
  layerFor: (role: InferenceRole) => Layer.Layer<Infer>,
  modelLayerFor?: (model: {
    provider: string;
    model_id: string;
  }) => Layer.Layer<Infer>,
) {
  return Layer.effect(
    Infer,
    Effect.gen(function* () {
      const base = yield* Infer;
      return {
        ...base,
        compact: (
          request: Parameters<NonNullable<typeof base.compact>>[0],
          key?: string,
          signal?: AbortSignal,
        ) =>
          Effect.gen(function* () {
            // A checkpoint belongs to the model that produced the retained history.
            // A current tool role may already point at a different provider.
            if (request.model && modelLayerFor) {
              let selected: Layer.Layer<Infer>;
              try {
                selected = modelLayerFor(request.model);
              } catch {
                return undefined;
              }
              return yield* Effect.gen(function* () {
                const binding = yield* Infer;
                return binding.compact
                  ? yield* binding.compact(request, key, signal)
                  : undefined;
              }).pipe(Effect.provide(selected));
            }
            for (const role of ["conversation", "rag", "browser"] as const) {
              const result = yield* Effect.gen(function* () {
                const binding = yield* Infer,
                  model = binding.resolve?.().model;
                if (
                  request.model &&
                  (model?.provider !== request.model.provider ||
                    model.model_id !== request.model.model_id)
                )
                  return { matched: false } as const;
                return {
                  matched: true,
                  value: binding.compact
                    ? yield* binding.compact(request, key, signal)
                    : undefined,
                } as const;
              }).pipe(Effect.provide(layerFor(role)));
              if (result.matched) return result.value;
            }
            return undefined;
          }),
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
