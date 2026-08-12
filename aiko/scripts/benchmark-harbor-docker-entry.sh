#!/bin/bash
# Runs inside the memory-capped termbench container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq unzip python3 curl ca-certificates git gnupg >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs >/dev/null
# HOME is /home/deck (auth path), so uv installs to ~/.local/bin under that home.
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="/home/deck/.local/bin:/root/.local/bin:${PATH:-}"
command -v uv >/dev/null || {
  echo "termbench-docker: uv not on PATH after install" >&2
  exit 5
}

mkdir -p /bench/repo/scripts /bench/repo/benchmarks/harbor /bench/repo/docs
cp /bench/scripts/benchmark-harbor-agents.mjs /bench/repo/scripts/
ln -sfn /bench/suite /bench/repo/benchmarks/harbor/terminal-bench
cd /bench/repo

/usr/local/bin/aiko --version
AUTH_OUT=$(/usr/local/bin/aiko models 2>&1 || true)
echo "$AUTH_OUT" | head -12
if ! echo "$AUTH_OUT" | grep -q "logged in"; then
  echo "termbench-docker: not authenticated inside container" >&2
  exit 3
fi

# plugins overlaid empty
test -d /home/deck/.aiko/installed-plugins
test -z "$(ls -A /home/deck/.aiko/installed-plugins 2>/dev/null || true)"

node --version
uv --version
/usr/local/bin/aiko --single "reply with exactly pong" \
  --max-turns 1 --output-format plain --permission-mode bypassPermissions \
  --no-memory --no-subagents --disable-web-search --no-plan \
  --leader-socket /bench/run/.leader-smoke.sock | tee /tmp/pong.txt
grep -q pong /tmp/pong.txt

leak_check() {
  # Bracket trick avoids matching this script's own argv.
  ps -eo pid,cmd | awk '/[b]un server\.ts|[t]elegram-c8e2e691/ {print}' || true
}

LEAK=$(leak_check)
if [ -n "$LEAK" ]; then
  echo "telegram/bun leaked inside container:" >&2
  echo "$LEAK" >&2
  exit 4
fi

node scripts/benchmark-harbor-agents.mjs

LEAK=$(leak_check)
if [ -n "$LEAK" ]; then
  echo "telegram/bun leaked after suite:" >&2
  echo "$LEAK" >&2
  exit 4
fi
