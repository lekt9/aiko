import { randomBytes, randomUUID } from "node:crypto";
import { postgres, migrate, type Database } from "../../apps/server/src/db.js";
import { LocalKeyring, VaultCipher } from "../../apps/server/src/crypto.js";
import { Vault, type RuntimePrincipal } from "../../apps/server/src/vault.js";
import { Runtime } from "../../apps/server/src/runtime.js";
import { Maintainer } from "../../apps/server/src/worker.js";
import { VaultError } from "../../apps/server/src/errors.js";
import type {
  AuthRecipe,
  PasswordSource,
} from "../../apps/server/src/recipes.js";
import type { VaultCookie } from "@unlock/protocol";
export const enabled = !!process.env.UNLOCK_TEST_DATABASE_URL;
export const secret = "SYNTHETIC-PASSWORD-CANARY-NOT-REAL";
export const cookie = (
  value = "verified-alice",
  domain = "service.test",
): VaultCookie => ({
  name: "sid",
  value,
  domain,
  path: "/",
  expires: -1,
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  hostOnly: true,
});
export const input = {
  name: "Fixture service",
  identity: "alice",
  website: "https://service.test",
  domains: ["service.test"],
  recipeId: "fixture",
  maintenance: true,
  credential: { password: secret },
};
const testKeys = new WeakMap<Database, string>();
export async function database() {
  const original = process.env.UNLOCK_TEST_DATABASE_URL;
  if (
    !original ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(original).hostname)
  )
    throw new Error("A dedicated loopback test database is required");
  const admin = postgres(original),
    schema = "unlock_test_" + randomUUID().replace(/-/g, "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(original);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = postgres(url.href);
  await migrate(db);
  return {
    db,
    url: url.href,
    async close() {
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
export async function fixture(
  db: Database,
  options: {
    recipe?: AuthRecipe;
    source?: PasswordSource;
    now?: () => number;
    runtimeId?: string;
  } = {},
) {
  if (!testKeys.has(db)) testKeys.set(db, randomBytes(32).toString("base64"));
  const key = testKeys.get(db)!,
    subject = randomUUID(),
    cipher = new VaultCipher(new LocalKeyring("test", { test: key })),
    vault = new Vault(db, cipher, options.now),
    tenant = await vault.owner("https://identity.test", subject);
  let renewals = 0;
  const recipe: AuthRecipe = options.recipe ?? {
    id: "fixture",
    async verify(ctx) {
      if (!ctx.cookies.some((c) => c.value === "verified-alice"))
        throw new VaultError("REAUTH_REQUIRED", 409);
      return {
        identity: ctx.identity,
        cookies: ctx.cookies,
        expiresAt: vault.now() + 300_000,
      };
    },
    async renew(ctx) {
      renewals++;
      if ((await ctx.password()) !== secret)
        throw new VaultError("REAUTH_REQUIRED", 409);
      return {
        identity: ctx.identity,
        cookies: [cookie()],
        expiresAt: vault.now() + 300_000,
      };
    },
  };
  const runtime = new Runtime(
      vault,
      new Map([[recipe.id, recipe]]),
      options.source ?? {
        async resolve() {
          throw new VaultError("SOURCE_UNAVAILABLE", 409);
        },
      },
      options.runtimeId,
    ),
    worker = new Maintainer(runtime);
  const connection = await vault.add(tenant, input),
    profile = await vault.saveProfile(tenant, { name: "Agent" });
  await vault.assign(tenant, profile.id, [connection.id]);
  const client = await vault.createClient(tenant, {
    name: "Test runtime",
    profileId: profile.id,
    connectionIds: [connection.id],
    redirectUris: ["http://127.0.0.1:4949/callback"],
  });
  const principal: RuntimePrincipal = {
    tenant,
    profile: profile.id,
    client: client.id,
    connections: [connection.id],
    scope: ["sessions:read", "sessions:write", "maintenance:request"],
  };
  return {
    vault,
    subject,
    key,
    cipher,
    tenant,
    runtime,
    worker,
    connection,
    profile,
    client,
    principal,
    renewals: () => renewals,
  };
}
