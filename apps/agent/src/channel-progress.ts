import { createHash } from "node:crypto";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import type { Sender } from "./actor.ts";
import type { Voice } from "./voice.ts";
import { liveAnswer } from "./reply-policy.ts";

type Progress = {
  key: string;
  turn: string;
  epoch: number;
  text: string;
  started: boolean;
  settled: boolean;
  context?: { replyTo?: number; messageThreadId?: number };
};
type Turn = { epoch: number; done: boolean; context: Progress["context"]; pending?: Progress };

/** Tardigrade's TextReturned is working commentary, not a terminal. Deliver it
 * through keyed native effects without manufacturing another inference turn.
 * Separate receipts keep progress from settling final delivery or stopping typing.
 */
export function channelProgress(options: {
  owner: string;
  voice: Voice;
  send: Sender;
  redact: (text: string) => string;
  requireThinkFeel?: boolean;
}) {
  return component({
    name: "aiko.channel-progress",
    keys: {
      prefixes: ["aiko-progress:"],
      keyOf: e => e.type === "AikoProgressActivated" ? "aiko-progress:activation"
        : e.type === "AikoProgressSettled" ? `aiko-progress:${e.key}`
        : e.type === "AikoProgressStarted" ? `aiko-progress:start:${e.key}` : undefined,
    },
    initial: () => ({ active: false, turns: new Map<string, Turn>() }),
    step: (state, e) => {
      if (e.type === "AikoProgressActivated") return { ...state, active: true };
      const turns = new Map(state.turns);
      if (e.type === "MessageReceived" && String(e.chat) === options.owner &&
        (e.source === "telegram" || (e.source === "operator" && e.channel === "telegram"))) {
        turns.set(String(e.id), { epoch: 0, done: false, context: {
          replyTo: (e.telegram as any)?.messageId,
          messageThreadId: (e.telegram as any)?.messageThreadId,
        } });
      }
      const turn = String(e.turn), current = turns.get(turn);
      if (!current) return { ...state, turns };
      if (e.type === "TurnResumed") {
        if (Number(e.epoch) > current.epoch) turns.set(turn, { ...current, epoch: Number(e.epoch), done: false, pending: undefined });
        return { ...state, turns };
      }
      if (Number(e.epoch ?? 0) !== current.epoch) return { ...state, turns };
      if (["TurnCompleted", "TurnFailed", "TurnCancelled", "AikoResponseRequested"].includes(e.type)) {
        turns.set(turn, { ...current, done: true, pending: undefined });
      } else if (e.type === "TextReturned" && !current.done && state.active && typeof e.text === "string") {
        const text = liveAnswer(e.text, options.owner, [], options.redact)?.trim();
        if (text) {
          const key = createHash("sha256").update(JSON.stringify([turn, current.epoch, text])).digest("hex");
          if (current.pending?.key !== key) turns.set(turn, { ...current, pending: {
            key, turn, epoch: current.epoch, text, started: false, settled: false, context: current.context,
          } });
        }
      } else if (e.type === "ToolCalled" && ["send_message", "telegram_send", "telegram_voice", "telegram_screenshot", "respond"].includes(String(e.name))) {
        // That native call already carries the model's intended channel message.
        turns.set(turn, { ...current, pending: undefined });
      } else if (current.pending && current.pending.key === e.key && ["AikoProgressStarted", "AikoProgressSettled"].includes(e.type)) {
        turns.set(turn, { ...current, pending: { ...current.pending,
          started: true, settled: e.type === "AikoProgressSettled",
        } });
      }
      return { ...state, turns };
    },
    output: state => ({
      view: undefined,
      transitions: !state.active && [...state.turns.values()].some(turn => !turn.done) ? [effect({
        key: "aiko-progress:activation", input: null,
        act: () => Effect.succeed([{ type: "AikoProgressActivated", at: Date.now() }]),
      })] : [...state.turns.values()].flatMap(({ pending }) => !pending || pending.settled ? [] : [effect({
        key: `aiko-progress:${pending.key}`, input: pending,
        interrupts: (input, e) => e.turn === input.turn &&
          ((["TurnCancelled", "TurnFailed", "TurnCompleted", "AikoResponseRequested"].includes(e.type) && Number(e.epoch ?? 0) === input.epoch) ||
            (e.type === "TurnResumed" && Number(e.epoch) > input.epoch)),
        act: (input, signal) => Effect.gen(function* () {
          const log = yield* EventLog;
          const stamp = { key: input.key, turn: input.turn, epoch: input.epoch, owner: options.owner };
          const settled = (result: unknown) => [{ type: "AikoProgressSettled", ...stamp, result, at: Date.now() }];
          // A crash after starting may have sent the message. Never retry an unknown send.
          if (input.started) return settled({ status: "unknown" });
          yield* log.append([{ type: "AikoProgressStarted", ...stamp, at: Date.now() }]);
          return yield* Effect.gen(function* () {
            const rendered = yield* options.voice({ kind: "answer", text: input.text }, signal);
            if (signal.aborted) return settled({ status: "rejected", reason: "cancelled" });
            if (rendered.source === "service" || (options.requireThinkFeel && rendered.source !== "thinkfeel"))
              return settled({ status: "rejected", reason: "wording_unavailable" });
            const result = yield* Effect.tryPromise({
              try: () => options.send(options.owner, options.redact(rendered.text), signal, input.context),
              catch: () => new Error("Progress delivery uncertain"),
            });
            return settled({ ...result, ...(result.status === "delivered" ? { text: options.redact(rendered.text) } : {}) });
          }).pipe(Effect.catch(() => Effect.succeed(settled({ status: "unknown" }))));
        }),
      })]),
    }),
  });
}
