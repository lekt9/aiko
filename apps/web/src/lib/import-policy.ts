import type { CsvLoginRow } from "@unlock/sdk";

export const MAX_CSV_BYTES = 1_048_576;
export const MAX_IMPORT_ROWS = 1_000;
export const MAX_VAULT_LOGINS = 2_000;
export const MAX_IMPORT_BODY_BYTES = 1_048_576;
export type ImportLogin = Pick<CsvLoginRow, "name" | "domain" | "identity">;
export type LoginValidation =
  { login: ImportLogin; error?: never } | { login?: never; error: string };

/** Demo metadata only. Never accept URL userinfo or persist URL paths/query tokens. */
export function normalizeImportLogin(input: ImportLogin): LoginValidation {
  let url: URL;
  try {
    url = new URL(
      input.domain.includes("://")
        ? input.domain.trim()
        : `https://${input.domain.trim()}`,
    );
  } catch {
    return { error: "A valid website is required." };
  }
  const domain = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !domain ||
    domain.length > 253 ||
    domain
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return { error: "Use an HTTP(S) website without embedded credentials." };
  }
  if (!/\.(example|test)$/.test(domain))
    return { error: "Demo only: website must end in .example or .test." };
  const identity = input.identity.trim();
  if (
    identity.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.(example|test)$/i.test(identity)
  ) {
    return {
      error:
        "Demo only: username must be an email ending in .example or .test.",
    };
  }
  const name = input.name.trim() || domain;
  if (name.length > 60 || /\p{C}/u.test(name))
    return {
      error: "Login name must be 1–60 characters without control characters.",
    };
  return { login: { name, domain, identity } };
}

// Host is canonicalized; username case is preserved because some sites distinguish it.
export const loginImportKey = (
  login: Pick<ImportLogin, "domain" | "identity">,
) =>
  JSON.stringify([
    login.domain.toLowerCase().replace(/\.$/, ""),
    login.identity.trim(),
  ]);
