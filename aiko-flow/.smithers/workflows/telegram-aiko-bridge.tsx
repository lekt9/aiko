// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: Telegram ↔ Aiko bridge
// smithers-description: Durable chat bridge — getUpdates long-poll (durable cursor, via the source host) wakes this run, an Aiko worker returns ONE typed reply union, and the bridge routes each reply kind to exactly one Telegram verb. Never carries the bot token in a row, a prompt, or an argument.
//
// SHAPE (one turn per loop iteration):
//
//   OnMessage(chat)            durable wait on integration:telegram:message,
//                              woken by the source host (bridgeHost.js) — the
//                              run holds no process while it waits
//     ├─ TypingIndicator       refreshing chat action, bounded (Telegram
//     │                        clears "typing…" after ~5s, so ONE action
//     │                        cannot cover an agent turn)
//     └─ Task(aiko worker)     runs on the AikoAgent harness, output typed as
//                              telegramWorkerReplySchema
//          └─ SendReply        THE ROUTER: kind → verb, one send per reply
//
// TypingIndicator and the worker are siblings with no dependency between
// them, so the engine schedules them CONCURRENTLY (Parallel, maxConcurrency
// 2). The indicator is bounded by `typingMaxMs` rather than by the turn's
// end: a compute task cannot observe another node's completion from inside
// its own process, and an unbounded refresher is an orphan generator. Keep
// `typingMaxMs` at or below the latency you are willing to add to the next
// wait — the iteration is not complete until the hold expires.
//
// SECRETS. The input carries `botTokenEnv`, the NAME of the environment
// variable. The value is read inside the effect by resolveTelegramConfig
// (packages/integrations/src/telegram/config.js) at the moment of the call,
// so it never reaches a prop, a durable row, a prompt, or a log. Prior art:
// .smithers/workflows/telegram-daily-digest.tsx:15,103,280.
//
// PRIVACY. The worker never sees the raw Update. It sees
// `toTelegramBridgeEvent(...)` — {source, update_id, actor_id, chat_id, kind,
// authorization, summary} with the summary truncated — the redacted-by-
// construction shape .agents/skills/telegram-contracts/SKILL.md specifies.
//
// RUN IT:
//   export TELEGRAM_BOT_TOKEN=...                     # value only in env
//   bun packages/integrations/src/telegram/bridgeHost.js --db ./smithers.db &
//   smithers workflow run telegram-aiko-bridge -d \
//     --input '{"chatId":"<chat>","maxTurns":50}'
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import {
  OnMessage,
  SendReply,
  TelegramMessageSchema,
  TypingIndicator,
  telegramDispatchResultSchema,
  telegramTypingHoldSchema,
  telegramWorkerReplySchema,
  toTelegramBridgeEvent,
} from "@smthrs/integrations/telegram";
import { providers } from "../agents";

const inputSchema = z.object({
  chatId: z.string().min(1).describe("Telegram chat id this bridge serves (correlation: chat:<id>)."),
  botTokenEnv: z
    .string()
    .min(1)
    .default("TELEGRAM_BOT_TOKEN")
    .describe("NAME of the environment variable holding the bot token — never the value."),
  apiBaseUrl: z
    .string()
    .optional()
    .describe("Bot API base URL override (the fixture seam; omit in production)."),
  maxTurns: z.number().int().min(1).default(50).describe("Loop bound: how many inbound turns this run serves."),
  waitTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .default(600_000)
    .describe("How long one turn waits for a message before looping (onTimeout=continue)."),
  typingIntervalMs: z.number().int().min(250).default(4_000).describe("Typing refresh cadence (Telegram expires ~5s)."),
  typingMaxMs: z.number().int().min(0).default(10_000).describe("Bound on the typing hold; 0 disables the indicator."),
  summaryMaxChars: z.number().int().min(16).default(280).describe("Truncation cap for the event summary."),
  agentTimeoutMs: z.number().int().min(1000).default(600_000).describe("Bound on one Aiko worker turn."),
});

const { Workflow, Task, Loop, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  // `<OnMessage>` writes the delivered Bot API Message through this schema,
  // so it must be registered here like any other output table.
  inbound: TelegramMessageSchema,
  reply: telegramWorkerReplySchema,
  dispatch: telegramDispatchResultSchema,
  typing: telegramTypingHoldSchema,
});

export default smithers((ctx) => {
  const {
    chatId,
    botTokenEnv,
    apiBaseUrl,
    maxTurns,
    waitTimeoutMs,
    typingIntervalMs,
    typingMaxMs,
    summaryMaxChars,
    agentTimeoutMs,
  } = ctx.input;
  // Config carries the env var NAME plus the (optional) API base — no token.
  const config = { botTokenEnv, ...(apiBaseUrl ? { apiBaseUrl } : {}) };
  return (
    <Workflow name="telegram-aiko-bridge">
      <Loop id="turn" until={false} maxIterations={maxTurns} onMaxReached="return-last" continueAsNewEvery={50}>
        <OnMessage id="inbound" chatId={chatId} timeoutMs={waitTimeoutMs} onTimeout="continue">
          {(message) => {
            const event = toTelegramBridgeEvent(message, {
              allowedChatIds: [chatId],
              summaryMaxChars,
            });
            return (
              <>
                <Parallel id="turn-work" maxConcurrency={2}>
                  <TypingIndicator
                    id="typing"
                    chatId={chatId}
                    config={config}
                    intervalMs={typingIntervalMs}
                    maxMs={typingMaxMs}
                    skipIf={typingMaxMs === 0}
                    dependsOn={["inbound"]}
                    output={outputs.typing}
                  />
                  <Task
                    id="worker"
                    agent={providers.aiko}
                    output={outputs.reply}
                    dependsOn={["inbound"]}
                    retries={2}
                    timeoutMs={agentTimeoutMs}
                  >
                    {[
                      `You are the Aiko worker behind a Telegram bridge. One inbound event, one reply turn.`,
                      ``,
                      `EVENT (already redacted — this is everything you get; there is no raw update, no token, no media bytes):`,
                      JSON.stringify(event),
                      ``,
                      `Decide the KIND of reply. The bridge owns the transport: it picks the Telegram verb from your`,
                      `"kind" and sends to the chat the event came from, so a chatId you invent cannot address anyone.`,
                      ``,
                      `Reply with ONLY this JSON object and nothing else:`,
                      `{"chatId": ${JSON.stringify(String(chatId))}, "replies": [ ...one or more replies... ]}`,
                      ``,
                      `Each reply is exactly one of:`,
                      `  {"kind":"text","text":"...","parseMode":"markdown"}`,
                      `  {"kind":"photo","path":"/absolute/path.png","caption":null}`,
                      `  {"kind":"video","path":"/absolute/path.mp4","caption":null}`,
                      `  {"kind":"audio","path":"/absolute/path.mp3","caption":null}`,
                      `  {"kind":"voice","path":"/absolute/path.ogg","caption":null}`,
                      ``,
                      `A media reply's "path" must be a file that already exists on this machine — produce it first`,
                      `with your tools, then name it. Never echo a token, a credential, or a file's raw bytes.`,
                    ].join("\n")}
                  </Task>
                </Parallel>
                {/* THE ROUTER. chatId comes from the event, never from the worker payload. */}
                <SendReply
                  id="dispatch"
                  chatId={chatId}
                  config={config}
                  deps={{ reply: outputs.reply }}
                  needs={{ reply: "worker" }}
                  output={outputs.dispatch}
                  // Bounded on purpose: the media path came from a model, so a
                  // path that does not exist must fail the turn, not retry forever.
                  retries={2}
                  replyToMessageId={typeof message?.message_id === "number" ? message.message_id : undefined}
                />
              </>
            );
          }}
        </OnMessage>
      </Loop>
    </Workflow>
  );
});
