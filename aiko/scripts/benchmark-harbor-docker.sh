#!/bin/sh
# Run Harbor termbench inside a memory-capped container so agent/plugin leaks
# cannot thrash host RAM/swap.
#
# Usage:
#   scripts/benchmark-harbor-docker.sh
#   HARBOR_MEM=4g HARBOR_TASKS=count-call-stack scripts/benchmark-harbor-docker.sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOST_AIKO_BIN=${AIKO_BIN:-/home/deck/bin/aiko}
HOST_AIKO_HOME=${AIKO_HOME_SRC:-/home/deck/.aiko}
MEM=${HARBOR_MEM:-3g}
PIDS=${HARBOR_PIDS:-512}
IMAGE=${HARBOR_IMAGE:-docker.io/library/ubuntu:24.04}
RUN_NAME=${HARBOR_CONTAINER_NAME:-aiko-termbench}

if [ ! -x "$HOST_AIKO_BIN" ]; then
  echo "aiko binary not found: $HOST_AIKO_BIN" >&2
  exit 1
fi
if [ ! -f "$HOST_AIKO_HOME/auth.json" ]; then
  echo "auth.json not found: $HOST_AIKO_HOME/auth.json" >&2
  exit 1
fi
if [ ! -d "$AIKO_ROOT/benchmarks/harbor/terminal-bench/original-tasks" ]; then
  echo "terminal-bench suite missing under benchmarks/harbor/terminal-bench" >&2
  exit 1
fi

STAGE=$(mktemp -d /tmp/aiko-termbench-docker.XXXXXX)
EMPTY_PLUGINS="$STAGE/empty-plugins"
EMPTY_MARKET="$STAGE/empty-market"
mkdir -p "$EMPTY_PLUGINS" "$EMPTY_MARKET" "$STAGE/out" "$STAGE/run"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# Lean config overlay: no plugins, telegram disabled. Auth stays on real ~/.aiko.
cat >"$STAGE/config.toml" <<'EOF'
[models]
default = "deepseek-v4-pro"
default_reasoning_effort = "xhigh"

[ui]
yolo = false
permission_mode = "always-approve"

[plugins]
enabled = []
disabled = ["telegram"]
EOF

TASKS_ENV=""
if [ -n "${HARBOR_TASKS:-}" ]; then
  TASKS_ENV="-e HARBOR_TASKS=$HARBOR_TASKS"
fi

MODEL=${AIKO_MODEL:-deepseek-v4-pro}
MAX_TURNS=${HARBOR_MAX_TURNS:-15}
AGENT_TIMEOUT_MS=${HARBOR_AGENT_TIMEOUT_MS:-480000}

echo "termbench-docker: image=$IMAGE mem=$MEM pids=$PIDS model=$MODEL"
echo "termbench-docker: suite=$AIKO_ROOT/benchmarks/harbor/terminal-bench"
echo "termbench-docker: AIKO_HOME=$HOST_AIKO_HOME (plugins overlaid empty)"

docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true

# Rootful for apt. Auth requires the real /home/deck/.aiko path.
# shellcheck disable=SC2086
docker run --rm --name "$RUN_NAME" \
  --memory="$MEM" \
  --memory-swap="$MEM" \
  --pids-limit="$PIDS" \
  --network=host \
  -e HOME=/home/deck \
  -e AIKO_HOME=/home/deck/.aiko \
  -e AIKO_BIN=/usr/local/bin/aiko \
  -e HARBOR_AGENTS=aiko \
  -e HARBOR_RUN_ROOT=/bench/run \
  -e HARBOR_JSON_OUT=/bench/out/AIKO-TERM-BENCH.json \
  -e HARBOR_MD_OUT=/bench/out/AIKO-TERM-BENCH.md \
  -e HARBOR_MAX_TURNS="$MAX_TURNS" \
  -e HARBOR_AGENT_TIMEOUT_MS="$AGENT_TIMEOUT_MS" \
  -e AIKO_MODEL="$MODEL" \
  -e PATH="/home/deck/.local/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  $TASKS_ENV \
  -v "$HOST_AIKO_BIN:/usr/local/bin/aiko:ro" \
  -v "$HOST_AIKO_HOME:/home/deck/.aiko:rw" \
  -v "$STAGE/config.toml:/home/deck/.aiko/config.toml:ro" \
  -v "$EMPTY_PLUGINS:/home/deck/.aiko/installed-plugins:ro" \
  -v "$EMPTY_MARKET:/home/deck/.aiko/marketplace-cache:ro" \
  -v "$STAGE/out:/bench/out:rw" \
  -v "$STAGE/run:/bench/run:rw" \
  -v "$AIKO_ROOT/scripts:/bench/scripts:ro" \
  -v "$AIKO_ROOT/benchmarks/harbor/terminal-bench:/bench/suite:ro" \
  -w /bench \
  "$IMAGE" \
  bash /bench/scripts/benchmark-harbor-docker-entry.sh

mkdir -p "$AIKO_ROOT/docs"
cp -a "$STAGE/out/AIKO-TERM-BENCH.json" "$AIKO_ROOT/docs/AIKO-TERM-BENCH.json"
cp -a "$STAGE/out/AIKO-TERM-BENCH.md" "$AIKO_ROOT/docs/AIKO-TERM-BENCH.md"
echo "termbench-docker: wrote docs/AIKO-TERM-BENCH.{json,md} (mem cap $MEM)"
python3 - <<PY
import json
from pathlib import Path
r = json.loads(Path("$AIKO_ROOT/docs/AIKO-TERM-BENCH.json").read_text())
s = r["summary"]["aiko"]
print(f"termbench-docker: aiko {s['passed']}/{s['eligible']} ({(s['passRate'] or 0)*100:.0f}%)")
for row in r["results"]:
    ag = row.get("agent") or {}
    print(f"  {row['taskId']:30} passed={row['passed']} infra={row.get('infrastructureFailure')} time={(ag.get('durationMs') or 0)/1000:.1f}s")
PY
