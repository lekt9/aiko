/**
 * Pure helpers for the composer model picker search/filter.
 */

import type { ModelOption } from "@/lib/grokCatalog";

/**
 * Filter models for the composer model menu by free-text query.
 * Case-insensitive match on `id` and `label`. Empty/whitespace query → all models.
 */
export function filterModelsForMenu(
  models: ModelOption[],
  query: string,
): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );
}
