#!/usr/bin/env bash
# child-gap source: for a funnel/sequence/quorum/funnel-first parent that
# hasn't resolved, list each unsatisfied child as a "next-layer" proposal
# (iterate it next). Non-binding: exits 1 silently if parent has no
# children or already has all children satisfied.
set -e

CID="${1:-${CONTEXT_CONTRACT_ID:-}}"
DATA="${CONTEXT_CONTRACT_DATA:-}"
[ -n "$CID" ] || exit 1
[ -n "$DATA" ] || exit 1

CTX_CID="$CID" CTX_DATA="$DATA" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get  # type: ignore

cid = os.environ["CTX_CID"]
data = json.loads(os.environ["CTX_DATA"])
action = (data.get("action") or "").strip()

# Only composition shapes have children worth gap-listing
comp_shapes = ("funnel", "funnel-first", "sequence", "children-satisfy")
is_comp = action in comp_shapes or action.startswith("quorum:")
if not is_comp:
    sys.exit(1)

children = data.get("children") or []
if not children:
    sys.exit(1)

proposals = []
for child_id in children:
    c = get(child_id)
    if not c:
        continue
    cs = c.get("status")
    if cs in ("satisfied", "merged", "rejected"):
        continue
    proposals.append({
        "plan": f"drive child {child_id} of {cid} to resolution",
        "action": f"contract:{child_id}",
        "rationale": f"unresolved child of {action} parent; iterate this leaf next",
        "parent": cid,
        "child_id": child_id,
        "child_plan": (c.get("plan") or "")[:120],
        "child_status": cs,
        "score": 5,
    })

if not proposals:
    sys.exit(1)
print(json.dumps(proposals))
PY
