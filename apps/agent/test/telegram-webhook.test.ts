import { expect, test } from "bun:test";
import { telegramWebhookResponse } from "../src/telegram-webhook.ts";

test("only confirmed durable acceptance or duplicate gets a successful webhook response", async () => {
  for (const status of ["accepted", "duplicate", "conflict", "limited", "unavailable"] as const) {
    let callbacks = 0;
    const response = await telegramWebhookResponse(Promise.resolve(status), async () => { callbacks++; });
    expect(response.status).toBe(({ accepted: 200, duplicate: 200, conflict: 409, limited: 429, unavailable: 503 })[status]);
    expect(callbacks).toBe(["accepted", "duplicate"].includes(status) ? 1 : 0);
  }
});

test("slow persistence remains retryable even when waitUntil eventually completes it", async () => {
  let resolve!: (status: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  const background: Promise<unknown>[] = [];
  let callbacks = 0;
  const response = await telegramWebhookResponse(pending, async () => { callbacks++; }, task => { background.push(task); }, 1);
  expect(response.status).toBe(503);
  expect(callbacks).toBe(0);
  resolve("accepted");
  await Promise.all(background);
  expect(callbacks).toBe(1);
  expect((await telegramWebhookResponse(Promise.resolve("duplicate"), async () => {})).status).toBe(200);
});

test("failed persistence and a missing waitUntil never acknowledge an unstored message", async () => {
  expect((await telegramWebhookResponse(Promise.reject(Error("storage failure")), async () => {})).status).toBe(503);
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, fail) => { reject = fail; });
  expect((await telegramWebhookResponse(pending, async () => {}, undefined, 1)).status).toBe(503);
  reject(Error("RPC failed after the response"));
  await Bun.sleep(1);
});
