#!/usr/bin/env bash
# search-bm25 source: surface up-to-3 similar satisfied contracts whose
# actions could be borrowed as the next-layer attempt. Non-binding —
# exits 1 silently when no similar contract scores high enough.
set -e

CID="${1:-${CONTEXT_CONTRACT_ID:-}}"
DATA="${CONTEXT_CONTRACT_DATA:-}"
[ -n "$DATA" ] || exit 1

PLAN=$(python3 -c "import json,sys,os; d=json.loads(os.environ['CTX_DATA']); print(d.get('plan','')[:200])" CTX_DATA="$DATA" 2>/dev/null || true)
CTX_DATA="$DATA" PLAN_TEXT=$(python3 -c "import json,os; d=json.loads(os.environ['CTX_DATA']); print(d.get('plan','')[:200])")
[ -n "$PLAN_TEXT" ] || exit 1

DETECTOR="$HOME/.claude/skills/contract/scripts/contract-habit-detect.py"
[ -x "$DETECTOR" ] || exit 1

RAW=$(python3 "$DETECTOR" --context "$PLAN_TEXT" --exclude "$CID" --threshold 0.6 2>/dev/null || true)
[ -n "$RAW" ] || exit 1

CTX_RAW="$RAW" CTX_CID="$CID" python3 <<'PY'
import json, os, re, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get  # type: ignore

raw = os.environ["CTX_RAW"]
cid = os.environ["CTX_CID"]

# detector output mentions ids as "id=<8hex>" lines
ids: list[str] = []
for m in re.finditer(r"id=([0-9a-f]{8})\b", raw):
    other = m.group(1)
    if other != cid and other not in ids:
        ids.append(other)
if not ids:
    sys.exit(1)

proposals = []
for other in ids[:3]:
    o = get(other)
    if not o:
        continue
    if o.get("status") != "satisfied":
        continue
    action = (o.get("action") or "").strip()
    if not action or action in ("funnel", "funnel-first", "sequence", "children-satisfy") or action.startswith(("quorum:", "contract:")):
        continue  # composition / pointer-only actions aren't borrowable
    proposals.append({
        "plan": f"try the approach from satisfied contract {other}: " + (o.get("plan") or "")[:80],
        "action": action,
        "rationale": f"similar plan, already satisfied — borrow this contract's action verbatim and iterate",
        "parent": cid,
        "borrowed_from": other,
        "score": 3,
    })
if not proposals:
    sys.exit(1)
print(json.dumps(proposals))
PY
