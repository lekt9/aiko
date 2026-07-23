#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VALIDATOR=/Users/lewis/.codex/skills/.system/skill-creator/scripts/quick_validate.py

python3 "$ROOT/scripts/test-contract-native-skills.py"
for SKILL in \
    inspect-project build-and-test-project transform-local-files observe-desktop \
    schedule-follow-up apply-standing-rule act-on-web-api send-notification \
    control-local-media issue-to-patch
do
    python3 "$VALIDATOR" "$ROOT/.agents/skills/$SKILL"
done

if [ "${AIKO_SKILL_TEST_FAST:-0}" = 1 ]; then
    exit 0
fi

(cd "$ROOT" && cargo test -p xai-grok-shell contract_native::skill_registry --lib)
(cd "$ROOT" && cargo check -p xai-grok-pager-bin)
(cd "$ROOT/apps/desktop" && npx vite build)

echo "contract-native skill suite passed"
