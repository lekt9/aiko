import { test, expect, spyOn } from "bun:test";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { BrowserController } from "../src/browser.ts";

for (const [fail, cleanupFailure] of [
  [false, false],
  [true, false],
  [false, true],
])
  test(`native startup recovery ${cleanupFailure ? "cleanup failure" : fail ? "failed turn" : "completion"} keeps dependencies through shutdown`, async () => {
    const dir = await mkdtemp("/tmp/aiko-startup-"),
      snapshot = join(dir, "recovery");
    const config: AikoConfig = {
      stateDir: join(dir, "initial"),
      mode: "demo",
      instanceId: "startup",
      port: 4242,
      persona: PERSONA,
      operatorToken: "controlled-startup-token-1234567890",
      allowedUsers: new Set(["123"]),
      voiceEnabled: false,
      browser: { executablePath: "/unused", domains: ["*"] },
    };
    const pendingStarted = Promise.withResolvers<void>(),
      continueInitial = Promise.withResolvers<void>();
    const done = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "startup" } }),
      react: (r) =>
        Effect.promise(async () => {
          if (r.identity.turn.includes("pending")) {
            pendingStarted.resolve();
            await continueInitial.promise;
          }
          return { kind: "complete" as const, output: "done" };
        }),
    });
    config.planeCredentials = [
      {
        account: "123",
        digest: credentialDigest("owner-startup-token-1234567890"),
        scopes: ["read", "write"],
      },
    ];
    let service = await createService(config, { model: done });
    const request = (path: string, body?: object) =>
      service.fetch(
        new Request("http://localhost" + path, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: "Bearer owner-startup-token-1234567890",
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const order: string[] = [];
    let closeSpy: ReturnType<typeof spyOn> | undefined;
    try {
      expect(
        (
          await request("/api/messages", {
            id: "startup-initial",
            text: "initial",
          })
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
      expect(
        (
          await request("/api/messages", {
            id: "startup-pending",
            text: "Compose a sonnet about harbor lanterns",
          })
        ).status,
      ).toBe(202);
      await pendingStarted.promise;
      await cp(config.stateDir, snapshot, { recursive: true });
      continueInitial.resolve();
      await service.close();
      let failDisposal = cleanupFailure;
      const original = BrowserController.prototype.close;
      closeSpy = spyOn(BrowserController.prototype, "close").mockImplementation(
        async function (this: BrowserController) {
          order.push("browser-close");
          await original.call(this);
          if (failDisposal) {
            failDisposal = false;
            throw Error("controlled cleanup failure");
          }
        },
      );
      service = await createService(
        { ...config, stateDir: snapshot },
        {
          model: Layer.succeed(Infer, {
            resolve: () => ({
              model: { provider: "fixture", model_id: "startup" },
            }),
            react: () =>
              Effect.promise(async () => {
                entered.resolve();
                await release.promise;
                order.push("recovery-finished");
                return fail
                  ? {
                      kind: "fail" as const,
                      error: "controlled native failure",
                    }
                  : { kind: "complete" as const, output: "recovered" };
              }),
          }),
        },
      );
      await entered.promise;
      let recovered = false;
      const readiness = service.ready.then(() => { recovered = true; });
      expect((await request("/ready")).status).toBe(503);
      let ordinaryDone = false;
      const ordinary = request("/api/harness/readiness").then((r) => {
        ordinaryDone = true;
        return r;
      });
      // Receive-only ingress is dispatched without waiting for recovery, even when unconfigured.
      const ingress = await request("/v1/channel-ingress/not-configured");
      expect(ingress.status).toBe(405);
      expect(ordinaryDone).toBe(false);
      expect(recovered).toBe(false);
      const closing = service.close();
      await Promise.resolve();
      expect(order).toEqual([]);
      release.resolve();
      if (cleanupFailure)
        await expect(closing).rejects.toThrow("Aiko dependency cleanup failed");
      else await closing;
      await ordinary;
      await readiness;
      expect(recovered).toBe(true);
      expect(order.indexOf("recovery-finished")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("browser-close")).toBeGreaterThan(
        order.indexOf("recovery-finished"),
      );
      service = await createService(
        { ...config, stateDir: snapshot },
        { model: done },
      );
      await request("/api/harness/readiness");
      expect((await request("/ready")).status).toBe(200);
      const retained = await service.host.read("user-123");
      expect(
        retained.some(
          (e) =>
            e.type === (fail ? "TurnFailed" : "TurnCompleted") &&
            e.turn === "local:startup-pending",
        ),
      ).toBe(true);
    } finally {
      continueInitial.resolve();
      release.resolve();
      await service.close();
      closeSpy?.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
