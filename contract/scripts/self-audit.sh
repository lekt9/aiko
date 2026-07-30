#!/bin/sh
# Contract black-box and native self-audit.
#
# This intentionally exits non-zero when an advertised invariant is violated.
# It uses a throwaway HOME/workspace and never invokes declare, resident tick,
# signing, import-root, broadcast, or an on-chain write path.
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BIN=${CONTRACT_BIN:-"$ROOT/scripts/contract"}
TMP=${TMPDIR:-/tmp}/contract-self-audit-$$
FAILURES=0
PASSES=0

cleanup() {
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

pass() {
  PASSES=$((PASSES + 1))
  printf 'PASS %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL %s\n' "$1" >&2
}

run() {
  name=$1
  shift
  if "$@"; then
    pass "$name"
  else
    fail "$name"
  fi
}

mkdir -m 700 "$TMP"
mkdir -m 700 "$TMP/home" "$TMP/work"
mkdir -m 700 "$TMP/work/.claude"

if [ ! -x "$BIN" ]; then
  printf 'FAIL executable missing: %s\n' "$BIN" >&2
  exit 2
fi

# Exercise the exact binary under test without overwriting its real signature.
# A clean profile must reject the unsigned copy; the explicit signing verb then
# establishes the temporary profile's local trust root for lifecycle tests.
AUDIT_BIN="$TMP/contract"
cp "$BIN" "$AUDIT_BIN"
chmod 700 "$AUDIT_BIN"
ln -s contract "$TMP/aiko"

if [ ! -e "$ROOT/scripts/contract-goal" ] && [ ! -e "$ROOT/scripts/contract-goal.sig" ]; then
  pass "command surface: redundant contract-goal persona is absent"
else
  fail "command surface: redundant contract-goal persona is absent"
fi
if "$TMP/aiko" --help 2>&1 | rg -q '^Usage:'; then
  pass "persona naming: aiko no longer selects Contract declaration mode"
else
  fail "persona naming: aiko no longer selects Contract declaration mode"
fi

run "native kernel: complete Zig suite" \
  sh -c 'cd "$1/libcontract" && zig build test --summary none' sh "$ROOT"
run "collective: cross-language golden vectors" \
  sh -c 'cd "$1/libcontract" && zig build collective-conformance -- ../fixtures/collective/golden-vectors.json >/dev/null' sh "$ROOT"
run "read-only commands: no wallet/ledger creation or prompt blocking" \
  env CONTRACT_BIN="$BIN" "$ROOT/tools/audit-readonly-keychain.sh"
run "runtime persistence: planted secret absent and renderer redacts" \
  "$ROOT/tools/scan-runtime-secret-leaks.sh"

cd "$TMP/work" || exit 2
unsigned_output=$(HOME="$TMP/home" "$AUDIT_BIN" task begin \
  "mutation must fail before binary attestation" \
  --check "true" 2>&1)
unsigned_rc=$?
if [ "$unsigned_rc" -ne 0 ] &&
   printf '%s\n' "$unsigned_output" | rg -q 'binary self-attestation failed' &&
   [ ! -f "$TMP/work/.claude/contracts.jsonl" ]; then
  pass "binary self-attestation: clean-home unsigned mutation fails closed before ledger write"
else
  fail "binary self-attestation: clean-home unsigned mutation fails closed before ledger write"
fi

if HOME="$TMP/home" "$AUDIT_BIN" sign-binary "$AUDIT_BIN" >"$TMP/sign.out" 2>"$TMP/sign.err" &&
   [ -f "$AUDIT_BIN.sig" ]; then
  pass "binary self-attestation: explicit isolated signing bootstrap succeeds"
else
  fail "binary self-attestation: explicit isolated signing bootstrap succeeds"
fi

begin_output=$(HOME="$TMP/home" "$AUDIT_BIN" task begin \
  "self audit task whose proof appears later" \
  --check "test -f proof.txt" 2>&1)
begin_rc=$?
task_id=$(printf '%s\n' "$begin_output" | rg -o '^[0-9a-f]{8}$' | tail -1)

if [ "$begin_rc" -eq 0 ] && [ -n "$task_id" ]; then
  pass "task begin: returns a bounded task id"
else
  fail "task begin: returns a bounded task id"
fi

if printf '%s\n' "$begin_output" | rg -q 'self-verify failed'; then
  fail "binary self-attestation: signed mutation has no failed verification"
else
  pass "binary self-attestation: signed mutation has no failed verification"
fi

if HOME="$TMP/home" "$AUDIT_BIN" task status "$task_id" 2>&1 | rg -q '^\[pending\]'; then
  pass "task status: new task is pending"
else
  fail "task status: new task is pending"
fi

HOME="$TMP/home" "$AUDIT_BIN" task verify "$task_id" >"$TMP/failed.out" 2>"$TMP/failed.err"
failed_rc=$?
if [ "$failed_rc" -ne 0 ] && rg -q 'remains pending' "$TMP/failed.out" "$TMP/failed.err"; then
  pass "task verify: failing check exits non-zero and remains pending"
else
  fail "task verify: failing check exits non-zero and remains pending"
fi

touch proof.txt
if HOME="$TMP/home" "$AUDIT_BIN" task verify "$task_id" >"$TMP/passed.out" 2>"$TMP/passed.err" &&
   rg -q 'satisfied' "$TMP/passed.out" "$TMP/passed.err"; then
  pass "task verify: reruns the real check and satisfies only after proof exists"
else
  fail "task verify: reruns the real check and satisfies only after proof exists"
fi

if HOME="$TMP/home" "$AUDIT_BIN" task status "$task_id" 2>&1 | rg -q '^\[satisfied\]'; then
  pass "task status: successful verification is durable"
else
  fail "task status: successful verification is durable"
fi

HOME="$TMP/home" "$AUDIT_BIN" events --trace "task-$task_id" >"$TMP/events.jsonl" 2>"$TMP/events.err"
roles=$(jq -r '.role' "$TMP/events.jsonl" 2>/dev/null | sort -u | tr '\n' ' ')
if printf '%s' "$roles" | rg -q 'action' &&
   printf '%s' "$roles" | rg -q 'sensor' &&
   printf '%s' "$roles" | rg -q 'evaluator'; then
  pass "causal evidence: action, sensor, and evaluator roles are emitted"
else
  fail "causal evidence: action, sensor, and evaluator roles are emitted"
fi

event_count=$(jq -r '.event_id' "$TMP/events.jsonl" 2>/dev/null | wc -l | tr -d ' ')
unique_count=$(jq -r '.event_id' "$TMP/events.jsonl" 2>/dev/null | sort -u | wc -l | tr -d ' ')
if [ "$event_count" -gt 0 ] && [ "$event_count" -eq "$unique_count" ]; then
  pass "causal evidence: retry event_id values are globally unique within the trace"
else
  fail "causal evidence: retry event_id values are globally unique within the trace ($unique_count unique / $event_count events)"
fi

if HOME="$TMP/home" "$AUDIT_BIN" explain "task-$task_id" >"$TMP/explain.out" 2>"$TMP/explain.err" &&
   rg -q 'action/' "$TMP/explain.out" &&
   rg -q 'sensor/' "$TMP/explain.out" &&
   rg -q 'evaluator/' "$TMP/explain.out"; then
  pass "explain: renders the causal verification trace"
else
  fail "explain: renders the causal verification trace"
fi

printf '\nSelf-audit result: %s passed, %s failed\n' "$PASSES" "$FAILURES"
[ "$FAILURES" -eq 0 ]
