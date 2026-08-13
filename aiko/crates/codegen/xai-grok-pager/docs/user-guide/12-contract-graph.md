# Contract & Graph Engine

> **Aiko TUI docs.** The user binary is `aiko`. Crate/`~/.grok/` names are compatibility identifiers.

Aiko ships with a native Contract substrate and a graph engineering engine that runs every turn. This guide shows you how to use them and what you'll see in the TUI.

---

## What you see in the TUI

Every turn, Aiko emits a **graph verdict** chip. You'll see one of these in the scrollback:

**Chain (sequential — one thing at a time):**

```
graph: chain · 3 obligations · proceed sequentially
```

**FAN-OUT (parallel — independent work groups):**

```
graph: FAN-OUT · 3 independent groups · 5 obligations · 3 ready now
```

| Field | What it means |
|-------|---------------|
| `kind` | `chain` = linear dependency chain. `graph` = at least one fan-out point |
| `obligation_count` | Total pending work units this turn |
| `peak_parallelism` | Widest fan-out possible right now |
| `ready_count` | Obligations with no blocking dependency |
| `group_count` | Mutually independent obligation groups |

### Why this matters

A `chain` verdict means every step depends on the previous one — adding more agents or parallelizing won't help. A `FAN-OUT` verdict means some steps can run in parallel. The graph engine computes this automatically from the skill plan's declared dependencies each turn.

---

## Contract tasks

Register multi-step work with evidence. Every substantive task gets a durable identifier and a machine-checked postcondition.

### Begin a task

```bash
contract task begin "build the feature" --check "cargo test -p my-crate 2>&1"
```

This registers the goal and the check command. After your work completes, verify:

```bash
contract task verify <task-id>
```

### The algorithm

Before shipping any work, walk the five-step algorithm:

```
algorithm: question,delete,simplify,accelerate,automate
```

| Step | Action |
|------|--------|
| **question** | Challenge every requirement. Who asked? What breaks if removed? |
| **delete** | Remove what fails step 1. Target ~10% restoration. |
| **simplify** | Unify what remains — only after delete. |
| **accelerate** | Shorten build/test/review loops on the lean shape. |
| **automate** | Last. Never automate something that should not exist. |

Order is load-bearing: `question → delete → simplify → accelerate → automate`.

---

## Provider & model system

### Commands

```bash
# Login to a provider
aiko login              # Configuration-aware default
aiko login aiko         # Built-in Aiko OAuth profile
aiko login grok         # Built-in Grok/xAI OAuth profile
aiko login openai       # OpenAI ChatGPT PKCE OAuth
aiko login codex        # Compatibility spelling for OpenAI
aiko login --device-auth  # Headless device-code flow

# Switch models in the TUI
/model codex            # Switch to Codex (gpt-5.6-sol)
/model deepseek-v4-pro  # Switch to DeepSeek
Ctrl+M                  # Interactive model picker

# CLI flags
aiko -m codex           # Start session on Codex
aiko models             # List available models
```

### Codex (ChatGPT) OAuth flow

```
┌─────────┐     PKCE     ┌──────────────┐     code      ┌──────────────┐
│  aiko   │─────────────▶│ auth.openai.  │◀──────────────│  Browser     │
│ login   │              │ com           │               │  (user auth) │
│ codex   │◀─────────────│ (token exch.) │──────────────▶│              │
└────┬────┘   access +   └──────────────┘   redirect    └──────────────┘
     │      refresh token                                localhost:1455
     ▼
┌──────────────┐     Bearer      ┌──────────────────────────────┐
│ ~/.codex/    │────────────────▶│ chatgpt.com/backend-api/     │
│ auth.json    │                 │ codex/responses (Responses   │
│              │                 │ API, gpt-5.6-sol, 270k ctx)  │
└──────────────┘                 └──────────────────────────────┘
```

The token auto-refreshes 300s before expiry. If you ran `codex login` from the official CLI, Aiko picks up the same `~/.codex/auth.json` — no extra login needed.

### Adding custom providers

```toml
# ~/.grok/config.toml
[model.claude-sonnet]
model = "claude-sonnet-5"
base_url = "https://api.anthropic.com/v1"
name = "Claude Sonnet 5"
api_backend = "messages"
env_key = "ANTHROPIC_API_KEY"
context_window = 200000

[model.grok-4]
model = "grok-4.3"
base_url = "https://api.x.ai/v1"
name = "Aiko 4.3"
api_backend = "chat_completions"
env_key = "XAI_API_KEY"
context_window = 1000000
```

After adding to `config.toml`, the models appear in `Ctrl+M` and `/model <name>`.

### Credential resolution order

For each model, Aiko resolves credentials in this order:

```
1. Model-specific api_key    (inline in config.toml)
2. Model-specific env_key    (environment variable)
3. Session token             (from aiko login / OIDC)
4. Global XAI_API_KEY        (fallback)
5. OAuth (Codex)             (from ~/.codex/auth.json, auto-refresh)
```

---

## Full command map

| Command | What it does | Turn effect |
|---------|-------------|-------------|
| `aiko` | Launch interactive TUI | — |
| `aiko -m <model>` | Start on a specific model | Sets sampler config |
| `aiko login` | Configuration-aware default login | Writes `~/.grok/auth.json` |
| `aiko login aiko` | Built-in Aiko OAuth profile | Writes `~/.grok/auth.json` |
| `aiko login grok` | Built-in Grok/xAI OAuth profile | Writes `~/.grok/auth.json` |
| `aiko login openai` / `aiko login codex` | OpenAI ChatGPT PKCE OAuth | Writes `~/.codex/auth.json` |
| `aiko login --device-auth` | Headless device-code flow | Polls auth server |
| `aiko logout [aiko\|grok\|openai\|codex]` | Clear active or selected provider credentials | Removes the selected auth scope/file |
| `aiko models` | List available models | Reads catalog + user config |
| `/model <name>` | Switch model mid-session | Reselects sampler config |
| `Ctrl+M` | Interactive model picker | TUI overlay |
| `contract task begin` | Register work with check | Durable task in ledger |
| `contract task verify` | Verify postcondition | Runs check command |
| `algorithm:` | Ship-preflight (5 steps) | Gates completion |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Aiko CLI (TUI)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ /model,     │  │ contract     │  │ graph verdict  │  │
│  │ Ctrl+M      │  │ task begin   │  │ chip (every    │  │
│  │ (picker)    │  │ / verify     │  │ turn)          │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│  ┌──────▼────────────────▼───────────────────▼────────┐  │
│  │              xai-grok-shell                        │  │
│  │  ┌──────────┐  ┌────────────┐  ┌───────────────┐  │  │
│  │  │ resolve_ │  │ contract_  │  │ graph_plan_   │  │  │
│  │  │ creds()  │  │ native.rs  │  │ analyze()     │  │  │
│  │  └────┬─────┘  └─────┬──────┘  └──────┬────────┘  │  │
│  └───────┼──────────────┼───────────────┼────────────┘  │
│          │              │               │                │
│  ┌───────▼──────┐ ┌─────▼──────┐ ┌──────▼────────────┐  │
│  │ codex_oauth  │ │ Contract   │ │ graph_plan.zig   │  │
│  │ (PKCE flow)  │ │ substrate  │ │ (Zig native ABI) │  │
│  │              │ │ (libcontract│ │                  │  │
│  │ auth.openai. │ │  .dylib)   │ │ obligation FSM   │  │
│  │ com          │ │            │ │ + Kahn frontier  │  │
│  └──────────────┘ └────────────┘ └──────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                Contract substrate                         │
│  ┌────────────────────────────────────────────────────┐  │
│  │  validate → commit → dispatch → settle → train     │  │
│  │  (every tool call crosses this membrane)           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```
