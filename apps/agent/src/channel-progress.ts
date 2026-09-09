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
  source: "model" | "host";
  started: boolean;
  settled: boolean;
  context?: { replyTo?: number; messageThreadId?: number };
};
type Turn = { epoch: number; done: boolean; feedbackPlanned: boolean; context: Progress["context"]; pending?: Progress };
const messageTools = new Set(["send_message", "telegram_send", "telegram_voice", "telegram_screenshot", "telegram_sandbox_media", "respond"]);

function progress(turn: string, current: Turn, text: string, source: Progress["source"]): Progress {
  return {
    key: createHash("sha256").update(JSON.stringify([turn, current.epoch, text])).digest("hex"),
    turn, epoch: current.epoch, text, source, started: false, settled: false, context: current.context,
  };
}

/** Mount before infer/tool execution. Deliver working commentary, or one neutral
 * update if tools start silently, through the same keyed native effects. No extra
 * inference, timer or sender. Progress never settles final delivery or stops typing.
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
      keyOf: e => e.type === "AikoProgressActivated" ? (e.version === 2 ? "aiko-progress:activation:2" : "aiko-progress:activation")
        : e.type === "AikoProgressSettled" ? `aiko-progress:${e.key}`
        : e.type === "AikoProgressStarted" ? `aiko-progress:start:${e.key}` : undefined,
    },
    initial: () => ({ active: false, earlyFeedback: false, turns: new Map<string, Turn>() }),
    step: (state, e) => {
      if (e.type === "AikoProgressActivated") return { ...state, active: true, earlyFeedback: state.earlyFeedback || e.version === 2 };
      const turns = new Map(state.turns);
      if (e.type === "MessageReceived" && String(e.chat) === options.owner &&
        (e.source === "telegram" || (e.source === "operator" && e.channel === "telegram")) &&
        (String(e.sender) === options.owner || (e.source === "operator" && e.sender === "operator"))) {
        turns.set(String(e.id), { epoch: 0, done: false, feedbackPlanned: false, context: {
          replyTo: (e.telegram as any)?.messageId,
          messageThreadId: (e.telegram as any)?.messageThreadId,
        } });
      }
      const turn = String(e.turn), current = turns.get(turn);
      if (!current) return { ...state, turns };
      if (e.type === "TurnResumed") {
        if (Number(e.epoch) > current.epoch) turns.set(turn, { ...current, epoch: Number(e.epoch), done: false, feedbackPlanned: false, pending: undefined });
        return { ...state, turns };
      }
      if (Number(e.epoch ?? 0) !== current.epoch) return { ...state, turns };
      if (["TurnCompleted", "TurnFailed", "TurnCancelled", "AikoResponseRequested"].includes(e.type)) {
        turns.set(turn, { ...current, done: true, pending: undefined });
      } else if (e.type === "TextReturned" && !current.done && state.active && typeof e.text === "string") {
        const text = liveAnswer(e.text, options.owner, [], options.redact)?.trim();
        if (text) {
          const pending = progress(turn, current, text, "model");
          if (current.pending?.key !== pending.key) turns.set(turn, { ...current, feedbackPlanned: true, pending });
        }
      } else if (e.type === "ToolCalled" && !current.done) {
        if (messageTools.has(String(e.name))) {
          // That native call owns the message, including when it shares a batch
          // with work. Do not turn an uncertain explicit send into another send.
          turns.set(turn, { ...current, feedbackPlanned: true, pending: undefined });
        } else if (state.earlyFeedback && !current.feedbackPlanned) {
          turns.set(turn, { ...current, feedbackPlanned: true,
            pending: progress(turn, current, "I’m looking into your request now.", "host"),
          });
        }
      } else if (current.pending && current.pending.key === e.key && ["AikoProgressStarted", "AikoProgressSettled"].includes(e.type)) {
        turns.set(turn, { ...current, pending: { ...current.pending,
          started: true, settled: e.type === "AikoProgressSettled",
        } });
      }
      return { ...state, turns };
    },
    output: state => ({
      view: undefined,
      // A new durable activation fences the added behavior from pre-upgrade work.
      // Retain the legacy key so old commentary and uncertain receipts still replay.
      transitions: !state.earlyFeedback && [...state.turns.values()].some(turn => !turn.done) ? [effect({
        key: "aiko-progress:activation:2", input: null,
        act: () => Effect.succeed([{ type: "AikoProgressActivated", version: 2, at: Date.now() }]),
      })] : [...state.turns.values()].flatMap(({ pending }) => !pending || pending.settled ? [] : [effect({
        key: `aiko-progress:${pending.key}`, input: pending,
        interrupts: (input, e) => e.turn === input.turn &&
          ((["TurnCancelled", "TurnFailed", "TurnCompleted", "AikoResponseRequested"].includes(e.type) && Number(e.epoch ?? 0) === input.epoch) ||
            (e.type === "TurnResumed" && Number(e.epoch) > input.epoch)),
        act: (input, signal) => Effect.gen(function* () {
          const log = yield* EventLog;
          const stamp = { key: input.key, turn: input.turn, epoch: input.epoch, owner: options.owner, source: input.source };
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
