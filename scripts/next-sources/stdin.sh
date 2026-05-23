#!/usr/bin/env bash
# stdin source: accept proposals from stdin (the agent / chat / user
# supplies a candidate envelope manually). Non-binding fallback.
set -e

PAYLOAD=$(cat 2>/dev/null || true)
[ -n "$PAYLOAD" ] || exit 1

CTX_PAYLOAD="$PAYLOAD" python3 <<'PY'
import json, os
raw = os.environ["CTX_PAYLOAD"]
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    # Treat raw as plan+action separated by '|'
    if "|" in raw:
        plan, action = raw.split("|", 1)
        data = [{"plan": plan.strip(), "action": action.strip()}]
    else:
        data = [{"plan": raw.strip(), "action": "agent-judges"}]
proposals = data if isinstance(data, list) else data.get("proposals", [])
if not proposals:
    raise SystemExit(1)
for p in proposals:
    p["source"] = "stdin"
    p.setdefault("score", 7)  # explicit user input ranks high
    p.setdefault("rationale", "user/agent-provided proposal via stdin")
print(json.dumps(proposals))
PY
