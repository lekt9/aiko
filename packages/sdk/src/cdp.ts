/** Private CDP integration, not a model tool. Requires an isolated, exclusively owned task context. */
import { cookieJar, type VaultCookie } from "@unlock/protocol";
import type { PrivateBrowserAdapter } from "./agent.js";
import { UnlockError } from "./transport.js";
export interface PrivateCdp {
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
}
export async function createCdpCookieAdapter(
  cdp: PrivateCdp,
  binding: { browserContextId: string; targetId: string },
): Promise<PrivateBrowserAdapter> {
  const { browserContextId, targetId } = binding;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(browserContextId) || !targetId)
    throw new TypeError("An isolated browser context and target are required");
  const fault = () =>
    new UnlockError(
      "BROWSER_UNAVAILABLE",
      0,
      "The private browser cookie operation failed.",
    );
  let sessionId: string;
  try {
    const info = await cdp.send("Target.getTargetInfo", { targetId });
    if (info.targetInfo?.browserContextId !== browserContextId) throw fault();
    sessionId = (
      await cdp.send("Target.attachToTarget", { targetId, flatten: true })
    ).sessionId;
    if (!sessionId) throw fault();
  } catch {
    throw fault();
  }
  const read = async () => {
    const result = await cdp.send("Storage.getCookies", { browserContextId });
    if (!Array.isArray(result.cookies)) throw fault();
    return result.cookies as Record<string, any>[];
  };
  const decode = (c: Record<string, any>): VaultCookie => {
    if (c.partitionKeyOpaque) throw fault();
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.session ? -1 : c.expires,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite ?? "Lax",
      hostOnly: !c.domain.startsWith("."),
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    };
  };
  const encode = (c: VaultCookie) => {
    const url = new URL(`https://${c.domain.replace(/^\./, "")}`);
    url.pathname = c.path;
    return {
      name: c.name,
      value: c.value,
      url: url.href,
      ...(!c.hostOnly ? { domain: c.domain } : {}),
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      ...(c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    };
  };
  return {
    async exportCookies(domains) {
      try {
        return cookieJar.parse(
          (await read())
            .filter((c) =>
              domains.includes(String(c.domain).replace(/^\./, "")),
            )
            .map(decode),
        );
      } catch {
        throw fault();
      }
    },
    async replaceCookies(cookies, domains) {
      try {
        const input = cookieJar.parse(cookies);
        if (
          input.some(
            (c) =>
              !domains.includes(c.domain.replace(/^\./, "")) ||
              c.hostOnly !== !c.domain.startsWith("."),
          )
        )
          throw fault();
        // CDP has no atomic replace-jar operation: the bridge must suspend ordinary browser actions.
        const scoped = (await read()).filter((c) =>
          domains.includes(String(c.domain).replace(/^\./, "")),
        );
        for (const c of scoped) {
          if (c.partitionKeyOpaque) throw fault();
          await cdp.send(
            "Network.deleteCookies",
            {
              name: c.name,
              domain: c.domain,
              path: c.path,
              ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
            },
            sessionId,
          );
        }
        await cdp.send("Storage.setCookies", {
          browserContextId,
          cookies: input.map(encode),
        });
      } catch {
        throw fault();
      }
    },
  };
}
