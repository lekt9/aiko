import { describe, expect, it } from "vitest";
import {
  buildSkillEditRoots,
  isPathUnderSkillRoot,
  isSkillEditable,
  isSkillPathAllowed,
  normalizeSkillFsPath,
  resolveSkillMdPath,
  skillPathHasTraversal,
} from "./skillEditPath";

describe("normalizeSkillFsPath", () => {
  it("normalizes backslashes and trailing slash", () => {
    // Avoid trailing `\` before a template close (escapes the backtick).
    expect(normalizeSkillFsPath("C:\\Users\\me\\.aiko\\skills\\")).toBe(
      "C:/Users/me/.aiko/skills",
    );
    expect(normalizeSkillFsPath("/tmp/skills//a/")).toBe("/tmp/skills/a");
  });

  it("trims whitespace", () => {
    expect(normalizeSkillFsPath("  /home/u/.aiko/skills  ")).toBe(
      "/home/u/.aiko/skills",
    );
  });
});

describe("skillPathHasTraversal", () => {
  it("rejects parent segments and empty", () => {
    expect(skillPathHasTraversal("../etc/passwd")).toBe(true);
    expect(skillPathHasTraversal("/skills/../secret")).toBe(true);
    expect(skillPathHasTraversal("")).toBe(true);
    expect(skillPathHasTraversal("/skills/./x")).toBe(true);
  });

  it("allows normal absolute skill paths", () => {
    expect(skillPathHasTraversal("/Users/me/.aiko/skills/help/SKILL.md")).toBe(
      false,
    );
    expect(skillPathHasTraversal("C:/Users/me/.aiko/skills/help/SKILL.md")).toBe(
      false,
    );
  });
});

describe("isPathUnderSkillRoot", () => {
  it("matches descendants and equality", () => {
    expect(
      isPathUnderSkillRoot(
        "/Users/me/.aiko/skills/help/SKILL.md",
        "/Users/me/.aiko/skills",
      ),
    ).toBe(true);
    expect(
      isPathUnderSkillRoot("/Users/me/.aiko/skills", "/Users/me/.aiko/skills"),
    ).toBe(true);
  });

  it("does not match path prefix false positives", () => {
    expect(
      isPathUnderSkillRoot("/Users/me/.aiko/skills-evil/x", "/Users/me/.aiko/skills"),
    ).toBe(false);
    expect(isPathUnderSkillRoot("/foo/bar", "/foobar")).toBe(false);
  });

  it("blocks traversal", () => {
    expect(
      isPathUnderSkillRoot(
        "/Users/me/.aiko/skills/../secrets",
        "/Users/me/.aiko/skills",
      ),
    ).toBe(false);
  });
});

describe("buildSkillEditRoots", () => {
  it("builds user, agent-home, and project roots", () => {
    const roots = buildSkillEditRoots({
      userHome: "/Users/me",
      agentHome: "/Users/me/Library/Application Support/ai.aiko.desktop/agent-home",
      projectPath: "/Users/me/Code/demo",
    });
    expect(roots).toEqual([
      "/Users/me/.aiko/skills",
      "/Users/me/Library/Application Support/ai.aiko.desktop/agent-home/skills",
      "/Users/me/Code/demo/.aiko/skills",
    ]);
  });

  it("skips empty and dedupes", () => {
    expect(buildSkillEditRoots({})).toEqual([]);
    const roots = buildSkillEditRoots({
      userHome: "/u",
      agentHome: "/u/.aiko", // would yield /u/.aiko/skills
      projectPath: null,
    });
    // userHome → /u/.aiko/skills, agentHome /u/.aiko → /u/.aiko/skills (deduped)
    expect(roots).toEqual(["/u/.aiko/skills"]);
  });
});

describe("resolveSkillMdPath", () => {
  it("keeps SKILL.md paths", () => {
    expect(resolveSkillMdPath("/home/u/.aiko/skills/help/SKILL.md")).toBe(
      "/home/u/.aiko/skills/help/SKILL.md",
    );
  });

  it("appends SKILL.md for skill directories", () => {
    expect(resolveSkillMdPath("/home/u/.aiko/skills/help")).toBe(
      "/home/u/.aiko/skills/help/SKILL.md",
    );
  });

  it("rejects traversal", () => {
    expect(resolveSkillMdPath("/home/u/.aiko/skills/../x")).toBeNull();
    expect(resolveSkillMdPath("")).toBeNull();
  });
});

describe("isSkillPathAllowed", () => {
  const roots = [
    "/Users/me/.aiko/skills",
    "/Users/me/.aiko-app/agent-home/skills",
    "/Users/me/Code/demo/.aiko/skills",
  ];

  it("allows user skill SKILL.md", () => {
    expect(
      isSkillPathAllowed("/Users/me/.aiko/skills/help/SKILL.md", roots),
    ).toBe(true);
    expect(isSkillPathAllowed("/Users/me/.aiko/skills/help", roots)).toBe(true);
  });

  it("allows agent-home and project skills", () => {
    expect(
      isSkillPathAllowed(
        "/Users/me/.aiko-app/agent-home/skills/my-skill/SKILL.md",
        roots,
      ),
    ).toBe(true);
    expect(
      isSkillPathAllowed(
        "/Users/me/Code/demo/.aiko/skills/local/SKILL.md",
        roots,
      ),
    ).toBe(true);
  });

  it("blocks bundled / plugin / outside roots", () => {
    expect(
      isSkillPathAllowed("/Users/me/.aiko/bundled/skills/pdf/SKILL.md", roots),
    ).toBe(false);
    expect(
      isSkillPathAllowed(
        "/Users/me/.aiko/plugins/foo/skills/bar/SKILL.md",
        roots,
      ),
    ).toBe(false);
    expect(isSkillPathAllowed("/etc/passwd", roots)).toBe(false);
    expect(isSkillPathAllowed("/Users/me/.aiko/skills/../.ssh/id_rsa", roots)).toBe(
      false,
    );
  });

  it("blocks nested paths deeper than skill/SKILL.md", () => {
    expect(
      isSkillPathAllowed(
        "/Users/me/.aiko/skills/help/nested/SKILL.md",
        roots,
      ),
    ).toBe(false);
  });

  it("blocks empty roots", () => {
    expect(
      isSkillPathAllowed("/Users/me/.aiko/skills/help/SKILL.md", []),
    ).toBe(false);
  });
});

describe("isSkillEditable", () => {
  const roots = ["/Users/me/.aiko/skills"];

  it("requires path under roots", () => {
    expect(
      isSkillEditable(
        { path: "/Users/me/.aiko/skills/help/SKILL.md" },
        roots,
      ),
    ).toBe(true);
    expect(isSkillEditable({ path: null }, roots)).toBe(false);
    expect(isSkillEditable({ path: "" }, roots)).toBe(false);
    expect(
      isSkillEditable(
        { path: "/Users/me/.aiko/bundled/skills/x/SKILL.md" },
        roots,
      ),
    ).toBe(false);
  });
});
