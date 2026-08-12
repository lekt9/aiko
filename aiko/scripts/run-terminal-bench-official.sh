#!/bin/sh
# Official Terminal-Bench harness (tb) with the Aiko installed-agent adapter.
#
# Prerequisites:
#   - Podman/Docker with DOCKER_HOST set (Steam Deck: podman.sock)
#   - glibc-compatible aiko binary at benchmarks/harbor/tb-bin/aiko-bookworm
#     (or AIKO_BIN pointing at a binary that runs in Debian 12 task images)
#   - Host auth at ~/.aiko/auth.json
#
# Usage:
#   scripts/run-terminal-bench-official.sh                  # full original-tasks
#   scripts/run-terminal-bench-official.sh hello-world      # one task
#   TB_TASKS=hello-world,fibonacci-server scripts/run-terminal-bench-official.sh
#   TB_DATASET=core-0.1.1 scripts/run-terminal-bench-official.sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TB_ROOT=${TB_ROOT:-$AIKO_ROOT/benchmarks/harbor/terminal-bench}
RUNS_DIR=${TB_RUNS_DIR:-$AIKO_ROOT/benchmarks/harbor/tb-runs}
LOG_DIR=${TB_LOG_DIR:-$AIKO_ROOT/logs}
MODEL=${AIKO_MODEL:-deepseek-v4-pro}
CONCURRENT=${TB_N_CONCURRENT:-1}
RUN_ID=${TB_RUN_ID:-aiko-tb-$(date -u +%Y%m%dT%H%M%SZ)}

# Prefer bookworm-compatible binary for Debian 12 task containers.
if [ -n "${AIKO_BIN:-}" ]; then
  :
elif [ -x "$AIKO_ROOT/benchmarks/harbor/tb-bin/aiko-bookworm" ]; then
  AIKO_BIN="$AIKO_ROOT/benchmarks/harbor/tb-bin/aiko-bookworm"
else
  AIKO_BIN=${AIKO_BIN:-/home/deck/bin/aiko}
fi
AIKO_HOME_SRC=${AIKO_HOME_SRC:-$HOME/.aiko}

export PATH="${HOME}/.local/bin:${PATH}"
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/podman/podman.sock}
export AIKO_BIN AIKO_HOME_SRC AIKO_MODEL="$MODEL" AIKO_MAX_TURNS="${AIKO_MAX_TURNS:-30}"

if [ ! -x "$AIKO_BIN" ]; then
  echo "aiko binary not executable: $AIKO_BIN" >&2
  echo "Build bookworm binary first (see logs/aiko-bookworm-build.log)." >&2
  exit 2
fi
if [ ! -f "$AIKO_HOME_SRC/auth.json" ]; then
  echo "missing auth: $AIKO_HOME_SRC/auth.json" >&2
  exit 3
fi
if [ ! -d "$TB_ROOT/.venv" ]; then
  echo "terminal-bench venv missing; run: (cd $TB_ROOT && uv sync)" >&2
  exit 4
fi

mkdir -p "$RUNS_DIR" "$LOG_DIR"
LOG="$LOG_DIR/${RUN_ID}.log"

# Dataset selection
DATASET_ARGS="--dataset-path original-tasks"
case "${TB_DATASET:-local-original}" in
  core-0.1.1|terminal-bench-core-0.1.1)
    # Requires registry fetch of 0.1.1 tasks; local clone uses original-tasks.
    # Prefer filtering original-tasks to the 0.1.1 subset when present.
    DATASET_ARGS="--dataset-path original-tasks"
    if [ -z "${TB_TASKS:-}" ] && [ -z "${1:-}" ]; then
      # Load subset from registry.json if available
      SUBSET=$(python3 - <<'PY'
import json
from pathlib import Path
reg=json.loads(Path("'"$TB_ROOT"'/registry.json").read_text())
for e in reg:
  if e.get("name")=="terminal-bench-core" and str(e.get("version"))=="0.1.1":
    print(",".join(e.get("task_id_subset") or []))
    break
PY
)
      if [ -n "$SUBSET" ]; then
        export TB_TASKS="$SUBSET"
      fi
    fi
    ;;
  local-original|*)
    DATASET_ARGS="--dataset-path original-tasks"
    ;;
esac

TASK_ARGS=""
if [ -n "${1:-}" ]; then
  for t in "$@"; do
    TASK_ARGS="$TASK_ARGS --task-id $t"
  done
elif [ -n "${TB_TASKS:-}" ]; then
  OLDIFS=$IFS
  IFS=,
  for t in $TB_TASKS; do
    TASK_ARGS="$TASK_ARGS --task-id $t"
  done
  IFS=$OLDIFS
fi

echo "official-tb: run_id=$RUN_ID model=$MODEL concurrent=$CONCURRENT"
echo "official-tb: aiko_bin=$AIKO_BIN"
echo "official-tb: dataset_args=$DATASET_ARGS"
echo "official-tb: log=$LOG"

cd "$TB_ROOT"
# shellcheck disable=SC2086
uv run tb run \
  $DATASET_ARGS \
  --agent aiko \
  --model "$MODEL" \
  --n-concurrent "$CONCURRENT" \
  --output-path "$RUNS_DIR" \
  --run-id "$RUN_ID" \
  --cleanup \
  $TASK_ARGS \
  2>&1 | tee "$LOG"

RESULTS="$RUNS_DIR/$RUN_ID/results.json"
if [ -f "$RESULTS" ]; then
  python3 - <<PY
import json
from pathlib import Path
r=json.loads(Path("$RESULTS").read_text())
print("official-tb: results keys", list(r.keys())[:20])
acc=r.get("accuracy")
if acc is None and "n_resolved" in r:
  total=r.get("n_resolved",0)+r.get("n_unresolved",0)
  acc=(r.get("n_resolved",0)/total) if total else None
print(f"official-tb: accuracy={acc} resolved={r.get('n_resolved')} unresolved={r.get('n_unresolved')}")
PY
  # also copy a short report into docs/
  python3 - <<PY
import json
from pathlib import Path
from datetime import datetime, timezone
r=json.loads(Path("$RESULTS").read_text())
docs=Path("$AIKO_ROOT/docs")
docs.mkdir(exist_ok=True)
out_json=docs/"AIKO-TERMINAL-BENCH-OFFICIAL.json"
out_md=docs/"AIKO-TERMINAL-BENCH-OFFICIAL.md"
payload={
  "generatedAt": datetime.now(timezone.utc).isoformat(),
  "methodology": "official-terminal-bench-harness-tb-run",
  "officialHarborRun": True,
  "runId": "$RUN_ID",
  "model": "$MODEL",
  "aikoBin": "$AIKO_BIN",
  "resultsPath": "$RESULTS",
  "summary": {
    "accuracy": r.get("accuracy"),
    "n_resolved": r.get("n_resolved"),
    "n_unresolved": r.get("n_unresolved"),
  },
  "raw": r,
}
out_json.write_text(json.dumps(payload, indent=2)+"\n")
acc=r.get("accuracy")
md=[
  "# Official Terminal-Bench (tb run)",
  "",
  f"Generated: {payload['generatedAt']}",
  "",
  f"- Run ID: \`$RUN_ID\`",
  f"- Model: \`$MODEL\`",
  f"- Accuracy: {acc}",
  f"- Resolved: {r.get('n_resolved')}",
  f"- Unresolved: {r.get('n_unresolved')}",
  "",
  f"Evidence: [{out_json.name}](./{out_json.name}) and \`$RESULTS\`.",
  "",
]
out_md.write_text("\n".join(md))
print(f"official-tb: wrote {out_md} and {out_json}")
PY
fi
