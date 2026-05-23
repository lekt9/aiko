#!/usr/bin/env bash
# prior source: find a previous contract whose bind_to is "context:<topic>"
# or whose plan text declared "context_topic=<topic>". Reuses the cached
# envelope from that contract's stream (if it wrote one) or synthesizes a
# minimal envelope referencing the prior contract id.
#
# Non-binding: if no prior contract matches, exits 1 silently.
set -e

TOPIC="${1:-${CONTEXT_TOPIC:-}}"
SLUG="${CONTEXT_SLUG:-topic}"
LEDGER="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
[ -f "$LEDGER" ] || exit 1

python3 - "$TOPIC" "$SLUG" "$LEDGER" <<'PY'
import json, os, sys
from pathlib import Path

topic, slug, ledger = sys.argv[1], sys.argv[2], sys.argv[3]
bind_match = f"context:{topic}"
slug_bind  = f"context:{slug}"
candidates = []
try:
    with open(ledger) as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("event") != "declared":
                continue
            bt = row.get("bind_to")
            plan = (row.get("plan") or "")
            hit = False
            if bt and (bt == bind_match or bt == slug_bind):
                hit = True
            if not hit and f"context_topic={topic}" in plan:
                hit = True
            if hit:
                candidates.append(row)
except OSError:
    sys.exit(1)

if not candidates:
    sys.exit(1)

# Prefer the most recent matching declared row
winner = candidates[-1]
cid = winner.get("id")

# Did that contract write a stream body? (~/.contracts/streams/<cid>/state.json)
stream_state = Path(os.path.expanduser(f"~/.contracts/streams/{cid}/state.json"))
body = None
refs = []
if stream_state.exists():
    try:
        body = stream_state.read_text()
    except OSError:
        body = None

if body is None:
    body = (
        f"Prior contract {cid} bound to {bind_match!r}.\n"
        f"plan: {winner.get('plan','')}\n"
        f"action: {winner.get('action','')}\n"
        f"(no stream state.json was written; consult `contract status {cid}` for evidence)"
    )
    refs = [f"contract:{cid}"]

env = {
    "topic": topic,
    "slug": slug,
    "source": "prior",
    "body": body,
    "refs": refs or [f"contract:{cid}"],
    "prior_contract_id": cid,
}
print(json.dumps(env))
PY
