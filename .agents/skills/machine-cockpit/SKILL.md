---
name: machine-cockpit
description: "Wire a fresh macOS seat so a non-technical teammate can chat with Aiko in their browser and pair Telegram without touching the terminal. Use when the user says 'wire Gbear', 'set up a new Mac', 'install aiko on a machine', 'give them a UI', 'hook up Telegram for them', 'make it friendly', or hands you an IP/user/password for a new host. Also use when installing the aiko portable package + cockpit chat (port 8787) + telegram-daemon (launchd) onto a target over Tailscale/SSH."
---

# Machine Cockpit — friendly seat setup

Turn a bare macOS host into a chat-ready Aiko seat: install the portable stack, drop a browser chat UI, and make Telegram pairable in one tab — no terminal needed on the other end.

## What this does (3 minutes, same-arch shortcut)

1. **Install Aiko** — assemble (or reuse) `target/aiko-package/aiko-<ver>-macos-aarch64.tar.gz` locally, `scp` to `gbear@HOST:/tmp/`, `tar -xzf` + `install.sh` on the host. Verifies `aiko --version`, `aiko-doctor`, `~/.aiko/lib/libcontract.dylib` ABI, and `~/.local/bin` on PATH. Assumes same arch (both aarch64) so no cross-compile.

2. **Drop the Cockpit** — browser chat + Telegram wizard at `http://127.0.0.1:8787`:
   - UI template: local `aiko/.agents/skills/machine-cockpit/assets/chat.html` (or `/tmp/aiko-chat-ui.html` during dev) — dark, two tabs (Chat / Telegram), talks to `aiko native serve` on `127.0.0.1:19420` via WebSocket ACP `aiko.acp.v1` (`session/load` → `session/new` → `session/prompt`), auto-handles `session/request_permission` + `x.ai/ask_user_question`.
   - Backend: `cockpit.py` (python3 stdlib only, `http.server`) serves `__TOKEN__`/`__API_BASE__` from `~/.aiko/native/api.json` and wraps `aiko native telegram {status,set-token,approve-pair,log}` + `launchctl` for the bridge. Endpoints: `GET /`, `GET /api/health`, `GET /api/telegram/{status,check,log}`, `POST /api/telegram/{set-token,start,stop,approve-pair}`.
   - Daemon: `aiko/target/release/telegram-daemon` → `~/.local/bin/telegram-daemon` (verify via http before saving token, then `launchd` bridge at `net.theclarityproject.aiko.telegram-bridge`).
   - Launchd: `~/Library/LaunchAgents/net.theclarityproject.aiko.cockpit.plist` (`/usr/bin/python3 ~/.local/share/aiko-cockpit/cockpit.py`, `KeepAlive`+`RunAtLoad`, `AIKO_COCKPIT_PORT=8787`, logs to `~/.aiko/logs/cockpit.log`). Also leaves `~/Desktop/Aiko — Start Here.txt`.

3. **Telegram wiring** — the UI's Telegram tab guides: `@BotFather /newbot` → paste token → `Save` (masked `XXXX…YYYY`, `getMe` checked, save via `aiko native telegram set-token`) → `Start bridge` → message bot → paste pairing code → `Approve` (`aiko native telegram approve-pair`). UI also supports `Stop`/`Status`/`Check`/`Log`.

## When to use

- "set up Gbear / a new teammate / this Mac / that IP"
- "wire them a UI / make it non-technical / Telegram setup"
- handed an `IP  user  password` triple for a new host

## Inputs the skill expects

- `host`: Tailscale IP or `user@host` (gbear@100.104.x.x)
- `password`: for `sshpass` (pass `--ask` or env `AIKO_COCKPIT_PASSWORD` instead of pasting into chat when possible)
- optional `port` (default `8787`), `aikoPort` (default `19420`)

Don't ask for what `aiko native discovery` already knows.

## Steps (run inside this machine, talking to the target over SSH)

All remote work uses `ssh -F /dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive` + `sshpass` (so `~/.ssh/config` Host * identity doesn't interfere). Prefer piping files over `cat | ssh "cat > /tmp/..."` to avoid `scp` auth quirks; big binaries stream the same way.

### A — build & ship Aiko
```sh
# 1. ensure pyyaml for assemble-portable on this machine
pip3 install --break-system-packages pyyaml 2>&1 | tail -2
# 2. assemble (reuses existing binaries when present, no rebuild)
AIKO_PACKAGE_ONLY=1 bash -c 'source scripts/lib/aiko-env.sh; aiko_env_init; source scripts/lib/assemble-portable.sh; assemble_portable_tarball' 2>&1 | tail -3
# 3. ship + install on target
sshpass -p "$PASS" scp -F /dev/null ... target/aiko-package/*.tar.gz gbear@HOST:/tmp/aiko-package.tar.gz
sshpass -p "$PASS" ssh ... gbear@HOST "mkdir -p ~/src/aiko-package && tar -xzf /tmp/aiko-package.tar.gz -C ~/src/aiko-package && bash ~/src/aiko-package/aiko-*/install.sh"
ssh ... gbear@HOST "~/.local/bin/aiko --version; ~/.local/bin/aiko-doctor | head"
```

### B — ship cockpit + daemon
```sh
# daemon (build once, reuse): cargo build --manifest-path aiko/Cargo.toml -p xai-telegram-daemon --bin telegram-daemon --release
cat aiko/target/release/telegram-daemon | ssh ... gbear@HOST "cat > /tmp/telegram-daemon.bin && install -m 755 /tmp/telegram-daemon.bin ~/.local/bin/telegram-daemon"
cat /tmp/aiko-chat-ui.html | ssh ... gbear@HOST "cat > /tmp/aiko-chat-ui.html"
cat /tmp/aiko-cockpit.py   | ssh ... gbear@HOST "cat > /tmp/aiko-cockpit.py && python3 -m py_compile /tmp/aiko-cockpit.py"
ssh ... gbear@HOST "install -m 755 /tmp/telegram-daemon.bin ~/.local/bin/telegram-daemon; mkdir -p ~/.local/share/aiko-cockpit; cp /tmp/aiko-chat-ui.html ~/.local/share/aiko-cockpit/index.template.html; cp /tmp/aiko-cockpit.py ~/.local/share/aiko-cockpit/cockpit.py; cp ~/.local/share/aiko-cockpit/cockpit.py ~/.local/bin/aiko-cockpit; chmod +x ~/.local/bin/aiko-cockpit"
```

### C — launch
```sh
ssh ... gbear@HOST "cat > ~/Library/LaunchAgents/net.theclarityproject.aiko.cockpit.plist <<'PLIST' ...; launchctl bootout ...; launchctl bootstrap ...; launchctl kickstart ...; sleep 1; curl -s http://127.0.0.1:8787/api/health; curl -s http://127.0.0.1:8787/ | head"
ssh ... gbear@HOST "cat > ~/Desktop/'Aiko — Start Here.txt' <<'TXT' ...; open http://127.0.0.1:8787"
```

## Verification (the skill's own gate)

On the target, these must all succeed (non-zero or empty = fail the skill):

```sh
curl -s http://127.0.0.1:19420/v1/health -H "Authorization: Bearer $(cat ~/.aiko/native/token)" | jq -e '.status=="ok" and .contractAbi==13'
curl -s http://127.0.0.1:8787/api/health | jq -e '.ok==true'
curl -s http://127.0.0.1:8787/ | grep -q '<title>Aiko'
~/.local/bin/aiko --version | grep -q 'aiko '
~/.local/bin/telegram-daemon --help 2>&1 | grep -q 'Telegram' || test -x ~/.local/bin/telegram-daemon
launchctl print gui/$(id -u)/net.theclarityproject.aiko.cockpit | grep -q 'state = running'
test -f ~/Desktop/'Aiko — Start Here.txt'
```

## Where things live

| Thing | On your machine (source) | On their machine (dest) |
|---|---|---|
| Aiko package | `target/aiko-package/*.tar.gz` | `/tmp/aiko-package.tar.gz` → `~/src/aiko-package/` → `~/.local/bin/aiko`, `~/.aiko/lib/libcontract.*`, `~/.aiko/limbs/`, `~/.aiko/cell/` |
| Chat UI template | this skill's `assets/chat.html` | `~/.local/share/aiko-cockpit/index.template.html` + `/tmp/aiko-chat-ui.html` |
| Cockpit server | this skill's `scripts/cockpit.py` | `~/.local/share/aiko-cockpit/cockpit.py` + `~/.local/bin/aiko-cockpit` + `/tmp/aiko-cockpit.py` |
| Telegram daemon | `aiko/target/release/telegram-daemon` | `~/.local/bin/telegram-daemon` |
| Plists | generated on target | `~/Library/LaunchAgents/net.theclarityproject.aiko.cockpit.plist` (port 8787) + `net.theclarityproject.aiko.telegram-bridge.plist` (on first Start) + `net.theclarityproject.aiko.contract-worker.plist` |

Secrets: the UI never logs a token. `cockpit.py` validates via `https://api.telegram.org/bot<token>/getMe` before calling `aiko native telegram set-token`; the token is then masked as `XXXX…YYYY` in responses. Pair codes are 4–6 hex.

## Reuse

Next time, same skill — just `aiko "wire 100.104.x.x as Gbear"` and it will detect an existing Aiko (`~/.local/bin/aiko --version` succeeds) and skip the heavy install, jumping straight to cockpit/daemon refresh. The skill is at `aiko/.agents/skills/machine-cockpit/SKILL.md` (repo-local, highest precedence, no rebuild needed) and live-reloads within ~2s.

## Self-aware layer (decoupled, no daemon fork)

The cockpit is the brain, the daemon stays dumb. New endpoints (no core changes):

- `GET /api/telegram/self-aware` → `{hasToken, username, running, approvedUserIds, pendingChats, bridgeLog, auth:{signed_in, provider, accounts}, hint, action}`
  - `hint` in `not_signed_in|no_telegram_token|bridge_stopped|needs_pairing|waiting_first_message|ready`
  - `pendingChats` parsed from `~/.aiko/logs/telegram-bridge.log` "Unauthorized chat 123"
- `GET /api/auth-aware` → `{auth:{signed_in,...}, health:{ok, version, contractAbi}, nativeBase}` (via `GET /v1/auth` + `GET /v1/health` with the native bearer)

The UI shows a status bar (top of Chat tab) driven by `hint`: not_signed_in → "Sign in" sheet (`aiko login --device-code` or `aiko login aiko/grok/openai`), bridge stopped → Start, no pairing → Pair, etc. Chat's `sendPrompt` also checks `cachedAuth.signed_in` before calling ACP and surfaces "Not signed in" instead of silently failing. All decoupled: remove `cockpit.py` and the daemon still works, just without the self-awareness.

First-contact auto-approve is also decoupled: when `approvedUserIds==[]`, the cockpit's `pendingChats` surfaces the first sender so the owner can one-click approve (or we ship a tiny `first_contact_wrapper.py` in `/tmp/` on the target that reads the log and appends to `user-settings.json` — never modifying `aiko/crates/codegen/xai-telegram-daemon/src/bot.rs`).
