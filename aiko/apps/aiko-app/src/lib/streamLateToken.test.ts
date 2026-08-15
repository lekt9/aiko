import { describe, expect, it } from "vitest";
import { shouldApplyLateStreamText } from "./streamLateToken";

describe("shouldApplyLateStreamText", () => {
  it("always applies when host is still live-streaming", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: true,
        chunkIsForFocusedHost: true,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", streaming: true, content: "" },
        ],
      }),
    ).toBe(true);
  });

  it("always applies for background (non-focused) sessions", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", streaming: false, content: "done" },
        ],
      }),
    ).toBe(true);
  });

  it("applies late body after thinking when host already ready", () => {
    // User report: thinking finished, host ready, answer tokens still arrive.
    // Ready path may clear streaming=false while thought is already present.
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: true,
        messages: [
          { role: "user", content: "write pdf" },
          {
            role: "assistant",
            streaming: false,
            content: "",
            thought: "planning the pdf…",
          },
        ],
      }),
    ).toBe(true);
  });

  it("applies when streaming flag stuck true after ready", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: true,
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", streaming: true, content: "partial " },
        ],
      }),
    ).toBe(true);
  });

  it("drops pure replay once body is settled", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: true,
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", streaming: false, content: "final answer" },
        ],
      }),
    ).toBe(false);
  });

  it("drops settled tool-only empty body (no thought)", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: true,
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            streaming: false,
            content: "",
            thought: "",
          },
        ],
      }),
    ).toBe(false);
  });

  it("applies when no assistant yet (first body chunk after ready)", () => {
    expect(
      shouldApplyLateStreamText({
        hostLiveStreaming: false,
        chunkIsForFocusedHost: true,
        messages: [{ role: "user", content: "q" }],
      }),
    ).toBe(true);
  });
});
