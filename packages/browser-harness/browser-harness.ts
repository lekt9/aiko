/**
 * Public Bun library entrypoint. All browser work stays in the same trusted
 * controller used by the playground; importing this module performs no setup.
 */
import { randomUUID } from "node:crypto"
import { browseThread, type BrowseThreadOptions, type BrowseThreadResult } from "./browse-thread"

export type BrowserTaskOptions = Omit<BrowseThreadOptions, "threadId"> & {
  /** Omit for a fresh isolated run. Explicit IDs must be opaque and single-writer. */
  readonly threadId?: string
}

/** Runs one task, settling capture and cleanup before returning. No browser state is retained. */
export const runBrowserTask = (options: BrowserTaskOptions): Promise<BrowseThreadResult> =>
  browseThread({ ...options, threadId: options.threadId ?? `browse-${randomUUID().replaceAll("-", "")}` })

export { BrowseThreadError, validateBrowseThreadBaseUrl } from "./browse-thread"
export type {
  BrowseThreadResult, BrowseThreadErrorCode, BrowseThreadBrowserAgentOptions,
  BrowserTraceSink
} from "./browse-thread"
export {
  AGENT_BROWSER_AGENT_TOOL_DESCRIPTORS, AGENT_BROWSER_AGENT_TOOL_DEFINITIONS,
  agentBrowserAgentToolCallOf, AGENT_BROWSER_PINNED_VERSION, AgentBrowserClientError
} from "./src/agent-browser-client"
export type { AgentBrowserAgentAction, AgentBrowserAgentToolCall } from "./src/agent-browser-client"
export { DEFAULT_AGENT_BROWSER_AGENT_LIMITS, AgentBrowserAgentError } from "./src/agent-browser-agent"
export type { AgentBrowserAgentLimits } from "./src/agent-browser-agent"
export type { BrowserBackend } from "./src/cloak-browser"
export type { BrowseHarnessDebugEntry } from "./src/browse-harness-contract"
export type { BrowserTraceEvent } from "./src/browser-trace"
export type { BrowserNetworkToolIndex } from "./src/network-tool-catalog"
