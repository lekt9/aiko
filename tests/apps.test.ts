import { describe, expect, it } from "vitest";
import type { Connection } from "../packages/sdk/src/types";
import { appIdentity, groupApps, maskIdentity } from "../apps/web/src/lib/apps";
import {
  AIKO_TELEGRAM_URL,
  telegramBotUrl,
} from "../apps/web/src/lib/telegram";
const connection = (
  id: string,
  patch: Partial<Connection> = {},
): Connection => ({
  id,
  name: "GitHub",
  domain: "github.com",
  identity: `${id}@example.com`,
  kind: "session",
  sourceId: "vault",
  sourceLabel: "Vault",
  sourceMode: "native",
  status: "healthy",
  revision: 1,
  verifiedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-02-01T00:00:00Z",
  maintenance: false,
  recipe: "demo",
  createdAt: "2026-01-01T00:00:00Z",
  ...patch,
});
describe("Telegram gateway links", () => {
  it("uses a public HTTPS bot link with no identity or credential in the start payload", () => {
    expect(AIKO_TELEGRAM_URL).toBe("https://t.me/aikospillstea_bot?start=web");
    expect(telegramBotUrl("another_bot")).toBe(
      "https://t.me/another_bot?start=web",
    );
    for (const value of [
      "../escape",
      "bot?start=account123",
      "https://evil.example",
      "123:secret",
      "@bot",
      "",
    ]) {
      expect(() => telegramBotUrl(value)).toThrow();
    }
  });
});
describe("app-first grouping", () => {
  it("groups two identities into one app without hiding either", () => {
    const apps = groupApps([
      connection("work"),
      connection("personal", {
        name: "GitHub Personal",
        domain: "https://www.github.com/login",
      }),
    ]);
    expect(apps).toHaveLength(1);
    expect(apps[0].accounts).toHaveLength(2);
    expect(apps[0].name).toBe("GitHub");
  });
  it("an identity search returns the whole app and every authorized sibling account", () => {
    const apps = groupApps([connection("work"), connection("personal")], {
      query: "work@example.com",
    });
    expect(apps).toHaveLength(1);
    expect(apps[0].accounts).toHaveLength(2);
    expect(groupApps([connection("work")], { query: "absent" })).toHaveLength(
      0,
    );
  });
  it("groups by exact host, never by a user-chosen display name or an unsafe suffix", () => {
    expect(
      groupApps([
        connection("1"),
        connection("2", { domain: "github.com.evil.example" }),
        connection("3", { domain: "github.enterprise.example" }),
      ]),
    ).toHaveLength(3);
    expect(
      groupApps([
        connection("1", { domain: "https://user:pass@github.com" }),
        connection("2", { domain: "https://user:pass@github.com" }),
      ]),
    ).toHaveLength(2);
    expect(
      appIdentity(connection("1", { domain: "javascript:alert(1)" })).id,
    ).toBe("account:1");
  });
  it("revoked accounts disappear and favorites sort before alphabetical apps", () => {
    const apps = groupApps([
      connection("old", { status: "revoked" }),
      connection("work"),
      connection("z", { domain: "z.example", name: "Zeta", favorite: true }),
    ]);
    expect(apps).toHaveLength(2);
    expect(apps[0].name).toBe("Zeta");
    expect(
      groupApps(
        apps.flatMap((a) => a.accounts),
        { favorites: true },
      ),
    ).toHaveLength(1);
  });
  it("reports actionable status without treating a sleeping VM as a lost login", () => {
    expect(
      groupApps([connection("1", { status: "challenge" })])[0].status,
    ).toBe("Needs you");
    expect(groupApps([connection("1", { status: "paused" })])[0].status).toBe(
      "Access paused",
    );
    expect(
      groupApps([connection("1", { passwordUnavailable: true })])[0].status,
    ).toBe("Checking");
    expect(groupApps([connection("1")], { paused: true })[0].status).toBe(
      "Access paused",
    );
    expect(groupApps([connection("1")])[0].status).toBe("Ready");
  });
  it("masks email usernames in the app sheet but retains handles", () => {
    expect(maskIdentity("alice@work.example")).toBe("al•••@work.example");
    expect(maskIdentity("octocat")).toBe("octocat");
  });
});
