#!/usr/bin/env bash
# Make the goal reactive: install a git pre-commit hook that re-fires
# scripts/goal-gate.sh — but only when the files the gate is derived from
# actually change. That is the runtime's invalidation loop applied to the north
# star: a node re-fires when the thing it was derived from moves, and stays
# quiet otherwise. A commit that drifts the goal (drops a pillar, breaks a link,
# adds a user setup step) goes red before it lands.
#
#   scripts/install-goal-hook.sh          # install/refresh the hook
#
# Bypass a single commit with `git commit --no-verify`.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GITDIR=$(cd "$ROOT" && git rev-parse --git-dir)
HOOK="$GITDIR/hooks/pre-commit"
mkdir -p "$GITDIR/hooks"

# aiko path prefix relative to the repo toplevel (the gate lives under it).
TOP=$(cd "$ROOT" && git rev-parse --show-toplevel)
REL=${ROOT#"$TOP"/}

if [[ -e "$HOOK" ]] && ! grep -q "goal-gate.sh" "$HOOK"; then
  echo "A pre-commit hook already exists and is not the goal hook: $HOOK" >&2
  echo "Add this line to it yourself to keep both:" >&2
  echo "  \"$REL/scripts/goal-hook-body.sh\" || exit 1" >&2
  exit 1
fi

# The reusable body (so an existing hook can source it too).
cat > "$ROOT/scripts/goal-hook-body.sh" <<BODY
#!/usr/bin/env bash
# Re-fire the goal gate iff the files it is derived from are staged.
set -euo pipefail
REL="$REL"
WATCH="\$REL/docs/GOAL.md \$REL/README.md \$REL/docs/README.md \$REL/AGENTS.md \$REL/apps/desktop/README.md \$REL/apps/desktop/src-tauri/src/stack.rs \$REL/apps/desktop/src-tauri/tauri.conf.json \$REL/scripts/goal-gate.sh"
staged=\$(git diff --cached --name-only)
touched=0
for w in \$WATCH; do echo "\$staged" | grep -qxF "\$w" && touched=1; done
if [ "\$touched" = 1 ]; then
  echo "goal-hook: goal inputs changed — re-firing goal gate"
  bash "\$REL/scripts/goal-gate.sh" >/dev/null 2>&1 || {
    echo "goal gate FAILED — this commit drifts Aiko's north star (docs/GOAL.md)." >&2
    echo "Run: bash \$REL/scripts/goal-gate.sh   |   bypass once: git commit --no-verify" >&2
    exit 1
  }
  echo "goal-hook: goal gate green"
fi
BODY
chmod +x "$ROOT/scripts/goal-hook-body.sh"

cat > "$HOOK" <<HOOKSH
#!/usr/bin/env bash
# Installed by $REL/scripts/install-goal-hook.sh — re-fires the goal gate on
# changes to the north star's inputs. Bypass once with git commit --no-verify.
exec "\$(git rev-parse --show-toplevel)/$REL/scripts/goal-hook-body.sh"
HOOKSH
chmod +x "$HOOK"

echo "installed reactive goal hook → $HOOK"
echo "it re-fires $REL/scripts/goal-gate.sh only when the goal's inputs are staged"
