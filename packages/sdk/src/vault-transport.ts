import { z } from "@unlock/protocol";
import { createTransport, UnlockError } from "./transport.js";
import type { ClientOptions, RequestOptions } from "./types.js";
export interface VaultOptions extends ClientOptions {
  csrf?: string | (() => string | Promise<string>);
}
export function vaultTransport(options: VaultOptions) {
  const browser = globalThis as typeof globalThis & { location?: { href: string }; window?: unknown };
  const base = new URL(
    options.baseUrl,
    browser.location?.href,
  );
  if (
    base.username ||
    base.password ||
    base.hash ||
    base.search ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      ))
  )
    throw new TypeError("Use HTTPS, or loopback HTTP for local development");
  const request = createTransport({
    ...options,
    baseUrl: base.href,
    credentials: options.credentials ?? "include",
    headers: async () => {
      const headers = new Headers(await options.headers?.());
      if (options.csrf)
        headers.set(
          "X-Unlock-CSRF",
          typeof options.csrf === "function"
            ? await options.csrf()
            : options.csrf,
        );
      if (typeof browser.window === "undefined") headers.set("Origin", base.origin);
      return headers;
    },
  });
  return async <T>(
    schema: z.ZodType<T>,
    path: string,
    method = "GET",
    data?: unknown,
    opts?: RequestOptions,
  ): Promise<T> => {
    const value = await request<unknown>(path, method, data, opts),
      parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new UnlockError(
        "INVALID_RESPONSE",
        200,
        "Unlock returned an invalid response.",
      );
    return parsed.data;
  };
}
export const pathId = (value: string) => {
  if (!z.string().uuid().safeParse(value).success)
    throw new TypeError("Expected an Unlock record ID");
  return value;
};
export const idResult = z.object({ id: z.string().uuid() }).strict();
