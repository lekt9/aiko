#!/usr/bin/env bash
# verb-gate: bind-script / hydrate-script — scripts are cached artifacts of /contract.
#
# Plank 10 of DEFERRED-MEGA-VISION 386497eb realised: the local file is no longer
# the source of truth — the contract row carries the content-hashed script body
# (base64), and the unbrowse-mirror hook automatically pushes it to the KV cache
# at unbrowse for cross-host hydrate. Roundtrip: bind → delete local → hydrate
# → identical file (SHA matches).
#
# Catches regressions where:
#   - bind-script silently writes corrupt body (SHA mismatch on hydrate)
#   - hydrate doesn't restore exec bit on .sh/.py shebanged scripts
#   - missing script_bound row hydrates silently (would fake-green a fresh-clone)
#   - --to override is ignored
#   - rebinding writes a duplicate path instead of latest-wins on hydrate
#   - hydrate writes to current dir on missing parent (vs creating parent dirs)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"

# Helper: declare a contract, return id
declare_one() {
  "$CLI" declare "$1" --action "agent-judges" --no-drive 2>&1 \
    | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1
}

# === Phase 1: bind a shebanged shell script — row contains correct sha + size + body ===
SRC_SH="$TD/src.sh"
cat > "$SRC_SH" <<'EOF'
#!/usr/bin/env bash
echo "hello from bound script"
exit 0
EOF
chmod +x "$SRC_SH"
SRC_SHA=$(shasum -a 256 "$SRC_SH" | awk '{print substr($1,1,16)}')
SRC_SIZE=$(wc -c < "$SRC_SH" | tr -d ' ')

CID_SH=$(declare_one "phase1 bind shell script")
[ -n "$CID_SH" ] || { echo "FAIL P1: declare returned no id"; exit 1; }

OUT_BIND=$("$CLI" bind-script "$CID_SH" "$SRC_SH" 2>&1)
echo "$OUT_BIND" | grep -q "bound: cid=$CID_SH"   || { echo "FAIL P1: bind output missing cid. OUT=$OUT_BIND"; exit 1; }
echo "$OUT_BIND" | grep -q "sha=$SRC_SHA"         || { echo "FAIL P1: bind output sha doesn't match. expected=$SRC_SHA OUT=$OUT_BIND"; exit 1; }
echo "$OUT_BIND" | grep -q "size=${SRC_SIZE}B"    || { echo "FAIL P1: bind output size doesn't match. expected=$SRC_SIZE OUT=$OUT_BIND"; exit 1; }

# Verify ledger has the row with expected fields
ROW_CHECK=$(python3 -c "
import json, sys
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
bound = [r for r in rows if r.get('id') == '$CID_SH' and r.get('event') == 'script_bound']
if not bound: print('FAIL: no script_bound row'); sys.exit(1)
r = bound[-1]
print('OK' if r.get('code_hash') == '$SRC_SHA' and r.get('code_size') == $SRC_SIZE and r.get('code_body_b64') else f'FAIL: row mismatch hash={r.get(\"code_hash\")} size={r.get(\"code_size\")}')
")
[ "$ROW_CHECK" = "OK" ] || { echo "FAIL P1: ledger row check: $ROW_CHECK"; exit 1; }

# === Phase 2: hydrate to a NEW path, verify SHA matches + exec bit preserved ===
DST_SH="$TD/hydrated/restored.sh"
OUT_HYD=$("$CLI" hydrate-script "$CID_SH" --to "$DST_SH" 2>&1)
echo "$OUT_HYD" | grep -q "hydrated: cid=$CID_SH"  || { echo "FAIL P2: hydrate output missing cid. OUT=$OUT_HYD"; exit 1; }
echo "$OUT_HYD" | grep -q "sha=$SRC_SHA"           || { echo "FAIL P2: hydrate sha mismatch. expected=$SRC_SHA OUT=$OUT_HYD"; exit 1; }
[ -f "$DST_SH" ]                                    || { echo "FAIL P2: hydrate didn't create parent dir + file"; exit 1; }
DST_SHA=$(shasum -a 256 "$DST_SH" | awk '{print substr($1,1,16)}')
[ "$DST_SHA" = "$SRC_SHA" ]                         || { echo "FAIL P2: hydrated file SHA differs from source. src=$SRC_SHA dst=$DST_SHA"; exit 1; }
[ -x "$DST_SH" ]                                    || { echo "FAIL P2: hydrated .sh missing exec bit"; exit 1; }
# Should actually run end-to-end
RUN_OUT=$("$DST_SH" 2>&1)
echo "$RUN_OUT" | grep -q "hello from bound script" || { echo "FAIL P2: hydrated script doesn't run correctly. OUT=$RUN_OUT"; exit 1; }

# === Phase 3: missing script_bound row → SCRIPT MISSING block + exit 1 ===
CID_EMPTY=$(declare_one "phase3 nothing bound")
set +e
OUT_MISS=$("$CLI" hydrate-script "$CID_EMPTY" --to "$TD/never-written.sh" 2>&1)
MISS_RC=$?
set -e
[ "$MISS_RC" = "1" ]                                || { echo "FAIL P3: missing hydrate exit code $MISS_RC, expected 1"; exit 1; }
echo "$OUT_MISS" | grep -q "=== SCRIPT MISSING ===" || { echo "FAIL P3: no SCRIPT MISSING block. OUT=$OUT_MISS"; exit 1; }
echo "$OUT_MISS" | grep -q "$CID_EMPTY"             || { echo "FAIL P3: block doesn't name contract id. OUT=$OUT_MISS"; exit 1; }
echo "$OUT_MISS" | grep -q "result: FAIL"           || { echo "FAIL P3: no FAIL result line. OUT=$OUT_MISS"; exit 1; }
[ -f "$TD/never-written.sh" ]                       && { echo "FAIL P3: hydrate wrote a file despite SCRIPT MISSING"; exit 1; }

# === Phase 4: rebind same contract with different content → latest wins on hydrate ===
SRC_V2="$TD/src_v2.sh"
cat > "$SRC_V2" <<'EOF'
#!/usr/bin/env bash
echo "VERSION 2 of bound script"
exit 0
EOF
V2_SHA=$(shasum -a 256 "$SRC_V2" | awk '{print substr($1,1,16)}')
[ "$V2_SHA" != "$SRC_SHA" ] || { echo "FAIL P4 setup: v2 content didn't change SHA"; exit 1; }
"$CLI" bind-script "$CID_SH" "$SRC_V2" > /dev/null 2>&1
DST_V2="$TD/hydrated/v2.sh"
"$CLI" hydrate-script "$CID_SH" --to "$DST_V2" > /dev/null 2>&1
DST_V2_SHA=$(shasum -a 256 "$DST_V2" | awk '{print substr($1,1,16)}')
[ "$DST_V2_SHA" = "$V2_SHA" ] || { echo "FAIL P4: latest bind didn't win on hydrate. expected=$V2_SHA got=$DST_V2_SHA"; exit 1; }
# Old v1 hydrate should now also return v2 (latest-wins, not bind-id keyed)
OUT_V2_DEFAULT=$("$CLI" hydrate-script "$CID_SH" --to "$TD/hydrated/check.sh" 2>&1)
echo "$OUT_V2_DEFAULT" | grep -q "sha=$V2_SHA" || { echo "FAIL P4: default hydrate didn't pick latest. OUT=$OUT_V2_DEFAULT"; exit 1; }

# === Phase 5: bind without --to override hydrates to original code_path ===
ORIG="$TD/origin/where-it-came-from.py"
mkdir -p "$(dirname "$ORIG")"
cat > "$ORIG" <<'EOF'
#!/usr/bin/env python3
print("from original path")
EOF
ORIG_SHA=$(shasum -a 256 "$ORIG" | awk '{print substr($1,1,16)}')
CID_PATH=$(declare_one "phase5 bind py at known path")
"$CLI" bind-script "$CID_PATH" "$ORIG" > /dev/null 2>&1
# Delete the original
rm "$ORIG"
[ ! -f "$ORIG" ] || { echo "FAIL P5 setup: couldn't delete original"; exit 1; }
# Hydrate WITHOUT --to → should recreate at original path
"$CLI" hydrate-script "$CID_PATH" > /dev/null 2>&1
[ -f "$ORIG" ] || { echo "FAIL P5: hydrate didn't recreate at original code_path"; exit 1; }
ORIG_RESTORED_SHA=$(shasum -a 256 "$ORIG" | awk '{print substr($1,1,16)}')
[ "$ORIG_RESTORED_SHA" = "$ORIG_SHA" ] || { echo "FAIL P5: restored SHA differs. orig=$ORIG_SHA restored=$ORIG_RESTORED_SHA"; exit 1; }
[ -x "$ORIG" ] || { echo "FAIL P5: restored .py missing exec bit (had shebang)"; exit 1; }

# === Phase 6: missing args / unknown contract → exit 2 / 1 with clear errors ===
set +e
OUT_USAGE=$("$CLI" bind-script 2>&1); RC_U=$?
OUT_NOCID=$("$CLI" bind-script nonexistent_cid "$SRC_SH" 2>&1); RC_N=$?
OUT_NOPATH=$("$CLI" bind-script "$CID_SH" /nonexistent/path 2>&1); RC_P=$?
set -e
[ "$RC_U" = "2" ]                                   || { echo "FAIL P6a: empty bind-script didn't exit 2 (got $RC_U)"; exit 1; }
echo "$OUT_USAGE" | grep -q "usage: contract bind-script" || { echo "FAIL P6a: no usage line"; exit 1; }
[ "$RC_N" = "1" ]                                   || { echo "FAIL P6b: unknown cid didn't exit 1 (got $RC_N). OUT=$OUT_NOCID"; exit 1; }
echo "$OUT_NOCID" | grep -q "not found"             || { echo "FAIL P6b: unknown cid msg missing. OUT=$OUT_NOCID"; exit 1; }
[ "$RC_P" = "2" ]                                   || { echo "FAIL P6c: missing file didn't exit 2 (got $RC_P). OUT=$OUT_NOPATH"; exit 1; }

# === Phase 7: roundtrip a BINARY (non-text) body to confirm base64 transport is bytewise-faithful ===
BIN="$TD/bin.dat"
# 256 bytes of every possible byte value — catches any UTF-8 / encoding leak
python3 -c "open('$BIN', 'wb').write(bytes(range(256)))"
BIN_SHA=$(shasum -a 256 "$BIN" | awk '{print substr($1,1,16)}')
CID_BIN=$(declare_one "phase7 bind binary payload")
"$CLI" bind-script "$CID_BIN" "$BIN" > /dev/null 2>&1
DST_BIN="$TD/hydrated/bin.dat"
"$CLI" hydrate-script "$CID_BIN" --to "$DST_BIN" > /dev/null 2>&1
DST_BIN_SHA=$(shasum -a 256 "$DST_BIN" | awk '{print substr($1,1,16)}')
[ "$DST_BIN_SHA" = "$BIN_SHA" ] || { echo "FAIL P7: binary roundtrip SHA mismatch. src=$BIN_SHA dst=$DST_BIN_SHA"; exit 1; }
# Binary file (no .sh/.py extension, no shebang) should NOT get exec bit
[ ! -x "$DST_BIN" ] || { echo "FAIL P7: binary file got exec bit (should only be for .sh/.py/shebang)"; exit 1; }

echo "PASS: bind-script + hydrate-script — bind appends correct sha+size+body, hydrate restores byte-identical file with exec bit preserved for .sh/.py/shebanged, missing row → SCRIPT MISSING block + exit 1 (no fake-green), rebind = latest-wins on hydrate, default hydrate uses original code_path, args validation errors cleanly, binary body roundtrips bytewise (base64 transport is faithful — no UTF-8 leak)"
