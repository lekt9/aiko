// The typed reply union and its router.
//
// ONE worker output selects exactly ONE send capability. The union is
// discriminated on `kind`, so the router is a total function over the arms
// and a kind outside the union is a SCHEMA failure at the Task boundary
// (retried by maxSchemaRetries) rather than a silent no-op — the failure mode
// a `switch` with a default branch quietly produces.
//
// Division of labour, and it is deliberate:
//   * the worker decides the CONTENT KIND and produces local files;
//   * the bridge owns the TRANSPORT — which verb, which multipart field, and
//     crucially WHICH CHAT. `dispatchTelegramReplies` takes the chat id from
//     its caller (the inbound event), never from the worker's output, so a
//     worker that invents a chat id cannot address a stranger.
//   * the client speaks HTTP only; this module is the one place that reads
//     the filesystem, so "where do the bytes come from" has a single answer.

import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { TELEGRAM_MEDIA_METHODS } from "./TelegramClient.js";

/** Every kind the union covers, in declaration order. */
export const TELEGRAM_REPLY_KINDS = /** @type {const} */ (["text", "photo", "video", "audio", "voice"]);

/**
 * kind → Bot API verb. This table IS the router: `dispatchTelegramReply`
 * reads it rather than re-deciding, so a witness can assert the mapping
 * directly and a wrong entry is a one-line, visible defect.
 * @type {Record<(typeof TELEGRAM_REPLY_KINDS)[number], string>}
 */
export const TELEGRAM_REPLY_VERBS = {
  text: "sendMessage",
  photo: TELEGRAM_MEDIA_METHODS.photo,
  video: TELEGRAM_MEDIA_METHODS.video,
  audio: TELEGRAM_MEDIA_METHODS.audio,
  voice: TELEGRAM_MEDIA_METHODS.voice,
};

/** Cap on a single uploaded reply (Bot API rejects >50MB uploads anyway). */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const mediaArm = (/** @type {string} */ kind) =>
  z.object({
    kind: z.literal(kind),
    /** Local file the worker already produced. The worker never uploads. */
    path: z.string().min(1),
    caption: z.string().nullable().default(null),
  });

/**
 * The reply union. One arm per send capability; adding a capability means
 * adding an arm AND a verb — a half-added kind cannot type-check.
 */
export const telegramReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1),
    parseMode: z.enum(["markdown", "MarkdownV2", "HTML", "none"]).default("markdown"),
  }),
  mediaArm("photo"),
  mediaArm("video"),
  mediaArm("audio"),
  mediaArm("voice"),
]);

/**
 * What one Aiko worker turn returns. `replies` is an array because one turn
 * legitimately answers with a caption plus a voice note. `chatId` is the
 * worker's own bookkeeping — the router IGNORES it (see the header).
 */
export const telegramWorkerReplySchema = z.object({
  chatId: z.string().min(1),
  replies: z.array(telegramReplySchema).min(1),
});

/** One dispatched reply, as it lands in a durable row: no bytes, no token. */
export const telegramDispatchedSchema = z.object({
  kind: z.enum(TELEGRAM_REPLY_KINDS),
  method: z.string(),
  messageId: z.number().nullable().default(null),
  bytes: z.number().nullable().default(null),
  filename: z.string().nullable().default(null),
});

/** Output of the router as a durable Task result. */
export const telegramDispatchResultSchema = z.object({
  chatId: z.string(),
  count: z.number(),
  kinds: z.array(z.string()),
  dispatched: z.array(telegramDispatchedSchema),
});

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
};

/**
 * Content type for a local media path (extension table, lowercase).
 * @param {string} path
 * @returns {string | undefined}
 */
export function telegramContentTypeForPath(path) {
  return /** @type {Record<string, string>} */ (CONTENT_TYPES)[extname(String(path)).toLowerCase()];
}

/**
 * Bot API verb for a reply kind. Throws on an unknown kind rather than
 * returning undefined — an unrouted reply must be loud.
 * @param {string} kind
 * @returns {string}
 */
export function telegramReplyVerb(kind) {
  const verb = /** @type {Record<string, string>} */ (TELEGRAM_REPLY_VERBS)[kind];
  if (!verb) {
    throw new SmithersError("INVALID_INPUT", `No Telegram verb is wired for reply kind "${String(kind)}".`, { kind });
  }
  return verb;
}

/**
 * Load a local media file into the client's upload shape.
 * @param {string} path
 * @returns {Promise<{ filename: string; content: Uint8Array; contentType?: string }>}
 */
async function loadMedia(path) {
  /** @type {import("node:fs").Stats} */
  let info;
  try {
    info = await stat(path);
  } catch (cause) {
    throw new SmithersError("INVALID_INPUT", `Telegram reply media file not found: ${path}`, { path }, { cause });
  }
  if (!info.isFile()) {
    throw new SmithersError("INVALID_INPUT", `Telegram reply media path is not a file: ${path}`, { path });
  }
  if (info.size > TELEGRAM_MAX_UPLOAD_BYTES) {
    throw new SmithersError("INVALID_INPUT", `Telegram reply media exceeds the upload cap: ${path}`, {
      path,
      size: info.size,
      cap: TELEGRAM_MAX_UPLOAD_BYTES,
    });
  }
  const content = new Uint8Array(await readFile(path));
  const contentType = telegramContentTypeForPath(path);
  return { filename: basename(path), content, ...(contentType ? { contentType } : {}) };
}

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
export async function dispatchTelegramReply(client, chatId, reply, options = {}) {
  const parsed = telegramReplySchema.parse(reply);
  const method = telegramReplyVerb(parsed.kind);
  const shared = {
    ...(options.replyToMessageId != null ? { replyToMessageId: options.replyToMessageId } : {}),
    ...(options.messageThreadId != null ? { messageThreadId: options.messageThreadId } : {}),
  };
  if (parsed.kind === "text") {
    // typing:false — the BRIDGE owns the indicator (see typing.js), so the
    // send must not fire a second, unsequenced chat action of its own.
    const result = await Effect.runPromise(
      client.sendMessageSmart(chatId, parsed.text, { parseMode: parsed.parseMode, typing: false, ...shared }),
    );
    return {
      kind: parsed.kind,
      method,
      messageId: result.messageIds[0] ?? null,
      bytes: null,
      filename: null,
    };
  }
  const media = await loadMedia(parsed.path);
  /** @type {Record<string, (chatId: number | string, media: any, options: any) => Effect.Effect<unknown, unknown>>} */
  const senders = {
    photo: client.sendPhoto,
    video: client.sendVideo,
    audio: client.sendAudio,
    voice: client.sendVoice,
  };
  const send = senders[parsed.kind];
  const result = /** @type {{ message_id?: number } | null} */ (
    await Effect.runPromise(
      /** @type {Effect.Effect<any, any>} */ (
        send(chatId, media, { ...(parsed.caption ? { caption: parsed.caption } : {}), ...shared })
      ),
    )
  );
  return {
    kind: parsed.kind,
    method,
    messageId: typeof result?.message_id === "number" ? result.message_id : null,
    bytes: media.content.byteLength,
    filename: media.filename,
  };
}

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
export async function dispatchTelegramReplies(client, chatId, replies, options = {}) {
  const list = Array.isArray(replies) ? replies : telegramWorkerReplySchema.parse(replies).replies;
  if (list.length === 0) {
    throw new SmithersError("INVALID_INPUT", "Telegram reply dispatch needs at least one reply.");
  }
  /** @type {z.infer<typeof telegramDispatchedSchema>[]} */
  const dispatched = [];
  for (const reply of list) {
    dispatched.push(await dispatchTelegramReply(client, chatId, reply, options));
  }
  return {
    chatId: String(chatId),
    count: dispatched.length,
    kinds: dispatched.map((entry) => entry.kind),
    dispatched,
  };
}
