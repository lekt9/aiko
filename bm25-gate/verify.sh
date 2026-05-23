#!/usr/bin/env bash
# verify.sh — proves the plan stage discovers/reuses past contracts by BM25.
set -uo pipefail
DETECT="$HOME/.claude/skills/contract/scripts/contract-habit-detect.py"
CONTRACT="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"

# 1. BM25 idf property: a doc with a RARE query term must outscore a doc
#    stuffed with a COMMON one. Bare token-overlap would rank them the other
#    way; only idf-weighting gets this right.
python3 - "$DETECT" <<'PY' || { echo "FAIL: BM25 idf property"; exit 1; }
import importlib.util, sys
spec = importlib.util.spec_from_file_location("chd", sys.argv[1])
chd = importlib.util.module_from_spec(spec); spec.loader.exec_module(chd)
docs = [(f"d{i}", "common common widget gadget") for i in range(20)]
docs += [("rareDoc", "rare special unicorn"),
         ("commonDoc", "common common common common")]
s = chd._bm25_scores("rare common", docs)
assert s["rareDoc"] > s["commonDoc"], \
    f"idf fail: rareDoc={s['rareDoc']:.3f} commonDoc={s['commonDoc']:.3f}"
print(f"  bm25: rareDoc={s['rareDoc']:.3f} > commonDoc={s['commonDoc']:.3f}")
PY
echo "evidence: BM25 idf weights the rare term over a stuffed common term  OK"

# 2. discovery: a nonce contract must be found and ranked #1 at score 1.0.
NONCE="bm25gate_selftest_$$"
AID=$(bash "$CONTRACT" declare "$NONCE discover and reuse probe alpha bravo" \
        --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$AID" ] || { echo "FAIL: could not declare the probe contract"; exit 1; }
JSON=$(PYTHONPATH="$LIB" python3 "$DETECT" --context "$NONCE discover and reuse probe" --json 2>/dev/null)
TOP=$(echo "$JSON" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print((d[0]['id'] if d else 'NONE'), (d[0]['score'] if d else 0))")
case "$TOP" in
  "$AID 1.0"|"$AID 1") echo "evidence: BM25 discovery ranked the probe #1 at score 1.0  OK" ;;
  *) echo "FAIL: expected top hit '$AID 1.0', got '$TOP'"; exit 1 ;;
esac

# 3. ranking invariants: descending, normalized to <= 1.0.
echo "$JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin); sc=[c['score'] for c in d]
assert sc==sorted(sc,reverse=True), 'not sorted descending'
assert all(x<=1.0 for x in sc), 'a score exceeded 1.0'
" || { echo "FAIL: ranking invariants"; exit 1; }
echo "evidence: candidates sorted descending, normalized to <=1.0  OK"

echo "PASS: the plan stage discovers and reuses past contracts by BM25."
exit 0
