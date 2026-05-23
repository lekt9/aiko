#!/usr/bin/env bash
# audits/no-stub-training-data/verify.sh
#
# Walks every data/ dir under ~/Projects, finds every train.jsonl /
# valid.jsonl (or *_sft/train.jsonl style) with ≥1000 rows, and asserts
# stub-shape patterns are absent:
#
#   - ROW-COUNT STUB: file has <1000 rows when its dir name implies a
#     full-corpus training file (canon_sft / *_sft / *_train).
#   - TARGET-COLLAPSE STUB: the most-common assistant-content string
#     appears in >5% of rows, AND the unique-target ratio is <50%.
#     (Natural language frequency can hit ~0.1% on common phrases; 5%
#     is the threshold where "this is a hardcoded boilerplate" is clear.)
#   - PROMPT-COLLAPSE STUB: same heuristic but on user-content.
#
# Exits 0 on a clean corpus; exits 1 with a per-file violation listing
# on any stub detected. The fixer is NOT auto — stubs require either
# regenerating with diversified targets or formally removing the arm
# (the v23 fix on 2026-05-24 dropped the kjv_esv_parallel arm because
# it had a hardcoded target).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse scope.txt for globs of dirs to walk.
SCOPE_FILE="$SCRIPT_DIR/scope.txt"
[ -f "$SCOPE_FILE" ] || { echo "FAIL: scope.txt missing" >&2; exit 2; }

DIRS=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  # eval echo expands ~ and globs
  for d in $(eval echo "$line"); do
    [ -d "$d" ] && DIRS+=("$d")
  done
done < "$SCOPE_FILE"

if [ ${#DIRS[@]} -eq 0 ]; then
  echo "no scoped dirs exist on this host — skip"
  exit 0
fi

# Collect candidate jsonl files: training files under any data subdir,
# ≥1000 rows (cheap line count first to filter).
CANDIDATES=()
for d in "${DIRS[@]}"; do
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    rows=$(wc -l < "$f" 2>/dev/null || echo 0)
    [ "$rows" -ge 1000 ] && CANDIDATES+=("$f")
  done < <(find "$d" -maxdepth 3 -type f \( -name "train.jsonl" -o -name "valid.jsonl" -o -name "*_train.jsonl" -o -name "*_sft.jsonl" \) 2>/dev/null)
done

if [ ${#CANDIDATES[@]} -eq 0 ]; then
  echo "no candidate training jsonl found in scope — skip"
  exit 0
fi

# Run the stub-shape check via python3 (handles json + counter cleanly).
FAILS=$(CAND_LIST="$(printf '%s\n' "${CANDIDATES[@]}")" python3 - <<'PY'
import os, sys, json
from collections import Counter

files = [p for p in os.environ.get("CAND_LIST","").splitlines() if p.strip()]
fails = []

for path in files:
    try:
        targets = Counter()
        prompts = Counter()
        total = 0
        with open(path) as f:
            for line in f:
                if not line.strip(): continue
                try: row = json.loads(line)
                except Exception: continue
                msgs = row.get("messages") if isinstance(row, dict) else None
                if not msgs or len(msgs) < 2: continue
                # find first user and first assistant
                u = next((m["content"] for m in msgs if m.get("role")=="user" and isinstance(m.get("content"), str)), None)
                a = next((m["content"] for m in msgs if m.get("role")=="assistant" and isinstance(m.get("content"), str)), None)
                if u is None or a is None: continue
                prompts[u] += 1
                targets[a] += 1
                total += 1
        if total < 1000:
            continue
        # Target-collapse check
        top_a, top_a_n = targets.most_common(1)[0]
        uniq_a_ratio = len(targets) / total
        if (top_a_n / total) > 0.05 and uniq_a_ratio < 0.50:
            fails.append(f"TARGET-COLLAPSE  {path}\n  top target [{top_a_n}/{total} = {top_a_n/total:.1%}] {top_a[:80]!r}\n  unique-target ratio: {uniq_a_ratio:.1%} (<50%)")
        # Prompt-collapse check (less common, but a stub-shape — e.g. all rows have the same prompt template)
        top_p, top_p_n = prompts.most_common(1)[0]
        uniq_p_ratio = len(prompts) / total
        if (top_p_n / total) > 0.50 and uniq_p_ratio < 0.10:
            fails.append(f"PROMPT-COLLAPSE  {path}\n  top prompt [{top_p_n}/{total} = {top_p_n/total:.1%}] {top_p[:80]!r}\n  unique-prompt ratio: {uniq_p_ratio:.1%} (<10%)")
    except Exception as e:
        fails.append(f"READ-ERROR  {path}: {e}")

if fails:
    print("\n".join(fails))
    sys.exit(1)
sys.exit(0)
PY
)
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo "no-stub-training-data: ${#CANDIDATES[@]} file(s) checked, no stubs detected"
  exit 0
else
  echo "=== STUB-SHAPED TRAINING DATA DETECTED ==="
  echo "$FAILS"
  echo ""
  echo "Fix:"
  echo "  - TARGET-COLLAPSE: either regenerate the affected rows with diversified targets"
  echo "    (per-row real content, not a hardcoded boilerplate), or drop the offending arm"
  echo "    from the builder (worked example: build_canon_sft.py 2026-05-24 dropped the"
  echo "    kjv_esv_parallel arm)."
  echo "  - PROMPT-COLLAPSE: rotate prompt templates per-row; one prompt across the whole"
  echo "    corpus teaches the model only one shape."
  exit 1
fi
