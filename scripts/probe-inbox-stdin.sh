#!/usr/bin/env bash
# probe-inbox-stdin.sh — gate for child 6060ff8f of b2d15246.
#
# Asserts the mail-stdin doctrine holds:
#   A. When ~/.contracts/inbox-pending/<cid>.json exists at iterate time,
#      the cli pointer's action receives the event JSON on stdin AND in
#      CONTRACT_INBOX_EVENT env, AND CONTRACT_ID env is set.
#   B. The pending file is removed after consumption (idempotent fire).
#   C. wait-for-event.py prints the matched row JSON to stdout (the receptor
#      path inherits the same convention).
#
# Runs in a tempdir-scoped CONTRACTS_STORE so the real ledger is untouched.
set -e

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/contracts.jsonl"
mkdir -p "$HOME/.contracts/inbox-pending"

CLI="$HOME/.claude/skills/contract/scripts/contract"

# Declare a contract whose action reads stdin + CONTRACT_INBOX_EVENT.
PROBE_ACTION="bash -c 'set -e; STDIN_PAYLOAD=\$(cat); [ -n \"\$STDIN_PAYLOAD\" ] || { echo \"no stdin\" >&2; exit 1; }; [ -n \"\$CONTRACT_INBOX_EVENT\" ] || { echo \"no env\" >&2; exit 1; }; [ -n \"\$CONTRACT_ID\" ] || { echo \"no contract id\" >&2; exit 1; }; echo \"STDIN-OK ENV-OK ID-OK contract=\$CONTRACT_ID\"'"

DECLARE_OUT=$("$CLI" declare "probe inbox-stdin delivery" --action "$PROBE_ACTION" --no-drive 2>&1)
CID=$(printf '%s' "$DECLARE_OUT" | grep -oE '^declared: [0-9a-f]+' | head -1 | awk '{print $2}')
[ -n "$CID" ] || { echo "FAIL: could not declare probe contract"; printf '%s\n' "$DECLARE_OUT"; exit 1; }

# Stage a pending inbox event for this id.
STAGED='{"event":"flipped","contract_id":"'"$CID"'","probe_test":true,"marker":"unique-token-7df3"}'
echo "$STAGED" > "$HOME/.contracts/inbox-pending/$CID.json"

# Iterate — the action should pick up stdin + env + id.
ITERATE_OUT=$("$CLI" iterate "$CID" 2>&1)

echo "$ITERATE_OUT" | grep -q "result: PASS" || {
  echo "FAIL(A): iterate did not PASS — action did not see stdin/env/id"
  echo "--- iterate output ---"
  echo "$ITERATE_OUT" | sed 's/^/  /'
  exit 1
}

# (B) pending file removed after consumption
if [ -f "$HOME/.contracts/inbox-pending/$CID.json" ]; then
  echo "FAIL(B): inbox-pending file still exists after iterate — not idempotent"
  exit 1
fi
echo "PASS(A+B): inbox event delivered to stdin + env, pending file consumed"

# (C) wait-for-event.py prints matched JSON to stdout (receptor convention).
mkdir -p "$HOME/.contracts/inbox/probe-test"
WTE_INBOX="$HOME/.contracts/inbox/probe-test/probe.jsonl"
echo '{"message_id":1,"text":"hello-probe-rcptr"}' >> "$WTE_INBOX"
WTE_OUT=$(python3 "$HOME/.claude/skills/contract/scripts/wait-for-event.py" --inbox probe-test --filter hello-probe-rcptr --timeout 3 2>&1)
WTE_RC=$?
rm -f "$WTE_INBOX"
[ "$WTE_RC" -eq 0 ] || { echo "FAIL(C): wait-for-event.py did not match (rc=$WTE_RC)"; exit 1; }
echo "$WTE_OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("matched") is True and d.get("row",{}).get("text")=="hello-probe-rcptr", "unexpected shape"' || {
  echo "FAIL(C): wait-for-event.py stdout did not carry matched row JSON"; echo "  got: $WTE_OUT"; exit 1;
}
echo "PASS(C): wait-for-event.py emits matched row JSON to stdout"

echo
echo "probe-inbox-stdin: PASS"
exit 0
