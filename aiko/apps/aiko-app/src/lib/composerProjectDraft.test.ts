import { describe, expect, it } from "vitest";
import {
  clearComposerProjectDraft,
  COMPOSER_PROJECT_DRAFTS_STORAGE_KEY,
  emptyComposerProjectDraft,
  isComposerProjectDraftEmpty,
  loadAllComposerProjectDrafts,
  loadComposerProjectDraft,
  ORPHAN_PROJECT_DRAFT_KEY,
  projectDraftKey,
  saveComposerProjectDraft,
  type ComposerProjectDraftStorage,
} from "./composerProjectDraft";

function memoryStorage(seed: Record<string, string> = {}): ComposerProjectDraftStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe("projectDraftKey", () => {
  it("maps empty / null to orphan", () => {
    expect(projectDraftKey(null)).toBe(ORPHAN_PROJECT_DRAFT_KEY);
    expect(projectDraftKey(undefined)).toBe(ORPHAN_PROJECT_DRAFT_KEY);
    expect(projectDraftKey("")).toBe(ORPHAN_PROJECT_DRAFT_KEY);
    expect(projectDraftKey("  ")).toBe(ORPHAN_PROJECT_DRAFT_KEY);
  });

  it("trims project ids", () => {
    expect(projectDraftKey(" abc ")).toBe("abc");
  });
});

describe("isComposerProjectDraftEmpty", () => {
  it("treats whitespace-only as empty", () => {
    expect(isComposerProjectDraftEmpty(null)).toBe(true);
    expect(
      isComposerProjectDraftEmpty({
        text: "  \n  ",
        attachments: [],
        updatedAt: 1,
      }),
    ).toBe(true);
  });

  it("keeps skill-only or attachment drafts", () => {
    expect(
      isComposerProjectDraftEmpty({
        text: "[[skill:foo]]",
        attachments: [],
        updatedAt: 1,
      }),
    ).toBe(false);
    expect(
      isComposerProjectDraftEmpty({
        text: "",
        attachments: [{ path: "/a.png", name: "a.png", isDir: false }],
        updatedAt: 1,
      }),
    ).toBe(false);
  });
});

describe("save / load / clear", () => {
  it("round-trips per project and orphan", () => {
    const s = memoryStorage();
    saveComposerProjectDraft(
      "p1",
      { text: "hello p1", attachments: [], goalMode: true },
      s,
    );
    saveComposerProjectDraft(
      ORPHAN_PROJECT_DRAFT_KEY,
      {
        text: "orphan body",
        attachments: [{ path: "/x.md", name: "x.md", isDir: false }],
      },
      s,
    );

    expect(loadComposerProjectDraft("p1", s)?.text).toBe("hello p1");
    expect(loadComposerProjectDraft("p1", s)?.goalMode).toBe(true);
    expect(loadComposerProjectDraft(ORPHAN_PROJECT_DRAFT_KEY, s)?.text).toBe(
      "orphan body",
    );
    expect(
      loadComposerProjectDraft(ORPHAN_PROJECT_DRAFT_KEY, s)?.attachments,
    ).toHaveLength(1);
    expect(loadComposerProjectDraft("missing", s)).toBeNull();
  });

  it("clears empty saves and clearComposerProjectDraft", () => {
    const s = memoryStorage();
    saveComposerProjectDraft("p1", { text: "keep" }, s);
    saveComposerProjectDraft("p1", { text: "   " }, s);
    expect(loadComposerProjectDraft("p1", s)).toBeNull();

    saveComposerProjectDraft("p2", { text: "x" }, s);
    clearComposerProjectDraft("p2", s);
    expect(loadComposerProjectDraft("p2", s)).toBeNull();
  });

  it("ignores corrupt storage", () => {
    const s = memoryStorage({
      [COMPOSER_PROJECT_DRAFTS_STORAGE_KEY]: "{not-json",
    });
    expect(loadAllComposerProjectDrafts(s)).toEqual({});
  });

  it("emptyComposerProjectDraft is empty", () => {
    expect(isComposerProjectDraftEmpty(emptyComposerProjectDraft())).toBe(
      true,
    );
  });
});
