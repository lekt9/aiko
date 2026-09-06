// Local browser QA only. This deliberately public fixture token is not a credential.
import { mkdtemp, rm } from "node:fs/promises";
import { createService } from "../apps/agent/src/server.ts";
import { browserUiFixture } from "../apps/agent/test/browser-ui-fixture.ts";
const approvalFixture = process.env.AIKO_QA_BROWSER_APPROVALS === "true";
process.umask(0o077);
const stateDir = await mkdtemp("/tmp/aiko-console-qa-");
const service = await createService(
  {
    mode: "demo",
    port: 4243,
    stateDir,
    operatorToken: "public-fixture-token-not-a-secret-123456",
    persona: "fixture",
    voiceEnabled: false,
    allowedUsers: new Set(),
    ...(process.env.AIKO_QA_BROWSER_EXECUTABLE || approvalFixture
      ? {
          browser: {
            executablePath:
              process.env.AIKO_QA_BROWSER_EXECUTABLE ??
              "/fixture/not-a-browser",
            domains: ["*"],
          },
        }
      : {}),
  },
  approvalFixture ? browserUiFixture : {},
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4243,
  fetch: service.fetch,
  maxRequestBodySize: 24_576,
});
console.info(
  "Synthetic Aiko browser fixture ready on 127.0.0.1:4243. No paid integrations.",
);
async function close() {
  server.stop(true);
  await service.close();
  await rm(stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
