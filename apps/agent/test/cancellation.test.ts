import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";

test("owner cancellation aborts active inference and produces one truthful terminal reply", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-cancel-test-");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "cancellable" },
    }),
    react: (_request, _key, signal) =>
      Effect.promise(
        () =>
          new Promise<{ kind: "complete"; output: string }>((resolve) => {
            const timer = setTimeout(
              () => resolve({ kind: "complete", output: "Late fixture reply" }),
              1500,
            );
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                clearTimeout(timer);
                resolve({
                  kind: "complete",
                  output: "Interrupted fixture reply",
                });
              },
              { once: true },
            );
            started();
          }),
      ),
  });
  const token = "public-cancellation-fixture-token-1234";
  const service = await createService(
    {
      stateDir,
      mode: "demo",
      port: 4243,
      operatorToken: token,
      persona: "fixture",
      voiceEnabled: false,
      allowedUsers: new Set(),
    },
    { model },
  );
  const request = (path: string, body?: unknown) =>
    service.fetch(
      new Request(`http://127.0.0.1:4243/api/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    expect(
      (await request("messages", { id: "cancel_0001", text: "Show issues" }))
        .status,
    ).toBe(202);
    await ready;
    expect((await request("cancel", { id: "local:cancel_0001" })).status).toBe(
      202,
    );
    await service.host.drive();
    const result = await (await request("messages")).json();
    expect(aborted).toBe(true);
    expect(
      result.messages.filter((m: { role: string }) => m.role === "assistant"),
    ).toHaveLength(1);
    expect(result.messages.at(-1).text).toBe(
      "Cancelled this request. Actions already submitted may still complete; check their status before retrying.",
    );
    expect(result.pending).toHaveLength(0);
    expect((await request("cancel", { id: "local:cancel_0001" })).status).toBe(
      409,
    );
  } finally {
    await service.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 10_000);
