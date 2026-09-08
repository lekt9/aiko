import { trustedMiniAppUrl } from "./telegram-mini-app.ts";
import { telegramHtml, telegramText } from "./telegram-format.ts";
import {
  telegramOwner,
  TELEGRAM_MEDIA_LIMITS,
  type TelegramFetch,
  type TelegramMediaKind,
} from "./telegram-media.ts";

export type TelegramDelivery = {
  status: "delivered" | "unknown" | "rejected";
  providerId?: string;
  providerIds?: string[];
  reason?: "rate_limited" | "forbidden" | "invalid_request" | "provider_failure" | "invalid_response" | "transport";
  retryAfter?: number;
};
export type TelegramButton = {
  text: string;
  callbackData?: string;
  url?: string;
  /** Host-approved Mini App; never a caller-selected credential collection origin. */
  webAppUrl?: string;
};
export type TelegramFile =
  | { owner: string; fileId: string }
  | { owner: string; bytes: Uint8Array; mimeType: string; fileName: string };
type ReplyOptions = {
  replyTo?: number;
  messageThreadId?: number;
  silent?: boolean;
  buttons?: TelegramButton[][];
};
export type TelegramRichResponse = ReplyOptions &
  (
    | { kind: "text"; text: string }
    | { kind: "location"; latitude: number; longitude: number }
    | { kind: "venue"; latitude: number; longitude: number; title: string; address: string }
    | { kind: "contact"; phoneNumber: string; firstName: string; lastName?: string }
    | { kind: "poll"; question: string; choices: string[] }
    | {
        kind: TelegramMediaKind;
        file: TelegramFile;
        caption?: string;
        duration?: number;
        title?: string;
        performer?: string;
      }
    | {
        kind: "album";
        items: {
          kind: "photo" | "video" | "audio" | "document";
          file: TelegramFile;
          caption?: string;
        }[];
      }
  );
export const TELEGRAM_CONTROL_BUTTONS: TelegramButton[][] = [
  [
    { text: "Status", callbackData: "aiko:status" },
    { text: "Stop", callbackData: "aiko:cancel" },
  ],
];
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
/** Publish a Telegram generation draft on paragraph/chunk boundaries, never one letter at a time. */
export const TELEGRAM_DRAFT_CHUNK_CHARS = 96;
export function telegramDraftReady(previous: string | undefined, next: string, minChars = TELEGRAM_DRAFT_CHUNK_CHARS) {
  if (next === previous) return false;
  if (previous === undefined) return true;
  if (!next.startsWith(previous)) return true;
  const added = next.slice(previous.length);
  if (previous === "") return added.includes("\n") || added.length >= 8;
  return added.includes("\n") || added.length >= minChars;
}
async function responseBody(response: Response) {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64_000) throw new Error("large_response");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** One attempt per invocation. The native caller owns durable intent/settlement; unknown sends are never retried here. */
export function createTelegramOutbound(options: {
  token: string;
  allowedUsers: ReadonlySet<string>;
  public?: boolean;
  fetch?: TelegramFetch;
  redact?: (text: string) => string;
  miniAppUrl?: string;
}) {
  const canSend = (chat: string) =>
    telegramOwner(chat) &&
    (options.public === true || options.allowedUsers.has(chat));
  const safe = (text: string) =>
    (options.redact ? options.redact(text) : text)
      .split(options.token)
      .join("[redacted]");
  const call = async (
    method: string,
    body: object | FormData,
    signal: AbortSignal,
    expected: "message" | "album" | "boolean" = "boolean",
    expectedCount?: number,
  ): Promise<TelegramDelivery> => {
    if (signal.aborted) return { status: "rejected" };
    try {
      const response = await (options.fetch ?? fetch)(
        `https://api.telegram.org/bot${options.token}/${method}`,
        {
          method: "POST",
          ...(body instanceof FormData
            ? {}
            : { headers: { "content-type": "application/json" } }),
          body: body instanceof FormData ? body : JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          redirect: "manual",
        },
      );
      const value = await responseBody(response);
      if (response.ok && value?.ok === true) {
        if (expected === "boolean" && value.result === true)
          return { status: "delivered" };
        const messages = expected === "album" ? value.result : [value.result];
        if (
          Array.isArray(messages) &&
          messages.length > 0 &&
          (expectedCount === undefined || messages.length === expectedCount) &&
          messages.every((item) => positive(item?.message_id))
        ) {
          const ids = messages.map((item) => String(item.message_id));
          return {
            status: "delivered",
            providerId: ids[0],
            ...(ids.length > 1 ? { providerIds: ids } : {}),
          };
        }
      }
      return {
        status:
          response.status >= 400 && response.status < 500 && value?.ok === false
            ? "rejected"
            : "unknown",
        reason: response.status === 429 ? "rate_limited" : response.status === 403 ? "forbidden" : response.status >= 400 && response.status < 500 ? "invalid_request" : response.status >= 500 ? "provider_failure" : "invalid_response",
        ...(positive(value?.parameters?.retry_after) ? { retryAfter: value.parameters.retry_after } : {}),
      };
    } catch {
      return { status: "unknown", reason: "transport" };
    }
  };
  function markup(buttons: TelegramButton[][] | undefined) {
    if (!buttons) return undefined;
    if (
      !Array.isArray(buttons) ||
      buttons.length > 10 ||
      buttons.some((row) => !Array.isArray(row) || row.length > 8)
    )
      throw new Error("invalid_buttons");
    return {
      inline_keyboard: buttons.map((row) =>
        row.map((button) => {
          if (
            !button || typeof button !== "object" || Array.isArray(button) ||
            typeof button.text !== "string" ||
            !button.text ||
            button.text.length > 64 ||
            [button.callbackData, button.url, button.webAppUrl].some(
              (value) => value !== undefined && (typeof value !== "string" || !value),
            ) ||
            [button.callbackData, button.url, button.webAppUrl].filter(
              (value) => value !== undefined,
            ).length !== 1
          )
            throw new Error("invalid_button");
          if (button.callbackData) {
            if (new TextEncoder().encode(button.callbackData).length > 64)
              throw new Error("invalid_callback");
            return {
              text: safe(button.text),
              callback_data: button.callbackData,
            };
          }
          const url = new URL(button.webAppUrl ?? button.url!);
          if (url.protocol !== "https:" || url.username || url.password)
            throw new Error("invalid_button_url");
          if (button.webAppUrl !== undefined) {
            if (!trustedMiniAppUrl(url.href, options.miniAppUrl))
              throw new Error("untrusted_mini_app");
            return { text: safe(button.text), web_app: { url: url.href } };
          }
          return { text: safe(button.text), url: url.href };
        }),
      ),
    };
  }
  const sendRich = async (
    chat: string,
    message: TelegramRichResponse,
    signal: AbortSignal,
  ): Promise<TelegramDelivery> => {
    if (!canSend(chat)) return { status: "rejected" };
    try {
      if (message.replyTo !== undefined && !positive(message.replyTo))
        return { status: "rejected" };
      if (message.messageThreadId !== undefined && !positive(message.messageThreadId)) return { status: "rejected", reason: "invalid_request" };
      const common: Record<string, unknown> = {
        chat_id: chat,
        ...(message.messageThreadId ? { message_thread_id: message.messageThreadId } : {}),
        ...(message.replyTo
          ? {
              reply_parameters: {
                message_id: message.replyTo,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(message.silent ? { disable_notification: true } : {}),
        ...(message.buttons ? { reply_markup: markup(message.buttons) } : {}),
      };
      if (message.kind === "text") {
        if (!message.text || message.text.length > 16000)
          return { status: "rejected", reason: "invalid_request" };
        const text = safe(message.text);
        // A rich message preserves a long reply as one atomic, durable delivery.
        if ([...text].length > 4096) return call("sendRichMessage", {
          ...common, rich_message: { html: telegramHtml(text) },
        }, signal, "message");
        return call(
          "sendMessage",
          {
            ...common,
            ...telegramText(text),
            link_preview_options: { is_disabled: true },
          },
          signal,
          "message",
        );
      }
      if (message.kind === "location" || message.kind === "venue") {
        if (!Number.isFinite(message.latitude) || Math.abs(message.latitude) > 90 || !Number.isFinite(message.longitude) || Math.abs(message.longitude) > 180) return { status: "rejected", reason: "invalid_request" };
        if (message.kind === "venue" && (!message.title || message.title.length > 256 || !message.address || message.address.length > 1024)) return { status: "rejected", reason: "invalid_request" };
        return call(message.kind === "venue" ? "sendVenue" : "sendLocation", { ...common, latitude: message.latitude, longitude: message.longitude,
          ...(message.kind === "venue" ? { title: safe(message.title), address: safe(message.address) } : {}) }, signal, "message");
      }
      if (message.kind === "contact") {
        if (!/^\+?[0-9 ()-]{3,32}$/.test(message.phoneNumber) || !message.firstName || message.firstName.length > 128 || (message.lastName?.length ?? 0) > 128) return { status: "rejected", reason: "invalid_request" };
        return call("sendContact", { ...common, phone_number: safe(message.phoneNumber), first_name: safe(message.firstName), ...(message.lastName ? { last_name: safe(message.lastName) } : {}) }, signal, "message");
      }
      if (message.kind === "poll") {
        if (!message.question || [...message.question].length > 300 || !Array.isArray(message.choices) || message.choices.length < 1 || message.choices.length > 12 || message.choices.some(c => typeof c !== "string" || !c || [...c].length > 100)) return { status: "rejected", reason: "invalid_request" };
        return call("sendPoll", { ...common, question: safe(message.question), options: message.choices.map(text => ({ text: safe(text) })), is_anonymous: true, type: "regular" }, signal, "message");
      }
      const form = new FormData();
      let uploads = 0,
        uploadedBytes = 0;
      const file = (item: TelegramFile, kind: TelegramMediaKind): string => {
        if (item.owner !== chat) throw new Error("wrong_file_owner");
        if ("fileId" in item) {
          if (!/^[A-Za-z0-9_-]{1,512}$/.test(item.fileId))
            throw new Error("invalid_file_id");
          return item.fileId;
        }
        if (
          !(item.bytes instanceof Uint8Array) ||
          !item.bytes.byteLength ||
          item.bytes.byteLength >
            (kind === "photo"
              ? TELEGRAM_MEDIA_LIMITS.photoUploadBytes
              : TELEGRAM_MEDIA_LIMITS.uploadBytes)
        )
          throw new Error("invalid_upload_size");
        uploadedBytes += item.bytes.byteLength;
        if (uploadedBytes > TELEGRAM_MEDIA_LIMITS.uploadBytes)
          throw new Error("upload_request_too_large");
        const name = "file" + uploads++;
        form.set(
          name,
          new Blob([item.bytes.slice().buffer], { type: item.mimeType }),
          item.fileName.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 255) ||
            "attachment",
        );
        return "attach://" + name;
      };
      const caption = (value: string | undefined) => {
        if (value !== undefined && [...value].length > 1024)
          throw new Error("caption_too_long");
        return value === undefined ? undefined : telegramHtml(safe(value));
      };
      let method: string, body: Record<string, unknown>;
      if (message.kind === "album") {
        if (
          message.buttons ||
          message.items.length < 2 ||
          message.items.length > 10
        )
          return { status: "rejected" };
        const kinds = new Set(message.items.map((item) => item.kind));
        if ((kinds.has("audio") || kinds.has("document")) && kinds.size !== 1)
          return { status: "rejected" };
        method = "sendMediaGroup";
        body = {
          ...common,
          media: message.items.map((item) => ({
            type: item.kind,
            media: file(item.file, item.kind),
            caption: caption(item.caption),
            ...(item.caption !== undefined ? { parse_mode: "HTML" } : {}),
          })),
        };
      } else {
        const methods: Record<TelegramMediaKind, string> = {
          photo: "sendPhoto",
          video: "sendVideo",
          voice: "sendVoice",
          audio: "sendAudio",
          video_note: "sendVideoNote",
          document: "sendDocument",
          sticker: "sendSticker",
          animation: "sendAnimation",
        };
        method = methods[message.kind];
        if (!method) return { status: "rejected" };
        if (
          (message.kind === "video_note" || message.kind === "sticker") &&
          message.caption
        )
          return { status: "rejected" };
        if (
          message.duration !== undefined &&
          (!Number.isSafeInteger(message.duration) ||
            message.duration < 0 ||
            (message.kind === "video_note" && message.duration > 60))
        )
          return { status: "rejected" };
        body = {
          ...common,
          [message.kind]: file(message.file, message.kind),
          ...(message.caption !== undefined
            ? { caption: caption(message.caption), parse_mode: "HTML" }
            : {}),
          ...(message.duration !== undefined
            ? { duration: message.duration }
            : {}),
          ...(message.kind === "audio"
            ? { title: message.title, performer: message.performer }
            : {}),
          ...(message.kind === "video" ? { supports_streaming: true } : {}),
        };
      }
      if (uploads)
        for (const [key, value] of Object.entries(body))
          if (value !== undefined)
            form.set(
              key,
              typeof value === "object" ? JSON.stringify(value) : String(value),
            );
      return call(
        method,
        uploads ? form : body,
        signal,
        message.kind === "album" ? "album" : "message",
        message.kind === "album" ? message.items.length : undefined,
      );
    } catch {
      return { status: "rejected" };
    }
  };
  const activities = new Map<string, Map<symbol, string>>();
  const action = (chat: string, signal: AbortSignal, name = "typing") =>
    canSend(chat) &&
    [
      "typing",
      "upload_photo",
      "record_video",
      "upload_video",
      "record_voice",
      "upload_voice",
      "upload_document",
      "choose_sticker",
      "find_location",
      "record_video_note",
      "upload_video_note",
    ].includes(name)
      ? call(
          "sendChatAction",
          {
            chat_id: chat,
            action:
              name === "typing"
                ? ([...(activities.get(chat)?.values() ?? [])].at(-1) ?? name)
                : name,
          },
          signal,
        )
      : Promise.resolve<TelegramDelivery>({ status: "rejected" });
  /** Override the existing turn indicator while a media phase runs; this creates no renewal loop. */
  const activity = (
    chat: string,
    name: "record_voice" | "upload_voice" | "upload_photo" | "upload_video" | "upload_document" | "choose_sticker" | "upload_video_note",
    signal: AbortSignal,
  ) => {
    if (!canSend(chat) || signal.aborted) return async () => {};
    const id = Symbol(name),
      current = activities.get(chat) ?? new Map<symbol, string>(),
      controller = new AbortController();
    current.set(id, name);
    activities.set(chat, current);
    const work = action(
      chat,
      AbortSignal.any([signal, controller.signal]),
      name,
    );
    let stopped = false;
    const stop = async () => {
      if (stopped) return void (await work);
      stopped = true;
      controller.abort();
      signal.removeEventListener("abort", onAbort);
      current.delete(id);
      if (!current.size) activities.delete(chat);
      await work;
    };
    const onAbort = () => {
      void stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return stop;
  };
  const typing = (chat: string, signal: AbortSignal, name = "typing") => {
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined,
      work = Promise.resolve<TelegramDelivery>({ status: "rejected" });
    const tick = () => {
      if (combined.aborted || !canSend(chat)) return;
      work = action(chat, combined, name);
      void work.finally(() => {
        if (!combined.aborted) {
          timer = setTimeout(tick, 4000);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
        }
      });
    };
    const stop = async () => {
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await work;
    };
    const onAbort = () => {
      void stop();
    };
    if (!signal.aborted)
      signal.addEventListener("abort", onAbort, { once: true });
    tick();
    return stop;
  };
  const react = (
    chat: string,
    messageId: number,
    emoji: string | null,
    signal: AbortSignal,
  ) =>
    canSend(chat) &&
    positive(messageId) &&
    (emoji === null || (emoji.length > 0 && emoji.length <= 64))
      ? call(
          "setMessageReaction",
          {
            chat_id: chat,
            message_id: messageId,
            // Telegram matches bare emoji; variation selectors break the match.
            reaction:
              emoji === null
                ? []
                : [{ type: "emoji", emoji: emoji.replace(/\uFE0F/g, "") }],
          },
          signal,
        )
      : Promise.resolve<TelegramDelivery>({ status: "rejected" });
  const answerCallback = (
    chat: string,
    callbackId: string,
    signal: AbortSignal,
    text?: string,
  ) =>
    canSend(chat) &&
    callbackId.length > 0 &&
    callbackId.length <= 256 &&
    (text === undefined || text.length <= 200)
      ? call(
          "answerCallbackQuery",
          {
            callback_query_id: callbackId,
            ...(text ? { text: safe(text) } : {}),
          },
          signal,
        )
      : Promise.resolve<TelegramDelivery>({ status: "rejected" });
  const publishedDrafts = new Map<string, string>();
  const editProgress = (
    chat: string,
    messageId: number,
    text: string,
    signal: AbortSignal,
    buttons?: TelegramButton[][],
  ) => {
    if (
      !canSend(chat) ||
      !positive(messageId) ||
      !text ||
      [...text].length > 4096
    )
      return Promise.resolve<TelegramDelivery>({ status: "rejected" });
    try {
      return call(
        "editMessageText",
        {
          chat_id: chat,
          message_id: messageId,
          ...telegramText(safe(text)),
          link_preview_options: { is_disabled: true },
          ...(buttons ? { reply_markup: markup(buttons) } : {}),
        },
        signal,
        "message",
      );
    } catch {
      return Promise.resolve<TelegramDelivery>({ status: "rejected" });
    }
  };
  /** Ephemeral Bot API draft; successful submission is not a final-message delivery receipt. */
  const draft = (
    chat: string,
    draftId: number,
    text: string,
    signal: AbortSignal,
    context?: { messageThreadId?: number; canStop?: boolean },
  ) => {
    if (
      !canSend(chat) ||
      (context?.messageThreadId !== undefined && !positive(context.messageThreadId)) ||
      !Number.isSafeInteger(draftId) ||
      draftId === 0 ||
      [...text].length > 4096
    )
      return Promise.resolve<TelegramDelivery>({ status: "rejected" });
    const key = `${chat}:${draftId}`;
    const body = safe(text);
    if (!telegramDraftReady(publishedDrafts.get(key), body))
      return Promise.resolve<TelegramDelivery>({ status: "delivered" });
    publishedDrafts.set(key, body);
    return call(
      "sendMessageDraft",
      { chat_id: chat, draft_id: draftId, ...telegramText(body), ...(context?.messageThreadId ? { message_thread_id: context.messageThreadId } : {}), ...(context?.canStop ? { can_stop: true, keep_on_stop: false } : {}) },
      signal,
    );
  };
  return {
    sendRich,
    action,
    typing,
    activity,
    react,
    answerCallback,
    editProgress,
    draft,
  };
}
