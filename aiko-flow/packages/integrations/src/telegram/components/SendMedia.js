// @smithers-type-exports-begin
/** @typedef {import("./outboundProps.ts").SendMediaProps} SendMediaProps */
/** @typedef {import("./outboundProps.ts").SendChatActionProps} SendChatActionProps */
/** @typedef {import("./outboundProps.ts").TypingIndicatorProps} TypingIndicatorProps */
/** @typedef {import("./outboundProps.ts").SendReplyProps} SendReplyProps */
// @smithers-type-exports-end

import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { renderOutboundTask } from "./outboundInternals.js";
import { holdTypingIndicator } from "../typing.js";
import { dispatchTelegramReplies, telegramWorkerReplySchema } from "../reply.js";

/**
 * Resolve the media argument for one of the media components: a URL/file_id
 * string, an explicit upload object, or a local `path` the router loads.
 * @param {Record<string, any>} source
 * @param {string} componentName
 * @returns {{ media: any } | { path: string }}
 */
function resolveMediaArg(source, componentName) {
  if (source.media) {
    return { media: source.media };
  }
  if (typeof source.path === "string" && source.path.length > 0) {
    return { path: source.path };
  }
  throw new SmithersError(
    "INVALID_INPUT",
    `Telegram.${componentName} requires media (a URL/file_id string, an upload object, or a local path).`,
  );
}

/**
 * One factory for the four inline-media components. Each renders a durable
 * compute Task that calls exactly one verb — the component name, the client
 * method and the reply kind all come from the same `kind`, so no component
 * can quietly send through the wrong verb.
 * @param {import("../TelegramClientTypes.ts").TelegramMediaKind} kind
 * @param {string} componentName
 */
function makeMediaComponent(kind, componentName) {
  /**
   * @param {SendMediaProps} props
   */
  return function SendMediaComponent(props) {
    return renderOutboundTask(props, componentName, (client, deps) => {
      const built = props.children ? { ...props, ...props.children(deps) } : props;
      const arg = resolveMediaArg(built, componentName);
      const options = {
        ...(built.caption ? { caption: built.caption } : {}),
        ...(built.replyToMessageId != null ? { replyToMessageId: built.replyToMessageId } : {}),
        ...(built.messageThreadId != null ? { messageThreadId: built.messageThreadId } : {}),
        ...(built.duration != null ? { duration: built.duration } : {}),
        ...(built.width != null ? { width: built.width } : {}),
        ...(built.height != null ? { height: built.height } : {}),
        ...(built.performer ? { performer: built.performer } : {}),
        ...(built.title ? { title: built.title } : {}),
      };
      if ("path" in arg) {
        // Route a local path through the reply router so filesystem access
        // stays in exactly one module (reply.js), not in every component.
        return Effect.promise(() =>
          dispatchTelegramReplies(
            client,
            built.chatId,
            [{ kind, path: arg.path, caption: built.caption ?? null }],
            options,
          ),
        );
      }
      const senders = {
        photo: client.sendPhoto,
        video: client.sendVideo,
        audio: client.sendAudio,
        voice: client.sendVoice,
      };
      return senders[kind](built.chatId, arg.media, options);
    });
  };
}

/** Send an inline photo as a durable compute Task. */
export const SendPhoto = makeMediaComponent("photo", "SendPhoto");
/** Send an inline video as a durable compute Task. */
export const SendVideo = makeMediaComponent("video", "SendVideo");
/** Send an audio track as a durable compute Task. */
export const SendAudio = makeMediaComponent("audio", "SendAudio");
/** Send a voice note as a durable compute Task. */
export const SendVoice = makeMediaComponent("voice", "SendVoice");

/**
 * Fire ONE chat action (default `typing`) as a durable compute Task. Placed
 * before a long turn it is the "I heard you" the user sees immediately;
 * Telegram clears it after ~5s, which is what `<TypingIndicator>` is for.
 * @param {SendChatActionProps} props
 */
export function SendChatAction(props) {
  const { chatId, action, messageThreadId } = props;
  return renderOutboundTask(props, "SendChatAction", (client) =>
    client.sendChatAction(chatId, action ?? "typing", {
      ...(messageThreadId != null ? { messageThreadId } : {}),
    }),
  );
}

/**
 * Hold a REFRESHING typing indicator for a bounded window, as a durable
 * compute Task. Run it in `<Parallel>` with the long turn it decorates: a
 * compute task cannot observe another node's completion from inside its own
 * process, so the window is bounded by `maxMs` rather than by the turn —
 * deliberately, because an unbounded indicator is an orphan generator.
 * @param {TypingIndicatorProps} props
 */
export function TypingIndicator(props) {
  const { chatId, action, intervalMs, maxMs, messageThreadId } = props;
  return renderOutboundTask(props, "TypingIndicator", (client) =>
    Effect.promise(() =>
      holdTypingIndicator(client, chatId, {
        ...(action ? { action } : {}),
        ...(intervalMs != null ? { intervalMs } : {}),
        ...(maxMs != null ? { maxMs } : {}),
        ...(messageThreadId != null ? { messageThreadId } : {}),
      }),
    ),
  );
}

/**
 * THE ROUTER as a durable compute Task: take one worker output shaped like
 * `telegramWorkerReplySchema` and dispatch each reply through the single verb
 * its `kind` selects. `chatId` comes from this component's prop (the inbound
 * event), never from the worker payload.
 * @param {SendReplyProps} props
 */
export function SendReply(props) {
  const { chatId, reply, replyToMessageId, messageThreadId } = props;
  return renderOutboundTask(props, "SendReply", (client, deps) => {
    const payload = props.children ? props.children(deps) : (reply ?? deps.reply);
    if (!payload) {
      throw new SmithersError(
        "INVALID_INPUT",
        "Telegram.SendReply requires a typed reply (reply prop, deps.reply, or children returning one).",
      );
    }
    const parsed = telegramWorkerReplySchema.parse(payload);
    return Effect.promise(() =>
      dispatchTelegramReplies(client, chatId, parsed.replies, {
        ...(replyToMessageId != null ? { replyToMessageId } : {}),
        ...(messageThreadId != null ? { messageThreadId } : {}),
      }),
    );
  });
}
