import {
  BaseCliAgent,
  pushFlag,
  tryParseJson,
  isRecord,
  asString,
  asNumber,
  truncate,
  shouldSurfaceUnparsedStdout,
  createSyntheticIdGenerator,
} from "./BaseCliAgent/index.js";

/** @typedef {import("./BaseCliAgent/index.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./capability-registry/index.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./AikoAgentOptions.ts").AikoAgentOptions} AikoAgentOptions */

/** @typedef {import("./BaseCliAgent/index.ts").CliOutputInterpreter} CliOutputInterpreter */

/**
 * @param {AikoAgentOptions} [opts]  Currently unused — kept for API
 *   consistency with the other capability-registry factories (e.g.
 *   createOpenCodeCapabilityRegistry). Aiko does not expose a way to
 *   enumerate its built-in tool set per configuration, so the registry
 *   is static.
 * @returns {AgentCapabilityRegistry}
 */
export function createAikoCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    // "aiko" is not (yet) in the AgentCapabilityRegistry engine union; the
    // codebase already carries out-of-union engines at runtime (nanocodex),
    // and normalizeCapabilityRegistry passes the string through untouched.
    engine: /** @type {AgentCapabilityRegistry["engine"]} */ (/** @type {unknown} */ ("aiko")),
    runtimeTools: {},
    // `aiko mcp add --scope user|project` writes ~/.grok/config.toml or
    // ./.grok/config.toml (verified via `aiko mcp add --help`; the CLI is the
    // renamed grok shell, so its config home is ~/.grok/, not ~/.aiko/).
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    // Aiko installs skills through its plugin system (`aiko plugin install`);
    // no Smithers-managed skills are bundled for it yet.
    skills: {
      supportsSkills: true,
      installMode: "plugin",
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    // The verified streaming-json surface carries only `text` and `end`
    // events — no tool-call or file-change payloads — so file changes are
    // not reportable from the stream. Do not flip these without observing
    // a stream shape that clearly carries them.
    fileChanges: {
      supportsFileChanges: false,
      supportsUnifiedDiff: false,
    },
    // `--tools` accepts a comma-separated allow list but the CLI does not
    // enumerate the built-in tool names anywhere inspectable, so the set is
    // declared as the engine default rather than an invented list.
    builtIns: ["default"],
  };
}

/**
 * CLI agent wrapper for Aiko (the Contract-native agent CLI).
 *
 * Shells out to `aiko --single "<prompt>" --output-format streaming-json` in
 * headless mode. Parses AgentCliEvents from the nd-JSON stream.
 *
 * Usage:
 *   const agent = new AikoAgent({});
 *   const result = await agent.generate({
 *     messages: [{ role: "user", content: "Fix the bug" }],
 *   });
 */
export class AikoAgent extends BaseCliAgent {
  /** @type {AikoAgentOptions} */
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  /** @type {"aiko"} */
  cliEngine = "aiko";

  /**
   * @param {AikoAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.capabilities = createAikoCapabilityRegistry(opts);
  }

  /**
   * Create an output interpreter for Aiko's `--output-format streaming-json`.
   *
   * The verified stream (aiko 0.2.108, real runs) is one JSON object per
   * line with exactly two observed event types:
   *
   *   {"type":"text","data":"<chunk>"}                    — response text delta
   *   {"type":"end","stopReason":"EndTurn",
   *    "sessionId":"...","requestId":"...",
   *    "usage":{"input_tokens":N,"output_tokens":N,
   *             "reasoning_tokens":N,"total_tokens":N},
   *    "num_turns":N,"modelUsage":{...}}                  — terminal summary
   *
   * Even a prompt that drives a tool call surfaces only `text` and `end`
   * lines, so this interpreter reports text (plus usage/session from `end`)
   * and nothing else — no tool or file-change events are invented. The
   * terminal `completed` event is emitted from onExit, where the exit code
   * is known, because `end` carries no success/failure verdict beyond a
   * stopReason whose failure values are undocumented.
   *
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let fullText = "";
    let plainText = "";
    let sessionId = "";
    let didEmitStarted = false;
    /** @type {{ inputTokens: number; outputTokens: number; totalTokens: number } | null} */
    let usageTotals = null;

    const nextSyntheticId = createSyntheticIdGenerator();

    /**
     * @param {string} title
     * @param {string} message
     * @param {"warning" | "error"} [level]
     * @returns {import("./BaseCliAgent/index.ts").AgentCliEvent}
     */
    const warningAction = (title, message, level = "warning") => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("aiko-warning"),
        kind: "warning",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });

    /**
     * @param {string} text
     * @returns {import("./BaseCliAgent/index.ts").AgentCliEvent}
     */
    const textAction = (text) => ({
      type: "action",
      engine: this.cliEngine,
      phase: "updated",
      entryType: "message",
      action: {
        id: nextSyntheticId("aiko-text"),
        kind: "note",
        title: "assistant",
        detail: {},
      },
      message: text,
      ok: true,
      level: "info",
    });

    /** @returns {import("./BaseCliAgent/index.ts").AgentCliEvent[]} */
    const startedOnce = () => {
      if (didEmitStarted) return [];
      didEmitStarted = true;
      return [
        {
          type: "started",
          engine: this.cliEngine,
          title: "Aiko",
        },
      ];
    };

    /**
     * @param {string} line
     * @returns {import("./BaseCliAgent/index.ts").AgentCliEvent[]}
     */
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      const payload = tryParseJson(trimmed);

      // Not JSON — fall back to plain text emission. This is the model's
      // output when the format was overridden (e.g. extraArgs forcing
      // `--output-format plain`), or a banner. Keep it as answer fallback.
      if (!isRecord(payload)) {
        const events = startedOnce();
        if (shouldSurfaceUnparsedStdout(trimmed)) {
          events.push(warningAction("stdout", truncate(trimmed, 220)));
          return events;
        }
        plainText += (plainText ? "\n" : "") + trimmed;
        events.push(textAction(trimmed));
        return events;
      }

      const eventType = asString(payload.type);
      if (!eventType) return startedOnce();

      // --- text: response text delta ---
      if (eventType === "text") {
        const events = startedOnce();
        const text = asString(payload.data);
        if (text) {
          fullText += text;
          events.push(textAction(text));
        }
        return events;
      }

      // --- end: terminal summary with session id and token usage ---
      if (eventType === "end") {
        const events = startedOnce();
        const envelopeSessionId = asString(payload.sessionId);
        if (envelopeSessionId) {
          sessionId = envelopeSessionId;
        }
        const usage = isRecord(payload.usage) ? payload.usage : null;
        if (usage) {
          usageTotals = {
            inputTokens: asNumber(usage.input_tokens) ?? 0,
            outputTokens: asNumber(usage.output_tokens) ?? 0,
            totalTokens: asNumber(usage.total_tokens) ?? 0,
          };
        }
        return events;
      }

      // Unknown event type — the verified surface is text/end only; ignore
      // rather than guess at semantics.
      return startedOnce();
    };

    return {
      onStdoutLine: parseLine,

      onStderrLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        return [warningAction("stderr", truncate(trimmed, 220))];
      },

      onExit: (result) => {
        const events = startedOnce();
        const isSuccess = (result.exitCode ?? 0) === 0;
        const answer = fullText || plainText || undefined;
        events.push({
          type: "completed",
          engine: this.cliEngine,
          ok: isSuccess,
          answer: isSuccess ? answer : answer || undefined,
          resume: sessionId || undefined,
          error: isSuccess
            ? undefined
            : result.stderr.trim() || `Aiko exited with code ${result.exitCode ?? -1}`,
          usage: usageTotals ?? undefined,
        });
        return events;
      },
    };
  }

  /**
   * Build the CLI command spec for headless `aiko --single`.
   *
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
   */
  async buildCommand(params) {
    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    /** @type {string[]} */
    const args = [];

    // Model selection
    pushFlag(args, "--model", this.opts.model ?? this.model);

    // Working directory
    pushFlag(args, "--cwd", params.cwd);

    // Streaming nd-JSON output
    pushFlag(args, "--output-format", "streaming-json");

    // Named agent config
    pushFlag(args, "--agent", this.opts.agentName);

    // System prompt: `--rules` appends to the agent's system prompt without
    // replacing aiko's own harness prompt (`--system-prompt-override` would).
    // Verified headless: `aiko --single ... --rules "answer in uppercase"`
    // is honored.
    pushFlag(args, "--rules", params.systemPrompt || undefined);

    // Session continuation: a per-call resumeSession wins over the
    // configured sessionId; `--continue` picks up the most recent session
    // for the cwd. Note `-s/--session-id` names a NEW conversation and must
    // not be used for resume — `--resume <id>` is the resume flag.
    const explicitSession = resumeSession ?? this.opts.sessionId;
    if (explicitSession) {
      pushFlag(args, "--resume", explicitSession);
    } else if (this.opts.continueSession) {
      args.push("--continue");
    }

    // Reasoning effort: aiko exposes `--reasoning-effort` (alias --effort)
    // as a pass-through for reasoning models; the shared first-class
    // `effort` option maps straight onto it.
    const effort =
      (typeof this.opts.effort === "string" && this.opts.effort) ||
      (typeof this.effort === "string" && this.effort) ||
      undefined;
    pushFlag(args, "--reasoning-effort", effort);

    // Turn budget
    pushFlag(args, "--max-turns", this.opts.maxTurns);

    // Permission surface: an explicit permissionMode wins; otherwise yolo
    // (BaseCliAgent defaults it to true) maps to bypassPermissions so the
    // headless run never blocks on an approval prompt.
    const yoloEnabled = this.opts.yolo ?? this.yolo;
    const permissionMode = this.opts.permissionMode ?? (yoloEnabled ? "bypassPermissions" : undefined);
    pushFlag(args, "--permission-mode", permissionMode);

    // Extra args from constructor
    if (this.extraArgs?.length) {
      args.push(...this.extraArgs);
    }

    // Single-turn prompt last, as the flag value.
    const fullPrompt = params.prompt ?? "";
    args.push("--single", fullPrompt);

    return {
      command: "aiko",
      args,
      outputFormat: "stream-json",
      stdoutErrorPatterns: [/^error:/im, /^fatal:/im],
    };
  }
}
