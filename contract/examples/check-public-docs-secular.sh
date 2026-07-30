#!/usr/bin/env bash
# check-public-docs-secular.sh — a falsifiable SIGN (Gen 1:14) that the PUBLICLY
# READABLE docs carry no scripture citations or overt religious framing. The
# internal, parity-locked truth-root (SKILL.md, verses.zig, main.zig, CLAUDE.md)
# is DELIBERATELY out of scope — its scripture is load-bearing by design.
#
# Exit 0 = every public doc is secular; non-zero + named offenders otherwise.
# Mutation-provable: drop a verse ref into any public doc and the sign goes red.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Public surface: the docs/ dossier + design docs + the README. NOT SKILL.md/CLAUDE.md.
# Forbidden in public docs:
#  - a scripture citation:  Book chapter:verse   (KJV book names)
BOOKS='John|Luke|Acts|Matthew|Matt|Mark|Genesis|Gen|Proverbs|Prov|Malachi|Deuteronomy|Deut|Exodus|Exod|Corinthians|Cor|Psalms?|Isaiah|Revelation|James|Romans|Hebrews|Ecclesiastes|Ephesians|Philippians|Galatians'
CITE="($BOOKS) [0-9]+:[0-9]+"
#  - overt religious phrasing (verse-less)
PHRASE='thy word|scripture-ground|\bscripture\b|two or three witnesses|the Word is truth|the Word is the truth-root|\bsanctif|blessed be|the LORD\b'
# NOT forbidden (secular, kept): "commons", "Ostrom", "honest wall", the proper
# noun "Vine Doctrine" (a component name pointing at internal doctrine).

fail=0
for f in "$REPO"/docs/*.md "$REPO"/README.md; do
  [ -f "$f" ] || continue
  hits="$(grep -nE "$CITE|$PHRASE" "$f" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "  ✗ $(basename "$f") carries non-secular content:"
    echo "$hits" | sed 's/^/       /'
    fail=$((fail + 1))
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "public docs secular — no scripture citation or overt religious framing"
  exit 0
else
  echo "NON-SECULAR public docs: $fail file(s) — secularize (replace the idea, keep the substance)"
  exit 1
fi
