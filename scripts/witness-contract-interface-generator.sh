#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SKILL="$ROOT/.agents/skills/contract-interface"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
python3 "$SKILL/scripts/grow.py" "$SKILL/tests/telegram.json" --out "$TMP/telegram" >/dev/null
python3 "$SKILL/scripts/grow.py" "$SKILL/tests/filesystem.json" --out "$TMP/filesystem" >/dev/null
python3 "$SKILL/scripts/conform.py" "$TMP/telegram"
python3 "$SKILL/scripts/conform.py" "$TMP/filesystem"
python3 "$ROOT/scripts/test-contract-native-skills.py"
if rg -n -i 'telegram|ios|slack' "$SKILL/scripts/grow.py"; then
  echo "provider branch leaked into generic compiler" >&2
  exit 1
fi
python3 - "$TMP" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1])
a=json.loads((p/"telegram/contract-skill.json").read_text())
b=json.loads((p/"filesystem/contract-skill.json").read_text())
assert [n["key"] for n in a["nodes"]]==[n["key"] for n in b["nodes"]]
assert a["nodes"][4]["effect"]=="external_message"
assert b["nodes"][4]["effect"]=="local_reversible"
print("cross-interface fixed-point passed")
PY
echo "contract interface generator witness passed"
