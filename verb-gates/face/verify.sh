#!/bin/bash
set -e
C=~/.claude/skills/contract/scripts/contract
FACE=$($C face 2>&1)
echo "$FACE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'identity' in d and 'personality' in d and 'layer_routing' in d and 'standing_gates' in d, 'missing keys'
assert d['identity']['public_face'] == 'Aiko', 'public_face not Aiko'
assert len(d['personality']['voice_load_bearing']) >= 4, 'voice_load_bearing too few'
assert '1bed8068' in d['standing_gates'], 'no 1bed8068'
" || { echo "FAIL: face JSON schema invalid"; exit 1; }
echo "PASS: face manifest has identity+personality+layer_routing with Aiko + voice rules + standing-gate refs"
