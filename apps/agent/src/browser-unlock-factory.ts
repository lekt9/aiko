import type { BrowserDriverFactory } from "./browser-driver.ts";
import type { ConnectorVaultConfig } from "./connector-vault.ts";
import type { ConnectorEngine } from "./connectors.ts";
import { createBrowserUnlockAuth } from "./browser-unlock-auth.ts";

/** Host composition only: the actor sees ordinary browser tools, never credentials or a cookie-install operation. */
export function withUnlockBrowser(
  factory: BrowserDriverFactory,
  options: {
    config?: ConnectorVaultConfig;
    engine: (owner: string) => Pick<ConnectorEngine, "search">;
  },
): BrowserDriverFactory {
  return async (input) => {
    const driver = await factory(input),
      owner = input.owner;
    if (!owner || !options.config?.accounts[owner]) return driver;
    if (
      !driver.sessionContext ||
      !driver.installSession ||
      !driver.clearSession
    ) {
      await driver.close();
      throw new Error("Private Unlock browser adapter unavailable");
    }
    const context = await driver.sessionContext();
    if (context.owner !== owner) {
      await driver.close();
      throw new Error("Private browser owner mismatch");
    }
    const broker = createBrowserUnlockAuth({
      owner,
      config: options.config,
      engine: options.engine(owner),
      context,
      currentContext: () => driver.sessionContext!(),
      install: (material, signal) => driver.installSession!(material, signal),
      clear: (scope, signal) => driver.clearSession!(scope, signal),
    });
    let currentUrl: string | undefined;
    const before = async (url: string | undefined, signal?: AbortSignal) => {
      if (!url) return;
      const result = await broker.beforeNavigate({ ...context, url }, signal);
      if (result.status !== "ready" && result.status !== "not_applicable")
        throw new Error(
          "Unlock session requires renewal or connection recovery",
        );
    };
    return {
      ...driver,
      ...(driver.authorizeInspection ? {authorizeInspection: async (policy: import("./browser-driver.ts").BrowserInspectionPolicy, signal?: AbortSignal) => {
        if (!currentUrl || new URL(currentUrl).origin !== policy.origin) return false;
        try {
          if (!policy.publicOnly) await before(currentUrl,signal);
          return await driver.authorizeInspection!(policy,signal);
        } catch {return false;}
      }} : {}),
      ...(driver.inspectCurrentPage ? {inspectCurrentPage: async (policy: import("./browser-driver.ts").BrowserInspectionPolicy, signal?: AbortSignal) => {
        if (!currentUrl || new URL(currentUrl).origin !== policy.origin) throw Error("Current private page scope unavailable");
        // Public research must never acquire credentials as a side effect of reading.
        if (!policy.publicOnly) await before(currentUrl,signal);
        return driver.inspectCurrentPage!(policy,signal);
      }} : {}),
      execute: async (action, signal) => {
        const url = action.action === "navigate" ? action.url : currentUrl;
        if (!url)
          throw new Error(
            "Navigate to establish the current private session scope",
          );
        await before(url, signal);
        const result = await driver.execute(action, signal);
        if (action.action === "navigate") currentUrl = action.url;
        return result;
      },
      ...(driver.requestRehydrate
        ? {
            requestRehydrate: async (
              pointerId: string,
              inputs: Record<string, any> = {},
              signal?: AbortSignal,
            ) => {
              if (!currentUrl)
                throw new Error("Navigate before private session replay");
              await before(currentUrl, signal);
              return driver.requestRehydrate!(pointerId, inputs, signal);
            },
          }
        : {}),
      ...(driver.screenshot
        ? {
            screenshot: async (signal?: AbortSignal) => {
              if (!currentUrl)
                throw new Error("Navigate before private session capture");
              await before(currentUrl, signal);
              return driver.screenshot!(signal);
            },
          }
        : {}),
      ...(driver.requestTransport
        ? {
            requestTransport: {
              send: async (request) => {
                await before(request.url);
                return driver.requestTransport!.send(request);
              },
            },
          }
        : {}),
      close: async () => {
        try {
          await broker.release();
        } finally {
          await driver.close();
        }
      },
    };
  };
}
