// The privacy-safe inbound event shape the bridge hands to a worker.
//
// The worker never sees the raw Update. It sees a redacted-by-construction
// declaration: `{source, update_id, actor_id, kind, authorization, summary}`
// — no token, no media bytes, no arbitrary API response body, and a summary
// truncated to a declared cap. This is the shape
// `.agents/skills/telegram-contracts/SKILL.md` specifies, expressed as code
// so the redaction is a function rather than an instruction someone follows.
//
// Determinism note: this is a pure function of the message plus its options.
// It sits on the recompute path (a worker turn is derived from it), so it
// must not read a clock, a random source, or the environment.

import { z } from "zod";

export const TELEGRAM_BRIDGE_EVENT_SOURCE = "telegram";
export const DEFAULT_SUMMARY_MAX_CHARS = 280;

export const telegramBridgeEventSchema = z.object({
  source: z.literal(TELEGRAM_BRIDGE_EVENT_SOURCE),
  update_id: z.number().nullable(),
  /** Telegram user id of the sender — an id, never a name or handle. */
  actor_id: z.string().nullable(),
  chat_id: z.string(),
  /** What arrived, not what it said. */
  kind: z.enum(["text", "photo", "video", "audio", "voice", "document", "sticker", "location", "other"]),
  /** Whether this chat is on the bridge's allow-list. */
  authorization: z.enum(["allowed", "denied", "unrestricted"]),
  /** Truncated text/caption. Empty string when the message carried none. */
  summary: z.string(),
  /** True when the summary was cut — so a worker knows it is not the whole text. */
  truncated: z.boolean(),
});

/**
 * Classify a Telegram message by what it carries.
 * @param {Record<string, any>} message
 * @returns {z.infer<typeof telegramBridgeEventSchema>["kind"]}
 */
export function telegramMessageKind(message) {
  if (!message || typeof message !== "object") {
    return "other";
  }
  if (message.photo) return "photo";
  if (message.video || message.video_note || message.animation) return "video";
  if (message.audio) return "audio";
  if (message.voice) return "voice";
  if (message.document) return "document";
  if (message.sticker) return "sticker";
  if (message.location || message.venue) return "location";
  if (typeof message.text === "string" && message.text.length > 0) return "text";
  return "other";
}

/**
 * Build the privacy-safe event from an inbound message.
 *
 * @param {Record<string, any>} message Bot API Message (the OnMessage payload)
 * @param {{ updateId?: number | null; allowedChatIds?: (number | string)[] | null; summaryMaxChars?: number }} [options]
 * @returns {z.infer<typeof telegramBridgeEventSchema>}
 */
export function toTelegramBridgeEvent(message, options = {}) {
  const maxChars = Math.max(1, options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS);
  const raw = typeof message?.text === "string" ? message.text : typeof message?.caption === "string" ? message.caption : "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const truncated = collapsed.length > maxChars;
  const allowList = options.allowedChatIds ?? null;
  const chatId = message?.chat?.id;
  const authorization =
    allowList == null || allowList.length === 0
      ? "unrestricted"
      : allowList.map(String).includes(String(chatId))
        ? "allowed"
        : "denied";
  return {
    source: TELEGRAM_BRIDGE_EVENT_SOURCE,
    update_id: typeof options.updateId === "number" ? options.updateId : null,
    actor_id: message?.from?.id != null ? String(message.from.id) : null,
    chat_id: chatId != null ? String(chatId) : "",
    kind: telegramMessageKind(message),
    authorization,
    summary: truncated ? `${collapsed.slice(0, maxChars)}…` : collapsed,
    truncated,
  };
}
