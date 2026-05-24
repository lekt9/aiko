#!/bin/bash
# Σ10 universal verb-trigger: every CLI invocation fires _fire_contract_hooks
# with event="verb". Assert by installing a probe hook that records every
# verb event, then run a non-iterate verb (list) and check the probe fired.
set -e
TMP=$(mktemp -d)
PROBE=~/.contracts/hooks/sigma10-probe-$$.sh
LOG="$TMP/probe.log"
cat > "$PROBE" << HOOK
#!/bin/bash
echo "FIRED \$1 \$2" >> "$LOG"
HOOK
chmod +x "$PROBE"
# fire a verb that doesn't normally hit the hook bus (list)
~/.claude/skills/contract/scripts/contract list >/dev/null 2>&1 || true
sleep 1
rm -f "$PROBE"
if [ ! -f "$LOG" ] || ! grep -q "FIRED verb" "$LOG"; then
  echo "FAIL: list verb did not fire Σ10 universal hook"
  cat "$LOG" 2>/dev/null
  exit 1
fi
echo "PASS: Σ10 universal verb-trigger fires hook bus on long-tail verb (list)"
