import { secretaryPayload, type SecretaryUpdate } from "./secretary-telegram.ts";
import {
  telegramMessageMedia,
  type TelegramMediaDescriptor,
} from "./telegram-media.ts";

export type TelegramInbound = {
  secretary?: SecretaryUpdate;
  update: number;
  user: string;
  text: string;
  at: number;
  messageId?: number;
  messageThreadId?: number;
  stoppedDraftId?: number;
  sentAt?: number;
  kind?: "message" | "callback" | "reaction" | "generation_stopped";
  media?: TelegramMediaDescriptor[];
  caption?: string;
  /** Provider locale is a routing hint, never model installation authority. */
  language?: string;
  mediaGroupId?: string;
  replyTo?: {
    messageId: number;
    text?: string;
    sender?: string;
    media?: TelegramMediaDescriptor[];
  };
  callback?: { id: string; data: string; messageId: number };
  reaction?: { messageId: number; emoji: string[] };
};
export type TelegramInboundPolicy = {
  allowedUsers: ReadonlySet<string>;
  public?: boolean;
  receivedAt?: number;
};
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "stopped_message_generation",
  "message_reaction",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
] as const;
const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const shortText = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const emojiOf = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => object(item))
        .filter(
          (item) => item?.type === "emoji" && typeof item.emoji === "string",
        )
        .map((item) => item!.emoji.slice(0, 64))
        .slice(0, 20)
    : [];
function privateUser(chat: any, sender: any, policy: TelegramInboundPolicy) {
  if (
    chat?.type !== "private" ||
    !positive(sender?.id) ||
    sender?.is_bot === true ||
    chat.id !== sender.id
  )
    return undefined;
  const user = String(sender.id);
  return policy.public || policy.allowedUsers.has(user) ? user : undefined;
}

/** User-shared native cards become bounded text; never persist arbitrary provider fields or contact vCards. */
function nativeCardText(message: Record<string, any>): string | undefined {
  const location = object(message.venue?.location ?? message.location);
  if (location && typeof location.latitude === "number" && typeof location.longitude === "number" &&
    Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180) {
    const venue = object(message.venue), title = shortText(venue?.title, 256), address = shortText(venue?.address, 1024);
    return `[Shared ${venue ? "venue" : "location"}: ${location.latitude}, ${location.longitude}${title ? `; ${title}` : ""}${address ? `; ${address}` : ""}]`;
  }
  const contact = object(message.contact);
  if (contact) {
    const phone = shortText(contact.phone_number, 64), first = shortText(contact.first_name, 256), last = shortText(contact.last_name, 256);
    if (phone && /^[+\d ()-]{1,64}$/.test(phone) && first) return `[Shared contact: ${first}${last ? ` ${last}` : ""}; ${phone}]`;
  }
  const poll = object(message.poll);
  if (poll && shortText(poll.question, 300) && Array.isArray(poll.options) && poll.options.length >= 1 && poll.options.length <= 12 &&
    poll.options.every((option: unknown) => typeof object(option)?.text === "string" && object(option)!.text.length <= 100)) {
    return `[Shared poll: ${poll.question}${poll.is_closed === true ? " (closed)" : ""}]\n${poll.options.map((option: {text:string}, index: number) => `${index + 1}. ${option.text}`).join("\n")}`;
  }
}

/** Call only after webhook-secret verification, or for authenticated getUpdates results. */
export function normalizeTelegramUpdate(
  input: unknown,
  policy: TelegramInboundPolicy,
): { status: number; inbound?: TelegramInbound } {
  const update = object(input);
  if (
    !update ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0
  )
    return { status: 400 };
  const at = policy.receivedAt ?? Date.now();
  const stopped = object(update.stopped_message_generation);
  if (stopped) {
    const user = privateUser(stopped.chat, { id: stopped.chat?.id, is_bot: false }, policy);
    if (!user || !Number.isSafeInteger(stopped.draft_id) || stopped.draft_id === 0 ||
      (stopped.message_thread_id !== undefined && !positive(stopped.message_thread_id))) return { status: 200 };
    return { status: 200, inbound: { update: update.update_id, user, text: "/cancel", at,
      kind: "generation_stopped", stoppedDraftId: stopped.draft_id,
      ...(stopped.message_thread_id ? { messageThreadId: stopped.message_thread_id } : {}) } };
  }
  const callback = object(update.callback_query);
  if (callback) {
    const user = privateUser(callback.message?.chat, callback.from, policy),
      id = shortText(callback.id, 256),
      data = shortText(callback.data, 64);
    if (
      !user ||
      !id ||
      !data ||
      new TextEncoder().encode(data).length > 64 ||
      !positive(callback.message?.message_id)
    )
      return { status: 200 };
    const commands: Record<string, string> = {
      "aiko:status": "/status",
      "aiko:cancel": "/cancel",
      "aiko:help": "/help",
    };
    return {
      status: 200,
      inbound: {
        update: update.update_id,
        user,
        text: commands[data] ?? "[Telegram button selected]",
        at,
        kind: "callback",
        messageId: callback.message.message_id,
        ...(positive(callback.message.message_thread_id) ? { messageThreadId: callback.message.message_thread_id } : {}),
        callback: { id, data, messageId: callback.message.message_id },
      },
    };
  }
  const reaction = object(update.message_reaction);
  if (reaction) {
    const user = privateUser(reaction.chat, reaction.user, policy);
    if (!user || !positive(reaction.message_id)) return { status: 200 };
    const emoji = emojiOf(reaction.new_reaction);
    return {
      status: 200,
      inbound: {
        update: update.update_id,
        user,
        text: emoji.length
          ? "[Telegram reaction: " + emoji.join(" ") + "]"
          : "[Telegram reaction removed]",
        at,
        kind: "reaction",
        messageId: reaction.message_id,
        reaction: { messageId: reaction.message_id, emoji },
      },
    };
  }
  const message = object(update.message),
    user = privateUser(message?.chat, message?.from, policy);
  if (
    !message ||
    !user ||
    message.forward_origin ||
    message.forward_from ||
    message.forward_date ||
    message.via_bot ||
    !positive(message.message_id) ||
    !Number.isSafeInteger(message.date)
  )
    return { status: 200 };
  const media = telegramMessageMedia(user, message),
    caption = shortText(message.caption, 4096),
    originalText = shortText(message.text, 4096);
  if (
    (message.text !== undefined && originalText === undefined) ||
    (message.caption !== undefined && caption === undefined)
  )
    return { status: 200 };
  const text = originalText?.trim()
    ? originalText
    : caption?.trim()
      ? caption
      : nativeCardText(message) ?? media
          .map((item) => "[" + item.kind.replace("_", " ") + " attachment]")
          .join("\n");
  if (!text) return { status: 200 };
  const inbound: TelegramInbound = {
    update: update.update_id,
    user,
    text,
    at,
    kind: "message",
    ...(typeof message.from?.language_code==="string"&&/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(message.from.language_code)?{language:message.from.language_code.split("-")[0]}:{}),
    messageId: message.message_id,
    ...(positive(message.message_thread_id) ? { messageThreadId: message.message_thread_id } : {}),
    sentAt: message.date * 1000,
    ...(media.length ? { media } : {}),
  };
  if (caption !== undefined) inbound.caption = caption;
  if (
    typeof message.media_group_id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(message.media_group_id)
  )
    inbound.mediaGroupId = message.media_group_id;
  const reply = object(message.reply_to_message);
  if (
    reply &&
    positive(reply.message_id) &&
    (!reply.chat || reply.chat.id === Number(user))
  ) {
    const replyMedia = telegramMessageMedia(user, reply),
      replyText = shortText(reply.text ?? reply.caption, 4096);
    inbound.replyTo = {
      messageId: reply.message_id,
      ...(replyText ? { text: replyText } : {}),
      ...(positive(reply.from?.id) ? { sender: String(reply.from.id) } : {}),
      ...(replyMedia.length ? { media: replyMedia } : {}),
    };
  }
  return { status: 200, inbound };
}

/** Durable polling keeps only verified normalized fields, never the original provider body. */
export function serializeTelegramInbound(inbound: TelegramInbound): string {
  if (inbound.secretary) return JSON.stringify({ update_id: inbound.update, ...secretaryPayload(inbound.secretary) });
  const from = { id: Number(inbound.user), is_bot: false,...(inbound.language?{language_code:inbound.language}:{}) },
    chat = { id: Number(inbound.user), type: "private" };
  if (inbound.stoppedDraftId !== undefined) return JSON.stringify({ update_id: inbound.update,
    stopped_message_generation: { chat, draft_id: inbound.stoppedDraftId, message_thread_id: inbound.messageThreadId } });
  if (inbound.callback)
    return JSON.stringify({
      update_id: inbound.update,
      callback_query: {
        id: inbound.callback.id,
        data: inbound.callback.data,
        from,
        message: { message_id: inbound.callback.messageId, message_thread_id: inbound.messageThreadId, chat },
      },
    });
  if (inbound.reaction)
    return JSON.stringify({
      update_id: inbound.update,
      message_reaction: {
        chat,
        user: from,
        message_id: inbound.reaction.messageId,
        new_reaction: inbound.reaction.emoji.map((emoji) => ({
          type: "emoji",
          emoji,
        })),
      },
    });
  const files = (media: TelegramMediaDescriptor[] = []) => {
    const result: Record<string, unknown> = {};
    for (const item of media) {
      if (item.owner !== inbound.user)
        throw new Error("telegram_media_owner_mismatch");
      const value = {
        file_id: item.fileId,
        file_unique_id: item.uniqueId,
        mime_type: item.mimeType,
        file_name: item.fileName,
        file_size: item.size,
        width: item.width,
        height: item.height,
        duration: item.duration,
        emoji: item.emoji,
        is_animated: item.animated,
        is_video: item.video,
        ...(item.thumbnail
          ? {
              thumbnail: {
                file_id: item.thumbnail.fileId,
                file_unique_id: item.thumbnail.uniqueId,
                width: item.thumbnail.width,
                height: item.thumbnail.height,
                file_size: item.thumbnail.size,
              },
            }
          : {}),
      };
      result[item.kind] = item.kind === "photo" ? [value] : value;
    }
    return result;
  };
  return JSON.stringify({
    update_id: inbound.update,
    message: {
      message_id: inbound.messageId ?? inbound.update,
      message_thread_id: inbound.messageThreadId,
      date: Math.floor((inbound.sentAt ?? inbound.at) / 1000),
      from,
      chat,
      ...(inbound.media?.length
        ? { caption: inbound.caption, ...files(inbound.media) }
        : { text: inbound.text }),
      media_group_id: inbound.mediaGroupId,
      ...(inbound.replyTo
        ? {
            reply_to_message: {
              message_id: inbound.replyTo.messageId,
              chat,
              text: inbound.replyTo.text,
              ...(inbound.replyTo.sender
                ? { from: { id: Number(inbound.replyTo.sender) } }
                : {}),
              ...files(inbound.replyTo.media),
            },
          }
        : {}),
    },
  });
}
export const telegramAlbumKey = (inbound: TelegramInbound) =>
  inbound.mediaGroupId
    ? `telegram-album:${inbound.user}:${inbound.mediaGroupId}`
    : undefined;

/** Redact user-controlled prose before committing the transport inbox or native log. IDs remain opaque capabilities. */
export function redactTelegramInbound(
  inbound: TelegramInbound,
  redact: (text: string) => string,
): TelegramInbound {
  const media = (items: TelegramMediaDescriptor[] | undefined) =>
    items?.map((item) => ({
      ...item,
      ...(item.fileName ? { fileName: redact(item.fileName) } : {}),
      ...(item.thumbnail
        ? {
            thumbnail: {
              ...item.thumbnail,
              ...(item.thumbnail.fileName
                ? { fileName: redact(item.thumbnail.fileName) }
                : {}),
            },
          }
        : {}),
    }));
  return {
    ...inbound,
    text: redact(inbound.text),
    ...(inbound.secretary ? { secretary: "message" in inbound.secretary ? { ...inbound.secretary, message: { ...inbound.secretary.message, text: redact(inbound.secretary.message.text), name: redact(inbound.secretary.message.name) } } : inbound.secretary } : {}),
    ...(inbound.caption !== undefined
      ? { caption: redact(inbound.caption) }
      : {}),
    ...(inbound.media ? { media: media(inbound.media) } : {}),
    ...(inbound.replyTo
      ? {
          replyTo: {
            ...inbound.replyTo,
            ...(inbound.replyTo.text !== undefined
              ? { text: redact(inbound.replyTo.text) }
              : {}),
            ...(inbound.replyTo.media
              ? { media: media(inbound.replyTo.media) }
              : {}),
          },
        }
      : {}),
    ...(inbound.callback
      ? {
          callback: {
            ...inbound.callback,
            data: inbound.callback.data.startsWith("aiko:")
              ? inbound.callback.data
              : redact(inbound.callback.data),
          },
        }
      : {}),
  };
}
