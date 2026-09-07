import type { Event } from "tardie/core/log/event";
import {
  cancellationRequested,
  cancellationRequestedOf,
} from "tardie/core/method/cancellation";
import {
  eventEpochOf,
  turnEpochOf,
  turnView,
} from "tardie/code/execution/turns";

export const FOREGROUND_STALL_MS = 10 * 60_000;
const terminals = new Set(["TurnCompleted", "TurnFailed", "TurnCancelled"]);

/** A fallback for direct message ingress with no native invocation deadline.
 * Only the current head is timed; queued messages and cosmetic typing updates
 * aren't execution progress. A predecessor's terminal gives the next head a
 * fresh window, even when it spent hours waiting in the queue.
 */
export function turnWatchdog(log: readonly Event[], idleMs: number) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1)
    throw new Error("Invalid turn stall timeout");
  const view = turnView(log),
    head = view[0];
  if (!head || typeof head.id !== "string") return;
  const turn = head.id,
    epoch = turnEpochOf(log, turn);
  const invocation = { method: "message", id: turn, epoch };
  if (
    log.some((e) => {
      const cancelled = cancellationRequestedOf(e)?.invocation;
      return (
        cancelled?.method === "message" &&
        cancelled.id === turn &&
        cancelled.epoch === epoch
      );
    })
  )
    return;
  // Respect an explicit native deadline, including a passed deadline: Tardie
  // owns its timeout and child cancellation protocol.
  if (
    log.some((e) => {
      const call = e.call as
        { invocation?: typeof invocation; deadlineAt?: number } | undefined;
      return (
        call?.invocation?.method === "message" &&
        call.invocation.id === turn &&
        call.invocation.epoch === epoch &&
        Number.isFinite(call.deadlineAt)
      );
    })
  )
    return;

  const validTime = (at: unknown): at is number =>
    Number.isSafeInteger(at) && Number(at) >= 0;
  if (!validTime(head.at)) return;
  let progressAt = head.at;
  const predecessors = new Set<string>();
  for (const e of log) {
    if (e === head) break;
    if (e.type === "MessageReceived" && typeof e.id === "string")
      predecessors.add(e.id);
  }
  for (const e of log) {
    if (!validTime(e.at)) continue;
    if (terminals.has(e.type) && predecessors.has(String(e.turn)))
      progressAt = Math.max(progressAt, e.at);
    if (
      e.turn === turn &&
      eventEpochOf(e) === epoch &&
      !e.type.startsWith("AikoTelegram")
    )
      progressAt = Math.max(progressAt, e.at);
  }
  const deadlineAt = progressAt + idleMs;
  return {
    deadlineAt,
    event: (at: number) =>
      cancellationRequested({
        invocation,
        request: `watchdog:${turn}:${epoch}`,
        cause: "deadline",
        reason:
          "Foreground turn made no durable progress before its stall deadline; completed actions may be unconfirmed. Check before retrying.",
        deadlineAt,
        at,
      }),
  };
}
