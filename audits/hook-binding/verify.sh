#!/usr/bin/env bash
# audits/hook-binding/verify.sh — every hook is /contract-bound on both edges.
#
# Scans every ~/.contracts/hooks/*.{py,sh} (the scope.txt corpus).
# For each hook, checks:
#   PRE  — matches /feature-status|should_fire\(|_toggle_on\(/
#   POST — matches /hook_fired|record\(|_append\(/
# Reports per-hook status. Exits 1 if any hook lacks either edge; 0 if all bound.
#
# The substrate's audits/ self-binding doctrine fires this on every pre-commit.
# Lewis's framing: "enforce programmatically for the hooks for both pre and post
# to always be /contract properly via /contract as pointers".
set -uo pipefail

REAL_HOME="${HOME:-/Users/lekt9}"
SCOPE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scope.txt"

# Resolve scope paths (one per line, # comments, ~ expansion)
declare -a HOOK_DIRS
HOOK_DIRS=()
while IFS= read -r line; do
  case "$line" in
    \#*|"") continue ;;
  esac
  # Expand ~
  expanded="${line/#\~/$REAL_HOME}"
  HOOK_DIRS+=("$expanded")
done < "$SCOPE_FILE"

declare -a HOOK_FILES
HOOK_FILES=()
for d in "${HOOK_DIRS[@]}"; do
  [ -d "$d" ] || continue
  while IFS= read -r f; do
    HOOK_FILES+=("$f")
  done < <(find "$d" -maxdepth 1 -type f \( -name "*.py" -o -name "*.sh" \) 2>/dev/null | sort)
done

if [ "${#HOOK_FILES[@]}" -eq 0 ]; then
  echo "PASS: no hooks in scope (empty corpus is vacuously bound)"
  exit 0
fi

# Per-hook check
declare -a UNBOUND_PRE
declare -a UNBOUND_POST
declare -a FULLY_BOUND
UNBOUND_PRE=()
UNBOUND_POST=()
FULLY_BOUND=()

printf "%-32s  %-8s  %-9s\n" "hook" "pre-gate" "post-rec"
printf "%-32s  %-8s  %-9s\n" "----" "--------" "--------"

for f in "${HOOK_FILES[@]}"; do
  base="$(basename "$f")"
  # PRE patterns:
  #   feature-status   — direct CLI call to the toggle verb
  #   should_fire(     — hook_sdk import
  #   _toggle_on(      — legacy unbrowse-mirror pattern (still valid)
  if grep -qE "feature-status|should_fire\(|_toggle_on\(" "$f" 2>/dev/null; then
    pre="OK"
  else
    pre="MISSING"
    UNBOUND_PRE+=("$base")
  fi
  # POST patterns:
  #   hook_fired       — the event-type string written via _append
  #   record(          — hook_sdk import
  #   _append(         — direct contract_core write
  if grep -qE "hook_fired|record\(|_append\(" "$f" 2>/dev/null; then
    post="OK"
  else
    post="MISSING"
    UNBOUND_POST+=("$base")
  fi
  printf "%-32s  %-8s  %-9s\n" "$base" "$pre" "$post"
  if [ "$pre" = "OK" ] && [ "$post" = "OK" ]; then
    FULLY_BOUND+=("$base")
  fi
done

echo ""
echo "Summary:"
echo "  total hooks:    ${#HOOK_FILES[@]}"
echo "  fully bound:    ${#FULLY_BOUND[@]} (${FULLY_BOUND[*]:-})"
echo "  missing PRE:    ${#UNBOUND_PRE[@]} (${UNBOUND_PRE[*]:-})"
echo "  missing POST:   ${#UNBOUND_POST[@]} (${UNBOUND_POST[*]:-})"

if [ "${#UNBOUND_PRE[@]}" -eq 0 ] && [ "${#UNBOUND_POST[@]}" -eq 0 ]; then
  echo ""
  echo "PASS: every hook is /contract-bound on both edges (pre-gate + post-record)"
  exit 0
fi

echo ""
echo "FAIL: ${#UNBOUND_PRE[@]} hook(s) missing pre-gate, ${#UNBOUND_POST[@]} missing post-record"
echo ""
echo "Fix per-hook by adding hook_sdk pattern (see audits/hook-binding/README.md):"
echo "  from hook_sdk import should_fire, record"
echo "  if not should_fire('<hook-name>'): return 0"
echo "  # ... do work ..."
echo "  record('<hook-name>', event=sys.argv[1], exit_code=<rc>, ...)"
exit 1
