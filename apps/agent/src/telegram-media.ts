/** Telegram file capabilities are account-bound; secret-bearing download URLs never leave this adapter. */
export type TelegramMediaKind =
  | "photo"
  | "video"
  | "voice"
  | "audio"
  | "video_note"
  | "document"
  | "sticker"
  | "animation";
export type TelegramMediaDescriptor = {
  owner: string;
  kind: TelegramMediaKind;
  fileId: string;
  uniqueId?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  emoji?: string;
  animated?: boolean;
  video?: boolean;
  thumbnail?: Omit<TelegramMediaDescriptor, "thumbnail">;
};
export type TelegramImageInput = {
  mimeType: string;
  data: Uint8Array;
  sourceFileId: string;
  atSeconds?: number;
};
export type TelegramProcessedMedia = {
  status: "processed" | "unsupported" | "failed";
  kind: TelegramMediaKind;
  fileId: string;
  text?: string;
  images?: TelegramImageInput[];
  reason?: string;
  truncated?: boolean;
};
export type TelegramMediaProcessor = (input: {
  owner: string;
  media: TelegramMediaDescriptor;
  bytes: Uint8Array;
  mimeType: string;
  signal: AbortSignal;
}) => Promise<Omit<TelegramProcessedMedia, "kind" | "fileId">>;
export type TelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Public hosted Bot API limits, verified against https://core.telegram.org/bots/api#getfile. */
export const TELEGRAM_MEDIA_LIMITS = Object.freeze({
  downloadBytes: 20 * 1024 * 1024,
  photoUploadBytes: 10 * 1024 * 1024,
  uploadBytes: 50 * 1024 * 1024,
  albumItems: 10,
  captionChars: 1024,
});
const record = (input: unknown): Record<string, unknown> | undefined =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
const bounded = (input: unknown, length: number) =>
  typeof input === "string" && input.length > 0 && input.length <= length
    ? input
    : undefined;
const integer = (input: unknown) =>
  Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : undefined;
export const telegramOwner = (input: unknown): input is string =>
  typeof input === "string" &&
  /^[1-9]\d{0,15}$/.test(input) &&
  Number.isSafeInteger(Number(input));

export function telegramMediaDescriptor(
  owner: string,
  kind: TelegramMediaKind,
  input: unknown,
  thumbnail = true,
): TelegramMediaDescriptor | undefined {
  const value = record(input),
    fileId = bounded(value?.file_id, 512);
  if (
    !telegramOwner(owner) ||
    !value ||
    !fileId ||
    !/^[A-Za-z0-9_-]+$/.test(fileId)
  )
    return undefined;
  const result: TelegramMediaDescriptor = { owner, kind, fileId };
  const strings = {
    uniqueId: bounded(value.file_unique_id, 512),
    mimeType: bounded(value.mime_type, 128),
    fileName: bounded(value.file_name, 255),
    emoji: bounded(value.emoji, 64),
  };
  for (const [key, text] of Object.entries(strings))
    if (text !== undefined)
      (result as unknown as Record<string, unknown>)[key] = text;
  const numbers = {
    size: integer(value.file_size),
    width: integer(value.width ?? value.length),
    height: integer(value.height ?? value.length),
    duration: integer(value.duration),
  };
  for (const [key, number] of Object.entries(numbers))
    if (number !== undefined)
      (result as unknown as Record<string, unknown>)[key] = number;
  if (value.is_animated === true) result.animated = true;
  if (value.is_video === true) result.video = true;
  if (thumbnail && value.thumbnail)
    result.thumbnail = telegramMediaDescriptor(
      owner,
      "photo",
      value.thumbnail,
      false,
    );
  if (!result.mimeType)
    result.mimeType =
      kind === "photo"
        ? "image/jpeg"
        : kind === "voice"
          ? "audio/ogg"
          : kind === "video" || kind === "video_note"
            ? "video/mp4"
            : kind === "sticker"
              ? result.video
                ? "video/webm"
                : result.animated
                  ? "application/x-tgsticker"
                  : "image/webp"
              : "application/octet-stream";
  return result;
}

/** Telegram's photo array contains resolutions of one photo, not separate attachments. */
export function telegramMessageMedia(
  owner: string,
  input: unknown,
): TelegramMediaDescriptor[] {
  const message = record(input);
  if (!message) return [];
  const result: TelegramMediaDescriptor[] = [];
  if (Array.isArray(message.photo)) {
    const photos = message.photo
      .map((value) => telegramMediaDescriptor(owner, "photo", value))
      .filter((value): value is TelegramMediaDescriptor => !!value);
    photos.sort(
      (a, b) =>
        (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) ||
        (b.size ?? 0) - (a.size ?? 0),
    );
    if (photos[0]) result.push(photos[0]);
  }
  // Telegram includes document alongside animation for backwards compatibility: do not duplicate it.
  for (const kind of [
    "animation",
    "video",
    "voice",
    "audio",
    "video_note",
    "sticker",
    "document",
  ] as const) {
    if (kind === "document" && message.animation) continue;
    if (message[kind]) {
      const media = telegramMediaDescriptor(owner, kind, message[kind]);
      if (media) result.push(media);
    }
  }
  return result;
}

async function bytesOf(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error("telegram_media_unavailable");
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > maxBytes) {
    await response.body.cancel();
    throw new Error("telegram_media_too_large");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error("telegram_media_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  )
    return "image/png";
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a"))
    return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8) === "WEBP")
    return "image/webp";
  return undefined;
}

export function createTelegramMedia(options: {
  token: string;
  fetch?: TelegramFetch;
  maxBytes?: number;
  processor?: TelegramMediaProcessor;
  redact?: (text: string) => string;
}) {
  const transport = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? TELEGRAM_MEDIA_LIMITS.downloadBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > TELEGRAM_MEDIA_LIMITS.downloadBytes
  )
    throw new Error("invalid_telegram_media_limit");
  const safeText = (text: string) =>
    (options.redact ? options.redact(text) : text)
      .split(options.token)
      .join("[redacted]");
  const download = async (
    owner: string,
    media: TelegramMediaDescriptor,
    signal: AbortSignal,
  ) => {
    if (
      !telegramOwner(owner) ||
      media.owner !== owner ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(media.fileId)
    )
      throw new Error("telegram_media_owner_mismatch");
    if (
      media.size !== undefined &&
      (!Number.isSafeInteger(media.size) ||
        media.size < 0 ||
        media.size > maxBytes)
    )
      throw new Error("telegram_media_too_large");
    signal.throwIfAborted();
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      const metadata = await transport(
        "https://api.telegram.org/bot" + options.token + "/getFile",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: media.fileId }),
          signal: deadline,
          redirect: "manual",
        },
      );
      const body = JSON.parse(
        new TextDecoder().decode(await bytesOf(metadata, 32_768)),
      );
      const file = record(body?.result),
        path = bounded(file?.file_path, 1024);
      if (
        body?.ok !== true ||
        !path ||
        path.startsWith("/") ||
        path
          .split("/")
          .some(
            (part) =>
              !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
          )
      )
        throw new Error("telegram_media_unavailable");
      if (
        typeof file?.file_id !== "string" ||
        (media.uniqueId &&
          file.file_unique_id &&
          media.uniqueId !== file.file_unique_id) ||
        (file?.file_size !== undefined &&
          (integer(file.file_size) === undefined ||
            Number(file.file_size) > maxBytes))
      )
        throw new Error("telegram_media_unavailable");
      const response = await transport(
        "https://api.telegram.org/file/bot" + options.token + "/" + path,
        { signal: deadline, redirect: "manual" },
      );
      const bytes = await bytesOf(response, maxBytes);
      signal.throwIfAborted();
      return {
        bytes,
        mimeType:
          imageType(bytes) ?? media.mimeType ?? "application/octet-stream",
        fileName: media.fileName,
      };
    } catch (error) {
      if (signal.aborted) throw new Error("telegram_media_cancelled");
      if (
        error instanceof Error &&
        error.message === "telegram_media_too_large"
      )
        throw error;
      // Fetch/parser errors may contain the bot-token URL: never return their original messages.
      throw new Error("telegram_media_unavailable");
    }
  };
  const process = async (
    owner: string,
    media: TelegramMediaDescriptor,
    signal: AbortSignal,
  ): Promise<TelegramProcessedMedia> => {
    const base = { kind: media.kind, fileId: media.fileId };
    if (media.owner !== owner)
      return {
        ...base,
        status: "failed",
        reason: "telegram_media_owner_mismatch",
      };
    try {
      const downloaded = await download(owner, media, signal);
      if (options.processor) {
        const result = await options.processor({
          owner,
          media,
          ...downloaded,
          signal,
        });
        signal.throwIfAborted();
        return {
          ...result,
          ...base,
          ...(result.text ? { text: safeText(result.text) } : {}),
        };
      }
      const image = imageType(downloaded.bytes);
      if (
        image &&
        (media.kind === "photo" ||
          media.kind === "sticker" ||
          media.kind === "document")
      )
        return {
          ...base,
          status: "processed",
          images: [
            {
              mimeType: image,
              data: downloaded.bytes,
              sourceFileId: media.fileId,
            },
          ],
        };
      if (
        media.kind === "document" &&
        /^(?:text\/(?:plain|markdown|csv)|application\/json)(?:;|$)/i.test(
          downloaded.mimeType,
        )
      ) {
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(downloaded.bytes);
        if (text.includes("\u0000"))
          return {
            ...base,
            status: "unsupported",
            reason: "document_decoder_required",
          };
        return {
          ...base,
          status: "processed",
          text: safeText(text.slice(0, 64_000)),
          truncated: text.length > 64_000,
        };
      }
      return {
        ...base,
        status: "unsupported",
        reason:
          media.kind === "audio" || media.kind === "voice"
            ? "transcription_not_configured"
            : media.kind === "video" ||
                media.kind === "video_note" ||
                media.kind === "animation"
              ? "video_processor_not_configured"
              : "document_decoder_required",
      };
    } catch (error) {
      const reason =
        error instanceof Error && /^telegram_media_[a-z_]+$/.test(error.message)
          ? error.message
          : "media_processor_failed";
      return { ...base, status: "failed", reason };
    }
  };
  return {
    download,
    process,
    capabilities: {
      images: true,
      textDocuments: true,
      customProcessor: !!options.processor,
      maxDownloadBytes: maxBytes,
    },
  };
}
