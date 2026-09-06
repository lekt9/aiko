import {
  auditMetadata,
  clientMetadata,
  connectionMetadata,
  jobMetadata,
  meResult,
  okResult,
  profileMetadata,
  sourceMetadata,
  ssoMetadata,
} from "@unlock/protocol";
import {
  idResult,
  pathId,
  vaultTransport,
  type VaultOptions,
} from "./vault-transport.js";
import type { RequestOptions } from "./types.js";
export { UnlockError } from "./transport.js";
export type { VaultOptions } from "./vault-transport.js";
export type {
  VaultConnection,
  VaultProfile,
  VaultSource,
  VaultOAuthClient,
  VaultJob,
} from "@unlock/protocol";
/** Owner-authorized metadata management. No passwords, cookies or source-token methods. */
export function createVaultClient(options: VaultOptions) {
  const request = vaultTransport(options);
  return {
    me: (opts?: RequestOptions) =>
      request(meResult, "me", "GET", undefined, opts),
    logout: (opts?: RequestOptions) =>
      request(okResult, "logout", "POST", {}, opts),
    connections: {
      list: (opts?: RequestOptions) =>
        request(
          connectionMetadata.array(),
          "connections",
          "GET",
          undefined,
          opts,
        ),
      update: (
        id: string,
        input: {
          version: number;
          name?: string;
          maintenance?: boolean;
          recipeId?: string | null;
        },
        opts?: RequestOptions,
      ) =>
        request(
          connectionMetadata,
          `connections/${pathId(id)}`,
          "PATCH",
          input,
          opts,
        ),
      delete: (id: string, opts?: RequestOptions) =>
        request(okResult, `connections/${pathId(id)}`, "DELETE", {}, opts),
    },
    profiles: {
      list: (opts?: RequestOptions) =>
        request(profileMetadata.array(), "profiles", "GET", undefined, opts),
      create: (
        input: { name: string; enabled?: boolean },
        opts?: RequestOptions,
      ) => request(idResult, "profiles", "POST", input, opts),
      update: (
        id: string,
        input: { name: string; enabled?: boolean },
        opts?: RequestOptions,
      ) => request(idResult, `profiles/${pathId(id)}`, "PATCH", input, opts),
      assign: (id: string, connectionIds: string[], opts?: RequestOptions) =>
        request(
          okResult,
          `profiles/${pathId(id)}/assignments`,
          "PUT",
          { connectionIds },
          opts,
        ),
    },
    sources: {
      list: (opts?: RequestOptions) =>
        request(sourceMetadata.array(), "sources", "GET", undefined, opts),
      disconnect: (id: string, opts?: RequestOptions) =>
        request(okResult, `sources/${pathId(id)}`, "DELETE", {}, opts),
    },
    clients: {
      list: (opts?: RequestOptions) =>
        request(clientMetadata.array(), "clients", "GET", undefined, opts),
      create: (
        input: {
          name: string;
          profileId: string;
          connectionIds: string[];
          redirectUris: string[];
        },
        opts?: RequestOptions,
      ) => request(idResult, "clients", "POST", input, opts),
      updateAccess: (
        id: string,
        connectionIds: string[],
        opts?: RequestOptions,
      ) =>
        request(
          okResult,
          `clients/${pathId(id)}`,
          "PATCH",
          { connectionIds },
          opts,
        ),
      revoke: (id: string, opts?: RequestOptions) =>
        request(okResult, `clients/${pathId(id)}`, "DELETE", {}, opts),
    },
    sso: {
      list: (opts?: RequestOptions) =>
        request(ssoMetadata.array(), "sso", "GET", undefined, opts),
      disable: (id: string, opts?: RequestOptions) =>
        request(okResult, `sso/${pathId(id)}`, "DELETE", {}, opts),
    },
    jobs: (opts?: RequestOptions) =>
      request(jobMetadata.array(), "jobs", "GET", undefined, opts),
    events: (opts?: RequestOptions) =>
      request(auditMetadata.array(), "events", "GET", undefined, opts),
  };
}
export type VaultClient = ReturnType<typeof createVaultClient>;
