import type { WorkflowKV } from "./workflow-host.ts";
import type { ModelRoutingBudget } from "./model-routing.ts";
import { ModelBudgetDenied } from "./model-budget-denial.ts";
/** Worker account ledger shared by foreground, background and reflection.
 * Atomic owner KV reservation occurs before I/O; uncertain calls stay spent. */
export function registryModelBudget(owner: string, kv: WorkflowKV, accountPerDay = 40): ModelRoutingBudget {
  if (!owner || !Number.isSafeInteger(accountPerDay) || accountPerDay < 1 || accountPerDay > 200) throw Error("Invalid model allowance");
  return { transport: (requested, upstream = fetch) => async (url, init) => {
    if (requested !== owner) throw Error("Foreign model allowance");
    const target = new URL(String(url));
    if (target.href !== "https://gateway.codegraff.com/v1/chat/completions") throw Error("Model transport denied");
    const text = String(init?.body ?? "");
    if (Buffer.byteLength(text) > 262144) throw Error("Model request too large");
    const body = JSON.parse(text);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096) throw Error("Model output budget denied");
    init?.signal?.throwIfAborted();
    const day = new Date().toISOString().slice(0, 10);
    await kv.update(`model-budget:${owner}:${day}`, previous => {
      const row = previous as { owner?: unknown; day?: unknown; calls?: unknown } | undefined;
      const calls = row === undefined ? 0 : row?.calls;
      if (row !== undefined && (!row || row.owner !== owner || row.day !== day) ||
        typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 0) throw Error("Account model allowance unavailable");
      if (calls >= accountPerDay) throw new ModelBudgetDenied({ version: 1, owner, day, scope: "account", limit: accountPerDay });
      return { owner, day, calls: calls + 1 };
    });
    init?.signal?.throwIfAborted();
    return upstream(url, init);
  } };
}
