import type { BaseCliAgentOptions } from "./BaseCliAgent";

/**
 * Configuration options for the AikoAgent.
 */
export type AikoAgentOptions = BaseCliAgentOptions & {
  /** Model ID (maps to `--model`; see `aiko models` for the available list) */
  model?: string;
  /** Aiko agent name or definition file path (maps to `--agent`) */
  agentName?: string;
  /** Continue the most recent session for the working directory (`--continue`) */
  continueSession?: boolean;
  /** Resume a specific session by ID (`--resume <SESSION_ID>`) */
  sessionId?: string;
  /** Maximum number of agent turns (`--max-turns`) */
  maxTurns?: number;
  /**
   * Permission mode (`--permission-mode`). When unset, `yolo` (the
   * BaseCliAgent default) maps to `bypassPermissions` so headless runs never
   * block on an approval prompt.
   */
  permissionMode?: "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";
};
