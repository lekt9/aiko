#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VALIDATOR="${SKILL_VALIDATOR:-$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py}"

python3 "$ROOT/scripts/test-contract-native-skills.py"
# Structural discovery: every contract-native skill package is validated;
# adding a skill must require zero new harness entries.
for MANIFEST in "$ROOT"/.agents/skills/*/contract-skill.json; do
    # POSIX sh has no nullglob: an unmatched pattern iterates literally.
    [ -f "$MANIFEST" ] || { echo "no contract-native skill manifests found" >&2; exit 1; }
    python3 "$VALIDATOR" "$(dirname -- "$MANIFEST")"
done

if [ "${AIKO_SKILL_TEST_FAST:-0}" = 1 ]; then
    exit 0
fi

(cd "$ROOT" && cargo test -p xai-grok-shell contract_native::skill_registry --lib)
(cd "$ROOT" && cargo check -p xai-grok-pager-bin)
(cd "$ROOT/apps/aiko-app" && pnpm build:ui)

echo "contract-native skill suite passed"
