import { readConfig, cipherFor } from "./config.js";
import { postgres } from "./db.js";
import { Vault } from "./vault.js";
import { rewrapVault } from "./rewrap.js";
async function main() {
  if (
    process.argv[2] !== "rewrap" ||
    process.env.UNLOCK_MAINTENANCE_WINDOW !== "1" ||
    !process.env.UNLOCK_CONFIG
  )
    throw new Error("Explicit maintenance window required");
  const config = await readConfig(process.env.UNLOCK_CONFIG),
    db = postgres(config.databaseUrl);
  try {
    console.log(
      JSON.stringify({
        ok: true,
        ...(await rewrapVault(new Vault(db, cipherFor(config)))),
      }),
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "Rewrap failed. Stop all writers, set UNLOCK_MAINTENANCE_WINDOW=1, and check private configuration and old/new keys. No key material was logged.",
  );
  process.exitCode = 1;
});
