import { createTransport, UnlockError } from "./transport.js";
import type { ClientOptions, RequestOptions } from "./types.js";
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}
export interface SessionMaterial {
  connectionId: string;
  profileId: string;
  revision: number;
  allowedDomains: string[];
  cookies: SessionCookie[];
}
export interface SessionBinding {
  connectionId: string;
  profileId: string;
}
export function createRuntimeClient(options: ClientOptions) {
  const request = createTransport(options);
  return {
    retrieve: (binding: SessionBinding, opts?: RequestOptions) =>
      request<SessionMaterial>("runtime/session", "POST", binding, opts),
    sync: (material: SessionMaterial, opts?: RequestOptions) =>
      request<{ revision: number }>("runtime/sync", "POST", material, opts),
  };
}
export interface BrowserAdapter {
  /** Dedicated browser context per binding. Replace only these domains, not the whole browser. */
  replaceCookies(cookies: SessionCookie[], domains: string[]): Promise<void>;
  exportCookies(domains: string[]): Promise<SessionCookie[]>;
}
/** Trusted host code only. Never expose this object or material as LLM tool arguments/results.
 * One adapter per dedicated context; serialized lifecycle calls; no reinjection per click.
 */
export function createSessionBridge(
  runtime: ReturnType<typeof createRuntimeClient>,
  browser: BrowserAdapter,
  binding: SessionBinding,
) {
  let current: SessionMaterial | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>) {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  }
  const inScope = (cookies: SessionCookie[], domains: string[]) =>
    cookies.every((c) => domains.includes(c.domain.replace(/^\./, "")));
  async function hydrate(opts?: RequestOptions) {
    const material = await runtime.retrieve(binding, opts);
    if (
      material.connectionId !== binding.connectionId ||
      material.profileId !== binding.profileId ||
      !material.allowedDomains.length ||
      !inScope(material.cookies, material.allowedDomains)
    ) {
      throw new UnlockError(
        "FORBIDDEN",
        403,
        "Session binding or cookie scope does not match.",
      );
    }
    await browser.replaceCookies(material.cookies, material.allowedDomains);
    current = material;
    return { revision: material.revision };
  }
  return {
    initialize: (opts?: RequestOptions) =>
      serial(() =>
        current
          ? Promise.resolve({ revision: current.revision })
          : hydrate(opts),
      ),
    recover: (opts?: RequestOptions) =>
      serial(async () => {
        current = undefined;
        return hydrate(opts);
      }),
    sync: (opts?: RequestOptions) =>
      serial(async () => {
        if (!current)
          throw new UnlockError(
            "BAD_REQUEST",
            400,
            "Initialize the bridge first.",
          );
        const cookies = await browser.exportCookies(current.allowedDomains);
        if (!inScope(cookies, current.allowedDomains))
          throw new UnlockError(
            "FORBIDDEN",
            403,
            "Browser returned cookies outside this connection.",
          );
        const result = await runtime.sync({ ...current, cookies }, opts);
        current = { ...current, cookies, revision: result.revision };
        return result;
      }),
  };
}
