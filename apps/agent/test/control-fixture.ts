// Isolated control-panel demonstration: public fixture credentials, no paid inference or network sends.
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
process.umask(0o077);
const stateDir = await mkdtemp("/tmp/aiko-control-qa-");
const token = "public-fixture-token-not-a-secret-123456";
const ownerToken = "public-fixture-account-token-123456789";
const service = await createService(
  {
    mode: "demo",
    instanceId: "control-fixture",
    port: 4245,
    stateDir,
    operatorToken: token,
    persona: "fixture",
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(ownerToken),
        scopes: ["read", "write"],
      },
    ],
  },
  {
    backgroundModel: Layer.succeed(Infer, {
      resolve: () => ({
        model: { provider: "fixture", model_id: "deterministic" },
      }),
      react: (request) => {
        const message = [...request.trajectory]
          .reverse()
          .find((e) => e.type === "MessageReceived");
        if (request.identity.turn.startsWith("reflect:")) {
          const data = JSON.parse(String(message?.text));
          const supports = data.changed
            .slice(0, 1)
            .map((leaf: { observation: string }) => leaf.observation);
          return Effect.succeed({
            kind: "complete" as const,
            output: JSON.stringify(
              supports.length
                ? {
                    decision: "notify",
                    reason: "Demonstration of a cited background decision",
                    text: "The release check changed. Review the updated rollout evidence before proceeding.",
                    supports,
                  }
                : {
                    decision: "silent",
                    reason: "No semantic change",
                    text: "",
                    supports: [],
                  },
            ),
          });
        }
        return Effect.succeed({
          kind: "complete" as const,
          output: "Demo conversation recorded.",
        });
      },
    }),
  },
);
const request = async (path: string, body: object) => {
  const response = await service.fetch(
    new Request(`http://127.0.0.1:4245${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`Fixture setup failed: ${response.status}`);
  await service.host.drive();
};
await request("/v1/messages", {
  id: "fixture-conversation",
  text: "Keep track of the Aurora release checks.",
});
await request("/v1/hooks", {
  id: "release-check-001",
  subject: "aurora/release",
  title: "Aurora release check",
  kind: "entity",
  type: "release",
  payload: {
    status: "review_required",
    check: "Recovery verification complete",
    source: "synthetic fixture",
  },
});
await request("/v1/hooks", {
  id: "release-check-002",
  subject: "aurora/release",
  title: "Aurora release check",
  kind: "entity",
  type: "release",
  payload: {
    status: "ready",
    check: "Recovery and isolation checks passed",
    source: "synthetic fixture",
  },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4245,
  fetch: service.fetch,
  maxRequestBodySize: 24_576,
});
console.info("Control panel fixture ready: http://127.0.0.1:4245/control");
console.info(`Public fixture token: ${token}`);
async function close() {
  server.stop(true);
  await service.close();
  await rm(stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
