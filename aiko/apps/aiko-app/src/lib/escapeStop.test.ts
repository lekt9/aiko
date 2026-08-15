import { describe, expect, it } from "vitest";
import { shouldEscapeStopGeneration, type EscapeStopOpts } from "./escapeStop";

const free: EscapeStopOpts = {
  streamingOrBusy: true,
  overlayOpen: false,
  permOpen: false,
  askUserOpen: false,
  chatFindOpen: false,
  slashOrMenuOpen: false,
  promptHistoryOpen: false,
  voiceStealsEscape: false,
};

describe("shouldEscapeStopGeneration", () => {
  it("stops when streaming and nothing owns Escape", () => {
    expect(shouldEscapeStopGeneration(free)).toBe(true);
  });

  it("does not stop when idle / not busy", () => {
    expect(
      shouldEscapeStopGeneration({ ...free, streamingOrBusy: false }),
    ).toBe(false);
  });

  it("defers to voice dictation", () => {
    expect(
      shouldEscapeStopGeneration({ ...free, voiceStealsEscape: true }),
    ).toBe(false);
  });

  it("defers to overlays (search, dialog, doctor, shortcuts, export)", () => {
    expect(shouldEscapeStopGeneration({ ...free, overlayOpen: true })).toBe(
      false,
    );
  });

  it("defers to permission bar (Esc → deny)", () => {
    expect(shouldEscapeStopGeneration({ ...free, permOpen: true })).toBe(
      false,
    );
  });

  it("defers to ask-user modal", () => {
    expect(shouldEscapeStopGeneration({ ...free, askUserOpen: true })).toBe(
      false,
    );
  });

  it("defers to chat find", () => {
    expect(shouldEscapeStopGeneration({ ...free, chatFindOpen: true })).toBe(
      false,
    );
  });

  it("defers to slash / composer menus", () => {
    expect(
      shouldEscapeStopGeneration({ ...free, slashOrMenuOpen: true }),
    ).toBe(false);
  });

  it("defers to prompt history picker", () => {
    expect(
      shouldEscapeStopGeneration({ ...free, promptHistoryOpen: true }),
    ).toBe(false);
  });

  it("treats missing optional flags as not open", () => {
    expect(
      shouldEscapeStopGeneration({
        streamingOrBusy: true,
        overlayOpen: false,
        permOpen: false,
        askUserOpen: false,
        chatFindOpen: false,
        slashOrMenuOpen: false,
      }),
    ).toBe(true);
  });
});
