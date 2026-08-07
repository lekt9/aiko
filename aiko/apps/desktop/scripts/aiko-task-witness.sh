#!/usr/bin/env bash
# Witness: the main Task chat is driven by the local aiko runtime, not the
# Manus sandbox agent — the "replace Tasks with Aiko" engine swap.
#
#   bash apps/desktop/scripts/aiko-task-witness.sh
#
# Two parts:
#   A. Static — the flag, the branch, the translator, and the frontend
#      reasoning-coalesce are all present.
#   B. Live — with the backend running under AIKO_AGENT=true, driving /ws/chat
#      produces streamed reasoning + a whole answer + a settling status. That
#      combination is only possible when aiko is the engine: the Manus path
#      needs a Docker sandbox (absent in native mode) and emits no reasoning
#      unless separately configured. So the live check IS the falsifier — turn
#      AIKO_AGENT off and it goes red.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BE="$ROOT/apps/frontend/backend"
FE="$ROOT/apps/frontend/frontend"
E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.aiko-task-e2e.py"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS  $*"; }

echo "A. Static — the engine swap is wired"
rg -q 'aiko_agent: bool' "$BE/app/core/config.py" || fail "config lacks aiko_agent flag"
pass "config has AIKO_AGENT flag"
rg -q 'get_settings\(\).aiko_agent' "$BE/app/application/services/agent_service.py" \
  || fail "agent_service does not branch on aiko_agent"
rg -q '_get_aiko_task_chat' "$BE/app/application/services/agent_service.py" \
  || fail "agent_service does not route to AikoTaskChat"
pass "AgentService.chat branches to the aiko engine"
test -f "$BE/app/domain/services/aiko_task_chat.py" || fail "AikoTaskChat missing"
rg -q 'class AikoTaskChat' "$BE/app/domain/services/aiko_task_chat.py" || fail "AikoTaskChat class missing"
pass "AikoTaskChat translator present"
# The frontend must coalesce streamed thinking or a turn becomes thousands of rows.
rg -q "kind === 'thinking'" "$FE/src/composables/useAgentEvents.ts" \
  && rg -q "open.detail = " "$FE/src/composables/useAgentEvents.ts" \
  || fail "useAgentEvents lacks reasoning coalescing"
pass "frontend coalesces streamed reasoning"

# Stop must actually abort an aiko turn (no Manus task to cancel).
rg -q 'await cancel_stream\(\)' "$BE/app/interfaces/api/ws_routes.py" \
  && rg -q 'async def cancel' "$BE/app/infrastructure/external/claw/aiko_acp_client.py" \
  && rg -q 'aiko_agent' "$BE/app/application/services/agent_service.py" \
  || fail "stop is not wired to cancel the aiko turn"
pass "Stop aborts the aiko turn"

# Uploaded files must reach aiko (workspace) instead of silently doing nothing.
rg -q '_stage_attachments' "$BE/app/domain/services/aiko_task_chat.py" \
  && rg -q 'workspace_dir' "$BE/app/infrastructure/external/claw/aiko_acp_client.py" \
  || fail "attachments are not staged into the aiko workspace"
pass "uploaded files reach the aiko workspace + files panel"

# The dead VNC "use computer" button must be gated off for the no-sandbox engine.
rg -q 'canUseComputer' "$FE/src/components/ComputerPanelContent.vue" \
  && rg -q ':canUseComputer="hasBrowserTool"' "$FE/src/pages/ChatPage.vue" \
  || fail "use-computer takeover is not gated on sandbox availability"
pass "use-computer takeover hidden when there is no sandbox"

echo
echo "B. Unit — translator yields the right AgentEvents + bookkeeping"
( cd "$BE" && uv run pytest tests/test_aiko_task_chat.py -q >/tmp/aiko-task-unit.log 2>&1 ) \
  || { tail -5 /tmp/aiko-task-unit.log; fail "AikoTaskChat unit tests red"; }
pass "AikoTaskChat unit suite green"

echo
echo "C. Live — /ws/chat is actually aiko-backed"
if ! curl -sf -m 3 http://127.0.0.1:8000/api/v1/config/frontend >/dev/null 2>&1; then
  echo "SKIP  backend not serving on :8000 — static + unit proven, live unproven"
  echo "aiko-task witness: PASS (live skipped)"
  exit 0
fi
if ( cd "$BE" && timeout 180 uv run python "$E2E" "List /tmp and count the files. Think it through." ); then
  pass "live /ws/chat produced streamed thinking + answer + settling status"
else
  fail "live Task chat did not present as aiko-backed (is AIKO_AGENT=true and the aiko runtime up?)"
fi

echo
echo "aiko-task witness: PASS"
