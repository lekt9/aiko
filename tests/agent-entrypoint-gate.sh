#!/usr/bin/env bash
# Runnable witness for the standalone agent entrypoint (R9 / entrypoint plan
# Phase 1). From an empty directory, through the public CLI only:
# initialize an agent, solve a deterministic goal through the composed stage
# network, restart and reconstruct the same snapshot, replay without duplicate
# effects, cancel another goal, retire the agent, and reconstruct after
# compaction. Every assertion inspects durable state, not stdout resemblance.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

zig build

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-agent-entrypoint.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
node_dir="$gate_root/node"
binary="$repo_dir/zig-out/bin/neuron"
log="$node_dir/state/substrate.log"
goal="prove the standalone entrypoint"

# 1. Initialize a logical agent in an empty node directory.
"$binary" agent init "$node_dir" alpha >/dev/null
test -s "$log"

# A second init on the same substrate fails closed.
if "$binary" agent init "$node_dir" alpha >/dev/null 2>&1; then
    echo "FAIL: duplicate agent init did not fail closed" >&2
    exit 1
fi

# Genesis view: idle at snapshot 0000 with zero goals.
inspect0="$("$binary" agent inspect "$node_dir" alpha --json)"
python3 - "$inspect0" <<'PY'
import json, sys
view = json.loads(sys.argv[1])
assert view["status"] == "idle" and view["seq"] == 0, view
assert view["goals"] == 0 and view["beats"] == 0, view
PY

# 2. Solve a deterministic goal. The run must settle, CAS-advance the
# snapshot, and accrue grounded beats from the settlement-event hook.
run1="$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
python3 - "$run1" "$goal" <<'PY'
import hashlib, json, sys
run, goal = json.loads(sys.argv[1]), sys.argv[2]
assert run["status"] == "settled", run
assert run["seq"] == 1 and run["snapshot"].endswith("/0001"), run
# Independent recomputation of the reference resolution.
assert run["result_digest"] == hashlib.sha256(f"resolve:{goal}".encode()).hexdigest(), run
assert run["goal_digest"] == hashlib.sha256(goal.encode()).hexdigest(), run
assert run["beats"] > 0 and run["steps"] > 0 and run["pending"] == 0, run
PY

# The durable journal, not stdout, is the settlement evidence: the intake
# firing committed the goal artifact, the verifier committed the verdict, the
# settler advanced the active pointer, and the grounder hook committed context
# artifacts stimulated by durable neuron.firing-settled/v1 events.
python3 - "$log" "$run1" <<'PY'
import json, sys
log, run = sys.argv[1], json.loads(sys.argv[2])
records = [json.loads(line) for line in open(log, encoding="utf-8")]
commits = [r for r in records if r.get("op") == "commit"]
workflow = run["workflow"]
short = workflow.rsplit("/", 1)[1]

intake = next(r for r in commits if r["firing_id"] == f"{workflow}/intake")
assert any(a["id"] == f"agents/alpha/goals/{short}" for a in intake["artifacts"]), intake
assert any(
    m["to"] == "event/neuron.firing-settled/v1" and m["durable"]
    for m in intake["messages"]
), "intake firing did not emit a durable settlement event"

artifact_ids = [a["id"] for c in commits for a in c.get("artifacts", [])]
assert f"agents/alpha/work/{short}/result" in artifact_ids
assert f"agents/alpha/work/{short}/verdict" in artifact_ids
assert "agents/alpha/snapshots/0001" in artifact_ids

# Grounded beats: context artifacts written by grounder firings whose
# receptor was the settlement event (non-reflexive: no event for themselves).
contexts = [a for c in commits for a in c.get("artifacts", [])
            if a["id"].startswith("agents/alpha/context/")]
assert len(contexts) == run["beats"], (len(contexts), run["beats"])
grounder_commits = [c for c in commits
                    if any(a["id"].startswith("agents/alpha/context/") for a in c.get("artifacts", []))]
for commit in grounder_commits:
    assert not any(m["to"] == "event/neuron.firing-settled/v1" for m in commit.get("messages", [])), \
        "grounder firing reflexively emitted a settlement event"
PY

# 3. Restart: a fresh process reconstructs the same snapshot from the WAL.
inspect1="$("$binary" agent inspect "$node_dir" alpha --json)"
python3 - "$inspect1" "$run1" <<'PY'
import json, sys
view, run = json.loads(sys.argv[1]), json.loads(sys.argv[2])
assert view["status"] == "settled" and view["seq"] == 1, view
assert view["snapshot"] == run["snapshot"], (view, run)
assert view["workflow"] == run["workflow"], (view, run)
assert view["result_digest"] == run["result_digest"], (view, run)
assert view["beats"] == run["beats"], (view, run)
PY

# 4. Replay: the identical goal returns the recorded result and commits
# nothing — the WAL must be byte-identical afterwards.
wal_before="$(wc -c < "$log")"
run2="$("$binary" agent run "$node_dir" alpha --goal "$goal" --json)"
wal_after="$(wc -c < "$log")"
python3 - "$run2" "$run1" "$wal_before" "$wal_after" <<'PY'
import json, sys
replay, first = json.loads(sys.argv[1]), json.loads(sys.argv[2])
assert replay["status"] == "replayed", replay
assert replay["steps"] == 0, replay
assert replay["result_digest"] == first["result_digest"], (replay, first)
assert sys.argv[3] == sys.argv[4], ("WAL changed on replay", sys.argv[3], sys.argv[4])
PY

# 5. A second distinct goal settles and advances the chain to 0002.
run3="$("$binary" agent run "$node_dir" alpha --goal "a second distinct goal" --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="settled" and r["seq"]==2, r' "$run3"

# 6. A budget-starved run fails closed with durable partial progress; the
# resume gets a fresh attempt scope, wakes the parked stages from the
# durable artifacts, and settles. A further identical run replays.
if "$binary" agent run "$node_dir" alpha --goal "a starved goal" --budget 3 --json >/dev/null 2>&1; then
    echo "FAIL: under-budget run did not fail closed" >&2
    exit 1
fi
resume="$("$binary" agent run "$node_dir" alpha --goal "a starved goal" --budget 32 --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="settled" and r["seq"]==3, r' "$resume"
resume_replay="$("$binary" agent run "$node_dir" alpha --goal "a starved goal" --json)"
python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["status"]=="replayed", r' "$resume_replay"

# 7. Cancel another goal before it fires; running it then fails closed.
"$binary" agent cancel "$node_dir" alpha "a goal that never runs" >/dev/null
if "$binary" agent run "$node_dir" alpha --goal "a goal that never runs" --json >/dev/null 2>&1; then
    echo "FAIL: cancelled workflow did not fail closed" >&2
    exit 1
fi

# 8. Retire the agent; new goals and repeat retirement fail closed.
"$binary" agent retire "$node_dir" alpha >/dev/null
if "$binary" agent run "$node_dir" alpha --goal "after retirement" >/dev/null 2>&1; then
    echo "FAIL: retired agent accepted a goal" >&2
    exit 1
fi
if "$binary" agent retire "$node_dir" alpha >/dev/null 2>&1; then
    echo "FAIL: double retirement did not fail closed" >&2
    exit 1
fi

# 9. Compaction folds the WAL; a fresh process reconstructs the retired view
# with the full goal and beat history intact.
"$binary" compact "$node_dir/state" >/dev/null
inspect2="$("$binary" agent inspect "$node_dir" alpha --json)"
python3 - "$inspect2" <<'PY'
import json, sys
view = json.loads(sys.argv[1])
assert view["status"] == "retired" and view["seq"] == 4, view
assert view["goals"] == 3, view
assert view["beats"] > 0, view
assert view["firings"]["cancelled"] == 1, view
PY

# The unimplemented interface membrane stays honest: parsed, fails closed.
if "$binary" interface discover /bin/echo >/dev/null 2>&1; then
    echo "FAIL: unimplemented interface verb did not fail closed" >&2
    exit 1
fi

echo "agent-entrypoint gate: PASS"
