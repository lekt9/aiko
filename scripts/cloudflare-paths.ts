import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { privateEnv } from "../apps/agent/src/config.ts";

export const workspaceRoot = resolve(import.meta.dir, "..");
export const cloudflareStatePath = (env = process.env) =>
  resolve(env.AIKO_CLOUDFLARE_STATE_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse/aiko-cloudflare.env"));

export async function cloudflareSecrets(env = process.env) {
  let file: Record<string, string> = {};
  try { file = await privateEnv(env.AIKO_SECRET_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse/aiko.env")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const values: Record<string, string | undefined> = { ...file, ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
  if (!values.AIKO_OPERATOR_TOKEN) {
    try {
      values.AIKO_OPERATOR_TOKEN = (await privateEnv(values.AIKO_OPERATOR_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse/aiko-operator.env"))).AIKO_OPERATOR_TOKEN;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return values;
}

/** Read cloud operation credentials without opening or creating native state. */
export async function cloudflareOperatorConfig(source = process.env) {
  const env = await cloudflareSecrets(source);
  if (!env.AIKO_OPERATOR_TOKEN || env.AIKO_OPERATOR_TOKEN.length < 32)
    throw new Error("Cloud operation requires AIKO_OPERATOR_TOKEN");
  return { operatorToken: env.AIKO_OPERATOR_TOKEN, modelKey: env.CODEGRAFF_API_KEY, botToken: env.TELEGRAM_BOT_TOKEN ?? env.AIKO_BOT_TOKEN };
}

/** CI may supply credentials directly; local operator files remain supported. */
export async function cloudflareState(env = process.env) {
  let file: Record<string, string> = {};
  try { file = await privateEnv(cloudflareStatePath(env)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [key, value] of Object.entries(env))
    if (["AIKO_E2E_OWNER", "AIKO_E2E_TOKEN", "AIKO_BACKUP_KEY", "AIKO_CLOUDFLARE_URL"].includes(key) && value !== undefined) file[key] = value;
  return file;
}
