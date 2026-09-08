import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerGrant } from "./general-mcp.ts";

export interface McpStdioServer extends McpServerGrant {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}
/** Local-only adapter. Command/args/env come from explicit operator configuration, never model arguments. */
export function mcpStdioConnector(config: () => readonly McpStdioServer[]) {
  return async (grant: McpServerGrant, signal: AbortSignal) => {
    const server = config().find(
      (s) => s.id === grant.id && s.revision === grant.revision,
    );
    if (
      !server ||
      !server.command.startsWith("/") ||
      !server.cwd.startsWith("/")
    )
      throw Error(
        "MCP stdio requires a registered absolute executable and workspace",
      );
    const client = new Client({ name: "aiko-native-mcp", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env ?? {},
      stderr: "pipe",
    });
    // Drain privately; process stderr is never copied to the model or native journal.
    transport.stderr?.on("data", () => {});
    try {
      await client.connect(transport, { signal, timeout: 30_000 });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  };
}
