import { expect, test } from "bun:test";
import { registryModelBudget } from "../src/registry-model-budget.ts";
import type { WorkflowKV } from "../src/workflow-host.ts";
import { Database } from "bun:sqlite";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { ModelBudgetDenied } from "../src/model-budget-denial.ts";
test("Worker conversation and reflection share atomic durable spend across instances, errors and owners", async () => {
  const rows = new Map<string, unknown>();
  const kv: WorkflowKV = { get: async k => rows.get(k), put: async (k,v) => { rows.set(k,v); }, list: async () => [...rows.values()], claim: async (k,v) => { if(rows.has(k))return false;rows.set(k,v);return true; }, update: async (k,fn) => { rows.set(k,fn(rows.get(k))); } };
  let calls = 0;
  const upstream = async () => { calls++; throw Error("lost acknowledgement"); };
  const request = () => ({ method: "POST", body: JSON.stringify({ max_tokens: 1024 }) });
  const url = "https://gateway.codegraff.com/v1/chat/completions";
  const conversation = registryModelBudget("123", kv, 2).transport("123", upstream);
  const reflection = registryModelBudget("123", kv, 2).transport("123", upstream);
  await Promise.allSettled([conversation(url, request()), reflection(url, request())]);
  expect(calls).toBe(2);
  await expect(registryModelBudget("123",kv,2).transport("123",upstream)(url,request())).rejects.toThrow("exhausted");
  await expect(registryModelBudget("123",kv,2).transport("456",upstream)(url,request())).rejects.toThrow("Foreign");
  await expect(registryModelBudget("456",kv,2).transport("456",upstream)("https://example.com",request())).rejects.toThrow("denied");
  expect(calls).toBe(2);
});

test("Worker ledger atomically grants its final call and distinguishes exhaustion from corrupt owner state", async () => {
  const db = new Database(":memory:");
  try {
    const kv = sqliteWorkflowKV(db), day = new Date().toISOString().slice(0, 10);
    let physical = 0;
    const upstream = async () => { physical++; return Response.json({ ok: true }); };
    const invoke = () => registryModelBudget("123", kv, 1).transport("123", upstream)(
      "https://gateway.codegraff.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ max_tokens: 100 }) });
    const results = await Promise.allSettled([invoke(), invoke()]);
    expect(physical).toBe(1);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const error = (results.find(r => r.status === "rejected") as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(ModelBudgetDenied);
    expect(error.denial).toEqual({ version: 1, owner: "123", day, scope: "account", limit: 1 });
    for (const value of [{ calls: "1", owner: "123", day }, { calls: 1, owner: "456", day }, { calls: -1, owner: "123", day }, null]) {
      await kv.put(`model-budget:123:${day}`, value);
      const denied = await invoke().then(() => undefined, e => e);
      expect(denied).toBeInstanceOf(Error);
      expect(denied).not.toBeInstanceOf(ModelBudgetDenied);
    }
    expect(physical).toBe(1);
  } finally { db.close(); }
});

test("Worker cancellation during durable reservation prevents dispatch and keeps the allowance spent", async () => {
  const db = new Database(":memory:");
  try {
    const durable = sqliteWorkflowKV(db), controller = new AbortController();
    const kv = { ...durable, update: async (...args: Parameters<WorkflowKV["update"]>) => {
      await durable.update(...args); controller.abort();
    } };
    let physical = 0;
    const send = registryModelBudget("123", kv, 1).transport("123", async () => { physical++; return Response.json({ ok: true }); });
    const url = "https://gateway.codegraff.com/v1/chat/completions", body = JSON.stringify({ max_tokens: 100 });
    const cancelled = await send(url, { body, signal: controller.signal }).then(() => undefined, e => e);
    expect(cancelled).not.toBeInstanceOf(ModelBudgetDenied);
    expect(controller.signal.aborted).toBe(true);
    expect(physical).toBe(0);
    const day = new Date().toISOString().slice(0, 10);
    expect(await durable.get(`model-budget:123:${day}`)).toEqual({ owner: "123", day, calls: 1 });
    await expect(send(url, { body })).rejects.toBeInstanceOf(ModelBudgetDenied);
    expect(physical).toBe(0);
  } finally { db.close(); }
});
