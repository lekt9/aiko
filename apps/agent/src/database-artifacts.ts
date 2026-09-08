import { DataError, identifier } from "../../../packages/structured-data/src/index.ts";
import { authorizeDatabaseDependencies } from "./database-refresh.ts";
import type { DatabaseBinding } from "./database-component.ts";

export interface ArtifactReference { artifactId: string }
export interface ReplyArtifact extends ArtifactReference { kind: "database"; state: "available" | "unavailable" }

/** Only identifiers cross the response/outbox boundary. No query rows or UI code. */
export function artifactReferences(input: unknown): ArtifactReference[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) throw new DataError("invalid", "A reply supports at most eight artifacts");
  const ids = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => k !== "artifactId")) throw new DataError("invalid", "Artifact reference required");
    identifier(value.artifactId);
    if (ids.has(value.artifactId)) throw new DataError("invalid", "Duplicate artifact reference");
    ids.add(value.artifactId); return { artifactId: value.artifactId };
  });
}

/** Revalidate at admission, preparation, delivery and authenticated history reads. */
export async function replyArtifacts(binding: DatabaseBinding | undefined, refs: readonly ArtifactReference[], signal: AbortSignal): Promise<ReplyArtifact[]> {
  if (!refs.length) return [];
  let allowed = binding && !signal.aborted && await binding.authorize("read", signal).catch(() => false);
  if (allowed && binding?.readEvents) { try { binding.collections?.(await binding.readEvents()); } catch { allowed = false; } }
  const result = await Promise.all(refs.map(async ({ artifactId }): Promise<ReplyArtifact> => {
    try { if (!allowed || !binding) throw Error("Unavailable"); await authorizeDatabaseDependencies(binding, binding.store.artifact(artifactId).result.dependencies, signal); return { artifactId, kind: "database", state: "available" }; }
    catch { return { artifactId, kind: "database", state: "unavailable" }; }
  }));
  allowed = allowed && !signal.aborted && !!binding && await binding.authorize("read", signal).catch(() => false);
  return allowed ? result : refs.map(({ artifactId }) => ({ artifactId, kind: "database", state: "unavailable" }));
}

export async function reauthorizeReplyResult(binding: DatabaseBinding | undefined, input: unknown, signal: AbortSignal): Promise<unknown> {
  if (!input || typeof input !== "object" || !("artifacts" in input)) return input;
  const result = input as { artifacts?: unknown };
  try {
    const raw = result.artifacts;
    if (!Array.isArray(raw)) throw Error("Invalid artifact list");
    const refs = artifactReferences(raw.map(ref => ({ artifactId: ref?.artifactId })));
    return { ...result, artifacts: await replyArtifacts(binding, refs, signal) };
  } catch { return { ...result, artifacts: [], artifactError: "unavailable" }; }
}
