import type { McpBinding, McpServerGrant } from "./general-mcp.ts";
import { mcpHttpConnector, type McpHttpServer } from "./general-mcp-http.ts";
import { safeUserId } from "./security.ts";

export interface ConfiguredMcpServer extends McpServerGrant {
  url: string;
  /** Environment variable names, never credential values in public configuration. */
  headerRefs?: Readonly<Record<string, string>>;
}
export type ConfiguredMcpServers = Readonly<
  Record<string, readonly ConfiguredMcpServer[]>
>;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

/** Trusted deployment configuration. Repository/plugin metadata never enters this parser. */
export function parseMcpServers(raw: string | undefined): ConfiguredMcpServers {
  if (!raw?.trim()) return {};
  if (Buffer.byteLength(raw) > 262144)
    throw Error("MCP server configuration exceeds 256 KiB");
  const config: unknown = JSON.parse(raw);
  if (!record(config) || Object.keys(config).length > 1000)
    throw Error("Invalid owner MCP server configuration");
  for (const [owner, servers] of Object.entries(config)) {
    if (!safeUserId(owner) || !Array.isArray(servers) || servers.length > 32)
      throw Error("Invalid owner MCP server list");
    const ids = new Set<string>();
    for (const server of servers) {
      if (
        !record(server) ||
        Object.keys(server).some(
          (k) =>
            ![
              "id",
              "revision",
              "description",
              "tools",
              "url",
              "headerRefs",
            ].includes(k),
        ) ||
        !identifier(server.id) ||
        ids.has(server.id) ||
        !identifier(server.revision) ||
        typeof server.description !== "string" ||
        server.description.length > 4000 ||
        typeof server.url !== "string" ||
        server.url.length > 2048 ||
        !record(server.tools) ||
        Object.keys(server.tools).length > 256 ||
        Object.entries(server.tools).some(
          ([name, effect]) =>
            !identifier(name) || (effect !== "read" && effect !== "write"),
        )
      )
        throw Error("Invalid MCP server grant");
      ids.add(server.id);
      let endpoint: URL;
      try {
        endpoint = new URL(server.url);
      } catch {
        throw Error("Invalid MCP endpoint");
      }
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search
      )
        throw Error(
          "MCP endpoint requires HTTPS; credentials belong in header references",
        );
      if (
        server.headerRefs !== undefined &&
        (!record(server.headerRefs) ||
          Object.keys(server.headerRefs).length > 32 ||
          Object.entries(server.headerRefs).some(
            ([header, ref]) =>
              !/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(header) ||
              [
                "host",
                "content-length",
                "content-type",
                "accept",
                "connection",
              ].includes(header.toLowerCase()) ||
              typeof ref !== "string" ||
              !/^[A-Z_][A-Z0-9_]{0,127}$/.test(ref),
          ))
      )
        throw Error("Invalid MCP credential header references");
    }
  }
  return config as ConfiguredMcpServers;
}

/** Both hosts use this same HTTP binding; stdio remains an explicit local host adapter. */
export function configuredMcpBinding(options: {
  owner: string;
  thread: string;
  servers: ConfiguredMcpServers | (() => ConfiguredMcpServers);
  env: Readonly<Record<string, unknown>>;
  current: () => boolean | Promise<boolean>;
  redact: (value: string) => string;
  fetch?: typeof fetch;
}): McpBinding | undefined {
  const configured = () =>
    typeof options.servers === "function" ? options.servers() : options.servers;
  const servers = () => configured()[options.owner] ?? [];
  if (!servers().length) return undefined;
  const usedSecrets = new Set<string>();
  const resolve = (server: ConfiguredMcpServer): McpHttpServer => {
    const headers = Object.fromEntries(
      Object.entries(server.headerRefs ?? {}).map(([header, ref]) => {
        const value = options.env[ref];
        if (
          typeof value !== "string" ||
          !value ||
          value.length > 8192 ||
          /[\r\n\0]/.test(value)
        )
          throw Error("MCP credential reference is unavailable");
        usedSecrets.add(value);
        const token =
          header.toLowerCase() === "authorization"
            ? /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1]
            : undefined;
        if (token) usedSecrets.add(token);
        if (usedSecrets.size > 4096)
          throw Error(
            "MCP credential rotation limit reached; reload the binding",
          );
        return [header, value];
      }),
    );
    return { ...server, headers };
  };
  const connector = mcpHttpConnector(
    () => servers().map(resolve),
    options.fetch,
  );
  const redact = (value: string) => {
    let text = options.redact(value);
    for (const server of servers())
      for (const [header, ref] of Object.entries(server.headerRefs ?? {})) {
        const secret = options.env[ref];
        if (typeof secret !== "string" || !secret) continue;
        text = text.replaceAll(secret, "[redacted]");
        const token =
          header.toLowerCase() === "authorization"
            ? /^(?:Bearer|Basic)\s+(.+)$/i.exec(secret)?.[1]
            : undefined;
        if (token) text = text.replaceAll(token, "[redacted]");
      }
    for (const secret of usedSecrets)
      text = text.replaceAll(secret, "[redacted]");
    return text;
  };
  return {
    owner: options.owner,
    thread: options.thread,
    servers: () =>
      servers().map(({ id, revision, description, tools }) => ({
        id,
        revision,
        description,
        tools,
      })),
    current: async (grant) => {
      try {
        return (
          (await options.current()) &&
          servers().some(
            (server) =>
              server.id === grant.id &&
              server.revision === grant.revision &&
              !!resolve(server),
          )
        );
      } catch {
        return false;
      }
    },
    connect: connector,
    redact,
  };
}
