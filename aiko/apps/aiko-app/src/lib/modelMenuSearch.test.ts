import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/lib/grokCatalog";
import { filterModelsForMenu } from "./modelMenuSearch";

const models: ModelOption[] = [
  { id: "grok-4.5", label: "Grok 4.5", source: "official" },
  { id: "grok-3", label: "Grok 3", source: "official" },
  { id: "openai/gpt-4o", label: "GPT-4o", source: "custom" },
  { id: "anthropic/claude-sonnet", label: "Claude Sonnet", source: "custom" },
  { id: "local-llama", label: "Local Llama 3", source: "custom" },
];

describe("filterModelsForMenu", () => {
  it("returns all models for empty query", () => {
    expect(filterModelsForMenu(models, "")).toEqual(models);
  });

  it("returns all models for whitespace-only query", () => {
    expect(filterModelsForMenu(models, "   \t  ")).toEqual(models);
  });

  it("matches label case-insensitively", () => {
    expect(filterModelsForMenu(models, "gpt")).toEqual([
      { id: "openai/gpt-4o", label: "GPT-4o", source: "custom" },
    ]);
    expect(filterModelsForMenu(models, "GROK")).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", source: "official" },
      { id: "grok-3", label: "Grok 3", source: "official" },
    ]);
  });

  it("matches id case-insensitively", () => {
    expect(filterModelsForMenu(models, "anthropic")).toEqual([
      {
        id: "anthropic/claude-sonnet",
        label: "Claude Sonnet",
        source: "custom",
      },
    ]);
    expect(filterModelsForMenu(models, "4.5")).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", source: "official" },
    ]);
  });

  it("matches either id or label", () => {
    // label "Local Llama 3" / id "local-llama"
    expect(filterModelsForMenu(models, "llama")).toEqual([
      { id: "local-llama", label: "Local Llama 3", source: "custom" },
    ]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterModelsForMenu(models, "no-such-model-xyz")).toEqual([]);
  });

  it("preserves input order of matches", () => {
    const hits = filterModelsForMenu(models, "grok");
    expect(hits.map((m) => m.id)).toEqual(["grok-4.5", "grok-3"]);
  });

  it("handles empty model list", () => {
    expect(filterModelsForMenu([], "grok")).toEqual([]);
    expect(filterModelsForMenu([], "")).toEqual([]);
  });
});
