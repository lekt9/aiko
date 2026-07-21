/**
 * Durable generative UI client — contract-native.
 * Pointers: aiko:ui/<id>, aiko:data/<sha>
 * Rank: same pull shape as contract recommend (ui_store_rank / ui rank)
 * Ledger action: ui.resolve {"pointer":"aiko:ui/<id>","id":"<id>"}
 */

import { invoke } from "@tauri-apps/api/core";
import type { Spec } from "@json-render/react";
import type {
  PutUiResult,
  ResolveResult,
  StoredUiComponent,
  UiBindings,
  UiIndexEntry,
  UiRankHit,
} from "./types";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

const memory = {
  index: [] as UiIndexEntry[],
  components: new Map<string, StoredUiComponent>(),
  data: new Map<string, unknown>(),
  routes: {} as Record<string, string>,
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function idFromDigest(digest: string): string {
  return `ui-${digest.slice(0, 12)}`;
}

function buildAction(id: string): string {
  return `ui.resolve ${JSON.stringify({ pointer: `aiko:ui/${id}`, id })}`;
}

function buildPlan(title: string, tags: string[], description?: string): string {
  return ["ui:" + title, description, ...tags].filter(Boolean).join(" ");
}

export async function listUiComponents(
  workspace?: string,
): Promise<UiIndexEntry[]> {
  if (isTauri()) {
    return invoke<UiIndexEntry[]>("ui_store_list", {
      workspace: workspace ?? null,
    });
  }
  return memory.index.filter(
    (e) => !workspace || !e.workspace || e.workspace === workspace,
  );
}

export async function getUiComponent(id: string): Promise<StoredUiComponent> {
  if (isTauri()) {
    return invoke<StoredUiComponent>("ui_store_get", { id });
  }
  const c = memory.components.get(id);
  if (!c) throw new Error(`ui component not found: ${id}`);
  return c;
}

export interface PutUiInput {
  title: string;
  spec: Spec;
  state?: Record<string, unknown>;
  bindings?: UiBindings;
  tags?: string[];
  workspace?: string;
  description?: string;
  route?: string;
  id?: string;
  contractId?: string;
  registerContract?: boolean;
}

export async function putUiComponent(input: PutUiInput): Promise<PutUiResult> {
  if (isTauri()) {
    return invoke<PutUiResult>("ui_store_put", {
      request: {
        title: input.title,
        spec: input.spec,
        state: input.state ?? {},
        bindings: input.bindings ?? {},
        tags: input.tags ?? [],
        workspace: input.workspace ?? null,
        description: input.description ?? null,
        route: input.route ?? null,
        id: input.id ?? null,
        contractId: input.contractId ?? null,
        registerContract: input.registerContract ?? true,
      },
    });
  }

  const specJson = JSON.stringify(input.spec);
  const specDigest = await sha256Hex(specJson);
  const id = input.id || idFromDigest(specDigest);
  const now = new Date().toISOString();
  const tags = [...(input.tags ?? [])];
  if (!tags.includes("generative")) tags.push("generative");
  const plan = buildPlan(input.title, tags, input.description);
  const action = buildAction(id);
  const pointer = `aiko:ui/${id}` as const;
  const bindings = { ...(input.bindings ?? {}) };
  if (input.state && Object.keys(input.state).length > 0) {
    const body = JSON.stringify(input.state);
    const digest = await sha256Hex(body);
    memory.data.set(digest, input.state);
    const ptr = `aiko:data/${digest}`;
    bindings["/"] = bindings["/"] ?? ptr;
    bindings["/__snapshot"] = bindings["/__snapshot"] ?? ptr;
  }
  memory.data.set(specDigest, input.spec);
  const specPointer = `aiko:data/${specDigest}`;
  bindings["/__spec"] = bindings["/__spec"] ?? specPointer;

  const existing = memory.components.get(id);
  const meta = {
    id,
    title: input.title,
    description: input.description,
    tags,
    workspace: input.workspace,
    contractId: input.contractId ?? existing?.meta.contractId,
    specDigest,
    specPointer,
    plan,
    action,
    createdAt: existing?.meta.createdAt ?? now,
    updatedAt: now,
    route: input.route,
  };
  const stored: StoredUiComponent = {
    meta,
    spec: input.spec,
    state: input.state ?? {},
    bindings,
  };
  memory.components.set(id, stored);
  memory.index = [
    {
      id,
      title: input.title,
      route: input.route,
      tags,
      workspace: input.workspace,
      updatedAt: now,
      pointer,
      contractId: meta.contractId,
      plan,
      specDigest,
    },
    ...memory.index.filter((e) => e.id !== id),
  ];
  if (input.route) memory.routes[input.route] = id;
  return {
    meta,
    pointer,
    checkPath: `memory://${id}/spec.json`,
    specDigest,
    specPointer,
    bindings,
    plan,
    action,
    contractId: meta.contractId,
  };
}

export async function putData(value: unknown): Promise<{ pointer: string }> {
  if (isTauri()) {
    return invoke("ui_store_put_data", { value });
  }
  const digest = await sha256Hex(JSON.stringify(value));
  memory.data.set(digest, value);
  return { pointer: `aiko:data/${digest}` };
}

export async function resolvePointer(pointer: string): Promise<ResolveResult> {
  if (isTauri()) {
    return invoke<ResolveResult>("ui_store_resolve", { pointer });
  }
  if (pointer.startsWith("aiko:data/")) {
    const digest = pointer.slice("aiko:data/".length).split("#")[0];
    const value = memory.data.get(digest);
    return value === undefined
      ? { pointer, kind: "missing" }
      : { pointer, kind: "data", value };
  }
  if (pointer.startsWith("aiko:ui/")) {
    const rest = pointer.slice("aiko:ui/".length);
    const id = rest.split("/")[0];
    const c = memory.components.get(id);
    if (!c) return { pointer, kind: "missing" };
    return { pointer, kind: "ui", value: c, component: c };
  }
  return { pointer, kind: "missing" };
}

export async function listRoutes(): Promise<Record<string, string>> {
  if (isTauri()) {
    return invoke("ui_store_routes");
  }
  return { ...memory.routes };
}

export async function uiStoreRoot(): Promise<string> {
  if (isTauri()) {
    return invoke("ui_store_root");
  }
  return "memory://ui";
}

/** Rank surfaces for a goal — same retrieve path as contract recommend. */
export async function rankUiComponents(
  query: string,
  limit = 8,
): Promise<UiRankHit[]> {
  if (isTauri()) {
    return invoke<UiRankHit[]>("ui_store_rank", { query, limit });
  }
  const q = query.toLowerCase();
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const hits: UiRankHit[] = [];
  for (const e of memory.index) {
    const hay = [e.title, e.plan, e.tags.join(" "), e.route, e.pointer]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    let score = 0.05;
    for (const t of tokens) {
      if (hay.includes(t)) score += 0.42;
    }
    if (q && hay.includes(q)) score += 0.35;
    score = Math.min(score, 0.99);
    if (score > 0.1) {
      hits.push({
        id: e.id,
        title: e.title,
        pointer: e.pointer,
        score,
        plan: e.plan,
        contractId: e.contractId,
        route: e.route,
        tags: e.tags,
        action: buildAction(e.id),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export async function seedUiCatalog(): Promise<{ seeded: number; types: number }> {
  if (isTauri()) {
    return invoke("ui_store_seed_catalog");
  }
  return { seeded: 0, types: 0 };
}

/** Infer a title from a json-render spec. */
export function titleFromSpec(spec: Spec): string {
  const record = spec as {
    elements?: Record<string, { type?: string; props?: Record<string, unknown> }>;
    root?: string;
  };
  const elements = record.elements ?? {};
  for (const el of Object.values(elements)) {
    if (el.type === "Heading" && typeof el.props?.text === "string") {
      return el.props.text;
    }
  }
  for (const el of Object.values(elements)) {
    if (el.type === "Card" && typeof el.props?.title === "string") {
      return el.props.title;
    }
  }
  return "Untitled surface";
}

/** Slug route from title. */
export function routeFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `/ui/${slug || "surface"}`;
}
