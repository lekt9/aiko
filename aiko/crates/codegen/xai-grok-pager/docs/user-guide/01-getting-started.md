# Getting Started

> **Aiko TUI docs.** The user binary is `aiko`. Crate/`~/.grok/` names are compatibility identifiers.

**Aiko** is a terminal-based AI coding assistant from SpaceXAI. It runs as a TUI that understands your codebase, executes shell commands, edits files, searches the web, and manages tasks.

You can use it interactively as a full-screen TUI, run it headlessly for scripting and CI/CD, or integrate it into editors via the Agent Client Protocol (ACP).

The crate next to this guide is named `xai-grok-pager`. That is an implementation name. The user binary is `aiko`.

---

## Installation

From a clone of [`github.com/lekt9/aiko`](https://github.com/lekt9/aiko):

```bash
cd aiko   # Rust host directory in the monorepo
scripts/contract-runtime.sh install
export PATH="$HOME/bin:$PATH"
aiko --version
```

Or download a published installer from the
[latest GitHub release](https://github.com/lekt9/aiko/releases/latest).
Do **not** install from `https://x.ai/cli/install.sh` — that is a different product.

Verify:

```bash
aiko --version
```

Full install options (portable tarball, desktop) live in the
[product README](../../../../../README.md).

---

## First Launch

```bash
aiko
```

On first launch, run `aiko login`. The default session path uses the public
Aiko proxy (`https://aiko.theclarityproject.net`). You do not paste a
provider key for ordinary use.

Compatibility note: some config still lives under `~/.grok/` because the
runtime retained those paths. Prefer `aiko` on the command line.

If you must use a provider key (CI, BYOK), see [Authentication](02-authentication.md)
and [`docs/providers`](../../../../../docs/providers/README.md).

---

## Basic Interaction

Once authenticated, Aiko presents a full-screen TUI with two main areas:

- **Scrollback** -- the conversation history showing your prompts, Aiko's responses, tool calls, file edits, and more.
- **Prompt** -- the input area at the bottom where you type messages.

Type a message and press `Enter` to send it. Aiko reads files, runs commands, and edits code as needed. Each tool run streams into the scrollback in real time.

Press `Tab` to move focus between the prompt and the scrollback. While a turn is running, `Ctrl+C` cancels it (or clears a non-empty draft first); `Esc` is a no-op mid-turn. Idle, press `Esc` twice within 800ms to clear a non-empty prompt, or (with an empty prompt and conversation messages) to open rewind — see [Keyboard Shortcuts](03-keyboard-shortcuts.md#escape). With the scrollback focused, use the arrow keys to select entries and to collapse or expand them. To navigate with `j`/`k` and fold with `h`/`l` instead, enable Vim mode.

### File References

Use `@` in your prompt to attach files:

```
@src/main.rs              # Attach a file
@src/main.rs:10-50        # Attach lines 10-50
@src/                     # Browse a directory
```

The `@` operator opens a fuzzy file picker. By default it respects `.gitignore` and hides dotfiles. Prefix with `!` to search hidden files:

```
@!.github                 # Search hidden files
@!.env                    # Attach a .env file
```

### Permissions

By default, Aiko asks for permission before executing shell commands or editing files. You can approve individually or toggle always-approve mode:

- Press `Ctrl+O` to toggle always-approve mode
- Use the `--yolo` flag at launch: `grok --yolo`
- Type `/always-approve` in the prompt to toggle the mode

---

## Key Concepts

### Sessions

Every conversation is a **session**. Sessions are automatically saved to `~/.grok/sessions/` and can be resumed later. Each session tracks the full conversation history, tool calls, file edits, and task state.

- Start a new session: `Ctrl+N` or `/new`
- Resume a previous session: `/resume` in the TUI, or `--resume <ID>` from the CLI
- Continue the most recent session: `grok -c`

### Scrollback

The scrollback is the main display area. It shows:

- **User prompts** -- your messages, rendered as sticky headers
- **Agent messages** -- Aiko's responses with full markdown rendering and syntax highlighting
- **Thinking blocks** -- Aiko's reasoning process (collapsible)
- **Tool calls** -- file edits (with inline diffs), command executions, search results, and more
- **Task lists** -- TODO items tracking progress

Collapse or expand the selected entry with the `Left`/`Right` arrow keys (or `h`/`l` and `e` in Vim mode). In Vim mode, press `y` to copy its content and `Y` to copy its metadata (for example, the command that ran). Press `Enter` to open it in the fullscreen viewer (in any mode).

### Tools

Aiko has built-in tools for:

| Tool | Description |
|------|-------------|
| `read_file` / `search_replace` | Read and edit files with line-precise changes |
| `grep` | Regex search across your codebase (powered by ripgrep) |
| `list_dir` | List directory contents |
| `run_terminal_command` | Execute shell commands |
| `web_search` / `web_fetch` | Search the web and fetch URLs |
| `todo_write` | Create and manage task lists |
| `spawn_subagent` | Spawn parallel subagent sessions |
| `memory_search` | Search cross-session memory |

Tools can be extended with [MCP servers](05-configuration.md#mcp-servers) for integrations like GitHub, databases, and more.

### Slash Commands

Type `/` in the prompt to access commands. These provide quick actions without writing a full prompt:

```
/model grok-build                 # Switch model
/compact                          # Compress conversation history
/always-approve                   # Toggle always-approve mode
/new                              # Start a new session
```

See [Slash Commands](04-slash-commands.md) for the complete reference.

---

## Common Launch Options

```bash
# Launch the interactive TUI and submit an initial prompt as the first turn
grok "fix the failing auth test and run it"

# Initial prompt in a new git worktree. Use --worktree=<name> (with `=`) so the
# prompt isn't swallowed as the worktree name — `grok -w "refactor module X"`
# would treat "refactor module X" as the worktree label, not the prompt.
grok --worktree=feat "refactor module X"

# Base the worktree on a specific branch (e.g. main) instead of the current HEAD:
grok -w --ref main "implement feature from main"


# Start in a specific project directory
grok --cwd ~/projects/my-app

# Add project-specific rules
grok --rules "Always use TypeScript. Prefer functional components."

# Auto-approve all tool executions
grok --yolo

# Use a specific model
grok -m grok-build

# Resume a previous session
grok --resume <session-id>

# Continue the most recent session
grok -c

# Experimental scrollback-native render mode. Sticky: plain `aiko` reopens in
# the mode last chosen via --minimal/--fullscreen (or /minimal//fullscreen).
grok --minimal

# Back to the standard fullscreen TUI (and make it sticky again)
grok --fullscreen

# Headless mode (for scripts)
aiko --single "Explain this codebase"
```

---

## Headless Mode

Run Aiko non-interactively for scripting, CI/CD, and automation:

```bash
aiko --single "Your prompt here"
```

Output formats:

| Format | Flag | Description |
|--------|------|-------------|
| `plain` | (default) | Human-readable text |
| `json` | `--output-format json` | Single JSON object with `text`, `stopReason`, `sessionId`, and `requestId` |
| `streaming-json` | `--output-format streaming-json` | NDJSON event stream for real-time processing |

Example CI/CD usage:

```bash
aiko --single "Review changes for bugs" --output-format json --yolo | jq -r '.text'
```

---

## Project Rules (AGENTS.md)

Add per-project instructions by creating an `AGENTS.md` file in your repository. Aiko reads these files and injects their contents as a project-instructions message at the start of the conversation:

```
~/.grok/AGENTS.md           # Global rules (apply to all projects)
<repo-root>/AGENTS.md       # Repository-level rules
<cwd>/AGENTS.md             # Directory-level rules (highest priority)
```

Deeper files take precedence. Aiko also reads `CLAUDE.md` files for compatibility.

---

## Where to Go Next

| Document | What You Will Learn |
|----------|-------------------|
| [Authentication](02-authentication.md) | Browser login, API keys, OIDC, external auth, device code flow |
| [Keyboard Shortcuts](03-keyboard-shortcuts.md) | Complete reference for all key bindings |
| [Slash Commands](04-slash-commands.md) | All available `/` commands |
| [Configuration](05-configuration.md) | config.toml, pager.toml, environment variables |
