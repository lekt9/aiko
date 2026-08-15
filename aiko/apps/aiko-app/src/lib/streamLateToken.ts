/**
 * Decide whether a stream text chunk may still be applied when the focused
 * Host session is no longer "live streaming" (ready/idle after early
 * prompt_complete).
 *
 * Returns true when the UI still needs the tokens (streaming bubble or empty
 * assistant body after thinking). Returns false for pure post-turn replays
 * that would double-append into a finished bubble.
 */

export type LateTokenMessage = {
  role?: string;
  marker?: string | null;
  streaming?: boolean;
  content?: string | null;
  /** Joined thought text when known (live segments may leave content empty). */
  thought?: string | null;
};

/**
 * @param hostLiveStreaming - {@link isSessionLiveStreaming}(host.state)
 * @param chunkIsForFocusedHost - chunk.sessionId === focused liveHost.sessionId
 * @param messages - cached messages for that session (turn-local scan)
 */
export function shouldApplyLateStreamText(opts: {
  hostLiveStreaming: boolean;
  chunkIsForFocusedHost: boolean;
  messages: LateTokenMessage[];
}): boolean {
  if (!opts.chunkIsForFocusedHost) return true;
  if (opts.hostLiveStreaming) return true;

  const msgs = opts.messages;
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "user" && m.marker !== "interjection") {
      lastUserIdx = i;
      break;
    }
  }

  let turnAsst: LateTokenMessage | null = null;
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") {
      turnAsst = m;
      break;
    }
  }

  // No assistant yet → first body/thought chunk after early ready.
  if (!turnAsst) return true;

  if (turnAsst.streaming) return true;

  const bodyEmpty = !((turnAsst.content ?? "").trim());
  const hasThought = !((turnAsst.thought ?? "").trim() === "");
  // Thinking landed, body still empty (host may have cleared streaming on ready).
  if (bodyEmpty && hasThought) return true;

  // Settled with body already present, or tool-only empty final → drop replays.
  return false;
}
