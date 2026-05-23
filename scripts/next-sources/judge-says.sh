#!/usr/bin/env bash
# judge-says source: scan ledger for the latest `judged` row on this id.
# If verdict is HOLD or REJECT and blocked_by lists contract ids,
# propose each blocker as the next-layer to drive. Composes with Ω1
# unblock-rewake — drive the blocker, this id wakes up.
set -e

CID="${1:-${CONTEXT_CONTRACT_ID:-}}"
[ -n "$CID" ] || exit 1
LEDGER="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
[ -f "$LEDGER" ] || exit 1

CTX_CID="$CID" CTX_LEDGER="$LEDGER" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get  # type: ignore

cid = os.environ["CTX_CID"]
ledger = os.environ["CTX_LEDGER"]
latest = None
try:
    with open(ledger) as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try: row = json.loads(line)
            except json.JSONDecodeError: continue
            if row.get("event") == "judged" and row.get("id") == cid:
                latest = row
except OSError:
    sys.exit(1)
if not latest:
    sys.exit(1)
verdict = (latest.get("verdict") or "").upper()
if verdict not in ("HOLD", "REJECT"):
    sys.exit(1)
blockers = latest.get("blocked_by") or []
if not blockers:
    sys.exit(1)

proposals = []
for b in blockers:
    b_row = get(b)
    if not b_row:
        continue
    if b_row.get("status") in ("satisfied", "merged", "rejected"):
        continue
    proposals.append({
        "plan": f"resolve blocker {b} so {cid} can re-judge from {verdict}",
        "action": f"contract:{b}",
        "rationale": f"latest Λ1 verdict on {cid} was {verdict}, blocked_by={b}",
        "parent": cid,
        "blocker_id": b,
        "blocker_plan": (b_row.get("plan") or "")[:120],
        "blocker_status": b_row.get("status"),
        "score": 8,
    })
if not proposals:
    sys.exit(1)
print(json.dumps(proposals))
PY
