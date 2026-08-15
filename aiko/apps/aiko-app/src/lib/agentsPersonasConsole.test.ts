import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_NAMES } from "./agentsCatalog";
import {
  buildAgentsConsoleEntries,
  buildPersonasConsoleEntries,
  filterAgentCatalog,
  filterPersonaCatalog,
  flattenGroupedAgents,
  groupAgentCatalog,
  listPersonaNamesFromFiles,
  normalizeAgentsConsoleSource,
  personaExtensionOk,
  personaFileNameOk,
  resolveAgentsConsoleEmptyState,
  resolvePreferredAgentLabel,
  type AgentsConsoleEntry,
} from "./agentsPersonasConsole";

const sample: AgentsConsoleEntry[] = [
  {
    name: "explore",
    source: "builtin",
    path: null,
    description: "Built-in explore",
  },
  {
    name: "custom",
    source: "user",
    path: "/home/u/.aiko/agents/custom.md",
    description: "My custom agent",
  },
  {
    name: "proj-review",
    source: "project",
    path: "/repo/.aiko/agents/proj-review.md",
  },
  {
    name: "explore",
    source: "project",
    path: "/repo/.aiko/agents/explore.md",
    description: "Project override",
  },
];

describe("normalizeAgentsConsoleSource", () => {
  it("maps bundled and built-in aliases to builtin", () => {
    expect(normalizeAgentsConsoleSource("bundled")).toBe("builtin");
    expect(normalizeAgentsConsoleSource("built-in")).toBe("builtin");
    expect(normalizeAgentsConsoleSource("builtin")).toBe("builtin");
    expect(normalizeAgentsConsoleSource("user")).toBe("user");
    expect(normalizeAgentsConsoleSource("project")).toBe("project");
    expect(normalizeAgentsConsoleSource("")).toBe("builtin");
  });
});

describe("groupAgentCatalog", () => {
  it("buckets by source and sorts names within groups", () => {
    const g = groupAgentCatalog(sample);
    expect(g.project.map((e) => e.name)).toEqual(["explore", "proj-review"]);
    expect(g.user.map((e) => e.name)).toEqual(["custom"]);
    expect(g.builtin.map((e) => e.name)).toEqual(["explore"]);
  });

  it("folds bundled into builtin", () => {
    const g = groupAgentCatalog([
      { name: "plan", source: "builtin", rawSource: "bundled" },
    ]);
    expect(g.builtin).toHaveLength(1);
    expect(g.builtin[0].rawSource).toBe("bundled");
  });

  it("ignores empty names", () => {
    const g = groupAgentCatalog([{ name: "  ", source: "user" }]);
    expect(g.user).toEqual([]);
  });
});

describe("filterAgentCatalog", () => {
  it("returns all on empty query", () => {
    expect(filterAgentCatalog(sample, "")).toHaveLength(sample.length);
    expect(filterAgentCatalog(sample, "   ")).toHaveLength(sample.length);
    expect(filterAgentCatalog(sample, null)).toHaveLength(sample.length);
  });

  it("matches name, source, path, description (case-insensitive)", () => {
    expect(filterAgentCatalog(sample, "CUSTOM").map((e) => e.name)).toEqual([
      "custom",
    ]);
    expect(filterAgentCatalog(sample, "project").map((e) => e.name)).toEqual([
      "proj-review",
      "explore",
    ]);
    expect(
      filterAgentCatalog(sample, "/repo/.aiko").map((e) => e.name),
    ).toEqual(["proj-review", "explore"]);
    expect(filterAgentCatalog(sample, "override").map((e) => e.name)).toEqual([
      "explore",
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterAgentCatalog(sample, "zzz-no-hit")).toEqual([]);
  });
});

describe("filterPersonaCatalog", () => {
  it("filters persona rows by name/path", () => {
    const personas = [
      { name: "reviewer", source: "user", path: "/h/.aiko/personas/reviewer.toml" },
      { name: "thorough", source: "project", path: "/p/.aiko/personas/thorough.md" },
    ];
    expect(filterPersonaCatalog(personas, "toml").map((p) => p.name)).toEqual([
      "reviewer",
    ]);
  });
});

describe("resolveAgentsConsoleEmptyState", () => {
  it("host_only when desktop host is unavailable", () => {
    expect(
      resolveAgentsConsoleEmptyState({
        hostAvailable: false,
        totalCount: 3,
        filteredCount: 3,
      }),
    ).toBe("host_only");
  });

  it("no_project when project-scoped without project", () => {
    expect(
      resolveAgentsConsoleEmptyState({
        hostAvailable: true,
        totalCount: 0,
        filteredCount: 0,
        projectScopeWithoutProject: true,
      }),
    ).toBe("no_project");
  });

  it("filter when query excludes all rows", () => {
    expect(
      resolveAgentsConsoleEmptyState({
        hostAvailable: true,
        totalCount: 5,
        filteredCount: 0,
        query: "nope",
      }),
    ).toBe("filter");
  });

  it("empty when nothing discovered", () => {
    expect(
      resolveAgentsConsoleEmptyState({
        hostAvailable: true,
        totalCount: 0,
        filteredCount: 0,
      }),
    ).toBe("empty");
  });

  it("null when there is content", () => {
    expect(
      resolveAgentsConsoleEmptyState({
        hostAvailable: true,
        totalCount: 2,
        filteredCount: 1,
        query: "x",
      }),
    ).toBeNull();
  });
});

describe("personaFileNameOk / listPersonaNamesFromFiles", () => {
  it("accepts persona toml and markdown only", () => {
    expect(personaFileNameOk("reviewer.toml")).toBe(true);
    expect(personaFileNameOk("thorough.md")).toBe(true);
    expect(personaFileNameOk("x.markdown")).toBe(true);
    expect(personaFileNameOk("notes.txt")).toBe(false);
    expect(personaFileNameOk(".hidden.toml")).toBe(false);
    expect(personaFileNameOk(null)).toBe(false);
  });

  it("personaExtensionOk mirrors extensions", () => {
    expect(personaExtensionOk("a.toml")).toBe(true);
    expect(personaExtensionOk("a.json")).toBe(false);
  });

  it("lists unique sorted stems without inventing names", () => {
    expect(
      listPersonaNamesFromFiles([
        "reviewer.toml",
        "Thorough.md",
        "readme.txt",
        "reviewer.toml",
        ".skip.toml",
      ]),
    ).toEqual(["reviewer", "Thorough"]);
  });

  it("empty host list stays empty", () => {
    expect(listPersonaNamesFromFiles([])).toEqual([]);
    expect(listPersonaNamesFromFiles(null)).toEqual([]);
  });
});

describe("resolvePreferredAgentLabel", () => {
  const entries = [
    { name: "explore", source: "builtin" },
    { name: "custom", source: "user" },
  ];

  it("default for empty / sentinel", () => {
    expect(resolvePreferredAgentLabel("", entries).kind).toBe("default");
    expect(resolvePreferredAgentLabel("default", entries).kind).toBe("default");
    expect(resolvePreferredAgentLabel(null, entries).name).toBeNull();
  });

  it("matched when in catalog", () => {
    const r = resolvePreferredAgentLabel("  Explore  ", entries);
    expect(r.kind).toBe("matched");
    expect(r.name).toBe("explore");
    expect(r.source).toBe("builtin");
    expect(r.display).toContain("explore");
  });

  it("missing when preferred not in catalog", () => {
    const r = resolvePreferredAgentLabel("ghost-agent", entries);
    expect(r).toEqual({
      kind: "missing",
      name: "ghost-agent",
      source: null,
      display: "ghost-agent · not in catalog",
    });
  });
});

describe("buildAgentsConsoleEntries", () => {
  it("includes built-ins by default", () => {
    const rows = buildAgentsConsoleEntries({});
    expect(rows.map((r) => r.name).sort()).toEqual(
      [...BUILTIN_AGENT_NAMES].sort(),
    );
    expect(rows.every((r) => r.source === "builtin")).toBe(true);
  });

  it("prefers project discovery over user over builtin", () => {
    const rows = buildAgentsConsoleEntries({
      catalog: [
        { name: "explore", source: "builtin" },
        { name: "custom", source: "user", path: "/u/custom.md" },
      ],
      discovered: [
        {
          name: "explore",
          scope: "project",
          path: "/p/.aiko/agents/explore.md",
          description: "proj",
        },
        { name: "custom", scope: "user", path: "/u/.aiko/agents/custom.md" },
      ],
    });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.explore.source).toBe("project");
    expect(byName.explore.path).toBe("/p/.aiko/agents/explore.md");
    expect(byName.custom.source).toBe("user");
    expect(byName.plan.source).toBe("builtin");
  });
});

describe("buildPersonasConsoleEntries", () => {
  it("never invents personas — only maps discovered rows", () => {
    expect(buildPersonasConsoleEntries([])).toEqual([]);
    expect(buildPersonasConsoleEntries(null)).toEqual([]);
    const rows = buildPersonasConsoleEntries([
      { name: "reviewer", scope: "user", path: "/h/personas/reviewer.toml" },
      { name: "thorough", scope: "bundled", path: "/h/bundled/personas/thorough.toml" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["reviewer", "thorough"]);
    expect(rows[1].source).toBe("builtin");
  });
});

describe("flattenGroupedAgents", () => {
  it("orders project → user → builtin", () => {
    const flat = flattenGroupedAgents(
      groupAgentCatalog([
        { name: "b", source: "builtin" },
        { name: "u", source: "user" },
        { name: "p", source: "project" },
      ]),
    );
    expect(flat.map((e) => e.name)).toEqual(["p", "u", "b"]);
  });
});
