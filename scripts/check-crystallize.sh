#!/usr/bin/env bash
# check-crystallize.sh <module|hook|verb|docs>
#
# Wiring + behaviour gate for the contract crystallize-learning feature.
# Each subcommand is the --action of one child contract under organ
# cbb2a1d3. The harness collects evidence; the agent judges KEY 2 in-thread.
set -uo pipefail

SKILL="$HOME/.claude/skills/contract"
CONTRACT="$SKILL/scripts/contract"
CRYS="$SKILL/scripts/contract-crystallize.py"
HOOK="$HOME/.contracts/hooks/crystallize-learning.py"

sub="${1:-}"
case "$sub" in
  module)
    [ -x "$CRYS" ] || { echo "FAIL: $CRYS missing or not executable"; exit 1; }
    python3 "$CRYS" --self-check || { echo "FAIL: --self-check exit nonzero"; exit 1; }
    echo "PASS: crystallize module present and self-check green"
    ;;

  hook)
    [ -x "$HOOK" ] || { echo "FAIL: $HOOK missing or not executable"; exit 1; }
    TMP=$(mktemp -d)
    export CONTRACTS_STORE="$TMP/contracts.jsonl"
    export CONTRACT_CRYSTALLIZE_MEMORY_DIR="$TMP/memory"
    export CONTRACT_CRYSTALLIZE_NO_OUTLINE=1
    export CONTRACT_SELF_TEST=1
    ID=$(bash "$CONTRACT" declare "crystallize hook e2e probe $$-$(date +%s)" \
          --action agent-judges \
          --learning "e2e probe: the crystallize hook fires on the mark event and writes a memory file" \
          2>/dev/null | grep -oE 'declared: [0-9a-f]+' | head -1 | awk '{print $2}')
    [ -n "$ID" ] || { echo "FAIL: could not declare probe contract"; rm -rf "$TMP"; exit 1; }
    bash "$CONTRACT" _mark "$ID" satisfied >/dev/null 2>&1
    # Hooks fire in the background - poll the ledger for the crystallized row.
    ok=""
    for _ in $(seq 1 30); do
      if python3 -c "import json,sys; rows=[json.loads(l) for l in open('$CONTRACTS_STORE') if l.strip()]; sys.exit(0 if any(r.get('event')=='crystallized' and r.get('id')=='$ID' for r in rows) else 1)" 2>/dev/null; then
        ok=1; break
      fi
      sleep 0.5
    done
    memfiles=$(find "$CONTRACT_CRYSTALLIZE_MEMORY_DIR" -name '*.md' \
      ! -name 'MEMORY.md' 2>/dev/null | wc -l | tr -d ' ')
    rm -rf "$TMP"
    [ -n "$ok" ] || { echo "FAIL: no crystallized ledger row for $ID after mark"; exit 1; }
    [ "${memfiles:-0}" -ge 1 ] || { echo "FAIL: hook wrote no memory file"; exit 1; }
    echo "PASS: hook crystallizes a learning contract on mark (ledger row + memory file)"
    ;;

  verb)
    grep -qE '^[[:space:]]*learn\)' "$CONTRACT" || { echo "FAIL: learn) verb not in CLI"; exit 1; }
    TMP=$(mktemp -d)
    export CONTRACTS_STORE="$TMP/contracts.jsonl"
    export CONTRACT_CRYSTALLIZE_MEMORY_DIR="$TMP/memory"
    export CONTRACT_CRYSTALLIZE_NO_OUTLINE=1
    OUT=$(bash "$CONTRACT" learn "check-crystallize verb probe $$-$(date +%s)" \
            --source "check-crystallize.sh" 2>&1)
    rc=$?
    mem=$(echo "$OUT" | grep -E 'memory:[[:space:]]' | head -1)
    learned=$(python3 -c "import json; rows=[json.loads(l) for l in open('$CONTRACTS_STORE') if l.strip()]; print(sum(1 for r in rows if r.get('event')=='learned'))" 2>/dev/null || echo 0)
    memfiles=$(find "$CONTRACT_CRYSTALLIZE_MEMORY_DIR" -name '*.md' \
      ! -name 'MEMORY.md' 2>/dev/null | wc -l | tr -d ' ')
    rm -rf "$TMP"
    [ "$rc" -eq 0 ] || { echo "FAIL: learn verb exit $rc"; echo "$OUT"; exit 1; }
    [ -n "$mem" ] || { echo "FAIL: learn verb reported no memory file"; echo "$OUT"; exit 1; }
    [ "${learned:-0}" -ge 1 ] || { echo "FAIL: no learned ledger row"; exit 1; }
    [ "${memfiles:-0}" -ge 1 ] || { echo "FAIL: learn verb wrote no memory file"; exit 1; }
    echo "PASS: learn verb writes a memory file and a learned ledger row"
    ;;

  docs)
    M="$SKILL/SKILL.md"
    grep -q 'contract learn' "$M" || { echo "FAIL: SKILL.md does not document the learn verb"; exit 1; }
    grep -qi 'crystalliz' "$M" || { echo "FAIL: SKILL.md does not document the crystallize hook"; exit 1; }
    echo "PASS: SKILL.md documents the learn verb + crystallize hook"
    ;;

  *)
    echo "usage: check-crystallize.sh <module|hook|verb|docs>" >&2
    exit 2
    ;;
esac
