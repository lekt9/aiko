#!/usr/bin/env bash
set -euo pipefail
test -s .agents/skills/aiko-drop-in/pilots/hoysan-deploy/cell.yaml
grep -q 'escalation\|fanout\|telethon\|outbox' .agents/skills/aiko-drop-in/pilots/hoysan-deploy/cell.yaml || grep -q 'chase' .agents/skills/aiko-drop-in/pilots/hoysan-deploy/cell.yaml
echo "hoysan-deploy: PASS"
