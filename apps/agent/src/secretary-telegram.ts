import { boundedText, type HttpFetch } from "./security.ts";
import { telegramText } from "./telegram-format.ts";
import type {
  TelegramInbound,
  TelegramInboundPolicy,
} from "./telegram-normalize.ts";

export type SecretaryConnection = {
  id: string;
  owner: string;
  ownerChat: string;
  enabled: boolean;
  canReply: boolean;
  canRead: boolean;
};
export type SecretaryMessage = {
  connectionId: string;
  chat: string;
  chatType: string;
  name: string;
  messageId: number;
  sender: string;
  text: string;
  date: number;
  viaBot: boolean;
  unsupported: boolean;
};
export type SecretaryUpdate =
  | { kind: "connection"; connection: SecretaryConnection }
  | {
      kind: "message" | "edit";
      connection: SecretaryConnection;
      message: SecretaryMessage;
    }
  | {
      kind: "delete";
      connection: SecretaryConnection;
      chat: string;
      messageIds: number[];
    };
const positive = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0;
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(v);
export function businessConnection(raw: any): SecretaryConnection | undefined {
  if (
    !identifier(raw?.id) ||
    !positive(raw?.user?.id) ||
    !positive(raw?.user_chat_id) ||
    typeof raw.is_enabled !== "boolean"
  )
    return;
  return {
    id: raw.id,
    owner: String(raw.user.id),
    ownerChat: String(raw.user_chat_id),
    enabled: raw.is_enabled,
    canReply: raw.rights?.can_reply === true,
    canRead: raw.rights?.can_read_messages === true,
  };
}
export function connectionPayload(c: SecretaryConnection) {
  return {
    id: c.id,
    user: { id: Number(c.owner), is_bot: false },
    user_chat_id: Number(c.ownerChat),
    is_enabled: c.enabled,
    date: 0,
    rights: { can_reply: c.canReply, can_read_messages: c.canRead },
  };
}
export function secretaryPayload(u: SecretaryUpdate) {
  if (u.kind === "connection")
    return { business_connection: connectionPayload(u.connection) };
  if (u.kind === "delete")
    return {
      deleted_business_messages: {
        business_connection_id: u.connection.id,
        chat: { id: Number(u.chat), type: "private" },
        message_ids: u.messageIds,
      },
    };
  const m = u.message;
  return {
    [u.kind === "edit" ? "edited_business_message" : "business_message"]: {
      business_connection_id: m.connectionId,
      message_id: m.messageId,
      date: m.date,
      chat: { id: Number(m.chat), type: m.chatType, first_name: m.name },
      from: { id: Number(m.sender) },
      text: m.text,
      ...(m.viaBot ? { sender_business_bot: { id: 1 } } : {}),
      ...(m.unsupported ? { document: { file_id: "unprocessed" } } : {}),
    },
  };
}
export function secretaryTelegram(token: string, transport: HttpFetch = fetch) {
  async function call(method: string, body: object, signal: AbortSignal) {
    const response = await transport(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    const data = JSON.parse(await boundedText(response));
    if (!response.ok || data.ok !== true)
      throw new Error("Telegram secretary request failed");
    return data.result;
  }
  async function resolve(id: string, signal = AbortSignal.timeout(10_000)) {
    if (!identifier(id)) throw new Error("Invalid business connection");
    const c = businessConnection(
      await call(
        "getBusinessConnection",
        { business_connection_id: id },
        signal,
      ),
    );
    if (!c || c.id !== id) throw new Error("Invalid business connection");
    return c;
  }
  return {
    resolve,
    async receive(
      raw: any,
      policy: TelegramInboundPolicy,
    ): Promise<TelegramInbound | undefined> {
      if (!Number.isSafeInteger(raw?.update_id) || raw.update_id < 0) return;
      const data =
        raw.business_connection ??
        raw.business_message ??
        raw.edited_business_message ??
        raw.deleted_business_messages;
      if (!data) return;
      const c = raw.business_connection
        ? businessConnection(data)
        : identifier(data.business_connection_id)
          ? await resolve(data.business_connection_id)
          : undefined;
      if (!c || (!policy.public && !policy.allowedUsers.has(c.owner))) return;
      let secretary: SecretaryUpdate;
      if (raw.business_connection)
        secretary = { kind: "connection", connection: c };
      else if (raw.deleted_business_messages) {
        if (
          !Number.isSafeInteger(data.chat?.id) ||
          !Array.isArray(data.message_ids) ||
          data.message_ids.length > 1000 ||
          !data.message_ids.every(positive)
        )
          return;
        secretary = {
          kind: "delete",
          connection: c,
          chat: String(data.chat.id),
          messageIds: data.message_ids,
        };
      } else {
        if (
          !Number.isSafeInteger(data.chat?.id) ||
          !positive(data.message_id) ||
          !positive(data.from?.id) ||
          !positive(data.date)
        )
          return;
        const text = data.text ?? data.caption ?? "";
        if (typeof text !== "string" || text.length > 4096) return;
        secretary = {
          kind: raw.edited_business_message ? "edit" : "message",
          connection: c,
          message: {
            connectionId: c.id,
            chat: String(data.chat.id),
            chatType: String(data.chat.type),
            name: String(
              data.chat.title ??
                [data.chat.first_name, data.chat.last_name]
                  .filter(Boolean)
                  .join(" ") ??
                data.chat.id,
            ).slice(0, 200),
            messageId: data.message_id,
            sender: String(data.from.id),
            text,
            date: data.date,
            viaBot: !!(
              data.sender_business_bot ||
              data.via_bot ||
              data.from.is_bot
            ),
            unsupported:
              !!(
                data.forward_origin ||
                data.forward_from ||
                data.forward_date
              ) ||
              [
                "photo",
                "voice",
                "audio",
                "video",
                "document",
                "sticker",
                "animation",
                "video_note",
              ].some((k) => !!data[k]),
          },
        };
      }
      return {
        update: raw.update_id,
        user: c.owner,
        text: "[Secretary update]",
        at: Date.now(),
        secretary,
      };
    },
    async send(
      c: SecretaryConnection,
      m: SecretaryMessage,
      text: string,
      signal: AbortSignal,
    ) {
      try {
        const result = await call(
          "sendMessage",
          {
            business_connection_id: c.id,
            chat_id: m.chat,
            ...telegramText(text),
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        return positive(result?.message_id)
          ? {
              status: "delivered" as const,
              providerId: String(result.message_id),
            }
          : { status: "unknown" as const };
      } catch {
        return { status: "unknown" as const };
      }
    },
    async markRead(
      c: SecretaryConnection,
      m: SecretaryMessage,
      signal: AbortSignal,
    ) {
      if (c.canRead)
        await call(
          "readBusinessMessage",
          {
            business_connection_id: c.id,
            chat_id: m.chat,
            message_id: m.messageId,
          },
          signal,
        );
    },
  };
}
