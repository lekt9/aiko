import { loadConfig } from "../apps/agent/src/config.ts";
import { mkdir, writeFile } from "node:fs/promises";
const url = "https://aiko-agent.lewis-6d8.workers.dev/connect";
const config = await loadConfig(process.env, { readonly: true });
if (!config.botToken) throw new Error("Telegram is not configured");
const current = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!current.ok || !(await current.text()).includes('id="root"')) throw new Error("Connection page is not deployed");
async function api(method: string, body: object) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json() as { ok?: boolean; result?: unknown };
  if (!response.ok || data.ok !== true) throw new Error("Telegram menu configuration failed");
  return data.result;
}
// Configures the bot menu; does not send any chat messages or change the webhook.
await api("setChatMenuButton", { menu_button: { type: "web_app", text: "Connect apps", web_app: { url } } });
const result = await api("getChatMenuButton", {}) as { type?: string; text?: string; web_app?: { url?: string } };
if (result.type !== "web_app" || result.web_app?.url !== url) throw new Error("Telegram menu verification failed");
await mkdir("artifacts/connectors", { recursive: true });
await writeFile("artifacts/connectors/telegram-menu.json", JSON.stringify({ at: new Date().toISOString(), verified: true, menu: result, messagesSent: 0 }, null, 2));
console.log("Verified Telegram Connect apps Mini App menu");
