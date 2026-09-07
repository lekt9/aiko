/** Structured operations logging for the account DO: one JSON line per event,
 * tagged `aiko-ops` so `wrangler tail` and Logpush filter cleanly. Fields are
 * caller-redacted; values are truncated and never include message bodies,
 * transcripts or credentials. */
export type OpsFields = Record<string, string | number | boolean | undefined>;

export type OpsLogger = (event: string, fields?: OpsFields) => void;

export function createOpsLogger(redact: (text: string) => string): OpsLogger {
  return (event, fields = {}) => {
    try {
      const out: Record<string, unknown> = { ops: "aiko-ops", event, at: new Date().toISOString() };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (typeof value === "string") {
          const cleaned = redact(value).slice(0, 200);
          out[key] = cleaned;
        } else out[key] = value;
      }
      console.log(JSON.stringify(out));
    } catch {
      /* Observability must never break the operation it observes. */
    }
  };
}

/** Wraps an async operation and reports duration plus outcome. */
export async function withOps<T>(
  ops: OpsLogger,
  event: string,
  fields: OpsFields,
  run: () => Promise<T>,
  slowMs = 5_000,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await run();
    const ms = Date.now() - start;
    if (ms >= slowMs) ops(event, { ...fields, ms, outcome: "ok" });
    return result;
  } catch (error) {
    ops(event, {
      ...fields,
      ms: Date.now() - start,
      outcome: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : "unknown",
    });
    throw error;
  }
}
