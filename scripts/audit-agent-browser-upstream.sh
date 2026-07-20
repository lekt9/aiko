#!/bin/sh
set -eu

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UPSTREAM_REPO=${AIKO_AGENT_BROWSER_REPO:-"$AIKO_ROOT/../agent-browser"}
PROVENANCE="$AIKO_ROOT/crates/common/xai-application-runtime/UPSTREAM.md"

if [ ! -d "$UPSTREAM_REPO/.git" ]; then
    echo "Agent Browser repository not found at $UPSTREAM_REPO" >&2
    echo "Set AIKO_AGENT_BROWSER_REPO to audit another checkout." >&2
    exit 1
fi

RECORDED=$(sed -n -E 's/^([0-9a-f]{40})$/\1/p' "$PROVENANCE" | head -1)
CURRENT=$(git -C "$UPSTREAM_REPO" rev-parse HEAD)

echo "Aiko compatibility reference: $RECORDED"
echo "Agent Browser checkout:       $CURRENT"
if [ -n "$(git -C "$UPSTREAM_REPO" status --porcelain -- cli/Cargo.toml cli/src/lib.rs cli/src/native)" ]; then
    echo "Agent Browser native sources also have working-tree changes:"
    git -C "$UPSTREAM_REPO" status --short -- cli/Cargo.toml cli/src/lib.rs cli/src/native
fi

if [ "$RECORDED" = "$CURRENT" ]; then
    echo "No upstream commit drift."
else
    echo "Upstream changed. Relevant native-runtime diff:"
    git -C "$UPSTREAM_REPO" diff --stat "$RECORDED..$CURRENT" -- \
        cli/src/lib.rs \
        cli/src/native/actions.rs \
        cli/src/native/browser.rs \
        cli/src/native/cdp \
        cli/src/native/element.rs \
        cli/src/native/interaction.rs \
        cli/src/native/network.rs \
        cli/src/native/policy.rs \
        cli/src/native/react \
        cli/src/native/snapshot.rs
fi

if [ "${1:-}" = "--verify" ]; then
    echo "Running Aiko primitive compatibility tests..."
    (cd "$AIKO_ROOT" && cargo test -p xai-application-runtime)
fi
