import { createHash } from "node:crypto";
import { validateNoSecrets } from "entity-learn/cloudflare";
import { publicTarget } from "./browser-proxy.ts";
import type { LearningInput } from "./learning.ts";

export type ConnectionRoute = { url: string; revision: number };
export type ConnectionIndexPage = {
  input: LearningInput;
  url: string;
  revision: number;
  routes: string[];
  linksTruncated: boolean;
};
export const CONNECTION_LINK_LIMIT = 256;

function unsafeNavigation(url: URL) {
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (
    /(?:^|[/_.-])(?:logout|log-out|signout|sign-out|signin|login|delete|remove|revoke|unsubscribe|confirm|approve|checkout|purchase)(?:$|[/_.-])/.test(
      path,
    )
  )
    return true;
  for (const [name] of url.searchParams) {
    if (
      /token|session|password|passcode|secret|credential|authorization|oauth|csrf|signature|^(?:key|code|sig|auth|action|do|cmd|command|confirm|approve|delete|remove|logout)$/i.test(
        name,
      )
    )
      return true;
  }
  return false;
}

/** Only observed, non-credential navigation URLs enter the durable frontier. */
export function connectionRoute(
  value: string,
  domain: string,
  base?: string,
): string | undefined {
  try {
    if (typeof value !== "string" || value.length > 2048) return;
    const url = publicTarget(new URL(value, base).href);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
    )
      return;
    // Navigation can mutate a session too. Do not follow sign-out, consent or
    // action links while automatically exploring an account.
    if (unsafeNavigation(url)) return;
    // Preserve hash-router paths, but collapse ordinary in-page anchors.
    if (!/^#!?\//.test(url.hash)) url.hash = "";
    else {
      const route = new URL(url.hash.replace(/^#!?/, ""), url.origin);
      if (route.origin !== url.origin || unsafeNavigation(route) || route.hash)
        return;
    }
    url.searchParams.sort();
    validateNoSecrets(url.href);
    return url.href;
  } catch {
    return;
  }
}

export function connectionRouteId(crawlId: string, url: string) {
  return createHash("sha256")
    .update(JSON.stringify([crawlId, url]))
    .digest("hex");
}
