#!/usr/bin/env bash
# secret-inject.sh — the canonical wrapper for moving a secret value from a
# source store into a target system without ever echoing the value into the
# calling agent's chat or shell history.
#
# Usage:
#   secret-inject.sh <source-uri> <target-uri> [--note "<one-line>"]
#   secret-inject.sh --self-test
#
# Source URI grammar:
#   env:<NAME>              # read $NAME from ~/.config/env/global.env (or current env)
#   file:<path>:<NAME>      # read $NAME from a KEY=VALUE file
#   keychain:<service>      # macOS Keychain (security find-generic-password)
#   op:<reference>          # 1Password CLI (op read <reference>)  — opt-in
#   stdin                   # read value from stdin (single line)
#
# Target URI grammar:
#   pages-secret:<project>:<NAME>     # wrangler pages secret put NAME --project-name project
#   wrangler-secret:<worker>:<NAME>   # wrangler secret put NAME (worker)
#   file-env:<path>:<NAME>            # append/update NAME=VALUE in a KEY=VALUE file
#   container-env:<svc>:<NAME>        # docker-compose-style env injection (writes to <svc>.env)
#   stdout-sha256                     # echo sha256 fingerprint of value (no value!) — self-test/diagnostics
#   stdout-len                        # echo only the length — self-test/diagnostics
#
# Output policy:
#   - NEVER prints the raw value.
#   - Prints exactly one confirmation line: `injected <name> (len=<N> sha256=<8hex>) → <target>`
#   - On error, prints the error CLASS (e.g. "source not found", "target unreachable"),
#     never the partial value.
#
# Why this exists: every prior session shipped secrets into chat because the
# agent called `echo "$FAL_KEY" | wrangler pages secret put`, which writes
# the value into the shell + the captured tool output. Wrapping in a single
# script removes the only path that can leak.

set -u
set -o pipefail

SELF_TEST=0
SOURCE=""
TARGET=""
NOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) SELF_TEST=1; shift ;;
    --note) NOTE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) if [ -z "$SOURCE" ]; then SOURCE="$1"; shift
       elif [ -z "$TARGET" ]; then TARGET="$1"; shift
       else echo "  ✗ unexpected arg: $1" >&2; exit 2; fi ;;
  esac
done

sha8() { printf '%s' "$1" | shasum -a 256 | cut -c1-8; }
mask_confirm() {
  local name="$1" value="$2" target="$3"
  local len=${#value}
  local sha; sha=$(sha8 "$value")
  printf '  ✓ injected %s (len=%d sha256=%s) → %s%s\n' "$name" "$len" "$sha" "$target" "${NOTE:+ · $NOTE}"
}

# Read source → echo VALUE only to a captured local var, never to stdout
read_source() {
  local uri="$1"
  case "$uri" in
    env:*)
      local var="${uri#env:}"
      # Prefer global.env then current env
      if [ -f "$HOME/.config/env/global.env" ]; then
        local v; v=$(grep -hE "^${var}=" "$HOME/.config/env/global.env" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')
        if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
      fi
      local v="${!var:-}"
      if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
      echo "  ✗ source not found: env:$var" >&2; return 1
      ;;
    file:*)
      local rest="${uri#file:}"
      local path="${rest%%:*}"; local var="${rest#*:}"
      [ -f "$path" ] || { echo "  ✗ source file missing: $path" >&2; return 1; }
      local v; v=$(grep -hE "^${var}=" "$path" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')
      [ -n "$v" ] || { echo "  ✗ source key missing: $path :: $var" >&2; return 1; }
      printf '%s' "$v"
      ;;
    keychain:*)
      local svc="${uri#keychain:}"
      local v; v=$(security find-generic-password -s "$svc" -w 2>/dev/null) || { echo "  ✗ keychain miss: $svc" >&2; return 1; }
      printf '%s' "$v"
      ;;
    op:*)
      command -v op >/dev/null || { echo "  ✗ op CLI not installed" >&2; return 1; }
      local ref="${uri#op:}"
      local v; v=$(op read "$ref" 2>/dev/null) || { echo "  ✗ op read failed: $ref" >&2; return 1; }
      printf '%s' "$v"
      ;;
    stdin)
      local v=""
      # read returns 1 on EOF-without-newline, but $v may still hold the data.
      IFS= read -r v || true
      if [ -z "$v" ]; then
        # Try reading the rest if it was multi-line / no-newline.
        v=$(cat)
      fi
      [ -n "$v" ] || { echo "  ✗ stdin read failed (empty input)" >&2; return 1; }
      printf '%s' "$v"
      ;;
    *) echo "  ✗ unknown source uri: $uri" >&2; return 2 ;;
  esac
}

write_target() {
  local uri="$1" value="$2"
  case "$uri" in
    pages-secret:*)
      local rest="${uri#pages-secret:}"
      local proj="${rest%%:*}"; local name="${rest#*:}"
      command -v wrangler >/dev/null || { echo "  ✗ wrangler missing" >&2; return 1; }
      printf '%s' "$value" | wrangler pages secret put "$name" --project-name "$proj" >/dev/null 2>&1 \
        || { echo "  ✗ wrangler pages secret put failed ($proj:$name)" >&2; return 1; }
      mask_confirm "$name" "$value" "pages-secret:$proj"
      ;;
    wrangler-secret:*)
      local rest="${uri#wrangler-secret:}"
      local worker="${rest%%:*}"; local name="${rest#*:}"
      command -v wrangler >/dev/null || { echo "  ✗ wrangler missing" >&2; return 1; }
      ( cd "$worker" 2>/dev/null && printf '%s' "$value" | wrangler secret put "$name" >/dev/null 2>&1 ) \
        || { echo "  ✗ wrangler secret put failed ($worker:$name)" >&2; return 1; }
      mask_confirm "$name" "$value" "wrangler-secret:$worker"
      ;;
    file-env:*)
      local rest="${uri#file-env:}"
      local path="${rest%%:*}"; local name="${rest#*:}"
      mkdir -p "$(dirname "$path")" || true
      # Strip any existing line for NAME, then append. Atomic via tmp file.
      local tmp; tmp=$(mktemp)
      [ -f "$path" ] && grep -vE "^${name}=" "$path" > "$tmp" || true
      printf '%s=%s\n' "$name" "$value" >> "$tmp"
      mv "$tmp" "$path"
      chmod 600 "$path"
      mask_confirm "$name" "$value" "file-env:$path"
      ;;
    container-env:*)
      local rest="${uri#container-env:}"
      local svc="${rest%%:*}"; local name="${rest#*:}"
      local path="./.env.${svc}"
      local tmp; tmp=$(mktemp)
      [ -f "$path" ] && grep -vE "^${name}=" "$path" > "$tmp" || true
      printf '%s=%s\n' "$name" "$value" >> "$tmp"
      mv "$tmp" "$path"; chmod 600 "$path"
      mask_confirm "$name" "$value" "container-env:$svc → $path"
      ;;
    stdout-sha256)
      local sha; sha=$(sha8 "$value")
      printf '  ✓ value present (sha256-8=%s len=%d)\n' "$sha" "${#value}"
      ;;
    stdout-len)
      printf '  ✓ value present (len=%d)\n' "${#value}"
      ;;
    *) echo "  ✗ unknown target uri: $uri" >&2; return 2 ;;
  esac
}

if [ "$SELF_TEST" = "1" ]; then
  # Self-test: never touches a real secret. Uses a synthetic value via stdin.
  echo "=== secret-inject.sh self-test ==="
  TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT
  # Test 1: stdin → file-env, then read back → stdout-sha256
  OUT=$(printf 'hello-secret-value-123' | bash "$0" stdin "file-env:$TMP/test.env:TEST_KEY" 2>&1)
  echo "  test1: $OUT"
  if ! grep -q "TEST_KEY=hello-secret-value-123" "$TMP/test.env"; then echo "  ✗ test1: file write failed"; exit 1; fi
  # Confirm the script's stdout does NOT contain the value
  if echo "$OUT" | grep -q "hello-secret-value-123"; then echo "  ✗ test1: VALUE LEAKED INTO STDOUT"; exit 1; fi
  echo "  ✓ test1: file-env target writes value, stdout sanitized"

  # Test 2: file → stdout-len
  OUT=$(bash "$0" "file:$TMP/test.env:TEST_KEY" stdout-len 2>&1)
  echo "  test2: $OUT"
  if echo "$OUT" | grep -q "hello-secret-value-123"; then echo "  ✗ test2: VALUE LEAKED"; exit 1; fi
  echo "$OUT" | grep -q "len=22" || { echo "  ✗ test2: wrong length"; exit 1; }
  echo "  ✓ test2: file→stdout-len reads + reports length, no value"

  # Test 3: missing source → clean error
  OUT=$(bash "$0" "env:NEVER_EXISTS_XYZ" stdout-len 2>&1 || true)
  echo "  test3: $OUT"
  echo "$OUT" | grep -q "source not found" || { echo "  ✗ test3: missing-source error not surfaced"; exit 1; }
  echo "  ✓ test3: missing source emits clean error class, no partial value"

  echo "=== self-test green ==="
  exit 0
fi

[ -z "$SOURCE" ] || [ -z "$TARGET" ] && {
  echo "usage: secret-inject.sh <source-uri> <target-uri> [--note <text>]" >&2
  echo "       secret-inject.sh --self-test" >&2
  exit 2
}

# Read value into a local var. The only place the value lives.
VALUE=$(read_source "$SOURCE") || exit 1
[ -z "$VALUE" ] && { echo "  ✗ source returned empty value" >&2; exit 1; }

write_target "$TARGET" "$VALUE" || exit 1

# Belt-and-braces: clear the var before exit (best-effort; shells may keep
# the assignment in history regardless).
VALUE=
