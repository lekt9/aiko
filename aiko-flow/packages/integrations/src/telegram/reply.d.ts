import { TelegramClientService } from './TelegramClientTypes.js';
import { z } from 'zod';
import 'effect';
import '@smthrs/errors/SmithersError';

/**
 * Content type for a local media path (extension table, lowercase).
 * @param {string} path
 * @returns {string | undefined}
 */
declare function telegramContentTypeForPath(path: string): string | undefined;
/**
 * Bot API verb for a reply kind. Throws on an unknown kind rather than
 * returning undefined — an unrouted reply must be loud.
 * @param {string} kind
 * @returns {string}
 */
declare function telegramReplyVerb(kind: string): string;
/**
 * Dispatch ONE typed reply to ONE chat. Returns the durable record of what
 * crossed the boundary — never the bytes.
 *
 * @param {import("./TelegramClientTypes.ts").TelegramClientService} client
 * @param {number | string} chatId destination, from the INBOUND event
 * @param {z.infer<typeof telegramReplySchema>} reply
 * @param {{ replyToMessageId?: number; messageThreadId?: number }} [options]
 * @returns {Promise<z.infer<typeof telegramDispatchedSchema>>}
 */
declare function dispatchTelegramReply(client: TelegramClientService, chatId: number | string, reply: z.infer<typeof telegramReplySchema>, options?: {
    replyToMessageId?: number;
    messageThreadId?: number;
}): Promise<z.infer<typeof telegramDispatchedSchema>>;
/**
 * Dispatch a whole worker turn, in order. Sequential on purpose: a caption
 * followed by a voice note must arrive in that order, and Telegram does not
 * promise ordering for concurrent sends.
 *
 * @param {import("./TelegramClientTypes.ts").TelegramClientService} client
 * @param {number | string} chatId destination, from the INBOUND event
 * @param {z.infer<typeof telegramReplySchema>[] | z.infer<typeof telegramWorkerReplySchema>} replies
 * @param {{ replyToMessageId?: number; messageThreadId?: number }} [options]
 * @returns {Promise<z.infer<typeof telegramDispatchResultSchema>>}
 */
declare function dispatchTelegramReplies(client: TelegramClientService, chatId: number | string, replies: z.infer<typeof telegramReplySchema>[] | z.infer<typeof telegramWorkerReplySchema>, options?: {
    replyToMessageId?: number;
    messageThreadId?: number;
}): Promise<z.infer<typeof telegramDispatchResultSchema>>;
/** Every kind the union covers, in declaration order. */
declare const TELEGRAM_REPLY_KINDS: readonly ["text", "photo", "video", "audio", "voice"];
/**
 * kind → Bot API verb. This table IS the router: `dispatchTelegramReply`
 * reads it rather than re-deciding, so a witness can assert the mapping
 * directly and a wrong entry is a one-line, visible defect.
 * @type {Record<(typeof TELEGRAM_REPLY_KINDS)[number], string>}
 */
declare const TELEGRAM_REPLY_VERBS: Record<(typeof TELEGRAM_REPLY_KINDS)[number], string>;
/** Cap on a single uploaded reply (Bot API rejects >50MB uploads anyway). */
declare const TELEGRAM_MAX_UPLOAD_BYTES: number;
/**
 * The reply union. One arm per send capability; adding a capability means
 * adding an arm AND a verb — a half-added kind cannot type-check.
 */
declare const telegramReplySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"text">;
    text: z.ZodString;
    parseMode: z.ZodDefault<z.ZodEnum<{
        markdown: "markdown";
        MarkdownV2: "MarkdownV2";
        HTML: "HTML";
        none: "none";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<string>;
    path: z.ZodString;
    caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<string>;
    path: z.ZodString;
    caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<string>;
    path: z.ZodString;
    caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<string>;
    path: z.ZodString;
    caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>], "kind">;
/**
 * What one Aiko worker turn returns. `replies` is an array because one turn
 * legitimately answers with a caption plus a voice note. `chatId` is the
 * worker's own bookkeeping — the router IGNORES it (see the header).
 */
declare const telegramWorkerReplySchema: z.ZodObject<{
    chatId: z.ZodString;
    replies: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"text">;
        text: z.ZodString;
        parseMode: z.ZodDefault<z.ZodEnum<{
            markdown: "markdown";
            MarkdownV2: "MarkdownV2";
            HTML: "HTML";
            none: "none";
        }>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<string>;
        path: z.ZodString;
        caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<string>;
        path: z.ZodString;
        caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<string>;
        path: z.ZodString;
        caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<string>;
        path: z.ZodString;
        caption: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>], "kind">>;
}, z.core.$strip>;
/** One dispatched reply, as it lands in a durable row: no bytes, no token. */
declare const telegramDispatchedSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        text: "text";
        photo: "photo";
        video: "video";
        audio: "audio";
        voice: "voice";
    }>;
    method: z.ZodString;
    messageId: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    bytes: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    filename: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
/** Output of the router as a durable Task result. */
declare const telegramDispatchResultSchema: z.ZodObject<{
    chatId: z.ZodString;
    count: z.ZodNumber;
    kinds: z.ZodArray<z.ZodString>;
    dispatched: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            text: "text";
            photo: "photo";
            video: "video";
            audio: "audio";
            voice: "voice";
        }>;
        method: z.ZodString;
        messageId: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        bytes: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        filename: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;

export { TELEGRAM_MAX_UPLOAD_BYTES, TELEGRAM_REPLY_KINDS, TELEGRAM_REPLY_VERBS, dispatchTelegramReplies, dispatchTelegramReply, telegramContentTypeForPath, telegramDispatchResultSchema, telegramDispatchedSchema, telegramReplySchema, telegramReplyVerb, telegramWorkerReplySchema };
