import * as zod from 'zod';
import { TelegramListenerBaseProps } from './OnMessageProps.js';
import React__default from 'react';

/**
 * Derive the correlationId for a listener's chat/thread props.
 * @param {{ chatId?: number | string; threadId?: number | string }} props
 * @returns {string | undefined}
 */
declare function listenerCorrelationId(props: {
    chatId?: number | string;
    threadId?: number | string;
}): string | undefined;
/**
 * Drop null-valued keys from a delivered row before the schema sees it.
 *
 * A durable output row is columnar: every optional field the Bot API omitted
 * comes back as SQL NULL, and `z.string().optional()` refuses null. Without
 * this, a render-prop listener parses fine in memory and throws the moment
 * the same payload has round-tripped through the store — which is every
 * resume. Absent is absent; Telegram never means "null" by a missing field.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
declare function stripNullFields(value: unknown): unknown;
/**
 * @param {string} eventName integration signal name to wait for
 * @param {import("./OnMessageProps.ts").TelegramListenerBaseProps<any>} props
 * @param {import("zod").ZodTypeAny} schema effective payload schema
 * @returns {React.ReactElement | null}
 */
declare function renderTelegramListener(eventName: string, props: TelegramListenerBaseProps<any>, schema: zod.ZodTypeAny): React__default.ReactElement | null;

export { listenerCorrelationId, renderTelegramListener, stripNullFields };
