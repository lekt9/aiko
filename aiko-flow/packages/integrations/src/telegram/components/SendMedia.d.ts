import { SendMediaProps as SendMediaProps$1, SendChatActionProps as SendChatActionProps$1, SendReplyProps as SendReplyProps$1, TypingIndicatorProps as TypingIndicatorProps$1 } from './outboundProps.js';
import * as React from 'react';
import 'zod';
import '../TelegramClientTypes.js';
import 'effect';
import '@smthrs/errors/SmithersError';

/**
 * Fire ONE chat action (default `typing`) as a durable compute Task. Placed
 * before a long turn it is the "I heard you" the user sees immediately;
 * Telegram clears it after ~5s, which is what `<TypingIndicator>` is for.
 * @param {SendChatActionProps} props
 */
declare function SendChatAction(props: SendChatActionProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Hold a REFRESHING typing indicator for a bounded window, as a durable
 * compute Task. Run it in `<Parallel>` with the long turn it decorates: a
 * compute task cannot observe another node's completion from inside its own
 * process, so the window is bounded by `maxMs` rather than by the turn —
 * deliberately, because an unbounded indicator is an orphan generator.
 * @param {TypingIndicatorProps} props
 */
declare function TypingIndicator(props: TypingIndicatorProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * THE ROUTER as a durable compute Task: take one worker output shaped like
 * `telegramWorkerReplySchema` and dispatch each reply through the single verb
 * its `kind` selects. `chatId` comes from this component's prop (the inbound
 * event), never from the worker payload.
 * @param {SendReplyProps} props
 */
declare function SendReply(props: SendReplyProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
declare function SendPhoto(props: SendMediaProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
declare function SendVideo(props: SendMediaProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
declare function SendAudio(props: SendMediaProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
declare function SendVoice(props: SendMediaProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
type SendMediaProps = SendMediaProps$1;
type SendChatActionProps = SendChatActionProps$1;
type TypingIndicatorProps = TypingIndicatorProps$1;
type SendReplyProps = SendReplyProps$1;

export { SendAudio, SendChatAction, type SendChatActionProps, type SendMediaProps, SendPhoto, SendReply, type SendReplyProps, SendVideo, SendVoice, TypingIndicator, type TypingIndicatorProps };
