import { Effect } from 'effect';
import { SmithersError } from '@smthrs/errors/SmithersError';

/**
 * Configuration for the fetch-based Telegram Bot API client. `apiBaseUrl`
 * exists so tests can point the real client at a fixture server.
 */
type TelegramClientConfig = {
    /** Bot token from @BotFather. Never logged; stripped from error output. */
    botToken: string;
    /** @default "https://api.telegram.org" */
    apiBaseUrl?: string;
    /** Max automatic retries on 429 rate limits. @default 3 */
    maxRateLimitRetries?: number;
    /** Cap on the server-supplied `retry_after` honored per retry (seconds). @default 30 */
    maxRetryAfterSeconds?: number;
};
/** One button of an inline keyboard (Telegram `InlineKeyboardButton`). */
type TelegramInlineKeyboardButton = {
    text: string;
    callback_data?: string;
    url?: string;
    web_app?: {
        url: string;
    };
};
/** Rows of inline-keyboard buttons (Telegram `InlineKeyboardMarkup.inline_keyboard`). */
type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];
type SendMessageSmartOptions = {
    /**
     * How to format outgoing text. `"markdown"` (default) converts standard
     * markdown to MarkdownV2 with escaping and falls back to plain text when
     * Telegram rejects the entities; `"MarkdownV2"`/`"HTML"` send the text
     * as-is under that parse mode (still with plain-text fallback); `"none"`
     * sends raw text with no parse mode.
     */
    parseMode?: "markdown" | "MarkdownV2" | "HTML" | "none";
    /** Attached to the FIRST chunk only. */
    replyToMessageId?: number;
    /** Forum-topic thread id, attached to every chunk. */
    messageThreadId?: number;
    /** Inline keyboard attached to the LAST chunk only. */
    inlineKeyboard?: TelegramInlineKeyboard;
    /** Send a `typing` chat action before the first chunk. @default true */
    typing?: boolean;
    disableNotification?: boolean;
};
type SendMessageSmartResult = {
    chatId: string;
    /** message_id of every sent chunk, in send order. */
    messageIds: number[];
    chunkCount: number;
    /** True when at least one chunk fell back to plain text after a parse 400. */
    usedPlainTextFallback: boolean;
};
type SendDocumentOptions = {
    /** Caption for the document (converted/escaped like sendMessageSmart). */
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
};
/**
 * A document to upload: either a URL / existing `file_id` string (sent via
 * JSON) or raw bytes uploaded as multipart form data.
 */
type TelegramDocumentInput = string | {
    filename: string;
    content: string | Uint8Array;
    contentType?: string;
};
/**
 * Media to upload for `sendPhoto` / `sendVideo` / `sendAudio` / `sendVoice`.
 * Same two shapes as {@link TelegramDocumentInput}: a URL / existing
 * `file_id` string (JSON call) or raw bytes (multipart upload). Reading a
 * local path is deliberately NOT the client's job — the client speaks HTTP
 * only; `dispatchTelegramReply` (reply.js) is the one place that touches the
 * filesystem.
 */
type TelegramMediaInput = TelegramDocumentInput;
/** The four inline-media verbs this client covers. */
type TelegramMediaKind = "photo" | "video" | "audio" | "voice";
/**
 * Options shared by the inline-media send verbs. A field that means nothing
 * for a kind is simply not sent (e.g. `performer` only applies to audio).
 */
type SendMediaOptions = {
    /** Caption (converted/escaped to MarkdownV2 like sendDocument). */
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    disableNotification?: boolean;
    /** Duration in seconds (video / audio / voice). */
    duration?: number;
    /** Video pixel dimensions. */
    width?: number;
    height?: number;
    /** Audio metadata. */
    performer?: string;
    title?: string;
};
/**
 * Telegram chat actions (`sendChatAction`). `typing` is the one a chat
 * bridge refreshes during a long turn — Telegram clears the status after
 * about five seconds.
 */
type TelegramChatAction = "typing" | "upload_photo" | "record_video" | "upload_video" | "record_voice" | "upload_voice" | "upload_document" | "choose_sticker" | "find_location" | "record_video_note" | "upload_video_note";
type SendChatActionOptions = {
    messageThreadId?: number;
};
/** Bot API `File` object as returned by `getFile`. */
type TelegramFile = {
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    /** Relative path under `<apiBaseUrl>/file/bot<token>/`; valid ~1 hour. */
    file_path?: string;
};
/** The service behind the `TelegramClient` Context.Tag. */
type TelegramClientService = {
    /**
     * Raw Bot API call: POST `<apiBaseUrl>/bot<token>/<method>` with a JSON
     * body, returning the `result` field. Retries 429s honoring
     * `parameters.retry_after`. Fails with a SmithersError (code
     * `TELEGRAM_API_ERROR`) that never contains the bot token.
     */
    call: (method: string, params?: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>;
    /**
     * High-level send: chunks at 4096 chars on paragraph/sentence boundaries,
     * converts markdown → MarkdownV2, falls back to plain text on a 400
     * "can't parse entities", and shows a typing indicator first.
     */
    sendMessageSmart: (chatId: number | string, text: string, options?: SendMessageSmartOptions) => Effect.Effect<SendMessageSmartResult, SmithersError>;
    /** Edit a sent message in place, with the same MarkdownV2 → plain fallback. */
    editMessageSmart: (chatId: number | string, messageId: number, text: string, options?: Pick<SendMessageSmartOptions, "parseMode" | "inlineKeyboard">) => Effect.Effect<unknown, SmithersError>;
    /** Send a document (URL/file_id via JSON, raw content via multipart). */
    sendDocument: (chatId: number | string, document: TelegramDocumentInput, options?: SendDocumentOptions) => Effect.Effect<unknown, SmithersError>;
    /**
     * Standalone chat action. Separate from the one `sendMessageSmart` fires
     * internally so a long agent turn can REFRESH the indicator (Telegram
     * expires it after ~5s) instead of showing it once and losing it.
     */
    sendChatAction: (chatId: number | string, action?: TelegramChatAction, options?: SendChatActionOptions) => Effect.Effect<unknown, SmithersError>;
    /** Send an inline photo (URL/file_id via JSON, raw bytes via multipart). */
    sendPhoto: (chatId: number | string, photo: TelegramMediaInput, options?: SendMediaOptions) => Effect.Effect<unknown, SmithersError>;
    /** Send an inline video. */
    sendVideo: (chatId: number | string, video: TelegramMediaInput, options?: SendMediaOptions) => Effect.Effect<unknown, SmithersError>;
    /** Send an audio track (rendered as a music player). */
    sendAudio: (chatId: number | string, audio: TelegramMediaInput, options?: SendMediaOptions) => Effect.Effect<unknown, SmithersError>;
    /** Send a voice note (OGG/Opus; rendered as a waveform bubble). */
    sendVoice: (chatId: number | string, voice: TelegramMediaInput, options?: SendMediaOptions) => Effect.Effect<unknown, SmithersError>;
    /** Resolve a `file_id` to a Bot API `File` (carrying `file_path`). */
    getFile: (fileId: string) => Effect.Effect<TelegramFile, SmithersError>;
    /**
     * Download inbound media bytes: `getFile` when handed a `file_id`, then GET
     * `<apiBaseUrl>/file/bot<token>/<file_path>`. Returns raw bytes — callers
     * must never put them in a durable row.
     */
    downloadFile: (file: string | TelegramFile) => Effect.Effect<Uint8Array, SmithersError>;
    /** Answer a callback query (inline-keyboard button press). */
    answerCallbackQuery: (callbackQueryId: string, options?: {
        text?: string;
        showAlert?: boolean;
    }) => Effect.Effect<unknown, SmithersError>;
    /**
     * Answer a Mini App inline query: post the `result` back to the chat on the
     * user's behalf and close the Mini App. `webAppQueryId` is the `query_id`
     * from a Mini App launched by an inline-keyboard `web_app` button. `result`
     * is a Bot API `InlineQueryResult`. Returns the `SentWebAppMessage`.
     */
    answerWebAppQuery: (webAppQueryId: string, result: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>;
};

export type { SendChatActionOptions, SendDocumentOptions, SendMediaOptions, SendMessageSmartOptions, SendMessageSmartResult, TelegramChatAction, TelegramClientConfig, TelegramClientService, TelegramDocumentInput, TelegramFile, TelegramInlineKeyboard, TelegramInlineKeyboardButton, TelegramMediaInput, TelegramMediaKind };
