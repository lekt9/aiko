#!/usr/bin/env bash
# verb-gate: machine (Π3) — machine-local binary resolution pointer-type.
#
# Catches regressions where:
#   - missing binary silently passes (worst possible — false-green on a non-existent program)
#   - map file is ignored (cross-host portability defeated)
#   - PATH fallback doesn't fire when map is absent
#   - args don't pass through to the resolved binary
#   - pointer_type isn't "machine" on the declared row (downstream queries break)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 1: pointer_type inference is "machine" ===
PTYPE=$(MH_ACTION="machine:ls -la" python3 -c "
import sys, os
sys.path.insert(0, '$REAL_HOME/.claude/skills/contract/scripts/lib')
from contract_core import _infer_pointer_type
print(_infer_pointer_type(os.environ['MH_ACTION']))
")
[ "$PTYPE" = "machine" ] || { echo "FAIL: pointer_type for machine: action is '$PTYPE', expected 'machine'"; exit 1; }

# === Phase 2: PATH resolution — `true` is in PATH on every host ===
CID_PATH=$("$CLI" declare "machine PATH lookup" --action "machine:true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID_PATH" ] || { echo "FAIL: declare for machine:true returned no id"; exit 1; }
OUT_PATH=$("$CLI" iterate "$CID_PATH" --verbose 2>&1)
echo "$OUT_PATH" | grep -q "pointer(machine):" || { echo "FAIL: PATH iterate (--verbose) missing pointer(machine): line. OUT=$OUT_PATH"; exit 1; }
echo "$OUT_PATH" | grep -q "result: PASS"      || { echo "FAIL: PATH-resolved true didn't PASS. OUT=$OUT_PATH"; exit 1; }

# === Phase 3: args pass through ===
CID_ARGS=$("$CLI" declare "machine args passthrough" --action "machine:test 1 -eq 1" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_ARGS=$("$CLI" iterate "$CID_ARGS" 2>&1)
echo "$OUT_ARGS" | grep -q "result: PASS" || { echo "FAIL: args passthrough didn't PASS. OUT=$OUT_ARGS"; exit 1; }

CID_ARGS_F=$("$CLI" declare "machine args fail passthrough" --action "machine:test 1 -eq 2" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_ARGS_F=$("$CLI" iterate "$CID_ARGS_F" 2>&1 || true)
echo "$OUT_ARGS_F" | grep -q "result: FAIL" || { echo "FAIL: failing args didn't FAIL. OUT=$OUT_ARGS_F"; exit 1; }

# === Phase 4: missing binary emits structured block, exits non-zero ===
CID_MISS=$("$CLI" declare "machine missing binary" --action "machine:totally-nonexistent-binary-9f8a" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_MISS=$("$CLI" iterate "$CID_MISS" 2>&1 || true)
echo "$OUT_MISS" | grep -q "MACHINE BINARY MISSING"      || { echo "FAIL: missing binary missing structured block. OUT=$OUT_MISS"; exit 1; }
echo "$OUT_MISS" | grep -q "totally-nonexistent-binary"  || { echo "FAIL: structured block doesn't name the binary"; exit 1; }
echo "$OUT_MISS" | grep -q "machine-binaries.json"       || { echo "FAIL: structured block missing fix hint (map file)"; exit 1; }
echo "$OUT_MISS" | grep -q "result: FAIL"                || { echo "FAIL: missing binary didn't surface FAIL line"; exit 1; }

# === Phase 5: map file overrides PATH ===
mkdir -p "$TD/.config/contract"
# Create a wrapper that exits 0 with a unique marker, point the map at it
cat > "$TD/marked-true.sh" <<'EOF'
#!/usr/bin/env bash
echo "MARKED-BY-MAP-ed3a"
exit 0
EOF
chmod +x "$TD/marked-true.sh"
echo "{\"map-test-bin\":\"$TD/marked-true.sh\"}" > "$TD/.config/contract/machine-binaries.json"

CID_MAP=$("$CLI" declare "machine map override" --action "machine:map-test-bin" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_MAP=$("$CLI" iterate "$CID_MAP" --verbose 2>&1)
echo "$OUT_MAP" | grep -q "MARKED-BY-MAP-ed3a" || { echo "FAIL: map override didn't execute mapped binary. OUT=$OUT_MAP"; exit 1; }
echo "$OUT_MAP" | grep -q "$TD/marked-true.sh"   || { echo "FAIL: pointer(machine): line (--verbose) doesn't show mapped path. OUT=$OUT_MAP"; exit 1; }
echo "$OUT_MAP" | grep -q "result: PASS"         || { echo "FAIL: map override didn't PASS"; exit 1; }

# === Phase 6: stale map entry (file removed) falls through to PATH ===
echo "{\"true\":\"/nonexistent/stale/path\"}" > "$TD/.config/contract/machine-binaries.json"
CID_STALE=$("$CLI" declare "machine stale map" --action "machine:true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_STALE=$("$CLI" iterate "$CID_STALE" 2>&1)
echo "$OUT_STALE" | grep -q "result: PASS" || { echo "FAIL: stale map should fall back to PATH and PASS. OUT=$OUT_STALE"; exit 1; }

echo "PASS: machine gate (Π3) — pointer_type inferred, PATH fallback, args passthrough, missing-binary structured block, map override wins, stale-map falls through"
