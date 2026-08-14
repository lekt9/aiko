// Fixture agents.ts for the aiko harness-within-the-harness gate
// (e2e/aiko-harness-gate.sh). Mirrors the shape `smithers init` generates via
// generateAgentsTs() — the aiko provider line below is byte-identical to the
// CONSTRUCTORS["aiko"] entry in apps/cli/src/agent-detection.js, so this
// fixture exercises the same import path (`smthrs` re-exporting AikoAgent
// from @smthrs/agents) that generated workspaces use.
import { type AgentLike } from "smthrs";
import { AikoAgent as SmithersAikoAgent } from "smthrs";

export const providers = {
  aiko: new SmithersAikoAgent(),
} as const;

export const agents: Record<string, AgentLike> = {
  smart: providers.aiko,
};
