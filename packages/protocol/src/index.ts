import { z } from "zod";
export { z };
export * from "./login-import.js";
export const id = z.string().uuid();
export const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !/\p{C}/u.test(s));
export const domain = z
  .string()
  .toLowerCase()
  .max(253)
  .refine(
    (s) =>
      s.includes(".") &&
      s
        .split(".")
        .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)),
  );
export const domains = z
  .array(domain)
  .min(1)
  .max(12)
  .refine((a) => new Set(a).size === a.length);
export const identity = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine((s) => !/\p{C}/u.test(s));
export const cookie = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/),
    value: z
      .string()
      .max(16384)
      .refine((s) => !/[\x00-\x1f\x7f;]/.test(s)),
    domain: z.string().max(254),
    path: z
      .string()
      .startsWith("/")
      .max(2048)
      .refine((s) => !/[\x00-\x1f\x7f;]/.test(s)),
    expires: z.number().finite(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
    hostOnly: z.boolean(),
    partitionKey: z
      .object({ topLevelSite: z.url(), hasCrossSiteAncestor: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export const cookieJar = z
  .array(cookie)
  .max(200)
  .refine(
    (c) => new TextEncoder().encode(JSON.stringify(c)).byteLength <= 1_048_576,
  );
export type VaultCookie = z.infer<typeof cookie>;
export const credential = z
  .object({ password: z.string().min(1).max(16384) })
  .strict();
export const connectionCreate = z
  .object({
    name: label,
    identity,
    website: z
      .url()
      .refine(
        (s) =>
          new URL(s).protocol === "https:" &&
          !new URL(s).username &&
          !new URL(s).password &&
          !new URL(s).hash &&
          !new URL(s).search,
      ),
    domains,
    recipeId: label.optional(),
    maintenance: z.boolean().default(false),
    credential: credential.optional(),
    sourceId: id.optional(),
    sourceReference: z.string().max(500).optional(),
    ssoContextId: id.optional(),
  })
  .strict()
  .refine(
    (x) =>
      !(x.credential && x.sourceId) &&
      !!x.sourceId === !!x.sourceReference &&
      x.domains.includes(new URL(x.website).hostname),
  );
export type VaultConnectionInput = z.input<typeof connectionCreate>;
export const connectionMetadata = z
  .object({
    id,
    name: label,
    identity,
    website: z.string(),
    domains,
    recipeId: z.string().nullable(),
    maintenance: z.boolean(),
    version: z.number().int(),
    sourceId: z.string().nullable(),
    sourceReference: z.string().nullable(),
    hasPassword: z.boolean(),
    deleted: z.boolean(),
  })
  .strict();
export type VaultConnection = z.infer<typeof connectionMetadata>;
export const profileInput = z
  .object({ name: label, enabled: z.boolean().optional() })
  .strict();
export const profileMetadata = z
  .object({
    id,
    name: label,
    enabled: z.boolean(),
    version: z.number().int(),
    connectionIds: z.array(id),
  })
  .strict();
export type VaultProfile = z.infer<typeof profileMetadata>;
export const clientMetadata = z
  .object({
    id,
    name: label,
    profileId: id,
    redirectUris: z.array(z.url()),
    connectionIds: z.array(id),
    enabled: z.boolean(),
  })
  .strict();
export type VaultOAuthClient = z.infer<typeof clientMetadata>;
/**
 * Natively supported password managers and secret stores. Each kind fixes the
 * reference syntax its provider resolves; the token is always the provider's
 * service credential (sealed server-side, never returned by the API).
 */
export const passwordManagerKinds = [
  "onepassword",
  "keeper",
  "hashicorp-vault",
  "doppler",
] as const;
export type PasswordManagerKind = (typeof passwordManagerKinds)[number];
const sourceReference = (pattern: RegExp) =>
  z
    .string()
    .max(500)
    .refine((s) => !/\p{C}/u.test(s))
    .regex(pattern);
export const sourceInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("onepassword"),
      name: label,
      /** 1Password service account token. */
      token: z.string().min(1).max(16384),
      // op://vault/item/field and op://vault/item/section/field
      references: z
        .array(
          sourceReference(/^op:\/\/[^/?#]+\/[^/?#]+(?:\/[^/?#]+)?\/[^/?#]+$/),
        )
        .min(1)
        .max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("keeper"),
      name: label,
      /** Keeper Secrets Manager one-line config token. */
      token: z.string().min(1).max(16384),
      // keeper://RECORD_UID/field/NAME (or custom_field/NAME)
      references: z
        .array(
          sourceReference(
            /^keeper:\/\/[A-Za-z0-9_-]{22}\/(?:field|custom_field)\/[A-Za-z0-9_.-]+$/,
          ),
        )
        .min(1)
        .max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hashicorp-vault"),
      name: label,
      /** Vault service token for the operator-configured cluster. */
      token: z.string().min(1).max(16384),
      // vault://MOUNT/PATH/TO/SECRET#FIELD (KV v2 data)
      references: z
        .array(
          sourceReference(
            /^vault:\/\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+#[A-Za-z0-9_.-]+$/,
          ).refine(
            (s) => !s.split(/[#/]/).some((seg) => seg === "." || seg === ".."),
          ),
        )
        .min(1)
        .max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("doppler"),
      name: label,
      /** Doppler service token, scoped to its project and config. */
      token: z.string().min(1).max(16384),
      // doppler://SECRET_NAME (service tokens already pin project/config)
      references: z
        .array(sourceReference(/^doppler:\/\/[A-Za-z0-9_.-]+$/))
        .min(1)
        .max(1000),
    })
    .strict(),
]);
export const sourceMetadata = z
  .object({
    id,
    name: label,
    kind: z.string(),
    enabled: z.boolean(),
    version: z.number().int(),
    references: z.array(z.string()),
  })
  .strict();
export type VaultSource = z.infer<typeof sourceMetadata>;
export const sessionMaterial = z
  .object({
    connectionId: id,
    profileId: id,
    runtimeId: id,
    revision: z.number().int().positive(),
    allowedDomains: domains,
    expiresAt: z.number().finite(),
    cookies: cookieJar,
  })
  .strict();
export type VaultSession = z.infer<typeof sessionMaterial>;
export const sessionWrite = z
  .object({ revision: z.number().int().positive(), cookies: cookieJar })
  .strict();
/** Owner-only commit of a browser login; no caller-supplied verification flag. */
export const browserLoginCommit = z
  .object({
    profileId: id,
    runtimeId: id,
    version: z.number().int().positive(),
    identity,
    credential,
    cookies: cookieJar,
  })
  .strict();
export const browserLoginReceipt = z
  .object({
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    expiresAt: z.number().finite(),
  })
  .strict();
export type BrowserLoginCommit = z.infer<typeof browserLoginCommit>;
export type BrowserLoginReceipt = z.infer<typeof browserLoginReceipt>;
export const importPreview = z
  .object({
    id,
    expiresAt: z.number(),
    rows: z.array(
      z
        .object({
          row: z.number().int(),
          name: z.string(),
          identity: z.string(),
          website: z.string(),
          status: z.enum(["ready", "duplicate", "invalid", "unsupported"]),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type VaultImportPreview = z.infer<typeof importPreview>;
export const importResult = z
  .object({
    imported: z.number().int(),
    duplicates: z.number().int(),
    connectionIds: z.array(id),
  })
  .strict();
export const jobMetadata = z
  .object({
    id,
    connectionId: id,
    profileId: id,
    runtimeId: id,
    state: z.string(),
    attempts: z.number().int(),
    reason: z.string(),
    error: z.string().nullable(),
    due: z.number(),
  })
  .strict();
export type VaultJob = z.infer<typeof jobMetadata>;
export const auditMetadata = z
  .object({
    id,
    at: z.number(),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    detail: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();
export const revisionResult = z
  .object({
    revision: z.number().int().positive(),
    expiresAt: z.number().finite().optional(),
  })
  .strict();
export const okResult = z.object({ ok: z.literal(true) }).strict();
export const meResult = z.object({ tenantId: id, csrf: z.string() }).strict();
export const ssoMetadata = z
  .object({
    id,
    identity,
    runtimeId: id,
    enabled: z.boolean(),
    version: z.number().int(),
  })
  .strict();
export const serviceInfo = z
  .object({
    service: z.literal("unlock"),
    version: z.literal("1"),
    mode: z.literal("vault"),
  })
  .strict();
export { deriveZohoVaultKey, decryptZohoVaultField, type ZohoUnlockParameters } from "./zoho-vault-crypto.js";
export * from "./database.js";
