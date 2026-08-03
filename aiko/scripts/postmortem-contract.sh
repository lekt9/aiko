#!/bin/sh
# postmortem-contract.sh — shared helpers for contract-shaped postmortem graphs.
#
# Usage (source from other scripts):
#   . scripts/postmortem-contract.sh
#   pm_init "kind-name"
#   pm_declare id "goal" "check cmd" critical=0|1
#   pm_run id "goal" critical "shell check..."
#   pm_finish
#
# Env:
#   AIKO_HOME   default ~/.aiko
#   PM_KIND     set by pm_init
set -eu

pm_json_escape() {
    printf '%s' "$1" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g' \
        -e 's/	/\\t/g' \
        -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

pm_init() {
    PM_KIND=${1:-generic}
    AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
    PM_DIR="$AIKO_HOME/postmortem"
    mkdir -p "$PM_DIR"
    PM_LEDGER="$PM_DIR/${PM_KIND}.jsonl"
    PM_LATEST="$PM_DIR/${PM_KIND}.latest.json"
    PM_RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
    PM_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    PM_FAILURES=0
    printf '%s\n' "{\"event\":\"run.begin\",\"run_id\":\"$PM_RUN_ID\",\"kind\":\"$PM_KIND\",\"ts\":\"$PM_TS\"}" >>"$PM_LEDGER"
}

pm_append() {
    printf '%s\n' "$1" >>"$PM_LEDGER"
}

pm_declare() {
    _id=$1
    _goal=$2
    _check=$3
    _crit=${4:-1}
    pm_append "{\"event\":\"contract.declared\",\"run_id\":\"$PM_RUN_ID\",\"id\":\"$_id\",\"goal\":$(printf '"%s"' "$(pm_json_escape "$_goal")"),\"check\":$(printf '"%s"' "$(pm_json_escape "$_check")"),\"critical\":$_crit,\"graph_key\":\"$PM_KIND--$_id\",\"depends_on\":[],\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
}

pm_verify() {
    _id=$1
    _status=$2
    _exit=$3
    _crit=${4:-1}
    _ev=${5:-}
    pm_append "{\"event\":\"contract.verified\",\"run_id\":\"$PM_RUN_ID\",\"id\":\"$_id\",\"status\":\"$_status\",\"exit\":$_exit,\"critical\":$_crit,\"evidence\":$(printf '"%s"' "$(pm_json_escape "$_ev")"),\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
}

# pm_run id goal critical shell-command...
pm_run() {
    _id=$1
    _goal=$2
    _crit=$3
    shift 3
    _cmd=$*
    pm_declare "$_id" "$_goal" "$_cmd" "$_crit"
    _ev=""
    _st="failed"
    _ex=1
    if _out=$(sh -c "$_cmd" 2>&1); then
        _st="satisfied"
        _ex=0
        _ev=$(printf '%s' "$_out" | head -c 800)
    else
        _ex=$?
        _ev=$(printf '%s' "$_out" | head -c 800)
    fi
    pm_verify "$_id" "$_st" "$_ex" "$_crit" "$_ev"
    if [ "$_st" = "satisfied" ]; then
        printf '  ok  %s — %s\n' "$_id" "$_goal"
        return 0
    fi
    printf '  RED %s — %s (exit %s)\n' "$_id" "$_goal" "$_ex" >&2
    if [ "$_crit" = "1" ]; then
        PM_FAILURES=$((PM_FAILURES + 1))
        return 1
    fi
    return 0
}

pm_finish() {
    _complete=false
    if [ "${PM_FAILURES:-0}" -eq 0 ]; then
        _complete=true
    fi
    pm_append "{\"event\":\"run.end\",\"run_id\":\"$PM_RUN_ID\",\"kind\":\"$PM_KIND\",\"failures\":${PM_FAILURES:-0},\"complete\":$_complete,\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    python3 - "$PM_LEDGER" "$PM_LATEST" "$PM_RUN_ID" "$PM_KIND" "${PM_FAILURES:-0}" <<'PY' || true
import json, sys
from pathlib import Path
ledger, latest, run_id, kind, failures = sys.argv[1:6]
nodes = {}
events = []
for line in Path(ledger).read_text(encoding="utf-8", errors="replace").splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        continue
    if ev.get("run_id") != run_id:
        continue
    events.append(ev)
    if ev.get("event") == "contract.declared":
        nodes[ev["id"]] = {
            "id": ev["id"],
            "goal": ev.get("goal"),
            "check": ev.get("check"),
            "critical": ev.get("critical"),
            "status": "pending",
            "depends_on": ev.get("depends_on") or [],
            "graph_key": ev.get("graph_key"),
        }
    if ev.get("event") == "contract.verified" and ev.get("id") in nodes:
        nodes[ev["id"]]["status"] = ev.get("status")
        nodes[ev["id"]]["exit"] = ev.get("exit")
        nodes[ev["id"]]["evidence"] = ev.get("evidence")
f = int(failures)
graph = {
    "format": 1,
    "kind": kind,
    "run_id": run_id,
    "failures": f,
    "complete": f == 0,
    "nodes": list(nodes.values()),
    "edges": [],
    "events": events,
}
Path(latest).write_text(json.dumps(graph, indent=2) + "\n", encoding="utf-8")
print(f"postmortem: {latest} complete={graph['complete']} nodes={len(nodes)}")
PY
    if [ -d .claude ]; then
        cp -f "$PM_LATEST" ".claude/${PM_KIND}.latest.json" 2>/dev/null || true
    fi
    return "${PM_FAILURES:-0}"
}
