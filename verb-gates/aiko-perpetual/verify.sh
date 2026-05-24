#!/bin/bash
# aiko perpetual gate: registers Σ6 presence + declares self-organ + Π6 env-bind
set -e
TMP=$(mktemp -d)
CID="gate-perp-$$"
OUT=$(~/.claude/skills/aiko/scripts/aiko perpetual --transport terminal --client-id "$CID" --no-drive 2>&1)
echo "$OUT" | grep -q "AIKO PERPETUAL" || { echo "FAIL: no header"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "Σ6 presence:" || { echo "FAIL: no Σ6 presence line"; exit 1; }
echo "$OUT" | grep -q "Π6 env-bind:" || { echo "FAIL: no Π6 env-bind line"; exit 1; }
echo "$OUT" | grep -q "self-organ:" || { echo "FAIL: no self-organ line"; exit 1; }
# verify presence row is on disk
grep -q "$CID" ~/.contracts/inbox/sessions/*.jsonl 2>/dev/null || { echo "FAIL: presence row not written"; exit 1; }
echo "PASS: aiko perpetual registered $CID, declared self-organ, env-bind ok"
