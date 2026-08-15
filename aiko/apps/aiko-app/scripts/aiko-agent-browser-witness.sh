#!/usr/bin/env bash
# jesus-graph: agent-browser-witness
# Exercise the production Aiko frontend as a user with agent-browser, then
# corroborate that UI fruit against the Aiko CLI and Contract runtime embedded
# in the assembled desktop bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/apps/aiko-app"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARTIFACT_DIR="$APP/src-tauri/target/agent-browser-witness/$RUN_ID"
SESSION=""
SERVER_PID=""

fail() {
  echo "FAIL: $*" >&2
  echo "Evidence retained at: $ARTIFACT_DIR" >&2
  exit 1
}

pass() { echo "PASS: $*"; }

run_bounded() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
command = sys.argv[2:]
try:
    completed = subprocess.run(command, timeout=timeout)
except subprocess.TimeoutExpired:
    print(f"timed out after {timeout}s: {' '.join(command)}", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SESSION" ]]; then
    run_bounded 20 agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for command in agent-browser curl node pnpm python3 rustc; do
  command -v "$command" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command"
done

mkdir -p "$ARTIFACT_DIR"
agent-browser --version > "$ARTIFACT_DIR/agent-browser-version.txt"
grep -Eq '^agent-browser [0-9]+' "$ARTIFACT_DIR/agent-browser-version.txt" \
  || fail "agent-browser did not report a usable direct CLI version"
pass "direct $(sed -n '1p' "$ARTIFACT_DIR/agent-browser-version.txt") is available"

# A fresh production web build is the browser target. The browser never reads
# or imports source files directly.
run_bounded 600 pnpm --dir "$APP" build:ui 2>&1 \
  | tee "$ARTIFACT_DIR/frontend-build.log"
test -f "$APP/dist/index.html" || fail "production frontend is missing dist/index.html"
pass "production frontend build completed"

SERVER_LOG="$ARTIFACT_DIR/server.log"
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$APP/dist" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

PORT=""
for _ in $(seq 1 100); do
  PORT="$(grep -Eo 'port [0-9]+' "$SERVER_LOG" 2>/dev/null \
    | awk '{print $2}' | tail -1 || true)"
  if [[ -n "$PORT" ]]; then
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null \
    || fail "production frontend server exited before reporting its port"
  sleep 0.05
done
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "production frontend server did not report an ephemeral port"

URL="http://127.0.0.1:$PORT/"
run_bounded 15 curl --fail --silent --show-error --output /dev/null "$URL"
printf '%s\n' "$URL" > "$ARTIFACT_DIR/url.txt"
pass "production frontend is reachable on an ephemeral localhost port"

SESSION="$(agent-browser session id --scope worktree --prefix "aiko-fruit-$RUN_ID")"
printf '%s\n' "$SESSION" > "$ARTIFACT_DIR/session.txt"

ab() {
  run_bounded 60 agent-browser --session "$SESSION" "$@"
}

ref_for() {
  local role="$1"
  local label="$2"
  local snapshot="$3"
  local line
  local ref
  line="$(grep -E -- "- ${role} \"${label}\"( |$)" "$snapshot" | head -1 || true)"
  ref="$(printf '%s\n' "$line" | sed -n 's/.*ref=\(e[0-9][0-9]*\).*/\1/p')"
  test -n "$ref" || fail "could not resolve $role '$label' from $(basename "$snapshot")"
  printf '@%s\n' "$ref"
}

ab open "$URL"
ab wait --load networkidle
test "$(ab get title)" = "Aiko" || fail "production page title is not Aiko"

INITIAL="$ARTIFACT_DIR/01-initial.interactive.txt"
INITIAL_FULL="$ARTIFACT_DIR/01-initial.snapshot.txt"
ab snapshot -i > "$INITIAL"
ab snapshot > "$INITIAL_FULL"
ab get text body > "$ARTIFACT_DIR/01-initial.body.txt"
ab screenshot --annotate "$ARTIFACT_DIR/01-initial.png"
grep -Fq 'Welcome to Aiko App' "$INITIAL_FULL" \
  || fail "Aiko onboarding dialog is not visible"
grep -Fq 'Aiko' "$ARTIFACT_DIR/01-initial.body.txt" \
  || fail "Aiko identity is not visible in the production UI"
if grep -Eiq 'Grok App|Grok CLI|grok-app' "$ARTIFACT_DIR/01-initial.body.txt"; then
  fail "legacy Grok application identity is visible in the production UI"
fi
pass "Aiko identity and onboarding are visible without legacy app branding"

# Interaction 1: advance the real onboarding state through a snapshot ref.
NEXT_REF="$(ref_for button "Next" "$INITIAL_FULL")"
ab click "$NEXT_REF"
ab wait 250
TOUR="$ARTIFACT_DIR/02-tour-next.interactive.txt"
TOUR_FULL="$ARTIFACT_DIR/02-tour-next.snapshot.txt"
ab snapshot -i > "$TOUR"
ab snapshot > "$TOUR_FULL"
ab screenshot --annotate "$ARTIFACT_DIR/02-tour-next.png"
grep -Fq 'Projects & trust' "$TOUR_FULL" \
  || fail "Next did not advance onboarding to Projects & trust"
pass "onboarding Next interaction changed visible state"

# Interaction 2: leave onboarding through the freshly observed Skip tour ref.
SKIP_REF="$(ref_for button "Skip tour" "$TOUR_FULL")"
ab click "$SKIP_REF"
ab wait 250
READY="$ARTIFACT_DIR/03-ready.interactive.txt"
ab snapshot -i > "$READY"
ab snapshot > "$ARTIFACT_DIR/03-ready.snapshot.txt"
ab screenshot --annotate "$ARTIFACT_DIR/03-ready.png"
grep -Fq 'heading "New chat"' "$READY" \
  || fail "main Aiko chat surface is not visible after onboarding"
grep -Fq 'textbox "Message composer"' "$READY" \
  || fail "Aiko message composer is not available"
pass "onboarding exits to the usable Aiko chat surface"

# Interaction 3: open the model controls and prove their visible production state.
MODEL_REF="$(ref_for button "Model" "$READY")"
ab click "$MODEL_REF"
ab wait 250
MODEL="$ARTIFACT_DIR/04-model-menu.interactive.txt"
MODEL_FULL="$ARTIFACT_DIR/04-model-menu.snapshot.txt"
ab snapshot -i > "$MODEL"
ab snapshot > "$MODEL_FULL"
ab screenshot --annotate "$ARTIFACT_DIR/04-model-menu.png"
grep -Fq 'button "Model Grok 4.5"' "$MODEL_FULL" \
  || fail "model menu did not expose the selected provider model"
grep -Fq 'button "Reasoning High"' "$MODEL_FULL" \
  || fail "model menu did not expose reasoning controls"
pass "model controls open and expose their visible state"

ab press Escape
ab wait 150
AFTER_MODEL="$ARTIFACT_DIR/05-after-model.interactive.txt"
ab snapshot -i > "$AFTER_MODEL"

# Interaction 4: open access controls, but do not fabricate a Tauri backend in
# the browser. Native backend fruit is exercised against the bundle below.
ACCESS_REF="$(ref_for button "Access" "$AFTER_MODEL")"
ab click "$ACCESS_REF"
ab wait 250
ACCESS="$ARTIFACT_DIR/06-access-menu.interactive.txt"
ACCESS_FULL="$ARTIFACT_DIR/06-access-menu.snapshot.txt"
ab snapshot -i > "$ACCESS"
ab snapshot > "$ACCESS_FULL"
ab screenshot --annotate "$ARTIFACT_DIR/06-access-menu.png"
grep -Fq 'button "Agent Full tools — can run commands"' "$ACCESS_FULL" \
  || fail "access menu did not expose Agent mode"
grep -Fq 'button "Plan Plan first — propose before edits"' "$ACCESS_FULL" \
  || fail "access menu did not expose Plan mode"
grep -Fq 'button "Ask Answer only — no files or shell"' "$ACCESS_FULL" \
  || fail "access menu did not expose Ask mode"
pass "access controls open and expose Agent, Plan, and Ask modes"

ab errors > "$ARTIFACT_DIR/browser-errors.txt"
ab console > "$ARTIFACT_DIR/browser-console.txt"
if [[ -s "$ARTIFACT_DIR/browser-errors.txt" ]]; then
  fail "browser reported page errors; see browser-errors.txt"
fi
if grep -Eiq 'uncaught|unhandled|exception|(^|[[:space:]])error([:[:space:]]|$)' \
  "$ARTIFACT_DIR/browser-console.txt"; then
  fail "browser console contains an error signature; see browser-console.txt"
fi
if grep -Eq '" [45][0-9][0-9] ' "$SERVER_LOG"; then
  fail "production frontend server returned an HTTP error; see server.log"
fi
pass "browser, console, and production asset requests are error-free"

# Native corroboration: the UI artifact is paired with the actual bundled
# sibling executable, not a browser shim or a PATH-resolved CLI.
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
test -n "$TRIPLE" || fail "rustc did not report a host triple"
case "$TRIPLE" in
  *apple-darwin*) ;;
  *) fail "Aiko.app bundle fruit witness currently requires a macOS host: $TRIPLE" ;;
esac

APP_BUNDLE="$APP/src-tauri/target/$TRIPLE/release/bundle/macos/Aiko.app"
DESKTOP="$APP_BUNDLE/Contents/MacOS/aiko-app"
EMBEDDED="$APP_BUNDLE/Contents/MacOS/aiko"
CONTRACT="$APP_BUNDLE/Contents/Resources/contract/libcontract.dylib"
PREPARED="$APP/src-tauri/binaries/aiko-$TRIPLE"
PREPARED_CONTRACT="$APP/src-tauri/resources/contract/libcontract.dylib"
PLIST="$APP_BUNDLE/Contents/Info.plist"

test -x "$DESKTOP" || fail "assembled Aiko.app desktop executable is missing"
test -x "$EMBEDDED" || fail "assembled Aiko.app embedded CLI is missing"
test -f "$CONTRACT" || fail "assembled Aiko.app Contract runtime is missing"
test -x "$PREPARED" || fail "prepared repository Aiko sidecar is missing"
test -f "$PREPARED_CONTRACT" || fail "prepared repository Contract runtime is missing"
cmp -s "$PREPARED" "$EMBEDDED" \
  || fail "Aiko.app embedded CLI differs from the prepared sidecar"
cmp -s "$PREPARED_CONTRACT" "$CONTRACT" \
  || fail "Aiko.app Contract runtime differs from the prepared resource"

APP_VERSION="$(node -p "require('$APP/package.json').version")"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")"
BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
{
  printf 'bundle_id=%s\n' "$BUNDLE_ID"
  printf 'bundle_version=%s\n' "$BUNDLE_VERSION"
  printf 'embedded_cli=%s\n' "$EMBEDDED"
  printf 'contract_runtime=%s\n' "$CONTRACT"
} > "$ARTIFACT_DIR/bundle-metadata.txt"
test "$BUNDLE_ID" = "ai.aiko.desktop" \
  || fail "assembled bundle identifier is not ai.aiko.desktop"
test "$BUNDLE_VERSION" = "$APP_VERSION" \
  || fail "assembled bundle version does not match app $APP_VERSION"

run_bounded 30 "$EMBEDDED" --version \
  | tee "$ARTIFACT_DIR/embedded-cli-version.txt"
grep -Fq "aiko $APP_VERSION" "$ARTIFACT_DIR/embedded-cli-version.txt" \
  || fail "embedded CLI did not execute as aiko $APP_VERSION"
run_bounded 30 "$EMBEDDED" --help > "$ARTIFACT_DIR/embedded-cli-help.txt"
grep -Fq 'Aiko — the Contract-native agent' "$ARTIFACT_DIR/embedded-cli-help.txt" \
  || fail "embedded CLI help does not identify Aiko"
pass "Aiko.app contains the byte-matched Aiko CLI and Contract runtime"

python3 - "$EMBEDDED" "$APP_VERSION" "$ARTIFACT_DIR/acp-initialize.json" <<'PY'
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

binary, expected_version, evidence_path = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix="aiko-agent-browser-acp-") as aiko_home:
    env = os.environ.copy()
    env["AIKO_HOME"] = aiko_home
    process = subprocess.Popen(
        [binary, "agent", "stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=env,
    )
    lines = queue.Queue()

    def read_stdout():
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)

    threading.Thread(target=read_stdout, daemon=True).start()
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientInfo": {"name": "aiko-agent-browser-witness", "version": "1"},
            "capabilities": {},
        },
    }
    assert process.stdin is not None
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()

    deadline = time.monotonic() + 30
    response = None
    try:
        while time.monotonic() < deadline:
            try:
                raw = lines.get(timeout=min(0.5, deadline - time.monotonic()))
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if message.get("id") == 1:
                response = message
                break
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    if response is None:
        stderr = process.stderr.read() if process.stderr else ""
        raise SystemExit(f"no ACP initialize response from embedded Aiko CLI: {stderr[-1200:]}")
    if "error" in response:
        raise SystemExit(f"ACP initialize returned an error: {response['error']}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SystemExit(f"ACP initialize result is not an object: {response}")

    meta = result.get("_meta") or {}
    agent_version = meta.get("agentVersion")
    if agent_version != expected_version:
        raise SystemExit(
            f"ACP agent version {agent_version!r} does not match app {expected_version!r}"
        )
    auth_names = [
        method.get("name")
        for method in result.get("authMethods", [])
        if isinstance(method, dict)
    ]
    if "Aiko" not in auth_names:
        raise SystemExit(f"ACP auth methods do not identify Aiko: {auth_names}")

    summary = {
        "jsonrpc": response.get("jsonrpc"),
        "id": response.get("id"),
        "protocolVersion": result.get("protocolVersion"),
        "agentVersion": agent_version,
        "authMethodNames": auth_names,
        "availableCommandNames": [
            command.get("name")
            for command in meta.get("availableCommands", [])
            if isinstance(command, dict)
        ],
        "availableModelCount": len((result.get("modelState") or {}).get("availableModels", [])),
    }
    Path(evidence_path).write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
PY
pass "embedded Aiko CLI completed a real ACP initialize handshake"

echo "Aiko agent-browser fruit witness: PASS"
echo "Evidence: $ARTIFACT_DIR"
