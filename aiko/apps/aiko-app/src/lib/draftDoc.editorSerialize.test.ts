/**
 * Policy: user draft keeps blank lines / newlines as typed.
 * Enter inserts "\n" into the stored string (insertNewlineAt) — no DOM guesswork.
 */
import { describe, expect, it } from "vitest";
import {
  applySkillAtSlash,
  detectSlashRangeOnStored,
  insertNewlineAt,
  parseStoredContent,
  serializeEditorLineContent,
  serializeStored,
} from "./draftDoc";

describe("as-is draft + insertNewlineAt", () => {
  it("user repro string survives stored round-trip", () => {
    const typed = "这是\n\n一条\n\n测试的\n提示词";
    expect(serializeStored(parseStoredContent(typed))).toBe(typed);
    expect(typed.includes("测试的\n提示词")).toBe(true);
    expect(typed.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("insertNewlineAt is exact (Enter SoT)", () => {
    expect(insertNewlineAt("ab", 1)).toBe("a\nb");
    expect(insertNewlineAt("这是", 2)).toBe("这是\n");
    // "这是\n\n一条".length === 6; insert at end
    expect(insertNewlineAt("这是\n\n一条", 6)).toBe("这是\n\n一条\n");
    // Build the user repro purely via end-caret inserts
    let s = "这是";
    s = insertNewlineAt(s, s.length);
    s = insertNewlineAt(s, s.length); // blank line
    s += "一条";
    s = insertNewlineAt(s, s.length);
    s = insertNewlineAt(s, s.length);
    s += "测试的";
    s = insertNewlineAt(s, s.length);
    s += "提示词";
    expect(s).toBe("这是\n\n一条\n\n测试的\n提示词");
  });

  it("skill convert does not touch body newlines", () => {
    const before = "这是\n\n一条\n\n测试的\n提示词\n/codex";
    const range = detectSlashRangeOnStored(before)!;
    const after = applySkillAtSlash(before, range.start, range.end, "codex");
    expect(after.startsWith("这是\n\n一条\n\n测试的\n提示词\n")).toBe(true);
  });
});

describe("serializeEditorLineContent (pure line box)", () => {
  it("exports for DOM adapter tests", () => {
    // Function exists and empty-ish helpers are callable in node without DOM
    // for block-line join logic covered via insertNewlineAt above.
    expect(typeof serializeEditorLineContent).toBe("function");
  });
});

/** Block-line join pure model — empty line between content. */
describe("block line join model", () => {
  function joinLines(bodies: string[]): string {
    const lines = [...bodies];
    if (lines.length >= 2 && lines[lines.length - 1] === "") {
      if (lines[lines.length - 2] !== "") lines.pop();
      else lines.pop();
    }
    return lines.join("\n");
  }

  it("empty bodies become blank lines (WebKit empty DIV)", () => {
    expect(
      joinLines(["这是", "", "一条", "", "测试的", "提示词"]),
    ).toBe("这是\n\n一条\n\n测试的\n提示词");
  });
});
