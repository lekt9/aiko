import { privateEnv } from "../apps/agent/src/config.ts";
import { createAikoClient } from "../packages/sdk/src/aiko.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Read one provisioned integration account, never the bot or operator credential.
try {
  const credentials = await privateEnv(
    process.env.AIKO_CLIENT_FILE ??
      join(homedir(), ".config/unbrowse/aiko-plane.env"),
  );
  const baseUrl = process.env.AIKO_BASE_URL ?? "http://127.0.0.1:4242";
  const client = createAikoClient({
    baseUrl,
    token: credentials.AIKO_PLANE_TOKEN,
  });
  const status = await client.status();
  if (status.account !== credentials.AIKO_ACCOUNT)
    throw new Error("Account mismatch");
  const manifest = await client.discover();
  if (manifest.protocol !== "aiko-plane/v1")
    throw new Error("Protocol mismatch");
  let probe = "skipped: live model mode";
  if (status.mode === "demo") {
    const accepted = await client.messages.send({
      id: "gateway_verification_001",
      text: "Remember: gateway verification uses UTC",
    });
    let complete = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const messages = await client.messages.list();
      const memory = await client.memory.recall("gateway verification");
      if (
        messages.messages.some(
          (message) =>
            message.role === "assistant" && message.turn === accepted.id,
        ) &&
        memory.items.length
      ) {
        complete = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (!complete) throw new Error("Probe did not settle");
    probe =
      "passed: demo message, reply and scoped memory via SDK; no Telegram send";
  }
  const response = await fetch(new URL("/health", baseUrl), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Health unavailable");
  const health = await response.json();
  if (!health.telegram?.running || !health.telegram?.lastPollAt)
    throw new Error("No completed Telegram poll");
  const evidence = {
    verifiedAt: new Date().toISOString(),
    protocol: manifest.protocol,
    account: status.account,
    mode: status.mode,
    probe,
    health,
  };
  const output = join(import.meta.dir, "../artifacts/aiko-gateway");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "live-verification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.info(JSON.stringify(evidence, null, 2));
} catch {
  console.error(
    "Gateway verification failed; no raw credential or provider response was printed.",
  );
  process.exitCode = 1;
}
