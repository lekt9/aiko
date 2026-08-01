#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$ROOT/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs"
python3 "$ROOT/scripts/contract_chokepoint_gate.py" "$SOURCE"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cp "$SOURCE" "$TMP"
printf '\nasync fn injected_bypass() { dispatch_tool(todo!(), todo!(), todo!()).await; }\n' >> "$TMP"
if python3 "$ROOT/scripts/contract_chokepoint_gate.py" "$TMP"; then
  echo "CHOKEPOINT FAIL: injected bypass was not detected" >&2
  exit 1
fi
perl -pe 'if (!$done) { $done = s/bind_active_tool_contract\(/contract_bind_removed\(/ }' "$SOURCE" > "$TMP"
if python3 "$ROOT/scripts/contract_chokepoint_gate.py" "$TMP"; then
  echo "CHOKEPOINT FAIL: removed begin was not detected" >&2
  exit 1
fi
perl -pe 's/\.hold_reason\(\)/.hold_check_removed()/g' "$SOURCE" > "$TMP"
if python3 "$ROOT/scripts/contract_chokepoint_gate.py" "$TMP"; then
  echo "CHOKEPOINT FAIL: removed HOLD check was not detected" >&2
  exit 1
fi
echo "CHOKEPOINT-COVERAGE PASS: real route passes and dispatch/bind/HOLD bypass mutations fail"
