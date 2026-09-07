/**
 * Read-reaction picker: a small deterministic emoji for an incoming message,
 * fired on ingestion so the sender sees the message was read before the model
 * even starts. Only Telegram Bot API `setMessageReaction` emoji are used.
 */

/** Emojis Telegram bots may set as reactions (conservative subset). */
export const READ_REACTIONS = new Set([
  "👍",
  "👎",
  "❤",
  "🔥",
  "👏",
  "😁",
  "🤔",
  "😱",
  "😢",
  "🎉",
  "🤩",
  "🙏",
  "👌",
  "😍",
  "💯",
  "⚡",
  "🤝",
  "🚀",
]);

/**
 * Pick the reaction that best matches what the message is. Deterministic,
 * ordering matters: gratitude beats questions ("thanks, how do I…?"), trouble
 * beats praise ("great, but it's broken").
 */
export function readReactionFor(rawText: string, media = false): string {
  const text = String(rawText ?? "").toLowerCase();
  const has = (re: RegExp): boolean => re.test(text);
  if (media && !text.trim()) return "😍";
  if (
    has(
      /^(thanks?|thank you|thx|tysm|ty)\b|grazie|merci|danke|gracias|spasibo|谢谢|ありがとう/,
    )
  )
    return "❤";
  if (has(/congrat|birthday|bday|graduat|wedding|anniversary|new (job|house)/))
    return "🎉";
  if (has(/^(hi+|hey+|hello+|yo|sup|gm|good (morning|afternoon|evening))\b/))
    return "😁";
  if (has(/asap|urgent|emergency|right now/)) return "⚡";
  if (has(/bug|error|broken|crash(ed|es|ing)?|fails?|not working|stuck/))
    return "😱";
  if (has(/\bhelp\b|support|assist/)) return "🙏";
  if (
    has(
      /amazing|awesome|great|perfect|excellent|beautiful|love (it|this)|wow|nice|cool/,
    )
  )
    return "🔥";
  if (has(/price|cost|pay|payment|invoice|buy|purchase|\$\d|€\d/)) return "💯";
  if (
    text.includes("?") ||
    has(
      /^(what|why|how|when|where|who|which|can|could|does|do|is|are|will|should)\b/,
    )
  )
    return "🤔";
  if (has(/^(ok|okay|k|sure|yes|yeah|yep|yup|done|sounds good|go ahead)\b/))
    return "👍";
  return "👍";
}
