import { KMSClient } from "@aws-sdk/client-kms";
import { readFile, stat } from "node:fs/promises";
import { z } from "@unlock/protocol";
import { LocalKeyring, KmsKeyWrapper, VaultCipher } from "./crypto.js";
import type { HttpRecipeConfig } from "./recipes.js";
const loopback = (value: string) =>
  ["127.0.0.1", "[::1]", "localhost"].includes(new URL(value).hostname);
export const configSchema = z
  .object({
    origin: z.url(),
    port: z.number().int().min(1024).max(65535).default(4180),
    localDevelopment: z.boolean().default(false),
    databaseUrl: z.string().startsWith("postgres"),
    encryption: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("local"),
          active: z.string().min(1),
          keys: z.record(z.string(), z.string()),
        })
        .strict(),
      z
        .object({
          kind: z.literal("kms"),
          keyId: z.string().min(1),
          region: z.string().min(1),
        })
        .strict(),
    ]),
    oauth: z
      .object({
        jwks: z.object({
          keys: z.array(z.record(z.string(), z.unknown())).min(1),
        }),
        cookieKeys: z.array(z.string().min(32)).min(1),
      })
      .strict(),
    owner: z
      .object({
        issuer: z.url(),
        clientId: z.string().min(1),
        clientSecret: z.string().optional(),
        tokenEndpointAuthMethod: z
          .enum(["client_secret_basic", "client_secret_post"])
          .optional(),
        allowedSubjects: z.array(z.string().min(1)).min(1).max(100),
      })
      .strict()
      .optional(),
    runtimeId: z.string().uuid().optional(),
    recipes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            origin: z.url(),
            identityPath: z.string(),
            identityField: z.string(),
            refreshPath: z.string().optional(),
            loginPath: z.string().optional(),
            bootstrapPath: z.string().optional(),
            csrfField: z.string().optional(),
            form: z.boolean().optional(),
            maxSessionMs: z.number().int().min(60_000).max(3600_000).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new URL(c.origin).origin !== c.origin)
      ctx.addIssue({ code: "custom", message: "Origin must have no path" });
    for (const url of [c.origin, c.owner?.issuer].filter(
      (s): s is string => !!s,
    )) {
      const u = new URL(url);
      if (
        u.username ||
        u.password ||
        u.hash ||
        u.search ||
        (u.protocol !== "https:" &&
          !(c.localDevelopment && u.protocol === "http:" && loopback(url)))
      )
        ctx.addIssue({
          code: "custom",
          message: "HTTPS required except explicit loopback development",
        });
    }
    if (new Set(c.recipes.map((r) => r.id)).size !== c.recipes.length)
      ctx.addIssue({ code: "custom", message: "Duplicate recipe IDs" });
  });
export type ServerConfig = z.infer<typeof configSchema>;
export async function readConfig(path: string) {
  const info = await stat(path);
  if (info.mode & 0o077)
    throw new Error("Configuration permissions must be 0600 or stricter");
  return configSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
export function cipherFor(config: ServerConfig) {
  return new VaultCipher(
    config.encryption.kind === "kms"
      ? new KmsKeyWrapper(
          new KMSClient({ region: config.encryption.region }),
          config.encryption.keyId,
        )
      : new LocalKeyring(config.encryption.active, config.encryption.keys),
  );
}
export const recipeConfigs = (config: ServerConfig) =>
  config.recipes as HttpRecipeConfig[];
