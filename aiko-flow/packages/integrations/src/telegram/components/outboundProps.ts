import type React from "react";
import type { z } from "zod";
import type {
  SendMessageSmartOptions,
  TelegramChatAction,
  TelegramClientConfig,
  TelegramDocumentInput,
  TelegramInlineKeyboard,
  TelegramMediaInput,
} from "../TelegramClientTypes.ts";

/** Loose deps spec (mirrors Task's DepsSpec: dep key → zod output schema). */
export type TelegramDepsSpec = Record<string, z.ZodTypeAny>;

type ResolvedDeps = Record<string, unknown>;

/** Props shared by every outbound Telegram compute-Task component. */
export type TelegramOutboundBaseProps = {
  id: string;
  /** Explicit client config; falls back to configureTelegram()/env. */
  config?: Partial<TelegramClientConfig>;
  /**
   * Upstream outputs to consume. The component resolves them itself and
   * renders a compute Task gated on them via `dependsOn` (Task's own
   * deps+function-children path would evaluate at render time as a static
   * payload — see Task.js — so it is deliberately not used here).
   */
  deps?: TelegramDepsSpec;
  /** dep key → node id when they differ. */
  needs?: Record<string, string>;
  output?: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  /**
   * Attempt bound. Without it a failing outbound task retries FOREVER (the
   * engine's default for a bridge-managed compute), so a reply naming a file
   * that does not exist becomes an infinite backoff loop instead of a failed
   * turn. Bound it on anything whose input a model chose.
   */
  retries?: number;
  retryPolicy?: unknown;
  timeoutMs?: number;
  dependsOn?: string[];
  async?: boolean;
  skipIf?: boolean;
  label?: string;
  key?: string;
  smithersContext?: React.Context<unknown>;
};

export type SendMessageProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  /** Static message text (standard markdown). */
  text?: string;
  /**
   * Build the message from resolved deps: return the text, or an object of
   * `{ text, ...SendMessageSmartOptions }` overrides.
   */
  children?: (deps: ResolvedDeps) => string | ({ text: string } & SendMessageSmartOptions);
  parseMode?: SendMessageSmartOptions["parseMode"];
  replyToMessageId?: number;
  messageThreadId?: number;
  inlineKeyboard?: TelegramInlineKeyboard;
  /** Show the typing indicator before sending. @default true */
  typing?: boolean;
  disableNotification?: boolean;
};

export type EditMessageProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  messageId?: number;
  text?: string;
  children?: (
    deps: ResolvedDeps,
  ) => string | { text: string; messageId?: number; inlineKeyboard?: TelegramInlineKeyboard };
  parseMode?: SendMessageSmartOptions["parseMode"];
  inlineKeyboard?: TelegramInlineKeyboard;
};

export type SendDocumentProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  document?: TelegramDocumentInput;
  caption?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  children?: (deps: ResolvedDeps) => { document: TelegramDocumentInput; caption?: string };
};

/** Props for `<SendPhoto>` / `<SendVideo>` / `<SendAudio>` / `<SendVoice>`. */
export type SendMediaProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  /** URL / existing file_id / explicit upload object. */
  media?: TelegramMediaInput;
  /** Local file path — loaded by the reply router, the one fs toucher. */
  path?: string;
  caption?: string | null;
  replyToMessageId?: number;
  messageThreadId?: number;
  duration?: number;
  width?: number;
  height?: number;
  performer?: string;
  title?: string;
  children?: (deps: ResolvedDeps) => {
    media?: TelegramMediaInput;
    path?: string;
    caption?: string | null;
    replyToMessageId?: number;
    messageThreadId?: number;
    duration?: number;
    width?: number;
    height?: number;
    performer?: string;
    title?: string;
  };
};

/** Props for `<SendChatAction>` — one presence signal, once. */
export type SendChatActionProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  /** @default "typing" */
  action?: TelegramChatAction;
  messageThreadId?: number;
};

/** Props for `<TypingIndicator>` — a REFRESHING presence signal, bounded. */
export type TypingIndicatorProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  /** @default "typing" */
  action?: TelegramChatAction;
  /** Refresh cadence; Telegram expires a chat action after ~5s. @default 4000 */
  intervalMs?: number;
  /** Hard bound on the hold. @default 300000 */
  maxMs?: number;
  messageThreadId?: number;
};

/** Props for `<SendReply>` — the typed-reply router. */
export type SendReplyProps = TelegramOutboundBaseProps & {
  /** Destination, from the INBOUND event — never from the worker payload. */
  chatId: number | string;
  /** Worker output shaped like `telegramWorkerReplySchema`. */
  reply?: unknown;
  replyToMessageId?: number;
  messageThreadId?: number;
  children?: (deps: ResolvedDeps) => unknown;
};

export type AnswerCallbackQueryProps = TelegramOutboundBaseProps & {
  callbackQueryId?: string;
  text?: string;
  showAlert?: boolean;
  children?: (deps: ResolvedDeps) => { callbackQueryId: string; text?: string; showAlert?: boolean };
};
