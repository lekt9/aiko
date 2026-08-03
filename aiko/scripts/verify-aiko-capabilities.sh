#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIKO="${AIKO_BIN:-$HOME/bin/aiko}"
REPORT="$ROOT/docs/AIKO-CAPABILITY-VERIFICATION.md"
CONTRACT="$ROOT/../contract/scripts/contract"
RESULTS=()
FAILURES=0

record() {
  local status="$1" id="$2" detail="$3"
  RESULTS+=("| $id | $status | $detail |")
  [ "$status" != "FAIL" ] || FAILURES=$((FAILURES + 1))
  printf '%-5s %-28s %s\n' "$status" "$id" "$detail"
}

check() {
  local id="$1" detail="$2"; shift 2
  if "$@" >/dev/null 2>&1; then record PASS "$id" "$detail"; else record FAIL "$id" "$detail"; fi
}

verify_report() {
  test -f "$REPORT" || return 1
  local id
  for id in installed-cli packaged-contract background-worker native-manifest native-discovery config-inspection session-catalog plugin-catalog mcp-catalog shell-completions contract-turn desktop-build collective-kernel native-api-tests contract-bridge-tests; do
    rg -q "^\| ${id} \| (PASS|FAIL|NOT-RUN) \|" "$REPORT" || return 1
  done
}

verify_repairs() {
  local completions
  completions=$("$AIKO" completions zsh) || return 1
  rg -q '^#compdef aiko$' <<<"$completions" || return 1
  rg -q '^_aiko\(\)' <<<"$completions" || return 1
  (
    cd "$ROOT"
    CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
      cargo test --release -p xai-grok-shell --lib contract_native::tests
  )
}

if [ "${1:-}" = "--verify-report" ]; then
  verify_report
  exit $?
fi

if [ "${1:-}" = "--verify-repairs" ]; then
  verify_repairs
  exit $?
fi

check installed-cli "Installed Aiko reports its version and command catalog." \
  sh -c 'test -x "$1" && "$1" --version && "$1" --help | rg -q "Contract-native durable tasks"' sh "$AIKO"

check packaged-contract "Installed ABI v3 library is arm64 and exports turn, task, and ranking symbols." \
  sh -c 'test -f "$1" && file "$1" | rg -q "arm64" && nm -gU "$1" | rg -q "_contract_abi_version" && nm -gU "$1" | rg -q "_contract_declare_turn" && nm -gU "$1" | rg -q "_contract_recommend_capabilities"' sh "$HOME/.aiko/lib/libcontract.dylib"

# macOS: worker must be running. Linux: honest "unsupported" postmortem is green.
if [[ "$(uname -s)" == "Darwin" ]]; then
  check background-worker "LaunchAgent-backed Contract worker is running." \
    sh -c '"$1" background status | rg -q "worker is running"' sh "$AIKO"
else
  check background-worker "Linux records durable unsupported witness for background worker." \
    sh -c '"$1" background status 2>&1 | rg -q "unsupported|postmortem"' sh "$AIKO"
fi

check native-manifest "Versioned manifest advertises Contract, Collective, agent-mail, application, and permission interfaces." \
  sh -c '"$1" native manifest | jq -e "[.interfaces[].id] | contains([\"contract.ledger\",\"contract.tasks\",\"collective.local-control\",\"agent.mail\",\"application.runtime\",\"permission.interactions\"])"' sh "$AIKO"

check native-discovery "Loopback discovery is valid and its bearer token file is mode 600." \
  sh -c '"$1" native discovery | jq -e ".baseUrl | startswith(\"http://127.0.0.1:\")" >/dev/null && test "$(stat -f %OLp "$2")" = 600 && test "$(wc -c < "$2" | tr -d " ")" -ge 32' sh "$AIKO" "$HOME/.aiko/native/token"

check config-inspection "Configuration, hooks, skills, agents, permissions, and MCP discovery serialize as JSON." \
  sh -c '"$1" inspect --json | jq -e "has(\"agents\") and has(\"hooks\") and has(\"skills\") and has(\"permissions\") and has(\"mcpServers\")"' sh "$AIKO"

check session-catalog "Persisted sessions can be listed without entering the TUI." \
  sh -c '"$1" sessions list --limit 2' sh "$AIKO"

check plugin-catalog "Installed plugin inventory is machine-readable." \
  sh -c '"$1" plugin list --json | jq -e ". != null"' sh "$AIKO"

check mcp-catalog "Configured MCP inventory is machine-readable." \
  sh -c '"$1" mcp list --json | jq -e ". != null"' sh "$AIKO"

check shell-completions "Zsh completions are generated from the installed command tree." \
  bash -c 'output=$("$1" completions zsh) && rg -q "^#compdef aiko$" <<<"$output" && rg -q "^_aiko\\(\\)" <<<"$output"' bash "$AIKO"

if [ "${AIKO_CAPABILITY_FULL:-1}" = 1 ]; then
  check collective-kernel "Contract collective vectors and decentralized Aiko host/network suite pass." \
    sh -c 'cd "$1/../contract/libcontract" && zig build test --summary none && zig build collective-conformance -- ../fixtures/collective/golden-vectors.json >/dev/null && cd "$1" && cargo test -p xai-aiko-collective -- --test-threads=1' sh "$ROOT"

  check native-api-tests "Native API schemas, bearer comparison, and external-id validation pass." \
    sh -c 'cd "$1" && cargo test -p xai-grok-pager-bin native_api::tests' sh "$ROOT"

  check contract-bridge-tests "Turn grounding, privacy filtering, standing orders, and claim identity tests pass." \
    sh -c 'cd "$1" && CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" cargo test --release -p xai-grok-shell --lib contract_native::tests' sh "$ROOT"

  check desktop-build "Desktop TypeScript/Vite build and stream/sanitizer tests pass." \
    sh -c 'cd "$1" && npm --prefix apps/desktop run build && node --test apps/desktop/src/lib/agentStream.test.mjs apps/desktop/src/generative/sanitizeSpec.test.mjs' sh "$ROOT"
else
  record NOT-RUN collective-kernel "Set AIKO_CAPABILITY_FULL=1 to run the native and peer suites."
  record NOT-RUN native-api-tests "Set AIKO_CAPABILITY_FULL=1 to compile the native API tests."
  record NOT-RUN contract-bridge-tests "Set AIKO_CAPABILITY_FULL=1 to compile Contract bridge tests."
  record NOT-RUN desktop-build "Set AIKO_CAPABILITY_FULL=1 to build the desktop."
fi

if [ "${AIKO_CAPABILITY_LIVE:-1}" = 1 ]; then
  SMOKE="aiko-capability-smoke-$(date +%s)"
  OUT=$("$AIKO" --single "Reply with exactly: $SMOKE" --max-turns 1 --output-format json 2>/dev/null || true)
  CID=$(rg -l "Reply with exactly: $SMOKE" "$ROOT/.claude/contracts.jsonl" >/dev/null 2>&1 && \
    jq -r --arg goal "Reply with exactly: $SMOKE" 'select(.event=="declared" and .plan==$goal) | .id' "$ROOT/.claude/contracts.jsonl" | tail -1)
  if printf '%s' "$OUT" | jq -e --arg smoke "$SMOKE" '.text==$smoke and .stopReason=="EndTurn"' >/dev/null 2>&1 \
    && [ -n "$CID" ] && "$CONTRACT" status "$CID" 2>/dev/null | rg -q '^\[satisfied\]'; then
    record PASS contract-turn "A real model turn was declared before sampling and signed satisfied at EndTurn."
  else
    record FAIL contract-turn "Live model response or native Contract lifecycle proof was missing."
  fi
else
  record NOT-RUN contract-turn "Set AIKO_CAPABILITY_LIVE=1 to make one live model request."
fi

record GATED auth-mutation "Login/logout were not mutated; current login policy was inspected only."
record GATED updater-mutation "Update installation was not invoked during an audit of the active install."
record GATED paid-services "AgentMail inbox creation and CAPTCHA solving require explicit purchase confirmation."
record GATED external-channels "Telegram delivery requires a configured bot and external recipient."
record GATED destructive-controls "Session deletion and Contract cancel/retry were not exercised on user data."
record STATIC windows-runtime "Windows artifacts can be inspected on macOS but require a Windows host for execution proof."

{
  printf '# Aiko capability verification\n\n'
  printf 'Generated: `%s`  \n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Installed binary: `%s`  \n' "$AIKO"
  printf 'Version: `%s`\n\n' "$($AIKO --version 2>/dev/null)"
  printf '| Capability | Result | Evidence |\n|---|---|---|\n'
  printf '%s\n' "${RESULTS[@]}"
  printf '\n## Interpretation\n\n'
  printf '`PASS` means the installed path or its documented acceptance suite was exercised successfully. '
  printf '`GATED` means testing would change accounts, spend money, contact third parties, or destroy user state. '
  printf '`STATIC` means the artifact can be inspected here but runtime proof requires another operating system.\n'
} > "$REPORT"

printf '\nreport=%s failures=%d\n' "$REPORT" "$FAILURES"

# Durable postmortem snapshot (same class as install-selfcheck).
PM_DIR="${AIKO_HOME:-$HOME/.aiko}/postmortem"
mkdir -p "$PM_DIR"
python3 - "$PM_DIR/capabilities.latest.json" "$FAILURES" "$REPORT" <<'PY' || true
import json, sys, os
from pathlib import Path
out, failures, report = sys.argv[1], int(sys.argv[2]), sys.argv[3]
Path(out).write_text(json.dumps({
    "format": 1,
    "kind": "capabilities",
    "failures": failures,
    "complete": failures == 0,
    "report": report,
}, indent=2) + "\n", encoding="utf-8")
print(f"postmortem: wrote {out}")
PY

verify_report
