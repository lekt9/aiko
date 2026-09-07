import { passwordManagerKinds, sourceInput } from "@unlock/protocol";
import type { z } from "@unlock/protocol";

export { passwordManagerKinds };
export type PasswordManagerKind = (typeof passwordManagerKinds)[number];

/** Fully validated password manager source authorization. */
export type SourceAuthorization = z.output<typeof sourceInput>;
export type SourceAuthorizationInput = z.input<typeof sourceInput>;
type SourceOf<K extends PasswordManagerKind> = Extract<
  SourceAuthorization,
  { kind: K }
>;
type SourceInputOf<K extends PasswordManagerKind> = Extract<
  SourceAuthorizationInput,
  { kind: K }
>;

/**
 * Validates and authorizes a connection source from any supported password
 * manager. Reference syntax is enforced per kind before anything is sent to
 * the vault service; the provider token is sealed server-side and never
 * returned by the API.
 *
 * ```ts
 * import { passwordManagers } from "@unlock/sdk/sources";
 * await owner.addSource(
 *   passwordManagers.onePassword({
 *     name: "1Password",
 *     token: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
 *     references: ["op://vault/item/password"],
 *   }),
 * );
 * ```
 */
export function passwordManagerSource<K extends PasswordManagerKind>(
  kind: K,
  input: SourceInputOf<K>,
): SourceOf<K> {
  return sourceInput.parse({ ...input, kind }) as SourceOf<K>;
}

/** Builders for each natively supported password manager. */
export const passwordManagers = {
  /** 1Password service account; references like op://vault/item/field */
  onePassword: (input: SourceInputOf<"onepassword">) =>
    passwordManagerSource("onepassword", input),
  /** Keeper Secrets Manager one-line config; references like keeper://RECORD_UID/field/NAME */
  keeper: (input: SourceInputOf<"keeper">) =>
    passwordManagerSource("keeper", input),
  /** HashiCorp Vault KV v2; references like vault://MOUNT/PATH#FIELD (cluster address is server config) */
  hashicorpVault: (input: SourceInputOf<"hashicorp-vault">) =>
    passwordManagerSource("hashicorp-vault", input),
  /** Doppler service token; references like doppler://SECRET_NAME */
  doppler: (input: SourceInputOf<"doppler">) =>
    passwordManagerSource("doppler", input),
} as const;
