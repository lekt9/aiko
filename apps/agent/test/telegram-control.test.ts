import { describe, expect, test } from "bun:test";
import {
  controlCommand,
  telegramControl,
  type TelegramConnectorControls,
} from "../src/telegram-control.ts";
import type { AikoEvent } from "../src/actor.ts";

function fixture(connectors?: Partial<TelegramConnectorControls>) {
  const events: AikoEvent[] = [];
  const host = {
    read: async () => events,
    seed: async () => {},
    self: () => "user-alice",
    commitRoot: async (_target: unknown, entry: AikoEvent) => {
      events.push(entry);
    },
  } as unknown as Parameters<typeof telegramControl>[0];
  const service = {
    search: async () => ({
      status: "available",
      connectors: [
        {
          id: "arcade:GitHub.List",
          name: "GitHub",
          description: "Read issues",
          provider: "arcade",
          toolName: "GitHub.List",
          domains: ["github.com"],
        },
      ],
      fallbackAllowed: false,
      message: "",
    }),
    connections: async () => [],
    disconnect: async () => ({
      id: "connection",
      connectorId: "GitHub",
      status: "disconnected",
      provider: "arcade",
      createdAt: 0,
    }),
    discover: async () => ({
      status: "needs_evidence",
      search: {
        status: "absent",
        connectors: [],
        fallbackAllowed: true,
        message: "",
      },
      capabilities: [],
    }),
    ...connectors,
  } as TelegramConnectorControls;
  async function run(text: string, id = `id-${events.length}`) {
    const status = await telegramControl(
      host,
      "alice",
      id,
      text,
      true,
      true,
      undefined,
      { connectors: service, connectorsUrl: "https://aiko.example/app" },
    );
    return { status, reply: String(events.at(-1)?.reply) };
  }
  return { run, events };
}

describe("native Telegram connector controls", () => {
  test("routes app names and website domains without routing ordinary chat", () => {
    expect(controlCommand("/apps Google Drive")).toBe("apps");
    expect(controlCommand("/apps https://github.com")).toBe("apps");
    expect(controlCommand("/start web")).toBe("start");
    expect(controlCommand("please connect github")).toBeUndefined();
    expect(controlCommand("/apps site\n/other")).toBeUndefined();
    expect(controlCommand(`/apps ${"x".repeat(241)}`)).toBeUndefined();
  });
  test("start teaches app search and keeps credentials out of chat", async () => {
    const { reply } = await fixture().run("/start web");
    expect(reply).toContain("/apps github.com");
    expect(reply).toContain("Never send passwords");
  });
  test("available catalog provider directs to authorization without claiming connection", async () => {
    const { reply } = await fixture().run("/apps github.com");
    expect(reply).toContain("Available through Arcade");
    expect(reply).toContain("Listing a provider does not connect it");
    expect(reply).toContain("https://aiko.example/app");
  });
  test("connect prioritizes native chat menu with explicit account-credential browser fallback", async () => {
    const { reply } = await fixture().run("/connect");
    expect(reply).toContain("Tap Connect apps in this chat’s menu");
    expect(reply).toContain("If you have an Aiko account credential");
    expect(reply).toContain("https://aiko.example/app");
    expect(reply).toContain("Never send passwords");
  });
  test("catalog failures never offer fallback", async () => {
    const { reply } = await fixture({
      search: async () => ({
        status: "unavailable",
        connectors: [],
        fallbackAllowed: false,
        message: "outage",
      }),
    }).run("/apps unknown.example");
    expect(reply).toContain("Browser sign-in is not offered");
    expect(reply).not.toContain("/discover");
  });
  test("confirmed absence offers discovery with explicit unavailable integration", async () => {
    const { reply } = await fixture({
      search: async () => ({
        status: "absent",
        connectors: [],
        fallbackAllowed: true,
        message: "absent",
      }),
    }).run("/apps unknown.example");
    expect(reply).toContain("needs discovery or a connector built");
    expect(reply).toContain("/discover");
    expect(reply).toContain("Never send passwords");
  });
  test("pending authorization URLs never enter control reply events", async () => {
    const f = fixture({
      connections: async () => [
        {
          id: "connection",
          connectorId: "GitHub",
          provider: "arcade",
          status: "pending",
          createdAt: 0,
          authorizationUrl: "https://arcade.dev/authorize?secret=private",
        },
      ],
    });
    expect((await f.run("/connections")).reply).toContain("pending");
    expect(JSON.stringify(f.events)).not.toContain("secret=private");
  });
  test("disconnect uses owned service once for duplicate updates", async () => {
    let calls = 0;
    const f = fixture({
      disconnect: async (id) => {
        expect(id).toBe("owned-id");
        calls++;
        return {
          id,
          connectorId: "GitHub",
          status: "disconnected",
          provider: "arcade",
          createdAt: 0,
        };
      },
    });
    expect((await f.run("/disconnect owned-id", "one")).status).toBe(
      "accepted",
    );
    expect((await f.run("/disconnect owned-id", "one")).status).toBe(
      "duplicate",
    );
    expect(calls).toBe(1);
  });
  test("provider errors are not copied into durable replies", async () => {
    const { reply } = await fixture({
      search: async () => {
        throw new Error("secret-token");
      },
    }).run("/apps github");
    expect(reply).not.toContain("secret-token");
    expect(reply).toContain("could not be completed");
  });
});
