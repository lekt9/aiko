#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MARKER=${1:-sk-contractfixture-do-not-persist-8675309}
found=0

for path in \
  "$ROOT/.claude/contracts.jsonl" \
  "$ROOT/.claude/events.jsonl" \
  "$ROOT/.claude/activity.log" \
  "$HOME/.contracts/contracts.jsonl" \
  "$HOME/.contracts/events.jsonl" \
  "$HOME/.contracts/activity.log" \
  "$ROOT/traces"
do
  [ -e "$path" ] || continue
  if rg -F -- "$MARKER" "$path" >/dev/null 2>&1; then
    echo "FAIL: planted secret persisted in $path" >&2
    found=1
  fi
done

if ! rg -F "REDACTED" "$ROOT/tools/contract-events.html" >/dev/null 2>&1; then
  echo "FAIL: renderer redaction boundary missing" >&2
  found=1
fi

[ "$found" -eq 0 ] || exit 1
echo "PASS: planted secret absent from runtime ledgers, logs, traces, and renderer output boundary"
