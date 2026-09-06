import { assertNoSecrets, fail, number, text } from "./codec.js";
import { checkedVector, type EmbeddingSpace } from "./semantic.js";

export type EmbeddingFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface EmbeddingRequest {
  key: string; model: string; documents: number; inputBytes: number; maxInputTokens: number; ceilingUsd: number;
}
export interface EmbeddingUsage { promptTokens: number; totalTokens: number; costUsd: number | null; }
export interface EmbeddingProvider {
  readonly space: Readonly<EmbeddingSpace>;
  readonly maxBatch: number;
  readonly maxInputBytes: number;
  embed(texts: readonly string[], context: { key: string; purpose: "document" | "query"; signal?: AbortSignal }): Promise<{ vectors: number[][]; usage: EmbeddingUsage }>;
}
export interface EmbeddingAdmission {
  /** Host must durably reserve before I/O; repeated/uncertain keys must never silently rebill. */
  reserve(request: EmbeddingRequest): void | Promise<void>;
  /** Retain reservations on failure. Record overruns and stop further admission, rather than refunding unknown usage. */
  settle(request: EmbeddingRequest, usage: EmbeddingUsage): void | Promise<void>;
}
export const GEMINI_EMBEDDING_2 = Object.freeze({ model: "google/gemini-embedding-2", dimensions: 3072, promptUsdPerMillion: 0.20 });

/** Optional text-only egress capability. No environment reads, fallback model, automatic retry or implicit indexing.
 * Public OpenRouter contract verified; provider execution still requires host consent, rotated credentials and budget.
 */
export function openRouterEmbeddings(options: {
  apiKey: () => string;
  admission: EmbeddingAdmission;
  revision: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: EmbeddingFetch;
}): EmbeddingProvider {
  text(options.revision, "embedding revision", 128);
  if (typeof options.apiKey !== "function" || typeof options.admission?.reserve !== "function" || typeof options.admission?.settle !== "function")
    fail("invalid_input", "An environment-bound credential accessor and explicit host spend admission are required");
  const dimensions = number(options.dimensions ?? GEMINI_EMBEDDING_2.dimensions, "dimensions", 128, 3072);
  const timeout = number(options.timeoutMs ?? 30000, "timeoutMs", 10, 60000);
  const space = Object.freeze({ model: GEMINI_EMBEDDING_2.model, dimensions, revision: `gemini-asymmetric-search/v1:${options.revision}` });
  return {
    space, maxBatch: 8, maxInputBytes: 4096,
    async embed(inputs, context) {
      text(context.key, "request key", 512); number(inputs.length, "batch", 1, 8);
      if (context.purpose !== "document" && context.purpose !== "query") fail("invalid_input", "Embedding purpose must be explicit");
      const texts: string[] = []; let inputBytes = 0;
      for (const input of inputs) {
        if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 4096) fail("too_large", "Embedding text must be nonempty and at most 4096 UTF-8 bytes; no silent truncation");
        assertNoSecrets(input);
        // Gemini Embedding 2 uses prompt prefixes, NOT the embedding-001 task_type parameter.
        const formatted = context.purpose === "query" ? `task: search result | query: ${input}` : `title: none | text: ${input}`;
        texts.push(formatted); inputBytes += Buffer.byteLength(formatted);
      }
      // Conservative byte-based allowance, not a tokenizer or an invoice. Router pricing is also capped.
      const maxInputTokens = inputBytes + texts.length * 256;
      const request = { key: context.key, model: space.model, documents: texts.length, inputBytes, maxInputTokens,
        ceilingUsd: Math.ceil(maxInputTokens * GEMINI_EMBEDDING_2.promptUsdPerMillion * 1000) / 1e9 };
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]);
      let timer: ReturnType<typeof setTimeout> | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("Embedding request aborted or timed out")); });
      const abort = () => { rejectAbort!(); void reader?.cancel().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => controller.abort(), timeout);
      try {
        signal.throwIfAborted();
        return await Promise.race([aborted, (async () => {
          // Resolve credentials before charging, but never expose the value in metadata or provider errors.
          const key = options.apiKey();
          if (!key || /[\r\n]/.test(key)) throw new Error("Embedding credential unavailable");
          await options.admission.reserve(request);
          signal.throwIfAborted();
          const response = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/embeddings", {
            method: "POST", redirect: "error", signal,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ model: space.model, dimensions, encoding_format: "float", input: texts,
              provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true,
                max_price: { prompt: String(GEMINI_EMBEDDING_2.promptUsdPerMillion), completion: "0", request: "0" } } }),
          });
          if (signal.aborted || !response.ok || !response.body || !response.headers.get("content-type")?.includes("application/json")) {
            void response.body?.cancel().catch(() => undefined); throw new Error("Embedding provider response rejected");
          }
          reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
          while (true) {
            const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024) throw new Error("Embedding response exceeds byte bound");
            chunks.push(part.value);
          }
          const encoded = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.byteLength; }
          const body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(encoded));
          const usage: EmbeddingUsage = {
            promptTokens: number(body.usage?.prompt_tokens, "prompt tokens", 0, Number.MAX_SAFE_INTEGER),
            totalTokens: number(body.usage?.total_tokens, "total tokens", 0, Number.MAX_SAFE_INTEGER),
            costUsd: body.usage?.cost ?? null,
          };
          if (usage.totalTokens < usage.promptTokens || (usage.costUsd !== null && (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)))
            throw new Error("Invalid embedding usage");
          signal.throwIfAborted(); await options.admission.settle(request, usage); signal.throwIfAborted();
          if (usage.totalTokens > maxInputTokens || (usage.costUsd !== null && usage.costUsd > request.ceilingUsd)) throw new Error("Embedding usage exceeded its reservation");
          // Known charges survive an unusable vector/model response too; validation never makes a request free.
          if (body.model !== space.model || !Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("Invalid embedding response identity");
          const vectors: number[][] = new Array(texts.length); const seen = new Set<number>();
          for (const row of body.data) {
            const index = number(row.index, "embedding index", 0, texts.length - 1);
            if (seen.has(index)) throw new Error("Duplicate embedding response index");
            seen.add(index); vectors[index] = checkedVector(row.embedding, dimensions);
          }
          return { vectors, usage };
        })()]);
      } catch {
        // No raw provider body, input, key or fetch exception escapes this capability.
        throw new Error("Embedding request failed; reservation retained, no automatic retry");
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort();
        void reader?.cancel().catch(() => undefined);
      }
    },
  };
}
