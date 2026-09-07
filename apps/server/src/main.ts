import { postgres, migrate } from "./db.js";
import { readConfig, cipherFor, recipeConfigs } from "./config.js";
import { Vault } from "./vault.js";
import { Runtime } from "./runtime.js";
import { Maintainer } from "./worker.js";
import { OwnerAuth } from "./owner-auth.js";
import { OAuth } from "./oauth.js";
import { createHttpRecipe } from "./recipes.js";
import {
  DopplerSource,
  HashiCorpVaultSource,
  KeeperSource,
  OnePasswordSource,
  SourceRegistry,
} from "./sources.js";
import { createHttpServer } from "./api.js";
async function main() {
  if (!process.env.UNLOCK_CONFIG) throw new Error("UNLOCK_CONFIG is required");
  const config = await readConfig(process.env.UNLOCK_CONFIG),
    db = postgres(config.databaseUrl);
  await migrate(db);
  const vault = new Vault(db, cipherFor(config)),
    owner = new OwnerAuth(
      vault,
      config.origin,
      config.owner
        ? { ...config.owner, allowLocalHttp: config.localDevelopment }
        : undefined,
    ),
    oauth = new OAuth(
      vault,
      owner,
      config.origin,
      config.oauth.jwks as ConstructorParameters<typeof OAuth>[3],
      config.oauth.cookieKeys,
    );
  const recipes = new Map(
      recipeConfigs(config).map((c) => [c.id, createHttpRecipe(c)]),
    ),
    sources = new SourceRegistry({
      onepassword: new OnePasswordSource(),
      keeper: new KeeperSource(),
      doppler: new DopplerSource(),
      ...(config.sources.hashicorpVault
        ? {
            "hashicorp-vault": new HashiCorpVaultSource(
              config.sources.hashicorpVault,
            ),
          }
        : {}),
    }),
    runtime = new Runtime(vault, recipes, sources, config.runtimeId),
    worker = new Maintainer(runtime);
  const server = createHttpServer(vault, owner, oauth, runtime, worker);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  console.info(
    `Unlock vault service listening on loopback port ${config.port}. ${config.localDevelopment ? "LOCAL DEVELOPMENT: no public HTTP use." : "Use the configured TLS reverse proxy."}`,
  );
  let stopping = false,
    lastSchedule = 0;
  const loop = (async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastSchedule > 30_000) {
          await worker.schedule();
          lastSchedule = Date.now();
        }
        if (await worker.tick()) continue;
      } catch {
        console.error(
          "Unlock maintenance iteration failed; retrying without logging request material.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await loop;
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
}
main().catch(() => {
  console.error(
    "Unlock startup failed. Check configuration permissions, keys, database and provider settings. No configuration values have been logged.",
  );
  process.exit(1);
});
