---
name: machine-cockpit
description: "Channel-generic cockpit for wiring any mac seat: browser chat (port 8787) + per-provider setup (Telegram, Slack, Discord, webhook) with self-aware auth/bridge/pairing. Use when the user says 'wire Gbear', 'set up a new Mac', 'install aiko', 'give them a UI', 'hook up Telegram/Slack/Discord', 'make it friendly', or hands you an IP/user/password. Telegram is one provider, not the product."
---

# Machine Cockpit — channel-generic seat setup

Turn a bare macOS host into a chat-ready Aiko seat for **any** messaging channel: a browser cockpit on `:8787` plus per-provider wiring. Telegram was the first provider; the skill is provider-generic (Telegram is one `provider=telegram` row).

## What this does (provider-generic)

1. **Install Aiko** — assemble `target/aiko-package/aiko-<ver>-macos-aarch64.tar.gz`, ship + `install.sh` on target. Verifies `aiko --version`, `aiko-doctor`, `libcontract ABI`, `~/.local/bin` on PATH. Same-arch shortcut, no cross-compile.

2. **Cockpit** — `http://127.0.0.1:8787`:
   - UI: `assets/chat.html` — Chat tab (WebSocket ACP `aiko.acp.v1` to `aiko native serve` on `:19420`) + per-provider tabs (Telegram today, Slack/Discord next) rendered from `wiring[]`. Auto-handles `session/request_permission` + `x.ai/ask_user_question`.
   - Backend: `scripts/cockpit.py` (stdlib only) serves `__TOKEN__/__API_BASE__` from `~/.aiko/native/api.json`, wraps provider CLIs (`aiko native telegram ...` is `provider=telegram`) + `launchctl`. Generic endpoints: `GET /`, `GET /api/health`, `GET /api/self` (self.json + live), `GET /api/auth-aware`, `GET /api/<provider>/self-aware|status|check|log`, `POST /api/<provider>/{set-token,start,stop,approve-pair}`. Telegram keeps `GET /api/telegram/self-aware` as alias for compat.
   - Self-aware (decoupled, no daemon fork): cockpit is the brain, daemon stays dumb. `hint ∈ {not_signed_in, no_token, bridge_stopped, needs_pairing, waiting_first_message, ready}` drives the chat banner. `sendPrompt` checks `cachedAuth.signed_in` before ACP and shows "Not signed in → aiko login --device-code" sheet. First-contact: whoever messaged first is auto-approved when `approved==[] && signed_in` (pendingChats[0] → approvedUserIds).
   - Daemon: `aiko/target/release/telegram-daemon` → `~/.local/bin/telegram-daemon` for `provider=telegram` (other providers via `channel.register` below).
   - Launchd: `net.theclarityproject.aiko.cockpit` (`python3 cockpit.py`, KeepAlive+RunAtLoad, `AIKO_COCKPIT_PORT=8787`). Also leaves `~/Desktop/Aiko — Start Here.txt`.

3. **Provider wiring (example: Telegram)** — `@BotFather /newbot` → paste token → Save (masked `XXXX…YYYY`, `getMe` checked, `aiko native telegram set-token`) → Start bridge (launchd `net.theclarityproject.aiko.telegram-bridge`) → slash commands registered (`/start /help /status /login` via `setMyCommands`) → message bot → pairing (auto, or manual code) → Aiko dispatches via `agent_mail` with typing + media (photo/document/voice/audio/video) + inline keyboards. See `docs/channel-api.md` (generic) + `docs/telegram-api.md` (provider).

## Channels

| provider | token/credential | observe | send | presence | media in/out | commands | status hint same? |
|---|---|---|---|---|---|---|---|
| **telegram** | `@BotFather` token → `aiko native telegram set-token` | `getUpdates` poll | `sendMessage` (+ typing) | `sendChatAction` | `getFile` ↔ `sendPhoto/Document/Voice/Audio/Video` | `setMyCommands` `/start /help /status /login` | yes |
| **slack** | `SLACK_BOT_TOKEN` → `aiko native slack set-token` (future) | Events API / Socket Mode | `chat.postMessage` | typing via `conversations_typing` | `files.info` ↔ `files.upload` | `commands` + shortcuts | yes — same `wiring[].channel` shape |
| **discord** | `DISCORD_BOT_TOKEN` (future) | Gateway intents | `create_message` | typing | attachments ↔ uploads | `bulk_overwrite_guild_commands` | yes |
| **webhook/IMAP/SAP** | env var per `self-integrate` | poll/webhook per service | adapter verb | — | per OPENAPI verb list | — | yes |

Adding a provider = new `provider=` value, a `docs/<provider>-api.md` row, and a `channel.register` entry (see below). No changes to self-model, hint enum, or chat.html contract.

### Registering a new channel (without editing the skill prose)

```sh
# 1. Docs: add .agents/skills/machine-cockpit/docs/<provider>-api.md (contract table)
# 2. Script: add provider case to cockpit.py: read_<provider>_state() + routes /api/<provider>/self-aware
# 3. Contract: add .agents/skills/machine-cockpit/docs/<provider>-contracts.md (contracts per verb)
# 4. Self-model: wiring[] already generic — just push {id, channel: "<provider>", host, token masked, bridge:{state, hint}, artifacts}
# 5. UI: chat.html renders tabs from GET /api/self wiring[] (no hard-coded Telegram tab)
python3 .agents/skills/machine-cockpit/scripts/build-self.py  # refreshes self.json
./tests/machine-cockpit-self-aware-gate.sh --provider <provider>  # gate must go red if you revert cockpit
```

## When to use

- "wire Gbear / new Mac / this host / that IP" — any provider
- "make it friendly / give them a UI / hook up Telegram/Slack/Discord"
- handed `IP user password` triple

## Inputs

- `host`: `user@host` (gbear@100.104.x.x), `password` via `sshpass`/`--ask`/`AIKO_COCKPIT_PASSWORD`, `port` (8787), `aikoPort` (19420), `provider` (default: telegram, or `auto` to wire all configured)

## Steps (inside this machine, over SSH)

`ssh -F /dev/null -o PubkeyAuthentication=no` + `sshpass`, pipe files via `cat | ssh "cat > /tmp/..."` for auth safety, binaries via same.

### A — build & ship Aiko

```sh
pip3 install --break-system-packages pyyaml 2>&1 | tail -2
AIKO_PACKAGE_ONLY=1 bash -c 'source scripts/lib/aiko-env.sh; aiko_env_init; source scripts/lib/assemble-portable.sh; assemble_portable_tarball' 2>&1 | tail -3
sshpass ... scp -F /dev/null target/aiko-package/*.tar.gz gbear@HOST:/tmp/aiko-package.tar.gz
sshpass ... ssh ... gbear@HOST "mkdir -p ~/src/aiko-package && tar -xzf /tmp/aiko-package.tar.gz -C ~/src/aiko-package && bash ~/src/aiko-package/aiko-*/install.sh"
```

### B — ship cockpit + provider daemon

```sh
cargo build --manifest-path aiko/Cargo.toml -p xai-telegram-daemon --bin telegram-daemon --release
cat aiko/target/release/telegram-daemon | ssh ... "cat > /tmp/telegram-daemon.bin && install -m 755 /tmp/telegram-daemon.bin ~/.local/bin/telegram-daemon"
cat .agents/skills/machine-cockpit/assets/chat.html | ssh ... "cat > /tmp/chat.html && mkdir -p ~/.local/share/aiko-cockpit && cp /tmp/chat.html ~/.local/share/aiko-cockpit/index.template.html"
cat .agents/skills/machine-cockpit/scripts/cockpit.py | ssh ... "cat > /tmp/cockpit.py && python3 -m py_compile /tmp/cockpit.py && mkdir -p ~/.local/share/aiko-cockpit && cp /tmp/cockpit.py ~/.local/share/aiko-cockpit/cockpit.py && cp ~/.local/share/aiko-cockpit/cockpit.py ~/.local/bin/aiko-cockpit && chmod +x ~/.local/bin/aiko-cockpit"
```

### C — launch + self-aware

```sh
ssh ... "cat > ~/Library/LaunchAgents/net.theclarityproject.aiko.cockpit.plist <<'PLIST' ...; launchctl bootout ...; launchctl bootstrap ...; launchctl kickstart ...; sleep 1; curl -s http://127.0.0.1:8787/api/self | jq .hint; curl -s http://127.0.0.1:8787/api/telegram/self-aware | jq .hint"
```

## Verification (gate)

All must pass (target):

```sh
curl -s http://127.0.0.1:19420/v1/health -H "Authorization: Bearer $(cat ~/.aiko/native/token)" | jq -e '.status=="ok" and .contractAbi==13'
curl -s http://127.0.0.1:8787/api/health | jq -e '.ok==true'
curl -s http://127.0.0.1:8787/api/self | jq -e '.schema=="aiko.self.v1"'
curl -s http://127.0.0.1:8787/ | grep -q 'Aiko'
~/.local/bin/aiko --version | grep -q 'aiko '
launchctl print gui/$(id -u)/net.theclarityproject.aiko.cockpit | grep -q 'state = running'
test -f ~/.aiko/self.json && python3 -c "import json,pathlib; d=json.loads(pathlib.Path.home().joinpath('.aiko/self.json').read_text()); assert 'telegram' in str(d).lower() or 'wiring' in d"
```
Provider-specific (telegram today): `~/.local/bin/telegram-daemon` + `curl .../api/telegram/self-aware | jq -e '.hint'`.

## Where things live

| Thing | Source | Dest |
|---|---|---|
| Aiko package | `target/aiko-package/*.tar.gz` | `/tmp/aiko-package.tar.gz` → `~/.local/bin/aiko`, `~/.aiko/lib/libcontract.*`, `~/.aiko/limbs/` |
| Chat UI | `assets/chat.html` | `~/.local/share/aiko-cockpit/index.template.html` |
| Cockpit | `scripts/cockpit.py` (generic `GET /api/<provider>/self-aware`) | `~/.local/share/aiko-cockpit/cockpit.py` + `~/.local/bin/aiko-cockpit` |
| Provider daemon | `aiko/target/release/telegram-daemon` (`provider=telegram`) | `~/.local/bin/telegram-daemon` (other providers analogous) |
| Plists | generated on target | `net.theclarityproject.aiko.cockpit` (:8787) + `net.theclarityproject.aiko.telegram-bridge` + `net.theclarityproject.aiko.contract-worker` |
| Docs | `docs/channel-api.md` (generic) + `docs/telegram-api.md` (provider) | — |
| Self model | `scripts/build-self.py` → `~/.aiko/self.json` (`aiko.self.v1`: aiko/host/auth + `wiring[]` `{id, channel, bridge:{hint, pendingChats}}` + `artifacts[]`) | — |

Secrets: no raw token in self.json/logs/rows; masked `XXXX…YYYY`; pair codes not stored.

## Reuse

`aiko "wire 100.104.x.x as Gbear"` — existing `~/.local/bin/aiko` skips heavy install, refreshes cockpit/daemon, rebuilds `self.json`. Skill is project-local (`.agents/skills/machine-cockpit/`), `aiko inspect --json` shows `machine-cockpit` as `project`.

## Self-aware layer (decoupled, no daemon fork)

`GET /api/self` + `GET /api/<provider>/self-aware` → `{hasToken, username, running, approvedUserIds, pendingChats, bridgeLog, auth, hint, action}` with `hint ∈ {not_signed_in, no_token, bridge_stopped, needs_pairing, waiting_first_message, ready}` (generic). First-contact: `pendingChats[0]` auto-approved when `approved==[] && signed_in`.

## Contracts (every touchpoint)

`telegram.*` today, `<provider>.*` generically: `observe` (durable before `offset+1`) → `approved` gate → `send/edit/delete/presence/media/callback/commands`. See `docs/telegram-contracts.md` (provider) + `docs/channel-api.md` (generic). Every `curl` with `bot<TOKEN>` is an event contract, never a prompt/proof.
