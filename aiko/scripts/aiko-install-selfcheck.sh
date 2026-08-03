#!/bin/sh
# aiko-install-selfcheck.sh — default post-install (and on-demand) self-check.
#
# Writes a contract-shaped *graph* of smoke obligations to a durable postmortem
# ledger, then runs each check. Completion is the fruit of the checks, not a
# claim that install "looked fine".
#
# Graph shape (one lane, then parallel smokes):
#   N0-path-mirror  →  N1-version ‖ N2-help ‖ N3-contract-lib ‖ N4-models
#   (models is soft by default — network/auth can be red without failing install)
#
# Ledger (append-only JSONL + latest snapshot):
#   $AIKO_HOME/postmortem/install-selfcheck.jsonl
#   $AIKO_HOME/postmortem/install-selfcheck.latest.json
#
# Env:
#   AIKO_BIN_DIR           installed binary dir (default: ~/bin)
#   AIKO_HOME              runtime home (default: ~/.aiko)
#   AIKO_SELFCHECK_SOFT=1  never exit non-zero (record only)
#   AIKO_SKIP_SELFCHECK=1  no-op (install sets this only when asked)
#   AIKO_SELFCHECK_STRICT_MODELS=1  fail when `aiko models` is red
#   AIKO_MIRROR_PATH_BIN=0 disable ~/.local/bin mirror
set -eu

if [ "${AIKO_SKIP_SELFCHECK:-0}" = "1" ]; then
    echo "selfcheck: skipped (AIKO_SKIP_SELFCHECK=1)"
    exit 0
fi

AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/bin"}
AIKO=${AIKO:-"$AIKO_BIN_DIR/aiko"}
POST_DIR="$AIKO_HOME/postmortem"
LEDGER="$POST_DIR/install-selfcheck.jsonl"
LATEST="$POST_DIR/install-selfcheck.latest.json"
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
TS_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SOFT=${AIKO_SELFCHECK_SOFT:-0}

mkdir -p "$POST_DIR"

# ── helpers ───────────────────────────────────────────────────────────
json_escape() {
    # Minimal JSON string escape for shell evidence lines.
    printf '%s' "$1" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g' \
        -e 's/	/\\t/g' \
        -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

append_event() {
    # append_event <json-object-body-without-braces-wrapper already full>
    printf '%s\n' "$1" >>"$LEDGER"
}

# Optional external contract CLI (work + witness). Never required.
# Use unique names — POSIX sh functions share the caller's variables.
try_contract_pair() {
    _pair_goal=$1
    _pair_check=$2
    if ! command -v contract >/dev/null 2>&1; then
        return 0
    fi
    # Probe: must actually run on this arch.
    if ! contract --help >/dev/null 2>&1; then
        return 0
    fi
    _pair_out=$(contract task begin "$_pair_goal" --check "$_pair_check" 2>&1) || true
    _pair_id=$(printf '%s\n' "$_pair_out" | sed -n -E 's/^open:[[:space:]]*//p; t; s/^Task registered:[[:space:]]*//p' | head -1)
    if [ -n "${_pair_id:-}" ]; then
        append_event "{\"event\":\"contract.external_begin\",\"run_id\":\"$RUN_ID\",\"goal\":$(printf '"%s"' "$(json_escape "$_pair_goal")"),\"task_id\":\"$_pair_id\",\"check\":$(printf '"%s"' "$(json_escape "$_pair_check")"),\"ts\":\"$TS_UTC\"}"
        if contract task verify "$_pair_id" >/dev/null 2>&1; then
            append_event "{\"event\":\"contract.external_verify\",\"run_id\":\"$RUN_ID\",\"task_id\":\"$_pair_id\",\"status\":\"satisfied\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
        else
            append_event "{\"event\":\"contract.external_verify\",\"run_id\":\"$RUN_ID\",\"task_id\":\"$_pair_id\",\"status\":\"failed\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
        fi
    fi
}

# Mirror install into ~/.local/bin when that dir is on PATH and writable.
# Atomic replace so a running binary does not block with "Text file busy".
path_mirror() {
    if [ "${AIKO_MIRROR_PATH_BIN:-1}" = "0" ]; then
        echo "selfcheck: PATH mirror disabled"
        return 0
    fi
    if [ ! -x "$AIKO" ]; then
        return 1
    fi
    local_bin="$HOME/.local/bin"
    if [ ! -d "$local_bin" ]; then
        return 0
    fi
    # Only mirror when ~/.local/bin would win or already has aiko.
    case ":${PATH}:" in
        *":$local_bin:"*) ;;
        *)
            if [ ! -e "$local_bin/aiko" ]; then
                return 0
            fi
            ;;
    esac
    if [ -x "$local_bin/aiko" ] && cmp -s "$AIKO" "$local_bin/aiko" 2>/dev/null; then
        echo "selfcheck: PATH mirror already current ($local_bin/aiko)"
        return 0
    fi
    tmp="$local_bin/.aiko.selfcheck.$$"
    if ! cp -a "$AIKO" "$tmp" 2>/dev/null; then
        echo "selfcheck: PATH mirror copy failed (non-fatal)" >&2
        return 0
    fi
    chmod 755 "$tmp" 2>/dev/null || true
    if ! mv -f "$tmp" "$local_bin/aiko" 2>/dev/null; then
        rm -f "$tmp"
        echo "selfcheck: PATH mirror rename failed (non-fatal)" >&2
        return 0
    fi
    echo "selfcheck: mirrored $AIKO → $local_bin/aiko"
    return 0
}

run_check() {
    # run_check <id> <goal> <critical:0|1> <shell command...>
    id=$1
    goal=$2
    critical=$3
    shift 3
    check_cmd=$*
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    append_event "{\"event\":\"contract.declared\",\"run_id\":\"$RUN_ID\",\"id\":\"$id\",\"goal\":$(printf '"%s"' "$(json_escape "$goal")"),\"check\":$(printf '"%s"' "$(json_escape "$check_cmd")"),\"critical\":$critical,\"graph_key\":\"install-selfcheck--$id\",\"depends_on\":[],\"ts\":\"$started\"}"

    evidence=""
    status="failed"
    exit_code=1
    if output=$(sh -c "$check_cmd" 2>&1); then
        status="satisfied"
        exit_code=0
        evidence=$(printf '%s' "$output" | head -c 800)
    else
        exit_code=$?
        evidence=$(printf '%s' "$output" | head -c 800)
    fi
    finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    append_event "{\"event\":\"contract.verified\",\"run_id\":\"$RUN_ID\",\"id\":\"$id\",\"status\":\"$status\",\"exit\":$exit_code,\"critical\":$critical,\"evidence\":$(printf '"%s"' "$(json_escape "$evidence")"),\"ts\":\"$finished\"}"

    # Best-effort external contract pair (when CLI is real on this host).
    try_contract_pair "install-selfcheck: $goal" "$check_cmd" || true

    if [ "$status" = "satisfied" ]; then
        printf '  ok  %s — %s\n' "$id" "$goal"
        return 0
    fi
    printf '  RED %s — %s (exit %s)\n' "$id" "$goal" "$exit_code" >&2
    if [ -n "$evidence" ]; then
        printf '      evidence: %s\n' "$(printf '%s' "$evidence" | tr '\n' ' ' | head -c 200)" >&2
    fi
    if [ "$critical" = "1" ]; then
        return 1
    fi
    return 0
}

# ── declare run ───────────────────────────────────────────────────────
VERSION_LINE=$("$AIKO" --version 2>/dev/null || printf 'unavailable')
GIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || printf '')
append_event "{\"event\":\"selfcheck.begin\",\"run_id\":\"$RUN_ID\",\"aiko\":$(printf '"%s"' "$(json_escape "$AIKO")"),\"version\":$(printf '"%s"' "$(json_escape "$VERSION_LINE")"),\"git_short\":$(printf '"%s"' "$(json_escape "$GIT_SHORT")"),\"ts\":\"$TS_UTC\"}"

echo "selfcheck: run_id=$RUN_ID"
echo "selfcheck: binary=$AIKO"
echo "selfcheck: version=$VERSION_LINE"
echo "selfcheck: ledger=$LEDGER"

failures=0

# N0 — PATH mirror (writes, not a pure check)
if path_mirror; then
    append_event "{\"event\":\"contract.verified\",\"run_id\":\"$RUN_ID\",\"id\":\"path-mirror\",\"status\":\"satisfied\",\"exit\":0,\"critical\":0,\"evidence\":\"mirrored or already current\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
else
    append_event "{\"event\":\"contract.verified\",\"run_id\":\"$RUN_ID\",\"id\":\"path-mirror\",\"status\":\"failed\",\"exit\":1,\"critical\":0,\"evidence\":\"mirror helper returned non-zero\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
fi

# N1 — installed binary exists and prints a version
if ! run_check version \
    "Installed aiko binary runs --version" \
    1 \
    "test -x \"$AIKO\" && \"$AIKO\" --version 2>&1 | grep -q 'aiko '"; then
    failures=$((failures + 1))
fi

# N1b — when git HEAD is available and AIKO_SELFCHECK_REQUIRE_HEAD=1 (default when
# inside a git work tree with a clean-enough short hash in --version), require match.
# Soft unless AIKO_SELFCHECK_STRICT_HEAD=1.
head_crit=0
if [ "${AIKO_SELFCHECK_STRICT_HEAD:-0}" = "1" ]; then
    head_crit=1
fi
if [ -n "$GIT_SHORT" ] && [ "${AIKO_SELFCHECK_REQUIRE_HEAD:-1}" = "1" ]; then
    if ! run_check git-head \
        "aiko --version embeds current git short HEAD when built from this tree" \
        "$head_crit" \
        "\"$AIKO\" --version 2>&1 | grep -q \"$GIT_SHORT\""; then
        if [ "$head_crit" = "1" ]; then
            failures=$((failures + 1))
        fi
    fi
fi

# N2 — help surface still advertises Contract-native work
if ! run_check help \
    "aiko --help advertises Contract-native durable tasks" \
    1 \
    "\"$AIKO\" --help 2>&1 | grep -Eqi 'Contract-native|contract-pair|durable'"; then
    failures=$((failures + 1))
fi

# N3 — contract dylib/so is where the loader looks
LIB_SO="$AIKO_HOME/lib/libcontract.so"
LIB_DYLIB="$AIKO_HOME/lib/libcontract.dylib"
if ! run_check contract-lib \
    "Contract runtime library is present under AIKO_HOME/lib" \
    1 \
    "test -f \"$LIB_SO\" -o -f \"$LIB_DYLIB\""; then
    failures=$((failures + 1))
fi

# N4 — PATH `aiko` (if any) is the same bytes as the install target
if ! run_check path-identity \
    "Bare aiko on PATH matches the installed binary when both exist" \
    1 \
    'path_aiko=$(command -v aiko 2>/dev/null || true); if [ -z "$path_aiko" ]; then echo "no aiko on PATH (ok if ~/bin not exported)"; exit 0; fi; if [ ! -x "'"$AIKO"'" ]; then exit 1; fi; if cmp -s "$path_aiko" "'"$AIKO"'"; then echo "PATH aiko == install target"; exit 0; fi; echo "PATH=$path_aiko differs from '"$AIKO"'"; exit 1'; then
    failures=$((failures + 1))
fi

# N5 — models catalog (soft unless STRICT)
models_critical=0
if [ "${AIKO_SELFCHECK_STRICT_MODELS:-0}" = "1" ]; then
    models_critical=1
fi
if ! run_check models \
    "aiko models lists at least one model (auth/network soft)" \
    "$models_critical" \
    "\"$AIKO\" models 2>&1 | grep -Eqi 'Available models:|Default model:'"; then
    if [ "$models_critical" = "1" ]; then
        failures=$((failures + 1))
    fi
fi

# ── snapshot graph for postmortem ─────────────────────────────────────
# Derive latest status from this run's ledger lines.
python3 - "$LEDGER" "$LATEST" "$RUN_ID" "$AIKO" "$VERSION_LINE" "$failures" <<'PY' || true
import json, sys
from pathlib import Path
ledger, latest, run_id, aiko, version, failures = sys.argv[1:7]
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

graph = {
    "format": 1,
    "kind": "install-selfcheck",
    "run_id": run_id,
    "aiko": aiko,
    "version": version,
    "failures": int(failures),
    "complete": int(failures) == 0,
    "nodes": list(nodes.values()),
    "edges": [],  # smokes are independent after path-mirror
    "events": events,
}
Path(latest).write_text(json.dumps(graph, indent=2) + "\n", encoding="utf-8")
print(f"selfcheck: wrote snapshot {latest} ({len(nodes)} contracts)")
PY

# Also drop a project-local copy when a .claude/ dir is present (agent postmortem).
if [ -d .claude ]; then
    cp -f "$LATEST" .claude/install-selfcheck.latest.json 2>/dev/null || true
fi

append_event "{\"event\":\"selfcheck.end\",\"run_id\":\"$RUN_ID\",\"failures\":$failures,\"complete\":$([ "$failures" -eq 0 ] && echo true || echo false),\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

echo "selfcheck: failures=$failures ledger=$LEDGER snapshot=$LATEST"

if [ "$failures" -gt 0 ]; then
    if [ "$SOFT" = "1" ]; then
        echo "selfcheck: soft mode — recording red checks without failing install" >&2
        exit 0
    fi
    echo "selfcheck: FAILED — install is not proven working" >&2
    exit 1
fi

echo "selfcheck: all critical contracts satisfied"
exit 0
