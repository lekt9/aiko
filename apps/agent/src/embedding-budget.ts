import type { EmbeddingAdmission, EmbeddingRequest, EmbeddingUsage, MemoryStorage } from "entity-learn/cloudflare";
import { safeUserId } from "./security.ts";

/** Host billing state, deliberately outside disposable memory projections and evidence archives.
 * Global daily cap across owners. Never refund failures or unknown usage; duplicate keys never rebill.
 */
export class EmbeddingBudget {
  private readonly limitNanos: number;
  constructor(private readonly storage: MemoryStorage, maxUsdPerDay: number, private readonly now = Date.now) {
    if (!Number.isFinite(maxUsdPerDay) || maxUsdPerDay <= 0 || maxUsdPerDay > 10) throw new Error("Invalid embedding spend cap");
    this.limitNanos = Math.floor(maxUsdPerDay * 1e9);
    if (!this.limitNanos) throw new Error("Embedding cap is below accounting precision");
    storage.exec(`CREATE TABLE IF NOT EXISTS embedding_usage (
      owner TEXT NOT NULL, key TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL,
      reserved INTEGER NOT NULL, accounted INTEGER NOT NULL, prompt_tokens INTEGER, total_tokens INTEGER,
      overrun INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,key))`);
  }
  status() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const total = this.storage.prepare("SELECT coalesce(sum(accounted),0) AS used FROM embedding_usage WHERE day=?").get(day)!;
    const stopped = this.storage.prepare("SELECT 1 AS stopped FROM embedding_usage WHERE overrun=1 LIMIT 1").get();
    return { day, accountedUsd: Number(total.used) / 1e9, maxUsdPerDay: this.limitNanos / 1e9, stopped: !!stopped };
  }
  forOwner(owner: string): EmbeddingAdmission {
    if (!safeUserId(owner)) throw new Error("Invalid embedding owner");
    return {
      reserve: (request: EmbeddingRequest) => this.storage.transaction(() => {
        const amount = Math.ceil(request.ceilingUsd * 1e9);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid embedding reservation");
        if (this.storage.prepare("SELECT 1 AS prior FROM embedding_usage WHERE owner=? AND key=?").get(owner, request.key))
          throw new Error("Embedding request already reserved; reconcile uncertain execution before retrying");
        const status = this.status();
        if (status.stopped || Math.round(status.accountedUsd * 1e9) + amount > this.limitNanos) throw new Error("Embedding allowance exhausted");
        this.storage.prepare("INSERT INTO embedding_usage(owner,key,day,model,reserved,accounted) VALUES(?,?,?,?,?,?)")
          .run(owner, request.key, status.day, request.model, amount, amount);
      }),
      settle: (request: EmbeddingRequest, usage: EmbeddingUsage) => {
        const invalid = this.storage.transaction(() => {
        const prior = this.storage.prepare("SELECT model,reserved,accounted FROM embedding_usage WHERE owner=? AND key=?").get(owner, request.key);
        if (!prior || prior.model !== request.model) throw new Error("Embedding reservation missing");
        const actual = usage.costUsd === null ? 0 : Math.ceil(usage.costUsd * 1e9);
        if (!Number.isSafeInteger(actual) || actual < 0) {
          this.storage.prepare("UPDATE embedding_usage SET overrun=1 WHERE owner=? AND key=?").run(owner, request.key);
          return true;
        }
        const overrun = actual > Number(prior.reserved) || usage.totalTokens > request.maxInputTokens;
        this.storage.prepare("UPDATE embedding_usage SET accounted=?,prompt_tokens=?,total_tokens=?,overrun=max(overrun,?) WHERE owner=? AND key=?")
          .run(Math.max(Number(prior.accounted), actual), usage.promptTokens, usage.totalTokens, overrun ? 1 : 0, owner, request.key);
        return false;
        });
        // Throw only after committing the stop flag: rollback must not reopen an invalid allowance.
        if (invalid) throw new Error("Embedding accounting requires operator reconciliation");
      },
    };
  }
  close() { this.storage.close(); }
}
