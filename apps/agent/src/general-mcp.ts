import { DynamicTools, type DynamicToolBinding } from "./dynamic-tools.ts";

// Keep the existing MCP API and recorded tool names compatible. SDK integrations
// use the same runtime with the integration namespace, not a parallel executor.
export type { DynamicToolBinding as McpBinding, DynamicToolGrant as McpServerGrant } from "./dynamic-tools.ts";
export class GeneralMcp extends DynamicTools {
  constructor(binding: DynamicToolBinding) { super(binding, "mcp_server"); }
}
