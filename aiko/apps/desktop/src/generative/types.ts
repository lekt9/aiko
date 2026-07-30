import type { Spec } from "@json-render/react";

/** Content-addressed data pointer: aiko:data/<sha256> */
export type DataPointer = `aiko:data/${string}`;

/** Component pointer: aiko:ui/<id>[/spec|/state|/bindings] */
export type UiPointer =
  | `aiko:ui/${string}`
  | `aiko:ui/${string}/spec`
  | `aiko:ui/${string}/state`
  | `aiko:ui/${string}/bindings`
  | `aiko:ui/${string}/meta`;

export type AikoPointer = DataPointer | UiPointer | string;

export interface UiComponentMeta {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  workspace?: string;
  /** Ledger contract id (recommend / verify) */
  contractId?: string;
  /** Content hash of current spec */
  specDigest: string;
  /** Content-addressed pointer to immutable spec blob */
  specPointer?: string;
  /** Plan text used for rank / recommend */
  plan?: string;
  /** Proven retrieve command: ui.resolve {…} */
  action?: string;
  createdAt: string;
  updatedAt: string;
  /** Route path, e.g. /ui/revenue-board */
  route?: string;
}

/**
 * Binding map: JSON Pointer path into runtime state → data pointer or nested path.
 * Example: { "/metrics/revenue": "aiko:data/abc…", "/rows": "aiko:ui/other/state#/table" }
 */
export type UiBindings = Record<string, AikoPointer>;

export interface StoredUiComponent {
  meta: UiComponentMeta;
  spec: Spec;
  /** Materialized state after pointer resolution (may be empty) */
  state: Record<string, unknown>;
  bindings: UiBindings;
}

export interface UiIndexEntry {
  id: string;
  title: string;
  route?: string;
  tags: string[];
  workspace?: string;
  updatedAt: string;
  pointer: UiPointer;
  contractId?: string;
  plan?: string;
  specDigest?: string;
}

export interface UiRankHit {
  id: string;
  title: string;
  pointer: string;
  score: number;
  plan?: string;
  contractId?: string;
  route?: string;
  tags: string[];
  action: string;
}

export interface ResolveResult {
  pointer: string;
  kind: "ui" | "data" | "fragment" | "missing";
  value?: unknown;
  component?: StoredUiComponent;
}

export interface PutUiResult {
  meta: UiComponentMeta;
  pointer: string;
  checkPath: string;
  specDigest: string;
  specPointer?: string;
  bindings: UiBindings;
  plan?: string;
  action?: string;
  contractId?: string;
}
