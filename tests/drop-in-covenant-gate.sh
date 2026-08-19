#!/usr/bin/env bash
set -euo pipefail
f="docs/graph-engineering/AIKO-DROP-IN-COVENANT.md"
test -s "$f"
grep -q 'VerifiedIngress' "$f"
grep -q 'delegation_capability' "$f"
grep -q 'breakpoint' "$f"
grep -q 'SMP' "$f"
echo "drop-in-covenant: PASS"
