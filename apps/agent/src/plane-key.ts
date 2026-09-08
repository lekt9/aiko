import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { privateEnv } from "./config.ts";
import { credentialDigest, parsePlaneCredentials } from "./plane-auth.ts";
import { privateDirectory } from "./accounts.ts";
import { safeUserId } from "./security.ts";

process.umask(0o077);
try {
  const args = process.argv.slice(2);
  const account = args[0] === "new" ? `acct_${randomUUID()}` : args[0];
  const output = args[1];
  const scope = args[2] ?? "read,write";
  if (
    !safeUserId(account) ||
    account === "local" ||
    !output ||
    !isAbsolute(output) ||
    !["read", "read,write"].includes(scope)
  )
    throw new Error(
      "Usage: bun src/plane-key.ts <new|Telegram numeric ID|acct_id> /absolute/private/client.env [read|read,write]",
    );
  const configPath =
    process.env.AIKO_SECRET_FILE ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse/aiko.env");
  privateDirectory(dirname(configPath));
  const lock = await open(`${configPath}.lock`, "wx", 0o600);
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    const values = await privateEnv(configPath);
    const credentials = parsePlaneCredentials(
      values.AIKO_PLANE_CREDENTIALS ?? "[]",
    );
    const token = `aiko_${randomBytes(32).toString("base64url")}`;
    credentials.push({
      account,
      digest: credentialDigest(token),
      scopes: scope === "read" ? ["read"] : ["read", "write"],
    });
    values.AIKO_PLANE_CREDENTIALS = JSON.stringify(credentials);
    parsePlaneCredentials(values.AIKO_PLANE_CREDENTIALS);
    privateDirectory(dirname(output));
    await writeFile(
      output,
      `AIKO_PLANE_TOKEN=${token}\nAIKO_ACCOUNT=${account}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      temporary,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, configPath);
    console.info(
      `Account ${account}; client credential saved privately. Redeploy hosted Aiko or restart local Aiko to load the grant. Revoke by removing its digest from AIKO_PLANE_CREDENTIALS and applying the configuration again.`,
    );
  } finally {
    await lock.close();
    await rm(`${configPath}.lock`, { force: true });
    await rm(temporary, { force: true });
  }
} catch {
  console.error(
    "Credential was not activated. Use: pnpm aiko:key <new|Telegram numeric ID|acct_id> /absolute/private/client.env [read|read,write]. Existing output files are never overwritten.",
  );
  process.exitCode = 1;
}
