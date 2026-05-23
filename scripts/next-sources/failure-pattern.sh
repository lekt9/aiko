#!/usr/bin/env bash
# failure-pattern source: scan ledger for ≥3 consecutive FAILed iterates
# on this id. If found, propose `revise` and `supersede` as next-layer
# options — the contract is grinding and needs an escalation.
set -e

CID="${1:-${CONTEXT_CONTRACT_ID:-}}"
[ -n "$CID" ] || exit 1
LEDGER="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
[ -f "$LEDGER" ] || exit 1

CTX_CID="$CID" CTX_LEDGER="$LEDGER" python3 <<'PY'
import json, os, sys
cid = os.environ["CTX_CID"]
ledger = os.environ["CTX_LEDGER"]
fails = 0
last_n_results: list[str] = []
try:
    with open(ledger) as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try: row = json.loads(line)
            except json.JSONDecodeError: continue
            if row.get("event") == "iterated" and row.get("id") == cid:
                r = row.get("action_result") or "fail"
                last_n_results.append(r)
                if r == "fail":
                    fails += 1
                else:
                    fails = 0  # streak resets on any non-fail
except OSError:
    sys.exit(1)

if fails < 3:
    sys.exit(1)

proposals = [
    {
        "plan": f"revise {cid} action — current action has FAILed {fails} consecutive waves",
        "action": "agent-judges",
        "rationale": f"failure-streak={fails} — propose `contract revise {cid} --action <new>` to swap the gate",
        "parent": cid,
        "next_cmd": f"contract revise {cid} --action '<new check>'",
        "score": 6,
    },
    {
        "plan": f"supersede {cid} — failure-streak={fails} suggests the claim itself is wrong",
        "action": "agent-judges",
        "rationale": f"contract has FAILed {fails} times; consider whether the truth claim itself is wrong and another contract should win",
        "parent": cid,
        "next_cmd": f"contract supersede {cid} <winner-id> --reason 'failure-streak={fails}'",
        "score": 4,
    },
]
print(json.dumps(proposals))
PY
