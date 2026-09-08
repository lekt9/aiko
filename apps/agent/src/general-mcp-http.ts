import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerGrant } from "./general-mcp.ts";

export interface McpHttpServer extends McpServerGrant {
  url: string;
  headers?: Readonly<Record<string, string>>;
}
/** The operator pins endpoint and credentials; model/server content cannot retarget transport. */
export function mcpHttpConnector(
  config: () => readonly McpHttpServer[],
  fetchImpl: typeof fetch = fetch,
) {
  return async (grant: McpServerGrant, signal: AbortSignal) => {
    const server = config().find(
      (s) => s.id === grant.id && s.revision === grant.revision,
    );
    if (!server) throw Error("MCP endpoint is no longer configured");
    const endpoint = new URL(server.url);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw Error("MCP endpoints require trusted HTTPS URLs");
    const client = new Client({ name: "aiko-native-mcp", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: server.headers },
      fetch: async (url, init) => {
        const current = config().find(
          (s) => s.id === grant.id && s.revision === grant.revision,
        );
        if (!current || new URL(current.url).href !== endpoint.href)
          throw Error("MCP endpoint configuration changed");
        const target = new URL(url instanceof Request ? url.url : String(url));
        if (
          target.origin !== endpoint.origin ||
          target.pathname !== endpoint.pathname ||
          target.search !== endpoint.search ||
          target.username ||
          target.password
        )
          throw Error("MCP transport attempted an unconfigured endpoint");
        const headers = new Headers(init?.headers);
        for (const name of Object.keys(server.headers ?? {}))
          headers.delete(name);
        for (const [name, value] of Object.entries(current.headers ?? {}))
          headers.set(name, value);
        return fetchImpl(url, {
          ...init,
          headers,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(60_000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
      },
    });
    try {
      await client.connect(transport, { signal, timeout: 30_000 });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  };
}
