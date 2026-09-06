/** Local learned embeddings. Only public model files are downloaded; indexed text never leaves the process. */
export const REQUEST_EMBEDDING_MODEL =
  "Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9";
export function createRequestEmbedding(cacheDir: string) {
  let loaded: Promise<any> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    model: REQUEST_EMBEDDING_MODEL,
    dimensions: 384,
    async embed(
      texts: readonly string[],
      signal?: AbortSignal,
    ): Promise<number[][]> {
      if (
        texts.length > 32 ||
        texts.some((t) => typeof t !== "string" || t.length > 16000)
      )
        throw new Error("Embedding input exceeds bounds");
      signal?.throwIfAborted();
      const run = queue
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          loaded ??= import("@huggingface/transformers").then(({ pipeline }) =>
            pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
              revision: "751bff37182d3f1213fa05d7196b954e230abad9",
              cache_dir: cacheDir,
              dtype: "q8",
              device: "cpu",
            }),
          );
          const extractor = await loaded;
          signal?.throwIfAborted();
          if (!texts.length) return [];
          const output = await extractor([...texts], {
            pooling: "mean",
            normalize: true,
          });
          signal?.throwIfAborted();
          const vectors = output.tolist() as number[][];
          if (
            vectors.length !== texts.length ||
            vectors.some(
              (v) => v.length !== 384 || v.some((x) => !Number.isFinite(x)),
            )
          )
            throw new Error("Invalid embedding output");
          return vectors;
        });
      queue = run;
      return run;
    },
  };
}
