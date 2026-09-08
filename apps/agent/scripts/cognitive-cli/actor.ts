/** Isolated CLI compatibility fixture. Production factory and component
 * contracts, synthetic memory and inference, no physical message sender. */
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createAikoActor } from "../../src/actor.ts";

export default createAikoActor({
  owner: "123",
  background: true,
  contributionMode: "enabled",
  memory: { owner: "123", thread: "user-123", stateDir: `${process.cwd()}/.tardigrade/fixture-memory`, redact: text => text, readPage: async () => [] },
  voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Hello.", source: "template" as const }),
});

export const layersFor = () => Layer.succeed(Infer, {
  resolve: () => ({ model: { provider: "fixture", model_id: "offline" } }),
  react: () => Effect.succeed({ kind: "complete" as const, output: "The isolated native CLI fixture completed. No external action was taken." }),
});
