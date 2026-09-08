/** Telegram owns retries until account ingress confirms durable acceptance.
 * waitUntil can finish an in-flight RPC, but cannot replace durable storage.
 */
export async function telegramWebhookResponse(
  pending: Promise<string>,
  answerCallback: () => Promise<unknown>,
  waitUntil?: (work: Promise<unknown>) => void,
  timeoutMs = 8_000,
): Promise<Response> {
  const accepted = pending.then(status => ({ status }), () => ({ status: "unavailable" }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: string }>(resolve => {
    timer = setTimeout(() => resolve({ status: "pending_persistence" }), timeoutMs);
  });
  const result = await Promise.race([accepted, timeout]);
  clearTimeout(timer);
  if (result.status === "pending_persistence") {
    waitUntil?.(accepted.then(async ({ status }) => {
      if (status === "accepted" || status === "duplicate") await answerCallback();
    }).catch(() => undefined));
  }
  const ok = result.status === "accepted" || result.status === "duplicate";
  if (ok) await answerCallback().catch(() => undefined);
  const status = ok ? 200 : result.status === "conflict" ? 409 : result.status === "limited" ? 429 : 503;
  return Response.json({ ok, status: result.status }, {
    status,
    headers: { "cache-control": "no-store", ...(status === 503 ? { "retry-after": "2" } : {}) },
  });
}
