// Shared body for the Telegram listener components. Pattern copied from
// packages/components/src/components/Signal.js: render a WaitForEvent on the
// integration signal name, and when the delivered row is readable via
// ctx.outputMaybe, parse it with the zod schema and invoke the render prop.

import React from "react";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { stripAutoColumns } from "@smthrs/db/react-output";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { WaitForEvent } from "@smthrs/components";
import { telegramChatCorrelationId, telegramThreadCorrelationId } from "../TelegramSource.js";

/**
 * Derive the correlationId for a listener's chat/thread props.
 * @param {{ chatId?: number | string; threadId?: number | string }} props
 * @returns {string | undefined}
 */
export function listenerCorrelationId(props) {
  if (props.threadId != null) {
    if (props.chatId == null) {
      throw new SmithersError("INVALID_INPUT", "Telegram listener threadId requires chatId.");
    }
    return telegramThreadCorrelationId(props.chatId, props.threadId);
  }
  return props.chatId != null ? telegramChatCorrelationId(props.chatId) : undefined;
}

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
export function stripNullFields(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripNullFields(entry));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) {
        continue;
      }
      out[key] = stripNullFields(entry);
    }
    return out;
  }
  return value;
}

/**
 * @param {string} eventName integration signal name to wait for
 * @param {import("./OnMessageProps.ts").TelegramListenerBaseProps<any>} props
 * @param {import("zod").ZodTypeAny} schema effective payload schema
 * @returns {React.ReactElement | null}
 */
export function renderTelegramListener(eventName, props, schema) {
  if (props.skipIf) {
    return null;
  }
  const smithersContext = /** @type {any} */ (props.smithersContext) ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const correlationId = listenerCorrelationId(props);
  const waitNode = React.createElement(WaitForEvent, {
    id: props.id,
    key: props.key,
    event: eventName,
    correlationId,
    output: /** @type {any} */ (schema),
    outputSchema: /** @type {any} */ (schema),
    timeoutMs: props.timeoutMs,
    onTimeout: props.onTimeout,
    async: props.async,
    dependsOn: props.dependsOn,
    label: props.label ?? `telegram:${eventName}`,
    meta: props.meta,
  });
  if (!props.children) {
    return waitNode;
  }
  if (!ctx) {
    throw new SmithersError(
      "CONTEXT_OUTSIDE_WORKFLOW",
      "Telegram listener children require a workflow context. Build the workflow with createSmithers().",
    );
  }
  const row = ctx.outputMaybe(schema, { nodeId: props.id });
  if (row === undefined) {
    return waitNode;
  }
  const data = schema.parse(stripNullFields(stripAutoColumns(row)));
  return React.createElement(React.Fragment, null, waitNode, props.children(data));
}
