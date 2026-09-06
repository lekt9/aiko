import { loadConfig } from "../apps/agent/src/config.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { TELEGRAM_ALLOWED_UPDATES } from "../apps/agent/src/telegram-normalize.ts";
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
// Same deployed destination; update delivery subscriptions without dropping pending messages.
const webhook = await api("getWebhookInfo", {}) as { url?: string; max_connections?: number; has_custom_certificate?: boolean };
if (webhook.url !== new URL("/telegram/webhook", url).href || webhook.has_custom_certificate || !config.webhookSecret)
  throw new Error("Expected the existing Aiko webhook and configured secret before refreshing subscriptions");
await api("setWebhook", { url: webhook.url, secret_token: config.webhookSecret,
  allowed_updates: TELEGRAM_ALLOWED_UPDATES, drop_pending_updates: false,
  ...(webhook.max_connections ? {max_connections:webhook.max_connections} : {}) });
const confirmedWebhook = await api("getWebhookInfo", {}) as {url?: string; allowed_updates?: string[]};
if (confirmedWebhook.url !== webhook.url || TELEGRAM_ALLOWED_UPDATES.some(type => !confirmedWebhook.allowed_updates?.includes(type)))
  throw new Error("Telegram update subscriptions were not verified");
const commands = [
  {command:"start",description:"Meet Aiko and get started"},
  {command:"apps",description:"Find an app or website to connect"},
  {command:"connect",description:"Open secure connection onboarding"},
  {command:"connections",description:"View your connected apps"},
  {command:"discover",description:"Discover capabilities for a website"},
  {command:"status",description:"Check progress without interrupting work"},
  {command:"cancel",description:"Stop your current request"},
  {command:"secretary",description:"Manage Telegram secretary mode"},
  {command:"disconnect",description:"Disconnect an app by its connection ID"},
  {command:"help",description:"See available commands and capabilities"},
];
const scope = {type:"all_private_chats"};
await api("setMyCommands", {commands,scope});
const confirmedCommands = await api("getMyCommands", {scope});
if (JSON.stringify(confirmedCommands) !== JSON.stringify(commands)) throw new Error("Telegram commands were not verified");
// Configures native navigation without sending chat messages.
await api("setChatMenuButton", { menu_button: { type: "web_app", text: "Connect apps", web_app: { url } } });
const result = await api("getChatMenuButton", {}) as { type?: string; text?: string; web_app?: { url?: string } };
if (result.type !== "web_app" || result.web_app?.url !== url) throw new Error("Telegram menu verification failed");
await mkdir("artifacts/connectors", { recursive: true });
await writeFile("artifacts/connectors/telegram-menu.json", JSON.stringify({ at: new Date().toISOString(), verified: true, menu: result, messagesSent: 0 }, null, 2));
await mkdir("artifacts/telegram-audit", {recursive:true});
await writeFile("artifacts/telegram-audit/bot-configuration.json", JSON.stringify({at:new Date().toISOString(),verified:true,
  webhookOrigin:new URL(webhook.url).origin,allowedUpdates:confirmedWebhook.allowed_updates,commands:confirmedCommands,
  menu:result,messagesSent:0,droppedPendingUpdates:false},null,2));
console.log("Verified Telegram commands, Stop updates and Connect apps Mini App menu");
