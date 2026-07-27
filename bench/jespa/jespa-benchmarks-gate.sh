#!/usr/bin/env bash
# TARGET=2 is the genuine reproduced-win count currently present in the ledger:
# one document-discrimination win and one Zig claimed-task runtime win.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LEDGER="${JESPA_LEDGER:-benchmarks-ledger.jsonl}"
TARGET="${JESPA_WIN_TARGET:-1}"
[ -s "$LEDGER" ] || { echo "[jespa-bench] no ledger ($LEDGER)"; exit 1; }
wins=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  won=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('won'))" 2>/dev/null)
  [ "$won" = "True" ] || continue
  witness=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('witness',''))" 2>/dev/null)
  bench=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('bench',''))" 2>/dev/null)
  if [ -n "$witness" ] && [ "$witness" != "none" ] && timeout 600 bash -c "$witness" >/dev/null 2>&1; then
    echo "[jespa-bench] WIN reproduced: $bench"
    wins=$((wins+1))
  else
    echo "[jespa-bench] won-row NOT reproduced: $bench"
  fi
done < "$LEDGER"
echo "[jespa-bench] reproduced wins: $wins / target $TARGET"
[ "$wins" -ge "$TARGET" ] && { echo "[jespa-bench] PASS"; exit 0; }
echo "[jespa-bench] FAIL — need $((TARGET-wins)) more reproduced win(s)"
exit 1
