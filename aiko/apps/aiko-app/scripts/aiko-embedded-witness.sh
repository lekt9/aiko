#!/usr/bin/env bash
# Prove Aiko App resolves and executes only the CLI embedded in its package.
#
#   bash apps/aiko-app/scripts/aiko-embedded-witness.sh --runtime-only
#   bash apps/aiko-app/scripts/aiko-embedded-witness.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/apps/aiko-app"
MODE="${1:-full}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

case "$MODE" in
  full | --full | --runtime-only) ;;
  *) fail "usage: $0 [--runtime-only|--full]" ;;
esac

SOURCE="$APP/src-tauri/src/cli_probe.rs"
INTEGRATION="$APP/src-tauri/src/integration_test.rs"
test -f "$SOURCE" || fail "missing CLI resolver: $SOURCE"
test -f "$INTEGRATION" || fail "missing embedded-runtime integration test: $INTEGRATION"

python3 - "$SOURCE" "$INTEGRATION" <<'PY'
from pathlib import Path
import re
import sys

source_path, integration_path = map(Path, sys.argv[1:])
source = source_path.read_text()
integration = integration_path.read_text()

for forbidden in (
    "which::",
    "enriched_path_env",
    ".aiko/bin",
    r".aiko\bin",
    ".grok",
    "GROK",
    "Homebrew",
    "WinGet",
    "Scoop",
):
    if forbidden in source:
        raise SystemExit(f"forbidden fallback discovery remains in cli_probe.rs: {forbidden}")

candidate = re.search(
    r"fn candidate_paths\(\) -> Vec<PathBuf> \{(?P<body>.*?)\n\}",
    source,
    re.S,
)
if not candidate:
    raise SystemExit("candidate_paths must have no manual/configured-path parameter")
body = candidate.group("body")
if "std::env::current_exe()" not in body or "bundled_cli_path_for" not in body:
    raise SystemExit("candidate_paths does not derive the sidecar from current_exe")
for forbidden in ("manual", "user_home", "PATH", "which", "var_os", "var("):
    if forbidden in body:
        raise SystemExit(f"candidate_paths contains non-bundled discovery: {forbidden}")

required_source = (
    "fn bundled_cli_path_for(desktop_executable: &Path)",
    "pub fn probe_cli(_manual_path: Option<&str>)",
    "let candidates = candidate_paths();",
    'let source = "bundled".to_string();',
)
for claim in required_source:
    if claim not in source:
        raise SystemExit(f"missing embedded-runtime invariant: {claim}")

if "probe_cli_uses_only_embedded_sibling" not in integration:
    raise SystemExit("integration test does not assert embedded sibling exclusivity")

print("embedded resolver static assertions: PASS")
PY
pass "automatic CLI discovery is limited to the packaged sibling"

if rg -n \
  'resolve_wsl_launch|start_wsl_tokio_command|probe_cli_for_settings|read_wsl_version|windows_path_to_wsl|wsl_launch' \
  "$APP/src-tauri/src/acp_client.rs" \
  "$APP/src-tauri/src/session_manager/connect.rs" \
  "$APP/src-tauri/src/commands/session_p1.rs"; then
  fail "a production local-agent path can still select an external WSL CLI"
fi
pass "local probe, cold spawn, and prewarm have no external WSL CLI branch"

if rg -n \
  'commands::(?:wsl_status|cli_repair_agent_sidecar|cli_install_latest|cli_install_commands|pick_cli_binary)' \
  "$APP/src-tauri/src/lib.rs"; then
  fail "legacy external CLI setup IPC remains registered"
fi
pass "legacy install, picker, repair, and WSL IPC is not exposed"

for legacy_module in cli_install.rs cli_update.rs wsl_backend.rs; do
  test ! -e "$APP/src-tauri/src/$legacy_module" \
    || fail "legacy external CLI module remains: $legacy_module"
done
pass "legacy external CLI installer, self-updater, and WSL modules are removed"

if rg -n \
  'GROK_MIRROR_|VITE_GROK_RELEASES_URL|grok_app::|__grok_app|__grokSimAppUpdate|\[grok\]|Next message starts a new Grok session|com\.grokapp\.desktop' \
  "$APP/src" "$APP/src-tauri/src" "$APP/src-tauri/Info.plist"; then
  fail "an Aiko-owned product, mirror, logging, or simulator identity still uses Grok naming"
fi
pass "Aiko-owned product, mirror, logging, and simulator identities are canonical"

if rg -n \
  '\.grok|GROK_|grok-app|Grok App|grok_app' \
  "$APP/src-tauri/src/account_profiles.rs" \
  "$APP/src-tauri/src/process_util.rs" \
  "$APP/src-tauri/src/skill_edit.rs" \
  "$APP/src-tauri/src/mirror" \
  "$APP/src-tauri/src/secrets.rs" \
  "$APP/src-tauri/src/updater.rs" \
  "$APP/src/i18n/messages/en/automations.ts" \
  "$APP/src/i18n/messages/zh/automations.ts" \
  "$APP/src/i18n/messages/zh-TW/automations.ts"; then
  fail "an Aiko-owned home, auth, mirror, keychain, updater, or skill surface still uses Grok naming"
fi
pass "Aiko-owned home, auth, mirror, keychain, updater, and skill surfaces are canonical"

if rg -n \
  'pathCandidate|homedir\(|process\.env\.PATH|join\(homedir' \
  "$APP/scripts/prepare-runtime.mjs"; then
  fail "runtime preparation can still source an untracked home or PATH binary"
fi
pass "build preparation accepts only explicit or repository-built Aiko runtimes"

run_bounded() {
  local seconds="$1"; shift
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

run_bounded 1200 cargo test --manifest-path "$APP/src-tauri/Cargo.toml" cli_probe -- --nocapture
run_bounded 1200 cargo test --manifest-path "$APP/src-tauri/Cargo.toml" \
  probe_cli_uses_only_embedded_sibling -- --nocapture
pass "focused Rust resolver and integration tests are green"

APP_VERSION="$(node -p "require('$APP/package.json').version")"
test -n "$APP_VERSION" || fail "Aiko App version is empty"

APP_BUNDLE="$(find "$APP/src-tauri/target" -type d \
  -path '*/release/bundle/macos/Aiko.app' -print -quit 2>/dev/null || true)"
if [[ -n "$APP_BUNDLE" ]]; then
  DESKTOP="$APP_BUNDLE/Contents/MacOS/aiko-app"
  EMBEDDED="$APP_BUNDLE/Contents/MacOS/aiko"
  test -x "$DESKTOP" || fail "Aiko.app desktop executable is missing: $DESKTOP"
  test -x "$EMBEDDED" || fail "Aiko.app embedded CLI is missing: $EMBEDDED"
  VERSION_OUTPUT="$(run_bounded 30 "$EMBEDDED" --version 2>&1)"
  grep -Fq "aiko $APP_VERSION" <<<"$VERSION_OUTPUT" \
    || fail "Aiko.app embedded CLI version does not match app $APP_VERSION: $VERSION_OUTPUT"
  pass "assembled Aiko.app embedded CLI executes as aiko $APP_VERSION"
else
  node "$APP/scripts/prepare-runtime.mjs"
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  test -n "$TRIPLE" || fail "rustc did not report a host target"
  case "$TRIPLE" in
    *windows*) EMBEDDED="$APP/src-tauri/binaries/aiko-$TRIPLE.exe" ;;
    *) EMBEDDED="$APP/src-tauri/binaries/aiko-$TRIPLE" ;;
  esac
  test -x "$EMBEDDED" || fail "prepared embedded Aiko CLI is missing: $EMBEDDED"
  VERSION_OUTPUT="$(run_bounded 30 "$EMBEDDED" --version 2>&1)"
  grep -Fq "aiko $APP_VERSION" <<<"$VERSION_OUTPUT" \
    || fail "prepared embedded CLI version does not match app $APP_VERSION: $VERSION_OUTPUT"
  pass "prepared embedded CLI executes as aiko $APP_VERSION"
fi

if [[ "$MODE" == "--runtime-only" ]]; then
  echo "aiko embedded witness: PASS (runtime-only)"
  exit 0
fi

bash "$APP/scripts/aiko-native-witness.sh"
pass "full native package witness remains green"
echo "aiko embedded witness: PASS"
