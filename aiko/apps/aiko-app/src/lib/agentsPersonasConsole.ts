/**
 * Pure helpers for Settings → General → Agent → Agents & Personas console.
 *
 * Aligns with CLI `/config-agents` discovery honesty:
 * - Built-in names + user/project/bundled definition files only
 * - Never invent installed personas from thin air
 * - Preferred agent label is honest when missing from the catalog
 *
 * No DOM / Tauri side effects.
 */

import {
  BUILTIN_AGENT_NAMES,
  normalizePreferredAgent,
} from "./agentsCatalog";
import {
  definitionNameFromFileName,
  isPersonaDefinitionFileName,
} from "./agentsDiscovery";

/** Group keys for the agents console (bundled folds into builtin). */
export type AgentsConsoleGroup = "builtin" | "user" | "project";

export type AgentsConsoleEntry = {
  name: string;
  /** Normalized group (bundled → builtin). */
  source: AgentsConsoleGroup;
  /** Raw source/scope string from host when present. */
  rawSource?: string | null;
  path?: string | null;
  description?: string | null;
};

export type PersonasConsoleEntry = {
  name: string;
  source: AgentsConsoleGroup;
  rawSource?: string | null;
  path?: string | null;
};

/** Empty-state kinds for the agents / personas list. */
export type AgentsConsoleEmptyKind =
  | "empty"
  | "filter"
  | "host_only"
  | "no_project";

export type PreferredAgentLabelKind = "default" | "matched" | "missing";

export type PreferredAgentLabel = {
  kind: PreferredAgentLabelKind;
  /** Normalized preferred name, or null when CLI default. */
  name: string | null;
  /** Catalog source when matched. */
  source: string | null;
  /** Short English fallback for tests / soft UI. */
  display: string;
};

const PERSONA_EXTS = new Set([".toml", ".md", ".markdown"]);

/** Map host scope/source strings into a console group. */
export function normalizeAgentsConsoleSource(
  raw: string | null | undefined,
): AgentsConsoleGroup {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "project":
      return "project";
    case "user":
      return "user";
    case "builtin":
    case "built-in":
    case "bundled":
    default:
      return "builtin";
  }
}

/** Scope sort: project → user → builtin. */
export function agentsConsoleSourceRank(
  source: string | null | undefined,
): number {
  switch (normalizeAgentsConsoleSource(source)) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "builtin":
    default:
      return 2;
  }
}

function sortBySourceThenName<T extends { name: string; source: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const sr =
      agentsConsoleSourceRank(a.source) - agentsConsoleSourceRank(b.source);
    if (sr !== 0) return sr;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Group catalog entries into builtin / user / project buckets.
 * Bundled folds into `builtin`. Order within each group is name A–Z.
 */
export function groupAgentCatalog(
  entries: readonly AgentsConsoleEntry[] | null | undefined,
): {
  builtin: AgentsConsoleEntry[];
  user: AgentsConsoleEntry[];
  project: AgentsConsoleEntry[];
} {
  const builtin: AgentsConsoleEntry[] = [];
  const user: AgentsConsoleEntry[] = [];
  const project: AgentsConsoleEntry[] = [];
  for (const e of entries ?? []) {
    const name = (e.name ?? "").trim();
    if (!name) continue;
    const source = normalizeAgentsConsoleSource(e.source ?? e.rawSource);
    const row: AgentsConsoleEntry = {
      name,
      source,
      rawSource: e.rawSource ?? e.source,
      path: e.path ?? null,
      description: e.description ?? null,
    };
    if (source === "project") project.push(row);
    else if (source === "user") user.push(row);
    else builtin.push(row);
  }
  const byName = (a: AgentsConsoleEntry, b: AgentsConsoleEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  builtin.sort(byName);
  user.sort(byName);
  project.sort(byName);
  return { builtin, user, project };
}

/**
 * Case-insensitive filter on name, source, path, and description.
 * Empty query returns a shallow copy (stable order preserved).
 */
export function filterAgentCatalog<
  T extends {
    name: string;
    source?: string | null;
    path?: string | null;
    description?: string | null;
  },
>(entries: readonly T[] | null | undefined, query?: string | null): T[] {
  const list = [...(entries ?? [])];
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => {
    const hay = [
      e.name,
      e.source ?? "",
      e.path ?? "",
      e.description ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Same filter semantics for persona rows. */
export function filterPersonaCatalog<
  T extends {
    name: string;
    source?: string | null;
    path?: string | null;
  },
>(entries: readonly T[] | null | undefined, query?: string | null): T[] {
  return filterAgentCatalog(entries, query);
}

/**
 * Resolve list empty presentation.
 * Returns `null` when there is content to render (caller handles loading).
 */
export function resolveAgentsConsoleEmptyState(input: {
  /** Desktop host (Tauri) available for discovery. */
  hostAvailable: boolean;
  /** Total discovered rows before filter. */
  totalCount: number;
  /** Rows after filter. */
  filteredCount: number;
  query?: string | null;
  /**
   * When true, the console is project-scoped and no workbench project is open.
   * Used for project-folder honesty (personas/agents project dir), not for
   * the full multi-scope list.
   */
  projectScopeWithoutProject?: boolean;
}): AgentsConsoleEmptyKind | null {
  if (!input.hostAvailable) return "host_only";
  if (input.projectScopeWithoutProject) return "no_project";
  const total = Math.max(0, Math.floor(Number(input.totalCount) || 0));
  const filtered = Math.max(0, Math.floor(Number(input.filteredCount) || 0));
  const q = (input.query ?? "").trim();
  if (total > 0 && filtered === 0 && q) return "filter";
  if (total === 0) return "empty";
  return null;
}

/**
 * True when a file name is a valid persona definition (`.toml` / `.md` / `.markdown`).
 * Never invents personas — only filesystem-discoverable names.
 */
export function personaFileNameOk(
  fileName: string | null | undefined,
): boolean {
  return isPersonaDefinitionFileName(fileName);
}

/**
 * List unique persona stems from bare file basenames (no host I/O).
 * Skips non-persona files, hidden names, and empty stems.
 */
export function listPersonaNamesFromFiles(
  fileNames: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of fileNames ?? []) {
    const base = (raw ?? "").trim().split(/[/\\]/).pop() ?? "";
    if (!personaFileNameOk(base)) continue;
    const name = definitionNameFromFileName(base);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return out;
}

/** Extension check used by tests / soft UI (mirrors discovery). */
export function personaExtensionOk(fileName: string | null | undefined): boolean {
  const base = (fileName ?? "").trim().split(/[/\\]/).pop() ?? "";
  if (!base || base.startsWith(".")) return false;
  const i = base.lastIndexOf(".");
  if (i <= 0) return false;
  return PERSONA_EXTS.has(base.slice(i).toLowerCase());
}

/**
 * Preferred agent honesty for the select / console status line.
 * - default: empty / sentinel → CLI default
 * - matched: name present in catalog (case-insensitive)
 * - missing: preferred set but not in discovered catalog
 */
export function resolvePreferredAgentLabel(
  preferred: string | null | undefined,
  entries:
    | readonly { name: string; source?: string | null }[]
    | null
    | undefined,
): PreferredAgentLabel {
  const name = normalizePreferredAgent(preferred);
  if (!name) {
    return {
      kind: "default",
      name: null,
      source: null,
      display: "Default (CLI)",
    };
  }
  const key = name.toLowerCase();
  const hit = (entries ?? []).find(
    (e) => (e.name ?? "").trim().toLowerCase() === key,
  );
  if (hit) {
    const source = (hit.source ?? "").trim() || null;
    return {
      kind: "matched",
      name: hit.name.trim() || name,
      source,
      display: source ? `${hit.name.trim()} · ${source}` : hit.name.trim(),
    };
  }
  return {
    kind: "missing",
    name,
    source: null,
    display: `${name} · not in catalog`,
  };
}

/**
 * Build console agent rows from preferred-agent catalog + filesystem discovery.
 * Same name may appear once: project > user > file bundled > catalog builtin.
 * Built-ins from {@link BUILTIN_AGENT_NAMES} are always present unless overridden.
 */
export function buildAgentsConsoleEntries(input: {
  catalog?: readonly {
    name: string;
    source?: string | null;
    path?: string | null;
    description?: string | null;
  }[] | null;
  discovered?: readonly {
    name: string;
    scope?: string | null;
    source?: string | null;
    path?: string | null;
    description?: string | null;
  }[] | null;
  builtins?: readonly string[] | null;
}): AgentsConsoleEntry[] {
  const byKey = new Map<string, AgentsConsoleEntry>();

  const builtins = input.builtins ?? BUILTIN_AGENT_NAMES;
  for (const n of builtins) {
    const name = (n ?? "").trim();
    if (!name) continue;
    byKey.set(name.toLowerCase(), {
      name,
      source: "builtin",
      rawSource: "builtin",
      path: null,
      description: null,
    });
  }

  for (const e of input.catalog ?? []) {
    const name = (e.name ?? "").trim();
    if (!name) continue;
    const source = normalizeAgentsConsoleSource(e.source);
    // Catalog may be lower priority than filesystem paths for user/project.
    const existing = byKey.get(name.toLowerCase());
    if (
      existing &&
      agentsConsoleSourceRank(existing.source) <
        agentsConsoleSourceRank(source)
    ) {
      continue;
    }
    byKey.set(name.toLowerCase(), {
      name,
      source,
      rawSource: e.source,
      path: e.path ?? existing?.path ?? null,
      description: existing?.description ?? null,
    });
  }

  for (const e of input.discovered ?? []) {
    const name = (e.name ?? "").trim();
    if (!name) continue;
    const raw = e.scope ?? e.source ?? "user";
    const source = normalizeAgentsConsoleSource(raw);
    byKey.set(name.toLowerCase(), {
      name,
      source,
      rawSource: raw,
      path: e.path ?? null,
      description: e.description ?? null,
    });
  }

  return sortBySourceThenName(Array.from(byKey.values()));
}

/**
 * Build persona console rows from host discovery only — never invent names.
 */
export function buildPersonasConsoleEntries(
  discovered:
    | readonly {
        name: string;
        scope?: string | null;
        source?: string | null;
        path?: string | null;
      }[]
    | null
    | undefined,
): PersonasConsoleEntry[] {
  const out: PersonasConsoleEntry[] = [];
  for (const e of discovered ?? []) {
    const name = (e.name ?? "").trim();
    if (!name) continue;
    const raw = e.scope ?? e.source ?? "user";
    out.push({
      name,
      source: normalizeAgentsConsoleSource(raw),
      rawSource: raw,
      path: e.path ?? null,
    });
  }
  return sortBySourceThenName(out);
}

/** Flatten grouped catalog back to a sorted list (project → user → builtin). */
export function flattenGroupedAgents(groups: {
  builtin: AgentsConsoleEntry[];
  user: AgentsConsoleEntry[];
  project: AgentsConsoleEntry[];
}): AgentsConsoleEntry[] {
  return [...groups.project, ...groups.user, ...groups.builtin];
}

