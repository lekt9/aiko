import type { ClientOptions, RequestOptions } from "./types.js";

/** Errors deliberately exclude response bodies, URLs and authentication material. */
export class UnlockError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UnlockError";
  }
}
const safeMessages: Record<string, string> = {
  UNAUTHENTICATED: "Sign in to Unlock again.",
  REAUTH_REQUIRED: "Owner sign-in or destination authentication is required.",
  UNSUPPORTED_PROVIDER: "No approved authentication recipe is configured.",
  RUNTIME_UNAVAILABLE: "The required trusted runtime is unavailable.",
  UNAVAILABLE: "The vault service is temporarily unavailable.",
  CAPACITY: "The request exceeds the configured capacity.",
  RATE_LIMITED: "Wait before trying again.",
  NOT_FOUND: "This record no longer exists.",
  CONFLICT: "The session revision changed. Recover before synchronizing.",
  DUPLICATE: "This account is already connected.",
  INVALID_INPUT: "Check the submitted fields.",
  VAULT_FULL:
    "The demo vault is full (2,000 records). Nothing in this batch was imported.",
  SOURCE_UNAVAILABLE: "Reconnect the source before renewing this session.",
  REVOKED: "Access to this connection was revoked.",
  FORBIDDEN: "This profile cannot access that connection.",
  DEMO_ONLY: "Only synthetic demo fixtures are accepted.",
  CHALLENGE: "Complete the demo recovery flow before renewing.",
  BAD_REQUEST: "The request could not be processed.",
};
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_097_152) {
        await reader.cancel();
        throw new Error("Response limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all));
}
export function createTransport(options: ClientOptions) {
  const transport = options.transport ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new TypeError("timeoutMs must be positive");
  return async function request<T>(
    path: string,
    method = "GET",
    data?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    // Race also bounds async token resolution and custom transports that ignore AbortSignal.
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          new UnlockError(
            timedOut ? "TIMEOUT" : "ABORTED",
            0,
            timedOut ? "Request timed out." : "Request cancelled.",
          ),
        );
      if (controller.signal.aborted) abortListener();
      else
        controller.signal.addEventListener("abort", abortListener, {
          once: true,
        });
    });
    try {
      return await Promise.race([
        aborted,
        (async () => {
          const token =
            typeof options.token === "function"
              ? await options.token()
              : options.token;
          const headers = new Headers(await options.headers?.());
          headers.set("Accept", "application/json");
          if (data !== undefined)
            headers.set("Content-Type", "application/json");
          if (token) headers.set("Authorization", `Bearer ${token}`);
          if (controller.signal.aborted)
            throw new UnlockError("ABORTED", 0, "Request cancelled.");
          const response = await transport(
            `${options.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
            {
              method,
              signal: controller.signal,
              redirect: "error",
              credentials: options.credentials,
              headers,
              ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
            },
          );
          if (!response.ok) {
            const body = (await boundedJson(response).catch(() => null)) as {
              error?: { code?: string };
            } | null;
            const raw = body?.error?.code;
            const code =
              raw && Object.hasOwn(safeMessages, raw) ? raw : "HTTP_ERROR";
            throw new UnlockError(
              code,
              response.status,
              safeMessages[code] ?? "Unlock request failed.",
            );
          }
          if (response.status === 204) return undefined as T;
          try {
            return (await boundedJson(response)) as T;
          } catch {
            throw new UnlockError(
              "INVALID_RESPONSE",
              response.status,
              "Unlock returned an invalid response.",
            );
          }
        })(),
      ]);
    } catch (error) {
      if (error instanceof UnlockError) throw error;
      throw new UnlockError("NETWORK_ERROR", 0, "Unable to reach Unlock.");
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (abortListener)
        controller.signal.removeEventListener("abort", abortListener);
    }
  };
}
