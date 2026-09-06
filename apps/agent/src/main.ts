import { loadConfig } from "./config.ts";
import { createService } from "./server.ts";
import { createTelegramPoller } from "./telegram-polling.ts";

process.umask(0o077);
let service: Awaited<ReturnType<typeof createService>> | undefined;
let poller: ReturnType<typeof createTelegramPoller> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await poller?.close();
  } finally {
    server?.stop(true);
    await service?.close();
  }
}
try {
  const config = await loadConfig();
  service = await createService(config, {
    telegramStatus: () => poller?.status() ?? { running: false },
  });
  if (config.botToken && config.telegramMode === "polling")
    poller = createTelegramPoller(config, service);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: 24_576,
    fetch: service.fetch,
  });
  await poller?.start();
  console.info(
    `Aiko by Unbrowse · ${config.mode} · http://127.0.0.1:${server.port}`,
  );
  console.info(
    `Account plane: /v1. Telegram: ${poller ? "polling" : config.botToken ? "webhook" : "disabled"}. Real app connections and arbitrary-code VMs are not enabled.`,
  );
  const shutdown = () =>
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  // Provider exceptions can contain credentials or response bodies. Never print raw errors.
  console.error(
    "Aiko could not start. Check private configuration, permissions, Bun >=1.4, and the port. See apps/agent/README.md.",
  );
  await close().catch(() => undefined);
  process.exitCode = 1;
}
