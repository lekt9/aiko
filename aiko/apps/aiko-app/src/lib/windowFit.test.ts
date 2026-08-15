import { afterEach, describe, expect, it, vi } from "vitest";
import { measureWorkbenchFitNeed } from "./windowFit";
import { MAIN_CHAT_MIN_WIDTH } from "./layout";

function rect(width: number): DOMRect {
  return {
    width,
    height: 100,
    top: 0,
    left: 0,
    bottom: 100,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function el(
  className: string,
  width: number,
): { classList: { contains: (c: string) => boolean }; getBoundingClientRect: () => DOMRect } {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  return {
    classList: {
      contains: (c: string) => classes.has(c),
    },
    getBoundingClientRect: () => rect(width),
  };
}

describe("measureWorkbenchFitNeed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when main is wide enough", () => {
    const map: Record<string, ReturnType<typeof el>> = {
      ".main": el("main", 500),
      ".sidebar": el("sidebar", 268),
      ".aside:not(.aside--hidden):not(.aside--collapsed)": el("aside", 400),
    };
    vi.stubGlobal("document", {
      querySelector: (sel: string) => map[sel] ?? null,
    });
    expect(measureWorkbenchFitNeed()).toBeNull();
  });

  it("sums panes when main is crushed", () => {
    const map: Record<string, ReturnType<typeof el>> = {
      ".main": el("main", 200),
      ".sidebar": el("sidebar", 268),
      ".aside:not(.aside--hidden):not(.aside--collapsed)": el("aside", 400),
    };
    vi.stubGlobal("document", {
      querySelector: (sel: string) => map[sel] ?? null,
    });
    expect(measureWorkbenchFitNeed()).toBe(268 + MAIN_CHAT_MIN_WIDTH + 400);
  });

  it("ignores hidden sidebar", () => {
    const map: Record<string, ReturnType<typeof el>> = {
      ".main": el("main", 180),
      ".sidebar": el("sidebar sidebar--hidden", 0),
    };
    vi.stubGlobal("document", {
      querySelector: (sel: string) => map[sel] ?? null,
    });
    expect(measureWorkbenchFitNeed()).toBe(MAIN_CHAT_MIN_WIDTH);
  });
});
