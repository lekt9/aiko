import { eventEpochOf, turnEpochOf } from "tardie/code/execution/turns";
import type { Event } from "tardie/core/log/event";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { NativeTool } from "tardie/component/tool";
import { artifactReferences, replyArtifacts } from "./database-artifacts.ts";
import type { DatabaseBinding } from "./database-component.ts";

export const RESPONSE_INSTRUCTIONS =
  "Every foreground user request must end with a response tool. Use respond(text) for the final answer; the host routes it to the originating chat, API or console using the existing persona and durable outbox. There is no destination argument. A final send_message, telegram_send, telegram_voice or telegram_screenshot also satisfies this for Telegram. Progress, reactions and connection recommendations are not final answers. A final response must be the only call in its native action, after all preceding work and checks have returned; never batch it with another call, including another final reply. Final response tools are direct native tools, not tools.call targets inside execute. After the final response tool, do no more work. Queued means accepted for delivery, not confirmed delivered. Never resend an unknown delivery. Report actual blockers without claiming unfinished work succeeded.";

/** Composition can outlive inference; report its durable intent until the reply exists. */
export function preparingReplies(log: readonly Event[]): string[] {
  const messages = new Set(log.filter(e => e.type === "MessageReceived").map(e => String(e.id)));
  const prepared = new Set(log.filter(e => e.type === "AikoReplyPrepared").map(e => `${e.turn}:${Number(e.epoch ?? 0)}`));
  return [...new Set(log.filter(e => e.type === "AikoVoiceStarted" && messages.has(String(e.turn)) &&
    Number(e.epoch ?? 0) === turnEpochOf(log, String(e.turn)) &&
    !prepared.has(`${e.turn}:${Number(e.epoch ?? 0)}`)).map(e => String(e.turn)))];
}

/** A durable response intent activates the existing persona/outbox, never a second sender. */
export function responseTool(
  owner: string,
  thread: string,
  redact: (text: string) => string,
  databases?: DatabaseBinding,
): NativeTool<Self | EventLog> {
  return {
    spec: {
      name: "respond",
      description:
        "Finish this user request with a reply on its original channel. Attach committed database views with artifacts:[{artifactId}]; only references are sent, and access is checked again when opened. The host owns the destination and persona rendering. This queues exactly one durable response; queued is not proof of external delivery.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 12000 },
          artifacts: { type: "array", maxItems: 8, items: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"], additionalProperties: false } },
          outcome: {
            type: ["string", "null"],
            enum: ["answer", "blocked", null],
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    run: (input, context) =>
      Effect.gen(function* () {
        const self = yield* Self,
          log = yield* EventLog,
          events = yield* log.read;
        const args = input as { text?: unknown; outcome?: unknown; artifacts?: unknown } | null;
        const message = events.find(
          (e) => e.type === "MessageReceived" && e.id === context.turn,
        );
        const call = [...events]
          .reverse()
          .find(
            (e) =>
              e.type === "ToolCalled" &&
              e.callId === context.callId &&
              e.turn === context.turn,
          );
        if (
          self.actor !== "aiko" ||
          self.thread !== thread ||
          !message ||
          !call ||
          message.source === "background" ||
          !args ||
          Object.keys(args).some((k) => !["text", "outcome", "artifacts"].includes(k)) ||
          (args.outcome != null &&
            !["answer", "blocked"].includes(String(args.outcome))) ||
          typeof args.text !== "string" ||
          !args.text.trim() ||
          args.text.length > 12000
        )
          return {
            kind: "channel-response",
            owner,
            turn: context.turn,
            status: "rejected",
          };
        const telegram =
          message.source === "telegram" ||
          (["operator", "automation"].includes(String(message.source)) &&
            message.channel === "telegram");
        if (
          telegram &&
          (String(message.chat) !== owner ||
            !(
              String(message.sender) === owner ||
              (["operator", "automation"].includes(String(message.source)) &&
                message.sender === message.source)
            ))
        )
          return {
            kind: "channel-response",
            owner,
            turn: context.turn,
            status: "rejected",
          };
        const epoch = Number(call.epoch ?? 0);
        const previous = events.find(
          (e) =>
            e.type === "AikoResponseRequested" &&
            e.turn === context.turn &&
            Number(e.epoch ?? 0) === epoch,
        );
        const text = previous
          ? String(previous.output)
          : redact(args.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
        const artifacts = yield* Effect.tryPromise({ try: async () => {
          const refs = artifactReferences(previous ? previous.artifacts : args.artifacts);
          if (refs.length && (!databases || databases.owner !== owner || databases.thread !== thread)) return undefined;
          const checked = await replyArtifacts(databases, refs, context.signal);
          return checked.some(ref => ref.state !== "available") ? undefined : refs;
        }, catch: () => undefined }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!artifacts) return { kind: "channel-response", owner, turn: context.turn, status: "rejected", code: "artifact_unavailable" };
        if (!text.trim())
          return {
            kind: "channel-response",
            owner,
            turn: context.turn,
            status: "rejected",
          };
        if (!previous)
          yield* log.append([
            {
              type: "AikoResponseRequested",
              owner,
              turn: context.turn,
              epoch,
              output: text,
              ...(artifacts.length ? { artifacts } : {}),
              outcome: args.outcome ?? "answer",
              channel: telegram ? "telegram" : String(message.source ?? "api"),
              at: Date.now(),
            },
          ]);
        return {
          kind: "channel-response",
          owner,
          turn: context.turn,
          status: "queued",
          text,
        };
      }),
  };
}

const terminalTools = new Set([
  "send_message",
  "telegram_send",
  "telegram_voice",
  "telegram_screenshot",
]);
export function isFinalResponseCall(call: { name: string; arguments: unknown }): boolean {
  return call.name === "respond" || terminalTools.has(call.name) &&
    (call.arguments as { final?: unknown } | null)?.final === true;
}
function finalResponse(request: InferRequest) {
  // Infer receives a projected trajectory: prior failed terminals are omitted.
  // Read the retained native epoch stamps instead of replaying a full-history turn projection.
  const epoch = Math.max(0, ...request.trajectory.filter(e => e.turn === request.identity.turn && ["ModelCalled", "ToolCalled", "TurnResumed"].includes(e.type)).map(eventEpochOf));
  const owner = /^user-(.+)$/.exec(request.identity.thread)?.[1];
  const calls = new Map<string, string>();
  let final: { output: string } | { error: string } | undefined;
  for (const e of request.trajectory) {
    if (e.turn !== request.identity.turn) continue;
    if (e.type === "ToolCalled" && Number(e.epoch ?? 0) === epoch)
      calls.set(String(e.callId), String(e.name));
    // Native tool() returns are correlated by callId; they need not repeat the epoch.
    if (e.type !== "ToolReturned" || (e.epoch !== undefined && Number(e.epoch) !== epoch)) continue;
    const name = calls.get(String(e.callId)),
      result = e.result as Record<string, unknown> | undefined;
    if (
      !result ||
      result.turn !== request.identity.turn ||
      (owner !== undefined && result.owner !== owner)
    )
      continue;
    if (
      name === "respond" &&
      result.kind === "channel-response" &&
      result.status === "queued"
    )
      final = { output: String(result.text ?? "") };
    if (
      name === "respond" &&
      result.kind === "channel-response" &&
      result.status === "rejected"
    )
      final = { error: "Response rejected by the channel boundary" };
    if (
      name &&
      terminalTools.has(name) &&
      result.final === true &&
      ["delivered", "unknown"].includes(String(result.status))
    )
      final = { output: String(result.reply ?? result.text ?? "") };
  }
  return final;
}

/** Host invariant outside all browser/workflow wrappers: a plain completion becomes a native tool call. */
export function withRequiredResponse(
  base: Layer.Layer<Infer>,
  redact: (text: string) => string = (text) => text,
) {
  return Layer.effect(
    Infer,
    Effect.gen(function* () {
      const binding = yield* Infer;
      return {
        ...binding,
        react: (request: InferRequest, key?: string, signal?: AbortSignal) =>
          Effect.gen(function* () {
            if (
              request.identity.actor !== "aiko" ||
              !request.tools.some((t) => t.name === "respond")
            )
              return yield* binding.react(request, key, signal);
            const final = finalResponse(request);
            if (final !== undefined)
              return "error" in final
                ? { kind: "fail" as const, error: final.error }
                : { kind: "complete" as const, output: final.output };
            const action = yield* binding.react(request, key, signal);
            // Native batches dispatch siblings concurrently. A final answer
            // cannot depend on their as-yet-unseen receipts. Reject the whole
            // batch before ordinary dispatch, rather than dropping a call.
            // Earlier authorized speculation is not undone by this rejection.
            if (action.kind === "calls" && action.calls.length > 1 && action.calls.some(isFinalResponseCall))
              return {
                kind: "fail" as const,
                error: "Final response refused: await the work and its acceptance checks, then send one standalone final response. This batch was not admitted; inspect any earlier or speculative work before retrying.",
                usage: action.usage, endpoint: action.endpoint, mode: action.mode,
                failure: { cause: "output_validation_failed" as const, attempts: 0, policy: { source: "aiko_final_response_boundary" } },
              };
            if (action.kind === "calls") return {
              ...action,
              calls: action.calls.map(call => call.name === "respond" && typeof (call.arguments as any)?.text === "string"
                ? { ...call, arguments: { ...(call.arguments as object), text: redact((call.arguments as any).text) } }
                : call),
            };
            if (
              action.kind === "call" &&
              action.name === "respond" &&
              typeof (action.arguments as any)?.text === "string"
            )
              return {
                ...action,
                arguments: {
                  ...(action.arguments as object),
                  text: redact((action.arguments as any).text),
                },
              };
            // Preserve the native failure terminal and its diagnostics. The outbox delivers its service notice.
            if (action.kind !== "complete")
              return action;
            const text =
              typeof action.output === "string" &&
              action.output.trim()
                ? action.output
                : "I couldn’t finish that request. Some actions may be unconfirmed; please check before retrying.";
            return {
              kind: "call" as const,
              callId: `respond-${crypto.randomUUID()}`,
              name: "respond",
              usage: action.usage,
              endpoint: action.endpoint,
              mode: action.mode,
              arguments: {
                text: redact(text),
              },
            };
          }),
      };
    }),
  ).pipe(Layer.provide(base));
}
