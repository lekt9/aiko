import { harnessDigest, type HarnessDigest } from "./harness-library.ts";

// Host-only metadata follows an actual tool return into custody. JSON supplied
// by a model or provider cannot attach dependencies to another invocation.
const retained = new WeakMap<object, readonly HarnessDigest[]>();

export const memoryObservationDependency = (observation: string): HarnessDigest =>
  harnessDigest(["aiko-memory-observation-custody/v1", observation]);

export function withRetainedDependencies<T extends object>(value: T, dependencies: readonly HarnessDigest[]): T {
  const unique = [...new Set(dependencies)].sort();
  if (unique.length > 1024) throw Error("Retained result dependency limit exceeded");
  retained.set(value, unique);
  return value;
}

export function retainedDependencies(value: unknown): readonly HarnessDigest[] {
  return value !== null && typeof value === "object" ? retained.get(value) ?? [] : [];
}

/** Inspect structural observation records, never strings or IDs inside payloads. */
export function memoryResultDependencies(value: unknown): HarnessDigest[] {
  const found = new Set<HarnessDigest>();
  let visited = 0;
  const visit = (item: unknown) => {
    if (++visited > 20000) throw Error("Memory result dependency limit exceeded");
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && /^obs_[a-f0-9]{64}$/.test(row.id) &&
        typeof row.subject === "string" && typeof row.type === "string" && Object.hasOwn(row, "payload")) {
      found.add(memoryObservationDependency(row.id));
      return;
    }
    for (const [key, child] of Object.entries(row)) if (key !== "payload") visit(child);
  };
  visit(value);
  return [...found].sort();
}
