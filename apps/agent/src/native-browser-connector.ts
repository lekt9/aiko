import { connectionMiniAppUrl } from "./telegram-mini-app.ts";
import type { SecureBrowserAdapter } from "./connectors-browser.ts";
import type { BrowserDriverFactory } from "./browser-driver.ts";
import { connectionRoute, CONNECTION_LINK_LIMIT } from "./connection-index.ts";
/** Cloud host binding; credentials travel only through the runner's encrypted private operation seam. */
export function nativeBrowserConnector(
  owner: string,
  factory: BrowserDriverFactory,
  emit: (event: object) => Promise<void>,
): SecureBrowserAdapter {
  const invoke = async (
    input: import("./native-login.ts").NativeLoginInput,
    signal?: AbortSignal,
  ) => {
    const driver = await factory({
      owner,
      domains: ["*"],
      emit: async () => {},
      signal,
    }).catch((error) => {
      console.warn("private_browser_allocation_failed");
      throw error;
    });
    if (!driver.nativeAuth) throw Error("Private sign-in unavailable");
    // Do not close this borrowed driver: it uses the owner's persistent sandbox.
    return driver.nativeAuth(input, signal);
  };
  return {
    native: true,
    readContext: async (binding, signal, target, linkOffset = 0) => {
      if (binding.owner !== owner) throw Error("Owner mismatch");
      if (!Number.isSafeInteger(linkOffset) || linkOffset < 0) throw Error("Invalid link offset");
      const destination = connectionRoute(
        target ?? `https://${binding.domain}/`,
        binding.domain,
      );
      if (!destination) throw Error("Invalid connection route");
      // Network evidence must reach the owner's durable foreground log before
      // the runner acknowledges it; the router reads its capabilities there.
      const driver = await factory({
        owner,
        domains: [binding.domain],
        emit,
        signal,
      });
      if (driver.readConnectionPage) return driver.readConnectionPage(destination,linkOffset,signal);
      const check = async () => {
        const result = (await driver.execute({ action: "url" }, signal)) as {
          url?: string;
        };
        const url = new URL(result?.url ?? "");
        if (
          url.protocol !== "https:" ||
          (url.hostname !== binding.domain &&
            !url.hostname.endsWith(`.${binding.domain}`))
        )
          throw Error("Connection context left its domain");
        return (
          connectionRoute(url.href, binding.domain) ??
          `${url.origin}${url.pathname}`
        );
      };
      await driver.execute({ action: "navigate", url: destination }, signal);
      await check();
      const loginFields = (await driver.execute(
        { action: "get_count", selector: 'input[type="password"]' },
        signal,
      )) as { count?: number };
      if (loginFields?.count !== 0)
        throw Error("Connected page still requires sign-in");
      const snapshot = await driver.execute({ action: "snapshot" }, signal);
      const visibleText = await driver.execute(
        { action: "get_text", selector: "body" },
        signal,
      );
      const url = await check();
      const count = (await driver.execute(
        { action: "get_count", selector: "a[href]" },
        signal,
      )) as { count?: number };
      if (!Number.isSafeInteger(count?.count) || count.count! < 0)
        throw Error("Connection links unavailable");
      const links = new Set<string>();
      const through = Math.min(count.count!, linkOffset + CONNECTION_LINK_LIMIT);
      for (let i = linkOffset; i < through; i++) {
        signal?.throwIfAborted();
        const attribute = (await driver.execute(
          {
            action: "get_attribute",
            selector: `a[href] >> nth=${i}`,
            name: "href",
          },
          signal,
        )) as { value?: unknown };
        if (typeof attribute?.value !== "string") continue;
        const link = connectionRoute(attribute.value, binding.domain, url);
        if (link) links.add(link);
      }
      if ((await check()) !== url)
        throw Error("Connection page changed during link discovery");
      const text = JSON.stringify({ visibleText, snapshot });
      if (!text || text.length > 64000)
        throw Error("Connection context is unavailable or too large");
      // Only the indexer receives this read; credential operations remain on the private seam.
      return {
        url,
        text: text.slice(0, 12000),
        links: [...links],
        linksTruncated: count.count! > through,
        ...(count.count! > through ? {nextLinkOffset:through} : {}),
      };
    },
    begin: async (binding, signal) => {
      if (binding.owner !== owner) throw Error("Owner mismatch");
      return { authorizationUrl: connectionMiniAppUrl(binding.connectionId) };
    },
    control: async (binding, input, signal) => {
      if (binding.owner !== owner) throw Error("Owner mismatch");
      return invoke(
        {
          ...input,
          connectionId: binding.connectionId,
          domain: binding.domain,
        },
        signal,
      );
    },
    status: async (binding, signal) => {
      if (binding.owner !== owner) throw Error("Owner mismatch");
      let result = await invoke({ ...binding, action: "status" }, signal);
      if (result.status === "connected" && result.expiresAt <= Date.now())
        result = await invoke({...binding, action:"renew"}, signal);
      return result.status === "connected"
        ? {
            ...binding,
            status: "connected",
            verification: {
              verified: true,
              revision: result.revision,
              expiresAt: result.expiresAt,
            },
          }
        : { ...binding, status: result.status };
    },
    disconnect: async (binding, signal) => {
      if (binding.owner !== owner) throw Error("Owner mismatch");
      const result = await invoke({ ...binding, action: "disconnect" }, signal);
      return {
        ...binding,
        status: result.status === "disconnected" ? "disconnected" : "unknown",
      };
    },
  };
}
