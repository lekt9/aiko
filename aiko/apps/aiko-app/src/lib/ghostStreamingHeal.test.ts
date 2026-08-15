import { describe, expect, it } from "vitest";
import {
  findOptimisticGhostTurn,
  GHOST_STREAMING_GRACE_MS,
  hostLooksIdleForSession,
  shouldHealGhostStreaming,
  stripGhostTurnMessages,
  type GhostChatMessage,
} from "./ghostStreamingHeal";

const baseMsgs = (extra: GhostChatMessage[] = []): GhostChatMessage[] => [
  { id: "u1", role: "user", content: "hello" },
  { id: "a1", role: "assistant", content: "hi", streaming: false },
  ...extra,
];

describe("ghostStreamingHeal", () => {
  it("finds trailing user + empty streaming assistant", () => {
    const msgs = baseMsgs([
      { id: "u2", role: "user", content: "cli check" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ]);
    const turn = findOptimisticGhostTurn(msgs);
    expect(turn?.userMessageId).toBe("u2");
    expect(turn?.assistantMessageId).toBe("a2");
    expect(turn?.restoreComposerText).toBe("cli check");
  });

  it("does not treat tool activity as a ghost", () => {
    const msgs: GhostChatMessage[] = [
      { id: "u2", role: "user", content: "go" },
      { id: "t1", role: "tool", content: "…", marker: "tool_step" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ];
    expect(findOptimisticGhostTurn(msgs)).toBeNull();
  });

  it("does not treat assistant body as a ghost", () => {
    const msgs = baseMsgs([
      { id: "u2", role: "user", content: "go" },
      { id: "a2", role: "assistant", content: "working…", streaming: true },
    ]);
    expect(findOptimisticGhostTurn(msgs)).toBeNull();
  });

  it("hostLooksIdleForSession treats missing/ready as idle", () => {
    expect(hostLooksIdleForSession(null)).toBe(true);
    expect(hostLooksIdleForSession(undefined)).toBe(true);
    expect(hostLooksIdleForSession("ready")).toBe(true);
    expect(hostLooksIdleForSession("idle")).toBe(true);
    expect(hostLooksIdleForSession("streaming")).toBe(false);
    expect(hostLooksIdleForSession("awaiting_permission")).toBe(false);
    expect(hostLooksIdleForSession("connecting")).toBe(false);
  });

  it("does not heal while send is still in flight (WSL cold connect)", () => {
    const messages = baseMsgs([
      { id: "u2", role: "user", content: "cli check" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ]);
    const started = 1_000_000;
    expect(
      shouldHealGhostStreaming({
        uiSessionState: "streaming",
        viewedSessionId: "s1",
        messages,
        turnStartedAt: started,
        nowMs: started + GHOST_STREAMING_GRACE_MS + 60_000,
        hostStateForSession: null,
        sendInFlight: true,
      }),
    ).toBe(false);
  });

  it("heals after grace when Host is idle and UI is empty-streaming", () => {
    const messages = baseMsgs([
      { id: "u2", role: "user", content: "cli check" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ]);
    const started = 1_000_000;
    expect(
      shouldHealGhostStreaming({
        uiSessionState: "streaming",
        viewedSessionId: "s1",
        messages,
        turnStartedAt: started,
        nowMs: started + GHOST_STREAMING_GRACE_MS - 1,
        hostStateForSession: "ready",
      }),
    ).toBe(false);
    expect(
      shouldHealGhostStreaming({
        uiSessionState: "streaming",
        viewedSessionId: "s1",
        messages,
        turnStartedAt: started,
        nowMs: started + GHOST_STREAMING_GRACE_MS,
        hostStateForSession: "ready",
      }),
    ).toBe(true);
    // Missing liveMap row also heals (optimistic never reached Host).
    expect(
      shouldHealGhostStreaming({
        uiSessionState: "streaming",
        viewedSessionId: "s1",
        messages,
        turnStartedAt: started,
        nowMs: started + GHOST_STREAMING_GRACE_MS + 5_000,
        hostStateForSession: null,
      }),
    ).toBe(true);
  });

  it("does not heal when Host is actually streaming", () => {
    const messages = baseMsgs([
      { id: "u2", role: "user", content: "cli check" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ]);
    expect(
      shouldHealGhostStreaming({
        uiSessionState: "streaming",
        viewedSessionId: "s1",
        messages,
        turnStartedAt: 0,
        nowMs: GHOST_STREAMING_GRACE_MS + 60_000,
        hostStateForSession: "streaming",
      }),
    ).toBe(false);
  });

  it("stripGhostTurnMessages drops only the ghost pair", () => {
    const messages = baseMsgs([
      { id: "u2", role: "user", content: "cli check" },
      { id: "a2", role: "assistant", content: "", streaming: true },
    ]);
    const turn = findOptimisticGhostTurn(messages)!;
    const next = stripGhostTurnMessages(messages, turn.dropIds);
    expect(next.map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});
