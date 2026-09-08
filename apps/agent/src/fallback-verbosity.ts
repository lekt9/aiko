/** Verbose foreground fallbacks expose bounded receipts, never provider errors or browser payloads. */
export function parseFallbackVerbosity(enabled?: string, since?: string) {
  if (enabled !== undefined && !["true", "false"].includes(enabled))
    throw new Error("AIKO_VERBOSE_FALLBACKS must be true or false");
  const at = since === undefined ? 0 : Number(since);
  if (!Number.isSafeInteger(at) || at < 0)
    throw new Error("AIKO_VERBOSE_FALLBACKS_SINCE must be a non-negative epoch millisecond timestamp");
  return { verboseFallbacks: enabled === "true", verboseFallbacksSince: at };
}

const reasons: Record<string, string> = {
  browser_uncertain: "The browser action has an unconfirmed outcome. Check the destination before repeating any action.",
  missing_answer: "Tool work finished, but no usable final answer was produced.",
  no_result: "No usable answer or confirmed tool result was produced. The request is not confirmed complete.",
  turn_failed: "The request failed before it could finish. Any unconfirmed actions need checking before retrying.",
  cancelled: "The request was cancelled. Actions already started may still have taken effect.",
  receipt_summary: "Showing recorded tool results because no model answer was available.",
};

export function verboseFallbackText(
  decision: string,
  receipts: readonly { kind: string; text: string; operation?: unknown; action?: unknown; status?: unknown; reason?: unknown }[],
  redact: (text: string) => string,
  omitted = false,
) {
  const details = receipts.slice(-8).map(receipt => {
    // Browser text can include page content and private form values. Only emit host metadata.
    if (receipt.kind === "browser-receipt") {
      const label = (value: unknown) => typeof value === "string" && /^[a-z_-]{1,40}$/i.test(value) ? value : "unconfirmed";
      const explanation: Record<string, string> = {
        private_sign_in_pending: "Finish or cancel the active sign-in before browsing.",
        private_sign_in_cleanup_failed: "Expired sign-in cleanup failed; the browser remains locked.",
        sandbox_reconciliation_required: "Browser allocation needs operator reconciliation.",
        browser_unavailable: "The browser connection failed.",
        element_not_found: "The requested page element was not found.",
      };
      const reason = typeof receipt.reason === "string" && Object.hasOwn(explanation, receipt.reason) ? explanation[receipt.reason] : "";
      return `Browser ${label(receipt.operation ?? receipt.action)}: ${label(receipt.status)}.${reason ? " " + reason : ""}`;
    }
    return redact(receipt.text).slice(0, 500);
  });
  const body = [`Fallback: ${decision}`, reasons[decision] ?? "A fallback was needed to complete the reply."];
  if (details.length) body.push("Recorded tool results:\n" + details.join("\n\n"));
  else body.push("Recorded tool results: none.");
  const text = redact(body.join("\n\n"));
  const truncated = omitted || receipts.length > 8 || text.length > 3400;
  return text.slice(0, 3400) + (truncated ? "\n\nSome results are shortened or omitted." : "");
}
