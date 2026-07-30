#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${ARC_AGI3_PYTHON:-/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python}"
"$PYTHON" - "$HERE" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
from native_contract import NativeContract

contract = NativeContract()
assert contract.abi_version in (2, 3, 4, 5, 6)
registered = contract.register_actions([1, 2, 6])
assert registered and registered["count"] == 3, registered
plan = contract.plan("unseen grid state; probe a legal action and learn from the transition", [1, 2, 6])
assert plan and (plan.get("candidates") or plan.get("cells")), plan
action = contract.recommended_action(plan)
assert action in (1, 2, 6), (action, plan)
outcome = contract.observe("native ARC ABI gate transition", action, True, "object")
assert outcome and outcome["status"] == "satisfied", outcome
print(json.dumps({"abi": contract.abi_version, "library": str(contract.path), "action": action, "status": outcome["status"]}))
PY
