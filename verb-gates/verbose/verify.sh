#!/usr/bin/env bash
# verb-gate: verbose (Ψ1) — layer-purity binding.
# Default iterate output hides L0 mechanical noise (pointer(...) lines);
# --verbose surfaces it. Same contract, same row, same KEY 1/2/3 surface —
# what differs is whether L0 internals appear alongside L2/L3.
#
# Catches regressions where:
#   - default iterate leaks pointer(...) lines (layer-bleed → cognitive load)
#   - --verbose flag silently ignored (Ψ1 documented but not bound)
#   - turning verbose on STILL hides the L0 lines (flag wired but inverted)
#   - L2/L3 surface (result:, KEY prompts) gets accidentally suppressed by verbose
#     gating (verbose should be additive, never subtractive)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

CID=$("$CLI" declare "verbose gate test target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID" ] || { echo "FAIL: declare empty"; exit 1; }

# === Phase 1: default iterate HIDES pointer(...) lines ===
OUT_DEFAULT=$("$CLI" iterate "$CID" 2>&1)
echo "$OUT_DEFAULT" | grep -q "pointer(" \
  && { echo "FAIL: default iterate leaked pointer(...) L0 line. OUT="; echo "$OUT_DEFAULT"; exit 1; } || true

# L2/L3 surface still present (verbose is additive, never subtractive)
echo "$OUT_DEFAULT" | grep -q "result: PASS" \
  || { echo "FAIL: default iterate missing result: line (L2). OUT="; echo "$OUT_DEFAULT"; exit 1; }
echo "$OUT_DEFAULT" | grep -q "=== CONTRACT ITERATE" \
  || { echo "FAIL: default iterate missing iterate header (L2). OUT="; echo "$OUT_DEFAULT"; exit 1; }
echo "$OUT_DEFAULT" | grep -q "KEY 1" \
  || { echo "FAIL: default iterate missing KEY 1 prompt (L3). OUT="; echo "$OUT_DEFAULT"; exit 1; }

# === Phase 2: --verbose iterate SHOWS pointer(...) line ===
OUT_VERBOSE=$("$CLI" iterate "$CID" --verbose 2>&1)
echo "$OUT_VERBOSE" | grep -q "pointer(cli):" \
  || { echo "FAIL: --verbose iterate missing pointer(cli): L0 line. OUT="; echo "$OUT_VERBOSE"; exit 1; }

# L2/L3 still present (verbose adds, never removes)
echo "$OUT_VERBOSE" | grep -q "result: PASS" \
  || { echo "FAIL: --verbose iterate dropped L2 result: line. OUT="; echo "$OUT_VERBOSE"; exit 1; }
echo "$OUT_VERBOSE" | grep -q "KEY 1" \
  || { echo "FAIL: --verbose iterate dropped KEY 1 prompt. OUT="; echo "$OUT_VERBOSE"; exit 1; }

# === Phase 3: env-var path — CONTRACT_VERBOSE=1 is equivalent to --verbose ===
OUT_ENV=$(CONTRACT_VERBOSE=1 "$CLI" iterate "$CID" 2>&1)
echo "$OUT_ENV" | grep -q "pointer(cli):" \
  || { echo "FAIL: CONTRACT_VERBOSE=1 didn't surface pointer(cli): line. OUT="; echo "$OUT_ENV"; exit 1; }

# === Phase 4: shape-specific pointers also gate on verbose ===
# Declare a funnel, iterate without and with verbose
CID_F=$("$CLI" declare "verbose funnel test" --action "funnel" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_F_DEFAULT=$("$CLI" iterate "$CID_F" 2>&1 || true)
echo "$OUT_F_DEFAULT" | grep -q "pointer(funnel):" \
  && { echo "FAIL: default funnel iterate leaked pointer(funnel): L0 line."; exit 1; } || true
OUT_F_VERBOSE=$("$CLI" iterate "$CID_F" --verbose 2>&1 || true)
echo "$OUT_F_VERBOSE" | grep -q "pointer(funnel):" \
  || { echo "FAIL: --verbose funnel iterate missing pointer(funnel): L0 line. OUT="; echo "$OUT_F_VERBOSE"; exit 1; }

echo "PASS: verbose gate (Ψ1) — default iterate hides L0 pointer(...) lines, --verbose AND CONTRACT_VERBOSE=1 surface them, L2/L3 always-on (verbose is additive, never subtractive), shape-specific pointers (funnel) also gate"
