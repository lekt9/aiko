#!/usr/bin/env bash
# probe-humanize.sh — child B of d26df94c.
set -e

H="$HOME/.claude/skills/contract/scripts/humanize.py"
[ -x "$H" ] || { echo "FAIL: humanize.py missing/not-executable"; exit 1; }
echo "PASS: humanize.py present + executable"

# AI-slop removed
OUT=$(printf 'This is a powerful and seamless tool that will unleash productivity.\n' | python3 "$H")
echo "$OUT" | grep -q 'powerful\|seamless\|unleash' && { echo "FAIL: AI-slop adjectives not stripped: $OUT"; exit 1; }
echo "PASS: AI-slop adjectives removed (powerful / seamless / unleash)"

# Em-dash removed
OUT=$(printf 'I shipped it — and the test passed.\n' | python3 "$H")
echo "$OUT" | grep -q '—' && { echo "FAIL: em-dash not removed: $OUT"; exit 1; }
echo "PASS: em-dash removed"

# Substrate jargon mapped
OUT=$(printf 'The funnel was iterated and the cell was marked satisfied.\n' | python3 "$H")
echo "$OUT" | grep -qE 'funnel|\bcell\b' && { echo "FAIL: jargon not mapped: $OUT"; exit 1; }
echo "PASS: substrate jargon mapped (funnel → group, cell → step)"

# Section markers stripped
OUT=$(printf '=== TWO-KEY EXIT ===\nI sent the invite.\n  Run: contract iterate abc12345\n' | python3 "$H")
echo "$OUT" | grep -qE '^=== ' && { echo "FAIL: section marker not stripped"; exit 1; }
echo "$OUT" | grep -q '^I sent the invite' || { echo "FAIL: real content lost: $OUT"; exit 1; }
echo "PASS: substrate section markers stripped, real content preserved"

# Idempotent: running on already-humanized text changes nothing
OUT2=$(printf '%s\n' "$OUT" | python3 "$H")
[ "$OUT" = "$OUT2" ] || { echo "FAIL: not idempotent — second pass changed output"; echo "first: $OUT"; echo "second: $OUT2"; exit 1; }
echo "PASS: idempotent on already-humanized text"

# JSON / SSE passthrough
JSON_LINE='{"kind":"status","title":"Done","body":"value"}'
OUT=$(printf '%s\n' "$JSON_LINE" | python3 "$H")
[ "$OUT" = "$JSON_LINE" ] || { echo "FAIL: JSON line altered: $OUT"; exit 1; }
echo "PASS: JSON-shaped lines pass through unchanged"

echo
echo "probe-humanize: PASS"
exit 0
