import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { HttpFetch } from "./security.ts";
import { privateDatabaseFile } from "./accounts.ts";

export type ModelLimits = {
  globalPerDay: number;
  accountPerDay: number;
  maxConcurrent: number;
};
export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  globalPerDay: 200,
  accountPerDay: 40,
  maxConcurrent: 4,
};

/** Count actual outbound inference requests, including compaction. Reserve before I/O; never refund uncertain calls. */
export class ModelBudget {
  private readonly db: Database;
  private active = 0;
  constructor(
    stateDir: string,
    readonly limits: ModelLimits = DEFAULT_MODEL_LIMITS,
    private now = Date.now,
  ) {
    this.db = new Database(
      privateDatabaseFile(join(stateDir, "model-budget.sqlite")),
    );
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS model_usage (day TEXT NOT NULL, owner TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day, owner))",
    );
  }
  status(owner: string) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const total = this.db
      .query(
        "SELECT coalesce(sum(calls),0) AS calls FROM model_usage WHERE day=?",
      )
      .get(day) as { calls: number };
    const own = this.db
      .query("SELECT calls FROM model_usage WHERE day=? AND owner=?")
      .get(day, owner) as { calls: number } | null;
    return {
      day,
      accountCalls: own?.calls ?? 0,
      globalCalls: total.calls,
      limits: this.limits,
      active: this.active,
    };
  }
  private reserve(owner: string) {
    return this.db
      .transaction(() => {
        const usage = this.status(owner);
        if (
          usage.accountCalls >= this.limits.accountPerDay ||
          usage.globalCalls >= this.limits.globalPerDay
        )
          return false;
        this.db
          .query(
            "INSERT INTO model_usage VALUES (?, ?, 1) ON CONFLICT(day,owner) DO UPDATE SET calls=calls+1",
          )
          .run(usage.day, owner);
        return true;
      })
      .immediate();
  }
  transport(owner: string, upstream: HttpFetch = fetch): HttpFetch {
    return async (url, init) => {
      // This wrapper is exclusively for the fixed model endpoint, not an arbitrary credential-forwarding proxy.
      if (String(url) !== "https://gateway.codegraff.com/v1/chat/completions")
        throw new Error("Invalid model endpoint");
      const encoded = typeof init?.body === "string" ? init.body : "";
      if (!encoded || Buffer.byteLength(encoded) > 262144)
        throw new Error("Model request exceeds byte budget");
      const body = JSON.parse(encoded);
      if (
        !Number.isInteger(body.max_tokens) ||
        body.max_tokens < 1 ||
        body.max_tokens > 2048
      )
        throw new Error("Invalid model output budget");
      while (this.active >= this.limits.maxConcurrent) {
        init?.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      init?.signal?.throwIfAborted();
      if (!this.reserve(owner))
        throw new Error("Daily inference allowance exhausted");
      this.active++;
      const signal = AbortSignal.any([
        init?.signal ?? new AbortController().signal,
        AbortSignal.timeout(65_000),
      ]);
      let detachAbort = () => {};
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          this.active--;
          detachAbort();
        }
      };
      try {
        const response = await upstream(url, {
          ...init,
          redirect: "manual",
          signal,
        });
        if (signal.aborted) {
          await response.body?.cancel();
          throw new Error("Model request aborted");
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          release();
          return Response.json(
            { error: { message: "Model provider request failed" } },
            { status: response.status >= 400 ? response.status : 502 },
          );
        }
        const reader = response.body.getReader();
        const abort = () => {
          release();
          void reader.cancel().catch(() => undefined);
        };
        detachAbort = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                release();
                controller.close();
              } else controller.enqueue(next.value);
            } catch {
              release();
              controller.error(new Error("Model stream interrupted"));
            }
          },
          async cancel() {
            release();
            await reader.cancel();
          },
        });
        return new Response(stream, {
          status: response.status,
          headers: response.headers,
        });
      } catch {
        release();
        throw new Error("Model transport unavailable");
      }
    };
  }
  close() {
    this.db.close();
  }
}
