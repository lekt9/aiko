import { z } from "@unlock/protocol";
import type { VaultAgent } from "./agent.js";
import { UnlockError } from "./transport.js";
/** The deliberately small model-facing surface. Cookie APIs are never registered. */
export function createAgentTools(agent: VaultAgent) {
  return {
    unlock_logins: {
      description:
        "List login metadata approved for this agent. No passwords or cookies.",
      inputSchema: z.object({}).strict(),
      async execute(input: unknown) {
        z.object({}).strict().parse(input);
        return (await agent.connections()).map(
          ({ id, name, identity, website }) => ({
            id,
            name,
            identity,
            website,
          }),
        );
      },
    },
  };
}
export interface MetadataMcpServer {
  registerTool(
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodType> },
    handler: (args: Record<string, unknown>) => Promise<{
      content: { type: "text"; text: string }[];
      isError?: boolean;
    }>,
  ): unknown;
}
/** Mount into the host's maintained MCP server. Authentication belongs to the host transport. */
export function registerUnlockMetadataTools(
  server: MetadataMcpServer,
  agent: VaultAgent,
) {
  for (const [name, tool] of Object.entries(createAgentTools(agent)))
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema.shape },
      async (args) => {
        try {
          return {
            content: [
              { type: "text", text: JSON.stringify(await tool.execute(args)) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: {
                    code:
                      error instanceof UnlockError
                        ? error.code
                        : "INVALID_INPUT",
                  },
                }),
              },
            ],
          };
        }
      },
    );
}
