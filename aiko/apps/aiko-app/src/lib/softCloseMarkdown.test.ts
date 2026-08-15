import { describe, expect, it } from "vitest";
import { softCloseMarkdown } from "./softCloseMarkdown";

describe("softCloseMarkdown", () => {
  it("returns source unchanged when not streaming", () => {
    expect(softCloseMarkdown("**partial", false)).toBe("**partial");
    expect(softCloseMarkdown("```js\ncode", false)).toBe("```js\ncode");
  });

  it("closes incomplete bold / italic / strike / inline code while streaming", () => {
    expect(softCloseMarkdown("hello **world", true)).toBe("hello **world**");
    expect(softCloseMarkdown("hello *world", true)).toBe("hello *world*");
    expect(softCloseMarkdown("~~strike", true)).toBe("~~strike~~");
    expect(softCloseMarkdown("`code", true)).toBe("`code`");
  });

  it("closes an open fence while streaming", () => {
    expect(softCloseMarkdown("```ts\nconst x = 1", true)).toBe(
      "```ts\nconst x = 1\n```",
    );
  });

  it("does not double-close a finished fence", () => {
    expect(softCloseMarkdown("```ts\nconst x = 1\n```", true)).toBe(
      "```ts\nconst x = 1\n```",
    );
  });

  it("does not close markers inside a fenced code block", () => {
    const src = "```js\nconst s = '**not bold'\n";
    const out = softCloseMarkdown(src, true);
    expect(out.startsWith("```js\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    // Interior stays raw; only trailing fence is added.
    expect(out).toContain("const s = '**not bold'");
    expect(out).not.toContain("'**not bold'**");
  });

  it("leaves balanced markdown alone", () => {
    expect(softCloseMarkdown("**ok** and *fine*", true)).toBe(
      "**ok** and *fine*",
    );
    expect(softCloseMarkdown("`x` and ~~y~~", true)).toBe("`x` and ~~y~~");
  });

  it("returns empty as-is", () => {
    expect(softCloseMarkdown("", true)).toBe("");
  });
});
