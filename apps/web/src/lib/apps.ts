import type { Connection } from "@unlock/sdk";

const names: Record<string, string> = {
  "github.com": "GitHub",
  "linear.app": "Linear",
  "notion.so": "Notion",
  "notion.com": "Notion",
  "figma.com": "Figma",
  "vercel.com": "Vercel",
};
export type AppGroup = {
  id: string;
  name: string;
  domain: string;
  accounts: Connection[];
  favorite: boolean;
  status: "Ready" | "Needs you" | "Checking" | "Access paused";
};
export function appIdentity(connection: Connection) {
  try {
    const url = new URL(
      connection.domain.includes("://")
        ? connection.domain
        : `https://${connection.domain}`,
    );
    if (
      url.username ||
      url.password ||
      !["https:", "http:"].includes(url.protocol)
    )
      throw new Error("invalid domain");
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!domain) throw new Error("missing host");
    return { id: domain, domain, name: names[domain] ?? connection.name };
  } catch {
    // Invalid domains must never merge unrelated accounts into one fallback app.
    return {
      id: `account:${connection.id}`,
      domain: "Unverified domain",
      name: connection.name,
    };
  }
}
export function groupApps(
  accounts: readonly Connection[],
  options: { query?: string; favorites?: boolean; paused?: boolean } = {},
): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const account of accounts) {
    if (account.status === "revoked") continue;
    const identity = appIdentity(account);
    let group = groups.get(identity.id);
    if (!group) {
      group = {
        ...identity,
        accounts: [],
        favorite: false,
        status: "Checking",
      };
      groups.set(identity.id, group);
    }
    group.accounts.push(account);
    group.favorite ||= !!account.favorite;
  }
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  return [...groups.values()]
    .map((group) => {
      group.status =
        options.paused || group.accounts.every((a) => a.status === "paused")
          ? "Access paused"
          : group.accounts.some(
                (a) =>
                  a.status === "challenge" || a.status === "source-unavailable",
              )
            ? "Needs you"
            : group.accounts.some((a) => a.passwordUnavailable)
              ? "Checking"
              : "Ready";
      return group;
    })
    .filter(
      (group) =>
        (!options.favorites || group.favorite) &&
        (!query ||
          `${group.name} ${group.domain} ${group.accounts.map((a) => `${a.name} ${a.identity}`).join(" ")}`
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
export function maskIdentity(identity: string): string {
  const at = identity.indexOf("@");
  return at > 0
    ? `${identity.slice(0, Math.min(at, 2))}•••${identity.slice(at)}`
    : identity;
}
export const appSuggestions: Record<string, string> = {
  "github.com": "What needs my attention on GitHub?",
  "linear.app": "Which issues are waiting on me?",
  "notion.so": "Find the notes from my last meeting.",
  "notion.com": "Find the notes from my last meeting.",
  "figma.com": "Find the latest design file.",
  "vercel.com": "How is my latest deployment doing?",
};
