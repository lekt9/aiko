#!/usr/bin/env bash
# verify.sh — proves the harness shape: action 'harness:<path>' delegates to
# <path>/verify.sh. Exit code of that verify.sh drives KEY 1.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="harnessgate_selftest_$$"

# Build a temporary harness whose verify.sh respects a sentinel file
HDIR=$(mktemp -d)
SENTINEL="$HDIR/should-pass"
cat > "$HDIR/verify.sh" <<'EOF'
#!/usr/bin/env bash
test -f "$(dirname "$0")/should-pass"
EOF
chmod +x "$HDIR/verify.sh"

ID=$(bash "$C" declare "$N harness probe" --action "harness:$HDIR" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: could not declare harness"; rm -rf "$HDIR"; exit 1; }

# wave 1: sentinel absent -> verify.sh returns 1 -> FAIL
O=$(bash "$C" iterate "$ID" 2>/dev/null)
echo "$O" | grep -q "result: FAIL" || { echo "FAIL: harness wave 1 did not FAIL"; echo "$O"; rm -rf "$HDIR"; exit 1; }
echo "evidence: harness wave 1  ->  external verify.sh FAILed -> KEY 1 FAIL  OK"

# wave 2: place sentinel -> verify.sh returns 0 -> PASS
touch "$SENTINEL"
O=$(bash "$C" iterate "$ID" 2>/dev/null)
echo "$O" | grep -q "result: PASS" || { echo "FAIL: harness wave 2 did not PASS"; echo "$O"; rm -rf "$HDIR"; exit 1; }
echo "evidence: harness wave 2  ->  external verify.sh PASSed -> KEY 1 PASS  OK"

rm -rf "$HDIR"
echo "PASS: harness — delegates to <path>/verify.sh; its exit drives KEY 1."
exit 0
