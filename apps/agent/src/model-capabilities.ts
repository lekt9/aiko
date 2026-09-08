import { createHash } from "node:crypto";
export interface ModelCapabilities {
  protocol?: "openai-chat-completions" | "openai-responses";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  promptCache?: { kind: "openai"; retention?: "in_memory" | "24h" };
  serverCompaction?: boolean;
  parallelToolCalls?: boolean;
}
/** Provider model API snapshot, 2026-09-08: https://api.cerebras.ai/public/v1/models.
 * Explicit deployment policy can replace these defaults as provider support changes. */
export const CEREBRAS_MODEL_CAPABILITIES: Readonly<
  Record<string, Readonly<ModelCapabilities>>
> = Object.freeze({
  "qwen-3.8-27b": Object.freeze({
    parallelToolCalls: true,
    contextWindowTokens: 65536,
    maxOutputTokens: 32768,
  }),
  "gemma-4-31b": Object.freeze({
    parallelToolCalls: true,
    contextWindowTokens: 131072,
    maxOutputTokens: 40960,
  }),
  "gpt-oss-120b": Object.freeze({
    parallelToolCalls: false,
    contextWindowTokens: 131072,
    maxOutputTokens: 40960,
  }),
});
/** Endpoint capabilities are trusted deployment metadata, never inferred from a model's text. */
export function parseModelCapabilities(
  raw: string | undefined,
): Readonly<Record<string, ModelCapabilities>> {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 64
  )
    throw Error("Invalid model capabilities");
  for (const [name, entry] of Object.entries(value)) {
    const policy = entry as ModelCapabilities;
    if (
      !/^(?:codegraff|cerebras)\/[A-Za-z0-9_./-]{1,128}$/.test(name) ||
      !policy ||
      typeof policy !== "object" ||
      Array.isArray(policy) ||
      Object.keys(policy).some(
        (key) =>
          ![
            "protocol",
            "contextWindowTokens",
            "maxOutputTokens",
            "promptCache",
            "serverCompaction",
            "parallelToolCalls",
          ].includes(key),
      )
    )
      throw Error("Invalid model capability policy");
    if (
      policy.protocol !== undefined &&
      !["openai-chat-completions", "openai-responses"].includes(policy.protocol)
    )
      throw Error("Unsupported model protocol");
    for (const [key, min, max] of [
      ["contextWindowTokens", 1024, 2000000],
      ["maxOutputTokens", 1, 65536],
    ] as const)
      if (
        policy[key] !== undefined &&
        (!Number.isSafeInteger(policy[key]) ||
          policy[key]! < min ||
          policy[key]! > max)
      )
        throw Error("Invalid model context capability");
    if (
      policy.serverCompaction !== undefined &&
      typeof policy.serverCompaction !== "boolean"
    )
      throw Error("Invalid server compaction capability");
    if (
      policy.parallelToolCalls !== undefined &&
      typeof policy.parallelToolCalls !== "boolean"
    )
      throw Error("Invalid parallel tool capability");
    if (policy.serverCompaction && policy.protocol !== "openai-responses")
      throw Error(
        "Server compaction requires an explicitly configured Responses route",
      );
    if (
      name.startsWith("cerebras/") &&
      (policy.protocol === "openai-responses" ||
        policy.promptCache ||
        policy.serverCompaction)
    )
      throw Error("Unsupported Cerebras protocol or cache control");
    const cache = policy.promptCache;
    if (
      cache !== undefined &&
      (!cache ||
        typeof cache !== "object" ||
        Array.isArray(cache) ||
        cache.kind !== "openai" ||
        Object.keys(cache).some(
          (key) => !["kind", "retention"].includes(key),
        ) ||
        (cache.retention !== undefined &&
          !["in_memory", "24h"].includes(cache.retention)))
    )
      throw Error("Invalid prompt cache policy");
  }
  return value;
}
/** Stable within a host/owner/thread/model/prompt prefix; content-free on the wire. */
export function modelPromptCacheKey(
  owner: string,
  identity: unknown,
  model: string,
  prefix: unknown,
): string {
  return `aiko-${createHash("sha256")
    .update(JSON.stringify([owner, identity, model, prefix]))
    .digest("hex")
    .slice(0, 56)}`;
}
