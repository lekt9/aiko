import { describe, expect, it } from "vitest";
import {
  SESSION_EXPORT_FORMATS,
  buildSessionExportFormatRows,
  canSessionExportActions,
  classifySessionExportError,
  defaultSessionExportOptions,
  estimateSessionExportSizeClass,
  estimateUtf8ByteLength,
  formatSessionExportBytes,
  isSessionExportFormat,
  isSessionExportJournalEmpty,
  resolveSessionExportSoftFail,
  sanitizeSessionExportBasename,
  sanitizeSessionExportSlug,
  sessionExportFormatExt,
  sessionExportFormatLabelKey,
  sessionExportFormatNameKey,
  sessionExportSafeFilename,
  sessionExportSizeClass,
  sessionExportSizeClassLabelKey,
  sessionExportSoftFailMessageKey,
  sessionExportSoftFailSilent,
} from "./sessionExportPro";

describe("SESSION_EXPORT_FORMATS / isSessionExportFormat", () => {
  it("lists md/txt/json/html only (no NDJSON)", () => {
    expect([...SESSION_EXPORT_FORMATS]).toEqual([
      "markdown",
      "plain",
      "json",
      "html",
    ]);
    expect(isSessionExportFormat("markdown")).toBe(true);
    expect(isSessionExportFormat("ndjson")).toBe(false);
    expect(isSessionExportFormat("")).toBe(false);
    expect(isSessionExportFormat(null)).toBe(false);
  });
});

describe("format labels / ext", () => {
  it("maps formats to menu label keys, name keys, and extensions", () => {
    expect(sessionExportFormatLabelKey("markdown")).toBe("session.exportMd");
    expect(sessionExportFormatLabelKey("plain")).toBe("session.exportPlain");
    expect(sessionExportFormatLabelKey("json")).toBe("session.exportJson");
    expect(sessionExportFormatLabelKey("html")).toBe("session.exportHtml");

    expect(sessionExportFormatNameKey("markdown")).toBe(
      "session.exportFormat.markdown",
    );
    expect(sessionExportFormatNameKey("plain")).toBe(
      "session.exportFormat.plain",
    );
    expect(sessionExportFormatNameKey("json")).toBe(
      "session.exportFormat.json",
    );
    expect(sessionExportFormatNameKey("html")).toBe(
      "session.exportFormat.html",
    );

    expect(sessionExportFormatExt("markdown")).toBe(".md");
    expect(sessionExportFormatExt("plain")).toBe(".txt");
    expect(sessionExportFormatExt("json")).toBe(".json");
    expect(sessionExportFormatExt("html")).toBe(".html");
  });
});

describe("defaultSessionExportOptions", () => {
  it("matches App defaults per format", () => {
    expect(defaultSessionExportOptions("json")).toEqual({
      includeThoughts: false,
      includeToolSummary: false,
    });
    expect(defaultSessionExportOptions("markdown").includeToolSummary).toBe(
      true,
    );
    expect(defaultSessionExportOptions("plain").includeThoughts).toBe(true);
    expect(defaultSessionExportOptions("html").includeToolSummary).toBe(true);
  });
});

describe("isSessionExportJournalEmpty", () => {
  it("treats null / empty / blank shells as empty", () => {
    expect(isSessionExportJournalEmpty(null)).toBe(true);
    expect(isSessionExportJournalEmpty([])).toBe(true);
    expect(
      isSessionExportJournalEmpty([
        { role: "user", content: "   " },
        { role: "assistant", content: "", thought: "  " },
      ]),
    ).toBe(true);
  });

  it("is not empty when user/assistant body exists", () => {
    expect(
      isSessionExportJournalEmpty([
        { role: "user", content: "hello" },
      ]),
    ).toBe(false);
  });

  it("counts thoughts when thoughts are included", () => {
    expect(
      isSessionExportJournalEmpty(
        [{ role: "assistant", content: "", thought: "plan" }],
        { format: "markdown" },
      ),
    ).toBe(false);
    expect(
      isSessionExportJournalEmpty(
        [{ role: "assistant", content: "", thought: "plan" }],
        {
          format: "markdown",
          options: { includeThoughts: false, includeToolSummary: false },
        },
      ),
    ).toBe(true);
  });

  it("tool-only journal is empty when tools omitted; soft-full when included", () => {
    const tools = [
      {
        role: "tool" as const,
        content: "tool_step|bash|completed|ok",
        marker: "tool_step",
      },
    ];
    expect(
      isSessionExportJournalEmpty(tools, {
        format: "markdown",
        options: { includeToolSummary: false },
      }),
    ).toBe(true);
    expect(
      isSessionExportJournalEmpty(tools, {
        format: "markdown",
        options: { includeToolSummary: true },
      }),
    ).toBe(false);
    // markdown default includes tools
    expect(isSessionExportJournalEmpty(tools, { format: "markdown" })).toBe(
      false,
    );
    // json default omits tools
    expect(isSessionExportJournalEmpty(tools, { format: "json" })).toBe(true);
  });

  it("json ignores thoughts and non user/assistant roles", () => {
    expect(
      isSessionExportJournalEmpty(
        [{ role: "assistant", content: "", thought: "only-thought" }],
        { format: "json" },
      ),
    ).toBe(true);
    expect(
      isSessionExportJournalEmpty(
        [{ role: "system", content: "sys" }],
        { format: "json" },
      ),
    ).toBe(true);
    expect(
      isSessionExportJournalEmpty(
        [{ role: "user", content: "hi" }],
        { format: "json" },
      ),
    ).toBe(false);
  });
});

describe("size class / bytes", () => {
  it("classifies byte lengths honestly", () => {
    expect(sessionExportSizeClass(0)).toBe("empty");
    expect(sessionExportSizeClass(-1)).toBe("empty");
    expect(sessionExportSizeClass(null)).toBe("empty");
    expect(sessionExportSizeClass(100)).toBe("tiny");
    expect(sessionExportSizeClass(3 * 1024)).toBe("small");
    expect(sessionExportSizeClass(40 * 1024)).toBe("medium");
    expect(sessionExportSizeClass(300 * 1024)).toBe("large");
    expect(sessionExportSizeClass(3 * 1024 * 1024)).toBe("huge");
  });

  it("maps size class to i18n keys", () => {
    expect(sessionExportSizeClassLabelKey("empty")).toBe(
      "session.exportSize.empty",
    );
    expect(sessionExportSizeClassLabelKey("huge")).toBe(
      "session.exportSize.huge",
    );
  });

  it("estimates UTF-8 and body size class", () => {
    expect(estimateUtf8ByteLength("")).toBe(0);
    expect(estimateUtf8ByteLength("abc")).toBe(3);
    // CJK is multi-byte
    expect(estimateUtf8ByteLength("中")).toBeGreaterThan(1);

    const empty = estimateSessionExportSizeClass("");
    expect(empty.empty).toBe(true);
    expect(empty.sizeClass).toBe("empty");

    const small = estimateSessionExportSizeClass("x".repeat(100));
    expect(small.empty).toBe(false);
    expect(small.sizeClass).toBe("tiny");
    expect(small.byteLength).toBe(100);
  });

  it("formatSessionExportBytes hides empty", () => {
    expect(formatSessionExportBytes(0)).toBeNull();
    expect(formatSessionExportBytes(null)).toBeNull();
    expect(formatSessionExportBytes(512)).toBe("512 B");
    expect(formatSessionExportBytes(2048)).toMatch(/KB/);
  });
});

describe("soft-fail classification", () => {
  it("maps empty / no_target / write / load / clipboard / cancel", () => {
    const empty = new Error("empty");
    (empty as Error & { code?: string }).code = "empty";
    expect(classifySessionExportError(empty)).toBe("empty");
    expect(classifySessionExportError(new Error("nothing to export"))).toBe(
      "empty",
    );
    expect(classifySessionExportError(new Error("no target"))).toBe(
      "no_target",
    );
    expect(classifySessionExportError(new Error("write failed"))).toBe(
      "write_failed",
    );
    expect(classifySessionExportError(new Error("save failed"))).toBe(
      "write_failed",
    );
    expect(classifySessionExportError(new Error("session not found"))).toBe(
      "load_failed",
    );
    expect(classifySessionExportError(new Error("clipboard blocked"))).toBe(
      "clipboard",
    );
    expect(classifySessionExportError(new Error("User cancelled"))).toBe(
      "cancelled",
    );
  });

  it("maps message keys; cancel is silent", () => {
    expect(sessionExportSoftFailMessageKey("empty")).toBe(
      "session.exportEmpty",
    );
    expect(sessionExportSoftFailMessageKey("write_failed")).toBe(
      "session.exportWriteFail",
    );
    expect(sessionExportSoftFailMessageKey("load_failed")).toBe(
      "session.exportLoadFail",
    );
    expect(sessionExportSoftFailMessageKey("clipboard")).toBe(
      "session.exportClipboardFail",
    );
    expect(sessionExportSoftFailMessageKey("no_target")).toBe(
      "session.exportNoTarget",
    );
    expect(sessionExportSoftFailMessageKey("other")).toBe("session.exportFail");
    expect(sessionExportSoftFailSilent("cancelled")).toBe(true);
    expect(sessionExportSoftFailSilent("empty")).toBe(false);
  });

  it("resolve hides detail for known kinds", () => {
    const r = resolveSessionExportSoftFail(new Error("empty"));
    expect(r.kind).toBe("empty");
    expect(r.messageKey).toBe("session.exportEmpty");
    expect(r.detail).toBe("");
    const other = resolveSessionExportSoftFail(new Error("host xyz boom"));
    expect(other.kind).toBe("other");
    expect(other.detail).toContain("host xyz");
  });
});

describe("filename sanitize", () => {
  it("slugifies title and strips path / control chars", () => {
    expect(sanitizeSessionExportSlug("Fix Doctor Reset!")).toBe(
      "fix-doctor-reset",
    );
    expect(sanitizeSessionExportSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeSessionExportSlug("a\\b:c*d?e\"f<g>h|i")).toBe(
      "a-b-c-d-e-f-g-h-i",
    );
    expect(sanitizeSessionExportSlug("")).toBe("session");
    expect(sanitizeSessionExportSlug("   ")).toBe("session");
    expect(sanitizeSessionExportSlug("CON")).toBe("session-con");
    expect(sanitizeSessionExportSlug("你好 世界")).toBe("你好-世界");
  });

  it("builds basename and safe filenames", () => {
    expect(sanitizeSessionExportBasename("Fix Doctor!", "abcdef12-xxxx")).toBe(
      "aiko-fix-doctor-abcdef12",
    );
    expect(sanitizeSessionExportBasename("", null)).toBe("aiko-session");
    expect(sessionExportSafeFilename("markdown", "Hi!", "abcdef12")).toMatch(
      /\.md$/,
    );
    expect(sessionExportSafeFilename("json", "../x", "id")).toMatch(
      /^aiko-.*\.json$/,
    );
    expect(sessionExportSafeFilename("json", "../x", "id")).not.toContain(
      "..",
    );
  });
});

describe("canSessionExportActions / format rows", () => {
  it("disables when no target or known empty", () => {
    expect(canSessionExportActions({ hasTarget: false })).toBe(false);
    expect(
      canSessionExportActions({ hasTarget: true, journalEmpty: true }),
    ).toBe(false);
    expect(
      canSessionExportActions({ hasTarget: true, journalEmpty: false }),
    ).toBe(true);
    expect(
      canSessionExportActions({ hasTarget: true, journalEmpty: null }),
    ).toBe(true);
    expect(
      canSessionExportActions({
        hasTarget: true,
        journalEmpty: false,
        busy: true,
      }),
    ).toBe(false);
  });

  it("builds honest format rows for picker / submenu", () => {
    const ok = buildSessionExportFormatRows({
      hasTarget: true,
      journalEmpty: false,
    });
    expect(ok).toHaveLength(4);
    expect(ok.every((r) => !r.disabled)).toBe(true);
    expect(ok.map((r) => r.ext)).toEqual([".md", ".txt", ".json", ".html"]);

    const empty = buildSessionExportFormatRows({
      hasTarget: true,
      journalEmpty: true,
    });
    expect(empty.every((r) => r.disabled)).toBe(true);
    expect(empty[0]?.disabledReasonKey).toBe("session.exportEmpty");

    const noTarget = buildSessionExportFormatRows({ hasTarget: false });
    expect(noTarget.every((r) => r.disabled)).toBe(true);
    expect(noTarget[0]?.disabledReasonKey).toBe("session.exportNoTarget");
  });
});
