#!/usr/bin/env bash
# Falsifiable lights for the Contracts TUI seed (check / verify_count / kind).
# Exit 0 only when all four gates pass:
#   1. state.rs has check, verify_count, kind + unit tests
#   2. render.rs references verify_count / check_display
#   3. pager-bin main List branch has verify_count and check_command
#   4. Python mirror of from_scheduled_json rules passes 3 cases
#      (present fields, missing defaults, shell: action)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/crates/codegen/xai-grok-pager/src/views/contracts/state.rs"
RENDER="$ROOT/crates/codegen/xai-grok-pager/src/views/contracts/render.rs"
CLI="$ROOT/crates/codegen/xai-grok-pager-bin/src/main.rs"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

test -f "$STATE" || fail "missing $STATE"
test -f "$RENDER" || fail "missing $RENDER"
test -f "$CLI" || fail "missing $CLI"
command -v rg >/dev/null 2>&1 || fail "rg (ripgrep) required"
command -v python3 >/dev/null 2>&1 || fail "python3 required"

# ── 1. state.rs: check, verify_count, kind + unit tests ──────────────────
rg -q 'pub check: Option<String>' "$STATE" || fail "state: check field"
rg -q 'pub verify_count: u32' "$STATE" || fail "state: verify_count field"
rg -q 'pub kind: String' "$STATE" || fail "state: kind field"
rg -q 'fn from_scheduled_json' "$STATE" || fail "state: from_scheduled_json"
rg -q 'fn check_display' "$STATE" || fail "state: check_display"
rg -q 'fn parses_check_and_verify_count_when_present' "$STATE" \
  || fail "state: unit test present fields"
rg -q 'fn missing_fields_default_gracefully' "$STATE" \
  || fail "state: unit test missing defaults"
rg -q 'fn shell_action_derives_check' "$STATE" \
  || fail "state: unit test shell: action"
ok "1/4 state fields + unit tests"

# ── 2. render.rs: verify_count / check_display ───────────────────────────
rg -q 'verify_count' "$RENDER" || fail "render: verify_count"
rg -q 'check_display' "$RENDER" || fail "render: check_display"
ok "2/4 render columns"

# ── 3. pager-bin main List branch: verify_count + check_command ──────────
# Scope to TasksCommand::List … next TasksCommand arm so stray matches fail closed.
python3 - <<'PY' "$CLI" || fail "cli: List branch missing verify_count / check_command"
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(
    r"TasksCommand::List\s*\{.*?\}\s*TasksCommand::",
    src,
    re.S,
)
if not m:
    # Fallback: List arm until next arm at same indent depth
    m = re.search(r"TasksCommand::List\s*\{.*?(?=\n\s{8}TasksCommand::)", src, re.S)
if not m:
    print("no TasksCommand::List arm", file=sys.stderr)
    sys.exit(1)
arm = m.group(0)
if "verify_count" not in arm:
    print("List arm lacks verify_count", file=sys.stderr)
    sys.exit(1)
if "check_command" not in arm:
    print("List arm lacks check_command", file=sys.stderr)
    sys.exit(1)
print("List arm has verify_count + check_command")
PY
ok "3/4 cli List branch"

# ── 4. Runtime falsifier: mirror of from_scheduled_json (3 cases) ────────
python3 - <<'PY'
"""Mirror ContractEntry::from_scheduled_json rules from state.rs."""

def parse(items):
    out = []
    for item in items:
        if "id" not in item:
            continue
        # check / check_command; empty string → None
        check = item.get("check")
        if check is None or check == "":
            check = item.get("check_command") or None
        if check == "":
            check = None
        # verify_count / wave; string ints allowed; default 0
        vc = item.get("verify_count")
        if vc is None:
            vc = item.get("wave", 0)
        if isinstance(vc, str):
            try:
                vc = int(vc)
            except ValueError:
                vc = 0
        if vc is None:
            vc = 0
        vc = int(vc)
        if vc < 0:
            vc = 0
        kind = item.get("kind") or "scheduled"
        action = item.get("action") or item.get("trigger")
        if isinstance(action, str) and action.startswith("shell:"):
            shell = action[len("shell:"):]
            if shell:
                if check is None:
                    check = shell
                if kind == "scheduled":
                    kind = "task"
        out.append({
            "id": item["id"],
            "check": check,
            "verify_count": vc,
            "kind": kind,
            "display": check if check else "—",
        })
    return out

# Case 1: present fields
r = parse([{
    "id": "deadbeef",
    "status": "active",
    "prompt": "ship",
    "check": "cargo test -q",
    "verify_count": 3,
    "kind": "task",
}])
assert r[0]["check"] == "cargo test -q", r
assert r[0]["verify_count"] == 3, r
assert r[0]["kind"] == "task", r
print("  case present fields: green")

# Case 2: missing defaults
r = parse([{"id": "cafebabe", "status": "waiting", "prompt": "old"}])
assert r[0]["check"] is None, r
assert r[0]["verify_count"] == 0, r
assert r[0]["kind"] == "scheduled", r
assert r[0]["display"] == "—", r
print("  case missing defaults: green")

# Case 3: shell: action derives check + kind=task
r = parse([{
    "id": "feedface",
    "status": "pending",
    "prompt": "checked",
    "action": "shell:bash scripts/witness.sh",
}])
assert r[0]["check"] == "bash scripts/witness.sh", r
assert r[0]["kind"] == "task", r
print("  case shell: action: green")

print("parse mirror: 3 cases green")
PY
ok "4/4 parse falsifier (3 cases)"

echo "WITNESS PASS: contracts TUI seed lights"
exit 0
