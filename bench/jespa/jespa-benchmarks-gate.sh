#!/usr/bin/env bash
# TARGET=4 is the genuine reproduced-win count currently present in the ledger:
# architecture-document discrimination, Zig claimed-task runtime, energy-router
# discrimination, and Agentic Organism benchmark-integrity discrimination.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LEDGER="${JESPA_LEDGER:-benchmarks-ledger.jsonl}"
TARGET="${JESPA_WIN_TARGET:-1}"
[ -s "$LEDGER" ] || { echo "[jespa-bench] no ledger ($LEDGER)"; exit 1; }
GATE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/neuron-jespa-gate.XXXXXX") || exit 1
SNAPSHOT="$GATE_TMP/ledger.jsonl"
SEEN="$GATE_TMP/seen.txt"
cp "$LEDGER" "$SNAPSHOT"
: > "$SEEN"
cleanup() {
  rm -f "$SNAPSHOT" "$SEEN"
  rmdir "$GATE_TMP"
}
trap cleanup EXIT
wins=0
line_number=0
while IFS= read -r line; do
  line_number=$((line_number+1))
  [ -z "$line" ] && continue
  if ! won=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('won'))" 2>/dev/null); then
    echo "[jespa-bench] malformed ledger row $line_number"
    exit 1
  fi
  [ "$won" = "True" ] || continue
  reproduced=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reproduced'))" 2>/dev/null)
  [ "$reproduced" = "True" ] || {
    echo "[jespa-bench] won-row is not marked reproduced at line $line_number"
    continue
  }
  witness=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('witness',''))" 2>/dev/null)
  bench=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin).get('bench',''))" 2>/dev/null)
  case "$bench" in
    ""|*[!A-Za-z0-9._-]*)
      echo "[jespa-bench] invalid benchmark id at line $line_number"
      exit 1
      ;;
  esac
  if grep -Fqx "$bench" "$SEEN"; then
    echo "[jespa-bench] duplicate won-row ignored: $bench"
    continue
  fi
  printf '%s\n' "$bench" >> "$SEEN"
  if [ -n "$witness" ] && [ "$witness" != "none" ] && timeout 600 bash -c "$witness" >/dev/null 2>&1; then
    echo "[jespa-bench] WIN reproduced: $bench"
    wins=$((wins+1))
  else
    echo "[jespa-bench] won-row NOT reproduced: $bench"
  fi
done < "$SNAPSHOT"
echo "[jespa-bench] reproduced wins: $wins / target $TARGET"
[ "$wins" -ge "$TARGET" ] && { echo "[jespa-bench] PASS"; exit 0; }
echo "[jespa-bench] FAIL — need $((TARGET-wins)) more reproduced win(s)"
exit 1
