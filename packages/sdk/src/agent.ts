/** TRUSTED RUNTIME ONLY. Session material must never become model tool input/output. */
import {
  connectionMetadata,
  revisionResult,
  sessionMaterial,
  type VaultCookie,
  type VaultSession,
} from "@unlock/protocol";
import {
  idResult,
  pathId,
  vaultTransport,
  type VaultOptions,
} from "./vault-transport.js";
import { UnlockError } from "./transport.js";
import type { RequestOptions } from "./types.js";
export type { VaultCookie, VaultSession } from "@unlock/protocol";
export function createVaultAgent(options: VaultOptions) {
  const request = vaultTransport({ ...options, credentials: "omit" });
  return {
    connections: (opts?: RequestOptions) =>
      request(
        connectionMetadata.array(),
        "runtime/connections",
        "GET",
        undefined,
        opts,
      ),
    retrieve: (id: string, opts?: RequestOptions) =>
      request(
        sessionMaterial,
        `runtime/connections/${pathId(id)}/session`,
        "GET",
        undefined,
        opts,
      ),
    sync: (
      id: string,
      input: { revision: number; cookies: VaultCookie[] },
      opts?: RequestOptions,
    ) =>
      request(
        revisionResult,
        `runtime/connections/${pathId(id)}/session`,
        "PUT",
        input,
        opts,
      ),
    requestRenewal: (id: string, opts?: RequestOptions) =>
      request(
        idResult,
        `runtime/connections/${pathId(id)}/renew`,
        "POST",
        {},
        opts,
      ),
  };
}
export type VaultAgent = ReturnType<typeof createVaultAgent>;
export interface PrivateBrowserAdapter {
  /** Replace the ENTIRE scoped jar (including deletions). Preserve unlisted domains and partitions. */
  replaceCookies(cookies: VaultCookie[], domains: string[]): Promise<void>;
  exportCookies(domains: string[]): Promise<VaultCookie[]>;
}
export interface VaultBinding {
  connectionId: string;
  profileId: string;
  runtimeId: string;
  domains: string[];
}
const safeError = (code: string) =>
  new UnlockError(code, 0, "The private browser session needs recovery.");
/** One bridge per exclusively owned task-browser context. Hydrates once, never before every action. */
export function createVaultBridge(
  client: VaultAgent,
  browser: PrivateBrowserAdapter,
  inputBinding: VaultBinding,
) {
  const binding = structuredClone(inputBinding);
  let current: VaultSession | undefined,
    blocked = false,
    tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const validate = (cookies: VaultCookie[]) => {
    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, "");
      if (
        !binding.domains.includes(domain) ||
        !c.secure ||
        c.hostOnly !== !c.domain.startsWith(".")
      )
        throw safeError("DOMAIN_MISMATCH");
    }
  };
  const load = async (opts?: RequestOptions) => {
    const material = await client.retrieve(binding.connectionId, opts);
    if (
      material.connectionId !== binding.connectionId ||
      material.profileId !== binding.profileId ||
      material.runtimeId !== binding.runtimeId ||
      material.allowedDomains.length !== binding.domains.length ||
      material.allowedDomains.some((d) => !binding.domains.includes(d)) ||
      material.expiresAt <= Date.now()
    )
      throw safeError("BINDING_MISMATCH");
    validate(material.cookies);
    try {
      await browser.replaceCookies(material.cookies, binding.domains);
    } catch {
      blocked = true;
      throw safeError("BROWSER_UNAVAILABLE");
    }
    current = material;
    blocked = false;
    return { ready: true as const, revision: material.revision };
  };
  const hydrate = async (opts?: RequestOptions) => {
    blocked = true;
    try {
      return await load(opts);
    } catch (error) {
      if (current) {
        try {
          await browser.replaceCookies([], binding.domains);
        } catch {
          /* Stop subsequent actions even if clearing fails. */
        }
      }
      throw error instanceof UnlockError
        ? error
        : safeError("BROWSER_UNAVAILABLE");
    }
  };
  const initialize = async (opts?: RequestOptions) => {
    if (current && current.expiresAt <= Date.now()) blocked = true;
    if (blocked) throw safeError("RECOVERY_REQUIRED");
    if (current) return { ready: true as const, revision: current.revision };
    return hydrate(opts);
  };
  const sync = async (opts?: RequestOptions) => {
    if (!current || blocked) throw safeError("RECOVERY_REQUIRED");
    try {
      const cookies = await browser.exportCookies(binding.domains);
      validate(cookies);
      const result = await client.sync(
        binding.connectionId,
        { revision: current.revision, cookies },
        opts,
      );
      current = {
        ...current,
        cookies,
        revision: result.revision,
        expiresAt: result.expiresAt ?? current.expiresAt,
      };
      if (!cookies.length) blocked = true;
      return result;
    } catch (error) {
      blocked = true;
      try {
        await browser.replaceCookies([], binding.domains);
      } catch {
        /* Best effort; stop all future wrapped actions regardless. */
      }
      throw error instanceof UnlockError
        ? error
        : safeError("BROWSER_UNAVAILABLE");
    }
  };
  return {
    initialize: (opts?: RequestOptions) => serial(() => initialize(opts)),
    recover: (opts?: RequestOptions) => serial(() => hydrate(opts)),
    sync: (opts?: RequestOptions) => serial(() => sync(opts)),
    /** Delegates exactly once. A post-action sync failure must not trigger replay of a successful action. */
    run: <T>(action: () => Promise<T>, onSyncError?: (code: string) => void) =>
      serial(async () => {
        await initialize();
        try {
          return await action();
        } finally {
          try {
            await sync();
          } catch (error) {
            try {
              onSyncError?.(
                error instanceof UnlockError
                  ? error.code
                  : "BROWSER_UNAVAILABLE",
              );
            } catch {
              /* observer must not replace the original tool result or error */
            }
          }
        }
      }),
    status: () => ({
      ready: !!current && !blocked,
      revision: current?.revision ?? null,
    }),
  };
}
/** Only expose a reviewed allowlist of ordinary browser tools. Never pass raw CDP/cookie/evaluate tools. */
export function wrapVaultTools<
  T extends Record<string, (...args: any[]) => Promise<any>>,
>(
  tools: T,
  bridge: ReturnType<typeof createVaultBridge>,
  onSyncError?: (code: string) => void,
): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, fn]) => [
      name,
      (...args: unknown[]) =>
        bridge.run(() => fn.apply(tools, args), onSyncError),
    ]),
  ) as T;
}
