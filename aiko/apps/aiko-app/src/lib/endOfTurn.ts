/**
 * Unified end-of-turn reason mapping for transcript chips.
 */

export type EndOfTurnReason =
  | "user_stop"
  | "agent_exit"
  | "stall"
  | "permission_denied"
  | "error"
  | "cancelled"
  | "unknown";

export interface EndOfTurnChipModel {
  reason: EndOfTurnReason;
  /** i18n message key under activity.* / endOfTurn.* */
  messageKey:
    | "activity.cancelledByUser"
    | "activity.cancelledAgentExit"
    | "activity.cancelled"
    | "endOfTurn.stall"
    | "endOfTurn.permissionDenied"
    | "endOfTurn.error"
    | "endOfTurn.unknown";
  tone: "neutral" | "warning" | "error";
}

/** Normalize host/UI reason strings into a chip model. */
export function mapEndOfTurnReason(
  raw: string | null | undefined,
): EndOfTurnChipModel {
  const r = (raw || "").toLowerCase().trim();
  if (
    r === "user_stop" ||
    r === "user" ||
    r === "stop" ||
    r === "cancelled_by_user" ||
    r === "user_cancel"
  ) {
    return {
      reason: "user_stop",
      messageKey: "activity.cancelledByUser",
      tone: "neutral",
    };
  }
  if (r === "agent_exit" || r === "agent" || r === "process_exit") {
    return {
      reason: "agent_exit",
      messageKey: "activity.cancelledAgentExit",
      tone: "warning",
    };
  }
  if (r === "stall" || r === "stream_stall" || r === "idle_timeout") {
    return {
      reason: "stall",
      messageKey: "endOfTurn.stall",
      tone: "warning",
    };
  }
  if (
    r === "permission_denied" ||
    r === "denied" ||
    r === "permission_deny" ||
    r === "reject"
  ) {
    return {
      reason: "permission_denied",
      messageKey: "endOfTurn.permissionDenied",
      tone: "error",
    };
  }
  if (r === "error" || r === "failed" || r === "turn_error") {
    return {
      reason: "error",
      messageKey: "endOfTurn.error",
      tone: "error",
    };
  }
  if (r === "cancelled" || r === "canceled" || r === "turn_cancelled") {
    return {
      reason: "cancelled",
      messageKey: "activity.cancelled",
      tone: "neutral",
    };
  }
  return {
    reason: "unknown",
    messageKey: "endOfTurn.unknown",
    tone: "neutral",
  };
}

/** Markers that should render as EndOfTurnChip family. */
export function isEndOfTurnMarker(marker: string | null | undefined): boolean {
  const m = (marker || "").toLowerCase();
  return (
    m === "turn_cancelled" ||
    m === "turn_end" ||
    m === "stream_stall" ||
    m === "end_of_turn"
  );
}

/**
 * Build content for applyTurnMarker so journal reload stays consistent.
 */
export function endOfTurnMarkerContent(reason: EndOfTurnReason): string {
  return `turn_end|${reason}`;
}

/**
 * First pipe segment after a known marker prefix.
 * Host journals `turn_cancelled|user_stop` and sometimes
 * `turn_cancelled|user_stop|partial:…` — only the reason token matters.
 */
function reasonTokenAfterPrefix(
  content: string,
  prefix: string,
): string | null {
  if (!content.startsWith(prefix)) return null;
  const rest = content.slice(prefix.length);
  if (!rest) return "";
  const token = rest.split("|")[0]?.trim() ?? "";
  return token;
}

export function parseEndOfTurnContent(
  content: string | null | undefined,
): EndOfTurnReason | null {
  if (!content) return null;
  // Live FE + journal: turn_end|<reason>
  const fromEnd = reasonTokenAfterPrefix(content, "turn_end|");
  if (fromEnd !== null) {
    return mapEndOfTurnReason(fromEnd || "unknown").reason;
  }
  // Host stop path: turn_cancelled|<reason>[|partial:…]
  // Must not collapse user_stop → generic "cancelled" (history vs live mismatch).
  const fromCancelled = reasonTokenAfterPrefix(content, "turn_cancelled|");
  if (fromCancelled !== null) {
    return mapEndOfTurnReason(fromCancelled || "cancelled").reason;
  }
  // Legacy bare marker with no reason payload.
  if (content === "turn_cancelled" || content.startsWith("turn_cancelled")) {
    return "cancelled";
  }
  return null;
}
