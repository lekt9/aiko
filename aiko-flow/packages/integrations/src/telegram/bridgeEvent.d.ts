import { z } from 'zod';

/**
 * Classify a Telegram message by what it carries.
 * @param {Record<string, any>} message
 * @returns {z.infer<typeof telegramBridgeEventSchema>["kind"]}
 */
declare function telegramMessageKind(message: Record<string, any>): z.infer<typeof telegramBridgeEventSchema>["kind"];
/**
 * Build the privacy-safe event from an inbound message.
 *
 * @param {Record<string, any>} message Bot API Message (the OnMessage payload)
 * @param {{ updateId?: number | null; allowedChatIds?: (number | string)[] | null; summaryMaxChars?: number }} [options]
 * @returns {z.infer<typeof telegramBridgeEventSchema>}
 */
declare function toTelegramBridgeEvent(message: Record<string, any>, options?: {
    updateId?: number | null;
    allowedChatIds?: (number | string)[] | null;
    summaryMaxChars?: number;
}): z.infer<typeof telegramBridgeEventSchema>;
declare const TELEGRAM_BRIDGE_EVENT_SOURCE: "telegram";
declare const DEFAULT_SUMMARY_MAX_CHARS: 280;
declare const telegramBridgeEventSchema: z.ZodObject<{
    source: z.ZodLiteral<"telegram">;
    update_id: z.ZodNullable<z.ZodNumber>;
    actor_id: z.ZodNullable<z.ZodString>;
    chat_id: z.ZodString;
    kind: z.ZodEnum<{
        photo: "photo";
        video: "video";
        audio: "audio";
        voice: "voice";
        text: "text";
        document: "document";
        sticker: "sticker";
        location: "location";
        other: "other";
    }>;
    authorization: z.ZodEnum<{
        allowed: "allowed";
        denied: "denied";
        unrestricted: "unrestricted";
    }>;
    summary: z.ZodString;
    truncated: z.ZodBoolean;
}, z.core.$strip>;

export { DEFAULT_SUMMARY_MAX_CHARS, TELEGRAM_BRIDGE_EVENT_SOURCE, telegramBridgeEventSchema, telegramMessageKind, toTelegramBridgeEvent };
