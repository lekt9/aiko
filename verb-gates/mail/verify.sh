#!/usr/bin/env bash
# Σ7 mail verb-gate. Verifies:
# 1. `contract mail` with no args → usage on stderr + exit 2
# 2. mail-write hook is executable + has the LISTEN-prefix-equivalent agent-field guard
# 3. The reader works against a synthetic mail file
set -u
PASS=0; FAIL=0
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
pass() { PASS=$((PASS+1)); }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Phase 1: no-args refusal
out=$(bash ~/.claude/skills/contract/scripts/contract mail 2>&1)
rc=$?
[ "$rc" = "2" ] && echo "$out" | grep -q "usage:" && pass || fail "no-args should exit 2 with usage; got rc=$rc out=$out"

# Phase 2: hook present + executable
[ -x ~/.contracts/hooks/mail-write.py ] && pass || fail "hook missing/not-exec"
grep -q "agent" ~/.contracts/hooks/mail-write.py && pass || fail "hook missing agent-field check"

# Phase 3: reader against synthetic mail
SAFE="testuser_example.com"
MAIL_DIR=$(mktemp -d)
mkdir -p ~/.contracts/inbox/mail
cat > ~/.contracts/inbox/mail/$SAFE.jsonl <<EOF
{"id":1,"ts":"2026-05-24T00:00:00Z","kind":"iterate","contract_id":"aaaaaaaa","plan":"test plan first","status":"active"}
{"id":2,"ts":"2026-05-24T00:01:00Z","kind":"mark","contract_id":"aaaaaaaa","plan":"test plan first","status":"satisfied","proof":"unit test passed"}
EOF
out=$(bash ~/.claude/skills/contract/scripts/contract mail "$SAFE" --last 5 2>&1)
echo "$out" | grep -q "MAIL CONTEXT" && pass || fail "reader missing MAIL CONTEXT block. got: $out"
echo "$out" | grep -q "test plan first" && pass || fail "reader missing plan text"
echo "$out" | grep -q "satisfied" && pass || fail "reader missing satisfied status"
echo "$out" | grep -q "unit test passed" && pass || fail "reader missing proof"
rm -f ~/.contracts/inbox/mail/$SAFE.jsonl

# Phase 4: --since filter
mkdir -p ~/.contracts/inbox/mail
cat > ~/.contracts/inbox/mail/$SAFE.jsonl <<EOF
{"id":1,"ts":"2026-01-01T00:00:00Z","kind":"iterate","contract_id":"bbbbbbbb","plan":"old plan","status":"active"}
{"id":2,"ts":"2026-12-01T00:00:00Z","kind":"iterate","contract_id":"cccccccc","plan":"new plan","status":"active"}
EOF
out=$(bash ~/.claude/skills/contract/scripts/contract mail "$SAFE" --since "2026-06-01T00:00:00Z" 2>&1)
echo "$out" | grep -q "new plan" && ! echo "$out" | grep -q "old plan" && pass || fail "--since filter broken"
rm -f ~/.contracts/inbox/mail/$SAFE.jsonl

# Phase 5: empty / nonexistent identity
out=$(bash ~/.claude/skills/contract/scripts/contract mail "nonexistent_user_xyz" 2>&1)
echo "$out" | grep -q "no mail for this identity yet" && pass || fail "missing mail should not crash"

if [ "$FAIL" = "0" ]; then
  echo "OK (mail verb-gate: $PASS phases passed)"
  exit 0
else
  echo "FAIL: $FAIL phases (passed $PASS)"
  exit 1
fi
