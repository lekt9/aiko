import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import { DynamicTools, type DynamicToolGrant } from "./dynamic-tools.ts";
import { composioMetaTools, composioSession } from "./composio.ts";
import { agentmailSession, agentmailTools } from "./agentmail.ts";
import type { ConnectorStore } from "./connectors.ts";
import { redactor, safeUserId } from "./security.ts";

export interface IntegrationConfig {
  owners: readonly string[];
  composioKey?: string;
  agentmailKey?: string;
}
export function parseIntegrationOwners(value?: string): readonly string[] {
  const owners = value?.split(",").map(v => v.trim()).filter(Boolean) ?? [];
  if (owners.length > 1000 || owners.some(v => !safeUserId(v))) throw Error("Invalid integration owner allowlist");
  return [...new Set(owners)];
}
export const INTEGRATION_INSTRUCTIONS = "For external API integrations, prefer integration_list and integration_tools with server=composio. These native tools expose the live Composio session meta-tool schemas; do not enumerate a static app catalog. Call integration_call with the exact tool and schemaDigest. COMPOSIO_SEARCH_TOOLS discovers app tools and connection status; COMPOSIO_GET_TOOL_SCHEMAS describes them; COMPOSIO_MULTI_EXECUTE_TOOL executes discovered read-only app calls. COMPOSIO_MANAGE_CONNECTIONS delivers private Connect Link buttons only to the current authenticated Telegram owner. Never put authorization links in prose or claim that delivery means connected; recheck connection state before continuing. This rollout permits provider-tagged read-only API tools, not API writes, remote bash, workbench or proxy execution. Use server=agentmail for this owner's isolated inbox creation/status when requested. API connections are not browser SSO sessions. Use the existing private website sign-in path for cookies and supported SSO/OTP handoffs; never retrieve sign-in codes or links into the model or use another owner's inbox. Unknown results must not be retried. integration_disconnect disables this thread's dispatch; it does not revoke upstream OAuth grants. Existing tool_router_* continues to discover local/browser/retained capabilities and legacy connectors.";

export function configuredIntegrations(options: {
  owner: string;
  thread: string;
  instance: string;
  config: IntegrationConfig;
  store: ConnectorStore;
  current(): boolean | Promise<boolean>;
  read(): Promise<readonly Event[]>;
  deliverLinks(links: string[], signal: AbortSignal): Promise<"delivered" | "unknown" | "rejected">;
}): DynamicTools | undefined {
  const { owner, thread } = options;
  const config = { ...options.config, owners: [...options.config.owners] };
  // Foreground only. Child workers need a separately narrowed grant, not merely
  // the same account id. Deployment eligibility is not a model-supplied argument.
  if (!config.owners.includes(owner) || thread !== `user-${owner}` || !safeUserId(owner)) return;
  const grants: DynamicToolGrant[] = [];
  const revision = (key: string) => createHash("sha256").update(key).digest("hex");
  if (config.composioKey) grants.push({ id: "composio", revision: `readonly-v1-${revision(config.composioKey)}`, description: "Live Composio API discovery, private app authorization and read-only session execution", tools: composioMetaTools });
  if (config.agentmailKey) grants.push({ id: "agentmail", revision: `mailbox-v1-${revision(config.agentmailKey)}`, description: "Your isolated AgentMail inbox; no cross-owner mail or model-visible OTPs", tools: agentmailTools });
  if (!grants.length) return;
  const current = async () => options.config.owners.includes(owner) && options.config.composioKey === config.composioKey && options.config.agentmailKey === config.agentmailKey && await options.current();
  const currentTelegram = async (turn?: string) => {
    if (!turn || !await current()) return false;
    const latest = (await options.read()).findLast(e => e.type === "MessageReceived");
    return latest?.id === turn && latest.source === "telegram" && String(latest.sender) === owner && String(latest.chat) === owner;
  };
  return new DynamicTools({ owner, thread, servers: () => grants, current,
    redact: redactor([config.composioKey ?? "", config.agentmailKey ?? ""]),
    connect: async (grant, signal) => grant.id === "composio"
      ? composioSession({ ...options, apiKey: config.composioKey!, current, canConnect: currentTelegram }, signal)
      : agentmailSession({ ...options, apiKey: config.agentmailKey!, current, canProvision: currentTelegram }),
  });
}
