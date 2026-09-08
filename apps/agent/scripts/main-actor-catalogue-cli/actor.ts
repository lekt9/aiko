/** Offline native CLI fixture: real main actor and response boundary, no sender
 * or provider I/O. See docs/main-actor-catalogue.md for invocation and limits. */
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createAikoActor } from "../../src/actor.ts";
import { withRequiredResponse } from "../../src/channel-response.ts";

export default createAikoActor({
  owner: "123", live: true,
  // The standalone CLI maps logical user-123 to native ag.user-123. Bind
  // this fixture to that exact address; do not loosen production owner checks.
  memory: { owner: "123", thread: "ag.user-123", stateDir: `${process.cwd()}/.tardigrade/fixture-memory`, redact: text => text, readPage: async () => [] },
  voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Hello.", source: "template" as const }),
});

export const layersFor = () => withRequiredResponse(Layer.succeed(Infer, {
  resolve: () => ({ model: { provider: "fixture", model_id: "offline" } }),
  react: request => {
    const message = request.trajectory.find(e => e.type === "MessageReceived" && e.id === request.identity.turn);
    if (message?.text === "premature") return Effect.succeed({ kind: "calls" as const, calls: [
      { name: "access_status", callId: "unchecked-read", arguments: {} },
      { name: "respond", callId: "premature-reply", arguments: { text: "Unverified success" } },
    ] });
    const returned = request.trajectory.some(e => e.type === "ToolReturned" && e.turn === request.identity.turn);
    return Effect.succeed(returned
      ? { kind: "complete" as const, output: "The native capability receipt was read. No external action was taken." }
      : { kind: "call" as const, name: "access_status", callId: `${request.identity.turn}:checked-read`, arguments: {} });
  },
}));
