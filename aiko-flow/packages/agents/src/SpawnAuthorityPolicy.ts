export type AikoCredentialProvider = "anthropic" | "google" | "openai" | "xai";

export type AikoSpawnAccount = {
  id: string;
  provider: AikoCredentialProvider;
  generation: string;
  credential: { name: string; value: string };
};

export type AikoSpawnAuthorityOptions = {
  workspaceRoot: string;
  cwd?: string;
  runtimeEnv: Partial<Record<"PATH" | "TMPDIR" | "TMP" | "TEMP" | "LANG" | "LC_ALL" | "NO_COLOR" | "TERM", string>>;
  account: AikoSpawnAccount;
  agent?: {
    model?: string;
    agentName?: string;
    systemPrompt?: string;
    maxTurns?: number;
    effort?: string;
    extraArgs?: string[];
  };
};

export type AikoSpawnDiagnostics = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
