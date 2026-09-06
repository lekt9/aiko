/** SECRET-BEARING. Trusted owner UI/runtime only; never register these methods as LLM tools. */
import {
  connectionMetadata,
  credential,
  importPreview,
  importResult,
  okResult,
  revisionResult,
  type VaultConnectionInput,
  type VaultCookie,
} from "@unlock/protocol";
import {
  idResult,
  pathId,
  vaultTransport,
  type VaultOptions,
} from "./vault-transport.js";
import type { RequestOptions } from "./types.js";
export type {
  VaultConnectionInput,
  VaultImportPreview,
} from "@unlock/protocol";
export interface SourceAuthorization {
  name: string;
  kind: "onepassword";
  token: string;
  references: string[];
}
export interface SsoContextInput {
  identity: string;
  runtimeId: string;
  domains: string[];
  cookies: VaultCookie[];
}
export function createVaultOwner(options: VaultOptions) {
  const request = vaultTransport(options);
  return {
    add: (input: VaultConnectionInput, opts?: RequestOptions) =>
      request(connectionMetadata, "owner/connections", "POST", input, opts),
    revealPassword: (id: string, opts?: RequestOptions) =>
      request(
        credential,
        `owner/connections/${pathId(id)}/credential`,
        "POST",
        {},
        opts,
      ),
    setPassword: (
      id: string,
      input: { password: string; version: number },
      opts?: RequestOptions,
    ) =>
      request(
        okResult,
        `owner/connections/${pathId(id)}/credential`,
        "PUT",
        input,
        opts,
      ),
    importSession: (
      id: string,
      input: { profileId: string; runtimeId: string; cookies: VaultCookie[] },
      opts?: RequestOptions,
    ) =>
      request(
        revisionResult,
        `owner/connections/${pathId(id)}/session`,
        "POST",
        input,
        opts,
      ),
    addSource: (input: SourceAuthorization, opts?: RequestOptions) =>
      request(idResult, "owner/sources", "POST", input, opts),
    reconnectSource: (
      id: string,
      input: SourceAuthorization,
      opts?: RequestOptions,
    ) => request(okResult, `owner/sources/${pathId(id)}`, "PUT", input, opts),
    importCsv: {
      preview: (
        input: {
          csv: string;
          columns?: {
            name: string;
            url: string;
            username: string;
            password: string;
          };
        },
        opts?: RequestOptions,
      ) => request(importPreview, "owner/imports/preview", "POST", input, opts),
      commit: (id: string, rows: number[], opts?: RequestOptions) =>
        request(
          importResult,
          `owner/imports/${pathId(id)}/commit`,
          "POST",
          { rows },
          opts,
        ),
      cancel: (id: string, opts?: RequestOptions) =>
        request(okResult, `owner/imports/${pathId(id)}`, "DELETE", {}, opts),
    },
    addSsoContext: (input: SsoContextInput, opts?: RequestOptions) =>
      request(idResult, "owner/sso", "POST", input, opts),
    reconnectSsoContext: (
      id: string,
      input: SsoContextInput & { version: number },
      opts?: RequestOptions,
    ) => request(idResult, `owner/sso/${pathId(id)}`, "PUT", input, opts),
  };
}
export type VaultOwner = ReturnType<typeof createVaultOwner>;
