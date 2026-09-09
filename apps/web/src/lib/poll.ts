/**
 * Poll on a fixed cadence while the page is visible.
 *
 * A Telegram mini app stays loaded behind the chat; without this check its
 * webviews keep polling the API unseen, spending the person's data and battery.
 * Hidden pages stop polling; returning to view refreshes immediately so the
 * surface is current without waiting a full interval. The poll callback keeps
 * its own guards against overlapping reads.
 */
export function pollWhileVisible(
  poll: () => void,
  intervalMs: number,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const schedule = () => {
    clearInterval(timer);
    timer = setInterval(poll, intervalMs);
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearInterval(timer);
      timer = undefined;
    } else {
      poll();
      schedule();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    clearInterval(timer);
  };
}
