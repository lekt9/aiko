import { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../brand", () => ({ DISPLAY_NAME: "Aiko" }));
vi.mock("../utils/settings", () => ({
  loadUserSettings: () => ({}),
  resolveTelegramStreamSettings: () => ({ streaming: "off", typingIndicator: false }),
}));
vi.mock("./audio-input", () => ({
  getTelegramAudioSource: () => null,
  transcribeTelegramAudioMessage: vi.fn(),
}));
vi.mock("./pairing", () => ({ registerPairingCode: () => "TEST" }));
vi.mock("./preview-stream", () => ({ runTelegramPartialReply: vi.fn() }));
vi.mock("./send-file", () => ({ sendFileToTelegram: vi.fn() }));
vi.mock("./typing-refresh", () => ({ startTypingRefresh: () => () => {} }));
import { createTelegramBridge } from "./bridge";
import type { TurnCoordinator } from "./turn-coordinator";

let mockSendMessage: ReturnType<typeof vi.fn>;
let mockOn: ReturnType<typeof vi.fn>;

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    return {
      api: { sendMessage: mockSendMessage },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

const MockedBot = vi.mocked(Bot);

function mockCoordinator(): TurnCoordinator {
  return { run: vi.fn((fn) => fn()) } as unknown as TurnCoordinator;
}

describe("createTelegramBridge", () => {
  describe("sendDm", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      mockOn = vi.fn();
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: mockOn,
        } as never;
      } as never);
    });

    it("records an unapproved inbound event before replying with the pairing gate", async () => {
      const onInboundMessage = vi.fn();
      createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
        onInboundMessage,
      });
      const handler = mockOn.mock.calls.find(([event]) => event === "message:text")?.[1];
      expect(handler).toBeTypeOf("function");
      const reply = vi.fn().mockResolvedValue(undefined);
      await handler({
        chat: { id: 489698073 },
        from: { id: 489698073 },
        message: { message_id: 291764682, text: "Yo aiko" },
        reply,
      });
      expect(onInboundMessage).toHaveBeenCalledWith({
        turnKey: "telegram:489698073:291764682",
        userId: 489698073,
        content: "Yo aiko",
        authorized: false,
        kind: "text",
      });
      expect(reply).toHaveBeenCalledWith(expect.stringContaining("Not paired yet"));
    });

    it("sends short messages without splitting", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "Hello, world!");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "Hello, world!");
    });

    it("splits long messages and sends each part", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const longMessage = "a".repeat(5000);
      await bridge.sendDm(123, longMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 123, "a".repeat(4096));
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(904));
    });

    it("handles empty messages", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "");

      expect(mockSendMessage).toHaveBeenCalledTimes(0);
    });

    it("sends multiple parts for message exactly at limit", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const exactLimitMessage = "a".repeat(4096);
      await bridge.sendDm(123, exactLimitMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "a".repeat(4096));
    });
  });
});
