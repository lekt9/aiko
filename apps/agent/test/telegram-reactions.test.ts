import { describe, expect, test } from "bun:test";
import { createTelegramOutbound } from "../src/telegram-outbound.ts";
import { READ_REACTIONS, readReactionFor } from "../src/telegram-reactions.ts";

describe("readReactionFor", () => {
  test("every picked emoji is in the bot-allowed set", () => {
    const samples = [
      "thanks!", "hello", "is this right?", "my app is broken",
      "congrats on the wedding", "this is amazing", "do it asap",
      "", "check", "ok", "what's the price", "help me",
    ];
    for (const s of samples) expect(READ_REACTIONS.has(readReactionFor(s))).toBe(true);
    expect(READ_REACTIONS.has(readReactionFor("", true))).toBe(true);
  });

  test("gratitude beats questions and everything else", () => {
    expect(readReactionFor("thanks, how do I use it?")).toBe("❤");
    expect(readReactionFor("THANK YOU")).toBe("❤");
  });

  test("celebration", () => {
    expect(readReactionFor("happy birthday!!")).toBe("🎉");
  });

  test("greetings", () => {
    expect(readReactionFor("hey there")).toBe("😁");
    expect(readReactionFor("good morning")).toBe("😁");
  });

  test("trouble and help", () => {
    expect(readReactionFor("it crashed again")).toBe("😱");
    expect(readReactionFor("this is broken")).toBe("😱");
    expect(readReactionFor("can you help me?")).toBe("🙏");
  });

  test("urgency", () => {
    expect(readReactionFor("send it asap")).toBe("⚡");
  });

  test("praise", () => {
    expect(readReactionFor("this is amazing")).toBe("🔥");
  });

  test("questions", () => {
    expect(readReactionFor("what time does it open?")).toBe("🤔");
    expect(readReactionFor("how does this work")).toBe("🤔");
  });

  test("media-only messages", () => {
    expect(readReactionFor("", true)).toBe("😍");
    expect(readReactionFor("   ", true)).toBe("😍");
  });

  test("plain statements agree with a thumbs up", () => {
    expect(readReactionFor("check")).toBe("👍");
    expect(readReactionFor("ok do it")).toBe("👍");
  });
});

describe("telegram outbound react", () => {
  const makeOutbound = (calls: { method: string; body: unknown }[]) =>
    createTelegramOutbound({
      token: "fixture-token-not-secret",
      allowedUsers: new Set(["123"]),
      fetch: async (url, init) => {
        const method = String(url).split("/").at(-1)!;
        calls.push({ method, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, result: true });
      },
    });

  test("sets the reaction via setMessageReaction", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const outbound = makeOutbound(calls);
    const delivery = await outbound.react("123", 41, "🔥", new AbortController().signal);
    expect(delivery.status).toBe("delivered");
    expect(calls[0]?.method).toBe("setMessageReaction");
    expect(calls[0]?.body).toEqual({
      chat_id: "123",
      message_id: 41,
      reaction: [{ type: "emoji", emoji: "🔥" }],
    });
  });

  test("strips variation selectors so Telegram matches the emoji", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const outbound = makeOutbound(calls);
    await outbound.react("123", 41, "❤️", new AbortController().signal);
    expect(calls[0]?.body).toMatchObject({
      reaction: [{ type: "emoji", emoji: "❤" }],
    });
  });

  test("rejects without calling Telegram for foreign chats or bad ids", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const outbound = makeOutbound(calls);
    expect((await outbound.react("999", 41, "👍", new AbortController().signal)).status).toBe("rejected");
    expect((await outbound.react("123", 0, "👍", new AbortController().signal)).status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  test("null emoji clears an existing reaction", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const outbound = makeOutbound(calls);
    await outbound.react("123", 41, null, new AbortController().signal);
    expect(calls[0]?.body).toMatchObject({ reaction: [] });
  });
});
