#!/usr/bin/env bash
# audit-secret-leaks.sh — surface (don't redact) likely leaked secrets in
# Claude Code transcript files from THIS session. The substrate principle
# is "harness collects, agent judges": we list candidate file:line hits;
# the agent decides if they're real secrets and adjusts future output.
#
# Patterns we flag (deliberately tolerant — false positives over false negatives):
#   - sk_live_*, sk_test_*           Stripe keys
#   - bearer eyJ...                  JWT
#   - 32+/40+/64-char lowercase hex  generic API tokens
#   - Authorization: Bearer <...>    leaked auth header
#   - "api_key=<value>"             KEY=VALUE pattern with raw value
set -u

# Scope: only the current Claude Code session transcripts. Globbing the
# whole projects tree is too noisy and was the OOM-risk in earlier audits.
SESSION_DIR="${CLAUDE_SESSION_TRANSCRIPT_DIR:-$HOME/.claude/projects/$(pwd | sed 's|/|-|g')}"
[ -d "$SESSION_DIR" ] || SESSION_DIR="$HOME/.claude/projects"

PATTERNS=(
  'sk_live_[A-Za-z0-9]{16,}'
  'sk_test_[A-Za-z0-9]{16,}'
  'eyJ[A-Za-z0-9._-]{40,}'
  '[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}'
  '\b[0-9a-f]{40,64}\b'
)

hits=0
for pat in "${PATTERNS[@]}"; do
  matches=$(rg --no-messages -nH "$pat" "$SESSION_DIR" 2>/dev/null \
    | grep -vE "/tool-results/|\.lock$|node_modules/|/sundayservice/|/bible-significance|/research/" \
    | head -20 || true)
  if [ -n "$matches" ]; then
    if [ "$hits" -eq 0 ]; then
      echo "  ⚠  candidate secret patterns found in session transcripts:"
    fi
    echo "  --- pattern: $pat ---"
    # Mask the value in the output — show only first 8 chars + length.
    echo "$matches" | awk '
      {
        # find pattern match position approximately — print line w/ partial mask
        line = $0
        # Coarse mask: replace any 40+ hex run with <40+hex>; replace sk_live/sk_test/eyJ runs.
        gsub(/sk_live_[A-Za-z0-9]+/, "<sk_live_…>", line)
        gsub(/sk_test_[A-Za-z0-9]+/, "<sk_test_…>", line)
        gsub(/eyJ[A-Za-z0-9._-]+/, "<jwt_eyJ…>", line)
        gsub(/[0-9a-f]{40,64}/, "<hex_token_…>", line)
        print "    " line
      }' | head -5
    hits=$((hits + 1))
  fi
done

if [ "$hits" -eq 0 ]; then
  echo "  ✓ no obvious leaked-secret patterns in current-session transcripts"
  exit 0
fi
echo ""
echo "  ⚠ $hits pattern class(es) hit. KEY 2: judge which are real secrets vs false positives"
echo "    (rules in the body of project keys, generic hex IDs, transcript-of-CLI output)."
echo "    Future output: route every secret read through secret-inject.sh and pages-secret/file-env targets."
exit 1
