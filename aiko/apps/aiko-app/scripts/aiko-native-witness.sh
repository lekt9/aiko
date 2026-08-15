#!/usr/bin/env bash
# Mechanical witness for the native Aiko desktop package.
#
#   bash apps/aiko-app/scripts/aiko-native-witness.sh --wiring-only
#   bash apps/aiko-app/scripts/aiko-native-witness.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/apps/aiko-app"
MODE="${1:-full}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

case "$MODE" in
  full | --wiring-only) ;;
  *) fail "usage: $0 [--wiring-only]" ;;
esac

for file in \
  "$APP/package.json" \
  "$APP/scripts/prepare-runtime.mjs" \
  "$APP/scripts/release-tag.sh" \
  "$APP/src-tauri/src/cli_probe.rs" \
  "$APP/src-tauri/tauri.conf.json" \
  "$APP/src-tauri/tauri.macos.conf.json" \
  "$APP/src-tauri/tauri.windows.conf.json"; do
  test -f "$file" || fail "missing native packaging input: $file"
done
test ! -e "$APP/.git" || fail "aiko-app is still an embedded Git repository instead of vendored monorepo source"
pass "Aiko App source is vendored into the parent workspace"

node --input-type=module - "$APP" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = process.argv[2];
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson(join(app, "package.json"));
const base = readJson(join(app, "src-tauri", "tauri.conf.json"));
const mac = readJson(join(app, "src-tauri", "tauri.macos.conf.json"));
const win = readJson(join(app, "src-tauri", "tauri.windows.conf.json"));
const releaseTag = readFileSync(join(app, "scripts", "release-tag.sh"), "utf8");
const requireClaim = (ok, message) => {
  if (!ok) throw new Error(message);
};

requireClaim(pkg.scripts?.["runtime:prepare"] === "node scripts/prepare-runtime.mjs",
  "package scripts do not expose runtime:prepare");
requireClaim(base.productName === "Aiko", "Tauri productName is not Aiko");
requireClaim(base.identifier === "ai.aiko.desktop", "Tauri identifier is not ai.aiko.desktop");
requireClaim(base.app?.windows?.every((window) => window.title === "Aiko"),
  "base window title is not Aiko");
requireClaim(mac.app?.windows?.every((window) => window.title === "Aiko"),
  "macOS window title is not Aiko");
requireClaim(win.app?.windows?.every((window) => window.title === "Aiko"),
  "Windows window title is not Aiko");
requireClaim(base.bundle?.externalBin?.includes("binaries/aiko"),
  "Tauri externalBin does not include binaries/aiko");
requireClaim(base.bundle?.resources?.["resources/contract/"] === "contract/",
  "Tauri bundle does not carry the Contract runtime resource");
requireClaim(base.build?.beforeDevCommand?.includes("runtime:prepare"),
  "beforeDevCommand does not prepare the Aiko sidecar");
requireClaim(base.build?.beforeBuildCommand?.includes("runtime:prepare"),
  "beforeBuildCommand does not prepare the Aiko sidecar");
requireClaim(releaseTag.includes('re.subn(r"(Aiko v)'),
  "release tagger does not update Aiko version footers");
requireClaim(!releaseTag.includes('re.subn(r"(Grok v)'),
  "release tagger still updates legacy Grok version footers");
NODE
pass "Tauri identity, externalBin, resources, and build hooks are wired"

if rg -n 'com\.grokapp\.desktop|Grok App' \
  "$APP/src-tauri/src" "$APP/src/lib"; then
  fail "active native or frontend product surfaces still use the legacy Grok App identity"
fi
pass "active desktop product surfaces use Aiko identity"

node "$APP/scripts/prepare-runtime.mjs" --test-contract-candidates
resolution="$(node "$APP/scripts/prepare-runtime.mjs" --check)"
printf '%s\n' "$resolution"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
test -n "$TRIPLE" || fail "rustc did not report a host triple"
case "$TRIPLE" in
  *windows*) EXPECTED_SIDECAR="$APP/src-tauri/binaries/aiko-$TRIPLE.exe" ;;
  *) EXPECTED_SIDECAR="$APP/src-tauri/binaries/aiko-$TRIPLE" ;;
esac
grep -Fq "Aiko sidecar destination: $EXPECTED_SIDECAR" <<<"$resolution" \
  || fail "prepare-runtime destination does not match Tauri externalBin naming"
rg -q 'current_exe' "$APP/src-tauri/src/cli_probe.rs" \
  || fail "CLI probe does not inspect the installed app directory"
rg -q 'aiko(\\.exe)?' "$APP/src-tauri/src/cli_probe.rs" \
  || fail "CLI probe does not admit the bundled Aiko executable"
pass "prepare-runtime resolves target-named Aiko and full Contract runtimes"

MONOREPO="$(git -C "$ROOT" rev-parse --show-toplevel)"
PREFIX="$(git -C "$ROOT" rev-parse --show-prefix)"
if git -C "$MONOREPO" grep -n 'apps/desktop' -- \
  "${PREFIX}README.md" "${PREFIX}docs" "${PREFIX}scripts" ".github/workflows"; then
  fail "tracked monorepo consumers still reference apps/desktop"
fi
pass "tracked docs, scripts, and workflows point at apps/aiko-app"

if [[ "$MODE" == "--wiring-only" ]]; then
  echo "aiko native witness: PASS (wiring-only)"
  exit 0
fi

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

run_bounded 600 pnpm --dir "$APP" typecheck
run_bounded 600 pnpm --dir "$APP" test
pass "frontend typecheck and unit tests are green"

run_bounded 1200 cargo test --manifest-path "$APP/src-tauri/Cargo.toml" --lib
run_bounded 1200 cargo build --manifest-path "$APP/src-tauri/Cargo.toml"
pass "native host tests and build are green"

node "$APP/scripts/prepare-runtime.mjs"
case "$TRIPLE" in
  *windows*) SIDECAR="$APP/src-tauri/binaries/aiko-$TRIPLE.exe" ;;
  *) SIDECAR="$APP/src-tauri/binaries/aiko-$TRIPLE" ;;
esac
test -x "$SIDECAR" || fail "prepared Aiko sidecar is not executable: $SIDECAR"
CLI_VERSION="$(sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
  "$ROOT/crates/codegen/xai-grok-pager-bin/Cargo.toml" | head -1)"
test -n "$CLI_VERSION" || fail "Aiko CLI manifest version is empty"
run_bounded 120 bash -c '"$1" --version 2>&1 | grep -F -- "$2"' bash "$SIDECAR" "$CLI_VERSION"
pass "packaged Aiko CLI executes --version"

python3 - "$SIDECAR" <<'PY'
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

binary = sys.argv[1]
with tempfile.TemporaryDirectory(prefix="aiko-native-acp-") as aiko_home:
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
            "clientInfo": {"name": "aiko-app-witness", "version": "0"},
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
        raise SystemExit(f"no ACP initialize response from bundled Aiko sidecar: {stderr[-1200:]}")
    if "error" in response:
        raise SystemExit(f"ACP initialize returned error: {response['error']}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SystemExit(f"ACP initialize result is not an object: {response}")
    print("ACP initialize handshake: PASS")
PY
pass "bundled Aiko sidecar completes a real ACP initialize handshake"

case "$TRIPLE" in
  *apple-darwin*)
    run_bounded 3600 pnpm --dir "$APP" exec tauri build --target "$TRIPLE" --bundles app
    APP_BUNDLE="$APP/src-tauri/target/$TRIPLE/release/bundle/macos/Aiko.app"
    test -x "$APP_BUNDLE/Contents/MacOS/aiko-app" \
      || fail "assembled Aiko.app is missing its desktop executable"
    test -x "$APP_BUNDLE/Contents/MacOS/aiko" \
      || fail "assembled Aiko.app is missing its Aiko CLI sidecar"
    test -f "$APP_BUNDLE/Contents/Resources/contract/libcontract.dylib" \
      || fail "assembled Aiko.app is missing the Contract runtime"
    cmp -s "$SIDECAR" "$APP_BUNDLE/Contents/MacOS/aiko" \
      || fail "assembled Aiko.app sidecar differs from the handshake-tested runtime"
    cmp -s "$APP/src-tauri/resources/contract/libcontract.dylib" \
      "$APP_BUNDLE/Contents/Resources/contract/libcontract.dylib" \
      || fail "assembled Aiko.app Contract runtime differs from the prepared resource"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist")" = "ai.aiko.desktop" \
      || fail "assembled Aiko.app bundle identifier is not ai.aiko.desktop"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist")" = "$CLI_VERSION" \
      || fail "assembled Aiko.app version does not match the Aiko CLI"
    run_bounded 120 bash -c '"$1" --version 2>&1 | grep -F -- "$2"' bash \
      "$APP_BUNDLE/Contents/MacOS/aiko" "$CLI_VERSION"
    pass "assembled Aiko.app contains the verified desktop, CLI, and Contract runtimes"
    ;;
  *windows*)
    run_bounded 3600 pnpm --dir "$APP" exec tauri build --target "$TRIPLE" --bundles nsis
    find "$APP/src-tauri/target/$TRIPLE/release/bundle/nsis" -type f -name '*.exe' -print -quit \
      | grep -q . || fail "assembled Windows installer is missing"
    pass "assembled Aiko Windows installer exists"
    ;;
  *)
    run_bounded 3600 pnpm --dir "$APP" exec tauri build --target "$TRIPLE" --bundles appimage
    find "$APP/src-tauri/target/$TRIPLE/release/bundle/appimage" -type f -name '*.AppImage' -print -quit \
      | grep -q . || fail "assembled Linux AppImage is missing"
    pass "assembled Aiko Linux AppImage exists"
    ;;
esac

echo "aiko native witness: PASS"
