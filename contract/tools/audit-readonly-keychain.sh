#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BIN=${CONTRACT_BIN:-"$ROOT/zig/zig-out/bin/contract-zig"}
TMP=${TMPDIR:-/tmp}/contract-keychain-audit-$$
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -m 700 "$TMP"

if [ ! -x "$BIN" ]; then
  echo "audit: missing binary: $BIN" >&2
  exit 2
fi

run_readonly() {
  name=$1
  shift
  (cd "$TMP" && HOME="$TMP" "$BIN" "$@" >"$TMP/$name.out" 2>"$TMP/$name.err") &
  pid=$!
  elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge 50 ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      echo "FAIL $name: blocked beyond five seconds (possible prompt)" >&2
      exit 1
    fi
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  if find "$TMP" -type f \( -name 'root.key' -o -name '*.enc' -o -name 'contracts.jsonl' \) | rg . >/dev/null 2>&1; then
    echo "FAIL $name: read-only command created wallet or semantic-ledger state" >&2
    exit 1
  fi
  echo "PASS $name"
}

run_readonly help --help
run_readonly status status
run_readonly events events
run_readonly explain explain absent-trace
run_readonly self self --json

if rg -n -i '(password|private.?key|seed phrase|api.?key|bearer [a-z0-9])' \
  "$TMP"/*.out "$TMP"/*.err >/dev/null 2>&1; then
  echo "FAIL: secret-shaped output found" >&2
  exit 1
fi

echo "PASS: read-only surfaces completed without prompt-shaped blocking or secret output"
