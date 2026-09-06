import { createTransport } from "./transport.js";
import type {
  ClientInput,
  ClientOptions,
  ConnectInput,
  Connection,
  ConnectionAction,
  CsvImportInput,
  CsvImportResult,
  OAuthClient,
  LoginUpdate,
  Profile,
  ProfileInput,
  RequestOptions,
  SessionMetadata,
  Source,
  Workspace,
} from "./types.js";
export * from "./types.js";
export { UnlockError } from "./transport.js";
const id = encodeURIComponent;
/** Metadata only. Cookie material is intentionally absent from this entry point. */
export function createUnlockClient(options: ClientOptions) {
  const request = createTransport(options);
  return {
    workspace: (opts?: RequestOptions) =>
      request<Workspace>("workspace", "GET", undefined, opts),
    connections: {
      importCsv: (input: CsvImportInput, opts?: RequestOptions) =>
        request<CsvImportResult>("connections/import", "POST", input, opts),
      update: (
        connectionId: string,
        input: LoginUpdate,
        opts?: RequestOptions,
      ) =>
        request<Connection>(
          `connections/${id(connectionId)}`,
          "PATCH",
          input,
          opts,
        ),
      assign: (
        connectionId: string,
        profileIds: string[],
        opts?: RequestOptions,
      ) =>
        request<Profile[]>(
          `connections/${id(connectionId)}/access`,
          "PUT",
          { profileIds },
          opts,
        ),
      list: (opts?: RequestOptions) =>
        request<Connection[]>("connections", "GET", undefined, opts),
      connect: (input: ConnectInput, opts?: RequestOptions) =>
        request<Connection>("connections", "POST", input, opts),
      action: (
        connectionId: string,
        action: ConnectionAction,
        opts?: RequestOptions,
      ) =>
        request<Connection>(
          `connections/${id(connectionId)}/action`,
          "POST",
          { action },
          opts,
        ),
    },
    sessions: {
      list: (opts?: RequestOptions) =>
        request<SessionMetadata[]>("sessions", "GET", undefined, opts),
      action: (
        connectionId: string,
        action: ConnectionAction,
        opts?: RequestOptions,
      ) =>
        request<Connection>(
          `connections/${id(connectionId)}/action`,
          "POST",
          { action },
          opts,
        ),
    },
    profiles: {
      list: (opts?: RequestOptions) =>
        request<Profile[]>("profiles", "GET", undefined, opts),
      create: (input: ProfileInput, opts?: RequestOptions) =>
        request<Profile>("profiles", "POST", input, opts),
      update: (
        profileId: string,
        input: Partial<
          Pick<
            Profile,
            "name" | "description" | "enabled" | "connectionIds" | "avatar"
          >
        >,
        opts?: RequestOptions,
      ) => request<Profile>(`profiles/${id(profileId)}`, "PATCH", input, opts),
    },
    sources: {
      list: (opts?: RequestOptions) =>
        request<Source[]>("sources", "GET", undefined, opts),
      update: (sourceId: string, connected: boolean, opts?: RequestOptions) =>
        request<Source>(
          `sources/${id(sourceId)}`,
          "PATCH",
          { connected },
          opts,
        ),
    },
    clients: {
      create: (input: ClientInput, opts?: RequestOptions) =>
        request<OAuthClient>("clients", "POST", input, opts),
    },
    settings: {
      update: (input: Workspace["settings"], opts?: RequestOptions) =>
        request<Workspace["settings"]>("settings", "PATCH", input, opts),
    },
    reset: (opts?: RequestOptions) =>
      request<Workspace>("reset", "POST", {}, opts),
  };
}
