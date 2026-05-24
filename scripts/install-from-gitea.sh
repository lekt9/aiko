#!/usr/bin/env bash
# /contract substrate one-time bootstrap for Jaryl, RQ, and any new install.
# Run this once on a fresh machine; afterwards every /contract activity
# auto-pulls from gitea via the pre-iterate-pull hook.
#
# Origin: Lewis directive 2026-05-24 "update all /contract that jaryl and rq
# are using to be actually updated from gitea always programmatically."
#
# Usage:
#   curl -fsSL <gitea>/lekt8/contract/raw/branch/main/scripts/install-from-gitea.sh | bash
#   OR
#   bash install-from-gitea.sh [--gitea-url <url>] [--token-env GITEA_TOKEN]
set -euo pipefail

GITEA_URL="${GITEA_URL:-http://100.86.107.47:3000}"
TOKEN_ENV="${TOKEN_ENV:-GITEA_TOKEN}"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
CONTRACTS_DIR="${CONTRACTS_DIR:-$HOME/.contracts}"

while [ $# -gt 0 ]; do
  case "$1" in
    --gitea-url) GITEA_URL="${2:-}"; shift 2 ;;
    --token-env) TOKEN_ENV="${2:-}"; shift 2 ;;
    --skill-dir) SKILL_DIR="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# Token lookup: env var first, then macOS keychain
TOKEN="${!TOKEN_ENV:-}"
if [ -z "$TOKEN" ] && command -v security >/dev/null 2>&1; then
  TOKEN=$(security find-generic-password -a lekt8 -s "$TOKEN_ENV" -w 2>/dev/null || true)
fi
if [ -z "$TOKEN" ]; then
  echo "no $TOKEN_ENV in env or keychain; clone will be public-only (read-only)" >&2
  CLONE_URL="$GITEA_URL/lekt8/contract.git"
else
  CLONE_URL="${GITEA_URL/http:\/\//http://lekt8:${TOKEN}@}/lekt8/contract.git"
fi

# 1. Clone (or update) the /contract skill
mkdir -p "$(dirname "$SKILL_DIR")"
if [ -d "$SKILL_DIR/.git" ]; then
  echo "[install] /contract skill already cloned at $SKILL_DIR — pulling latest"
  git -C "$SKILL_DIR" fetch gitea main 2>&1 | tail -3
  git -C "$SKILL_DIR" pull --rebase gitea main 2>&1 | tail -3
else
  echo "[install] cloning /contract skill from gitea -> $SKILL_DIR"
  git clone "$CLONE_URL" "$SKILL_DIR"
  git -C "$SKILL_DIR" remote rename origin gitea 2>/dev/null || true
fi

# 2. Initialize ~/.contracts state dir (ledger + inbox + hooks)
mkdir -p "$CONTRACTS_DIR/hooks" "$CONTRACTS_DIR/inbox/mail" "$CONTRACTS_DIR/watchers" "$CONTRACTS_DIR/streams"
[ -f "$CONTRACTS_DIR/contracts.jsonl" ] || touch "$CONTRACTS_DIR/contracts.jsonl"

# 3. Install the auto-pull pre-iterate hook
cat > "$CONTRACTS_DIR/hooks/pre-iterate-pull.sh" <<'HOOK'
#!/usr/bin/env bash
# Auto-pull /contract skill from gitea before each iterate/mark event.
# Rate-limited (default: max once per 300s); fail-open (network errors
# don't block the iterate). State at ~/.contracts/.last-pull-ts.
[ "${CONTRACT_PULL_TICKING:-}" = "1" ] && exit 0
PULL_INTERVAL="${CONTRACT_PULL_INTERVAL:-300}"
STATE="$HOME/.contracts/.last-pull-ts"
NOW=$(date +%s)
LAST=$(cat "$STATE" 2>/dev/null || echo 0)
[ $((NOW - LAST)) -lt "$PULL_INTERVAL" ] && exit 0
SKILL_DIR="$HOME/.claude/skills/contract"
[ -d "$SKILL_DIR/.git" ] || exit 0
CONTRACT_PULL_TICKING=1 timeout 10 git -C "$SKILL_DIR" fetch gitea main 2>/dev/null && \
  CONTRACT_PULL_TICKING=1 timeout 10 git -C "$SKILL_DIR" pull --rebase --autostash gitea main 2>/dev/null
echo "$NOW" > "$STATE"
exit 0
HOOK
chmod +x "$CONTRACTS_DIR/hooks/pre-iterate-pull.sh"

# 4. Verify
"$SKILL_DIR/scripts/contract" self 2>&1 | head -8 || {
  echo "[install] WARN: 'contract self' didn't run cleanly; check $SKILL_DIR" >&2
  exit 1
}

echo
echo "=== /contract install complete ==="
echo "  skill:     $SKILL_DIR"
echo "  state:     $CONTRACTS_DIR"
echo "  auto-pull: $CONTRACTS_DIR/hooks/pre-iterate-pull.sh (max once / ${CONTRACT_PULL_INTERVAL:-300}s, fail-open)"
echo
echo "  next: any 'contract iterate <id>' or 'contract _mark <id>' fires the pull hook;"
echo "        your local skill stays current with gitea/main automatically."
echo "  override interval: export CONTRACT_PULL_INTERVAL=60 (seconds)"
