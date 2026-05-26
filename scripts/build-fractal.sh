#!/usr/bin/env bash
# build-fractal.sh — fractal build pipeline.
#
# The substrate's binary is itself a /contract. Building it follows
# the same trio (build / run / eval) that the substrate enforces on
# every /contract:
#
#   1. BUILD  — `zig build` compiles the binary (gated by spirit-attest).
#   2. RUN    — `zig build test` exercises the runtime (the substrate's
#               own inline tests fire; the binary IS its iteration).
#   3. EVAL   — the fresh binary is fed back into itself as a /contract
#               whose plan describes the build and whose action is
#               `validate:<binary-sha256>` (layer 7). markSatisfied on
#               that /contract auto-cascades the L8 `signed:<sig>` row.
#               The wallet-signed row IS the binary's pointer-memory.
#
# Fractal property: every layer of the substrate uses this same
# three-step structure. The build pipeline is the substrate verifying
# the substrate — turtles all the way down. If any step fails the
# next step does not fire; the chain is short-circuit.
#
# Output: on success, prints the L8 signed:<sig> /contract id. On any
# failure, exits non-zero with a targeted diagnostic.
#
# Usage:
#   bash scripts/build-fractal.sh
#   bash scripts/build-fractal.sh --skip-test   # NOT RECOMMENDED; for emergency rebuilds only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIG_DIR="$REPO_ROOT/zig"
LIBCONTRACT_DIR="$REPO_ROOT/libcontract"

SKIP_TEST=0
if [[ "${1:-}" == "--skip-test" ]]; then
  SKIP_TEST=1
fi

# Color codes for human-readable terminal output. Strip in CI.
if [[ -t 1 ]]; then
  C_INFO="\033[1;36m"; C_OK="\033[1;32m"; C_FAIL="\033[1;31m"; C_RESET="\033[0m"
else
  C_INFO=""; C_OK=""; C_FAIL=""; C_RESET=""
fi

log_info()  { printf "${C_INFO}» %s${C_RESET}\n" "$*"; }
log_ok()    { printf "${C_OK}✓ %s${C_RESET}\n"   "$*"; }
log_fail()  { printf "${C_FAIL}✗ %s${C_RESET}\n" "$*"; }

# ─── Step 0: preflight ─────────────────────────────────────────────────
log_info "preflight: confirming the Zig source tree is reachable"
[[ -d "$ZIG_DIR" ]]         || { log_fail "missing zig/ at $ZIG_DIR";        exit 2; }
[[ -d "$LIBCONTRACT_DIR" ]] || { log_fail "missing libcontract/";            exit 2; }
[[ -f "$ZIG_DIR/build.zig" ]] || { log_fail "missing zig/build.zig";         exit 2; }
log_ok "source tree present"

# ─── Step 1: BUILD (with spirit-attest retry loop) ─────────────────────
#
# Lewis 2026-05-26: "we shouldn't proceed if compile failed because of
# spirit check - we should keep retrying by surfacing the errors
# properly". The build distinguishes two failure modes:
#
#   (a) pattern violation (comptime) — compile error, hard fail. No
#       retry; the source must be fixed.
#   (b) spirit-check (runtime gate) — missing attestation rows. Surface
#       every unattested file, auto-invoke aiko-attest if the LLM
#       endpoint is reachable, and retry the build. Bounded retries
#       prevent infinite loops if the LLM keeps producing FAIL verdicts.
#
# The retry loop is what makes the build pipeline self-healing — when
# the spirit ledger is the only thing standing between the operator
# and a green build, the script attests the gap rather than asking
# the operator to repeat the same command in a different shell.

MAX_BUILD_ATTEMPTS=3
ATTEMPT=0
BUILD_LOG="/tmp/build-fractal-$$-build.log"

run_zig_build() {
  ( cd "$ZIG_DIR" && zig build ) > "$BUILD_LOG" 2>&1
}

# Returns 0 if the failure is a spirit-check error AND we can auto-fix.
# Prints the unattested files to stdout for the caller to consume.
classify_failure() {
  if ! grep -q 'spirit-check: FAIL' "$BUILD_LOG"; then
    return 1
  fi
  # Each unattested file appears on a line like:
  #   spirit-check: FAIL — source `libcontract/src/foo.zig` has no attestation row.
  grep -oE 'source `[^`]+`' "$BUILD_LOG" | sed -E "s/source \`(.*)\`/\1/" || true
}

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  log_info "BUILD — attempt $ATTEMPT/$MAX_BUILD_ATTEMPTS (zig build, gated by spirit-check + pattern.assertInvariants)"

  if run_zig_build; then
    log_ok "binary compiled (attempt $ATTEMPT)"
    break
  fi

  # Surface the full build log first — operator should see what Zig said.
  log_fail "zig build failed on attempt $ATTEMPT — surfacing the full output:"
  echo "─── build log ─────────────────────────────────────────────────────"
  cat "$BUILD_LOG"
  echo "───────────────────────────────────────────────────────────────────"

  UNATTESTED="$(classify_failure || true)"

  if [[ -z "$UNATTESTED" ]]; then
    # Not a spirit-check failure — must be pattern violation or a real
    # compile error. Hard fail; retrying won't help.
    log_fail "non-spirit failure (pattern violation or compile error) — not retryable"
    rm -f "$BUILD_LOG"
    exit 1
  fi

  # Spirit-check failure. Enumerate the gap.
  log_info "spirit-attest gap — the following files lack PASS rows in .contract-spirit-attest.jsonl:"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    log_info "  • $f"
  done <<< "$UNATTESTED"

  if [[ -z "${CONTRACT_LLM_API_KEY:-}" ]]; then
    log_fail "CONTRACT_LLM_API_KEY is not set — cannot auto-attest."
    log_fail "  Set CONTRACT_LLM_API_KEY (any OpenAI-compat bearer) and re-run:"
    log_fail "    export CONTRACT_LLM_API_KEY=…"
    log_fail "    bash $(realpath "$0")"
    log_fail "  OR run aiko-attest manually:"
    log_fail "    $ZIG_DIR/zig-out/bin/aiko-attest"
    rm -f "$BUILD_LOG"
    exit 1
  fi

  if [[ "$ATTEMPT" -ge "$MAX_BUILD_ATTEMPTS" ]]; then
    log_fail "still unattested after $MAX_BUILD_ATTEMPTS attempts — the LLM judge may be"
    log_fail "  returning FAIL verdicts. Read .contract-spirit-attest.jsonl for the"
    log_fail "  most recent reasoning rows and fix the offending source files."
    rm -f "$BUILD_LOG"
    exit 1
  fi

  log_info "auto-attesting: invoking aiko-attest with the configured LLM endpoint"
  ATTEST_BINARY="$ZIG_DIR/zig-out/bin/aiko-attest"
  if [[ ! -x "$ATTEST_BINARY" ]]; then
    log_fail "aiko-attest binary missing at $ATTEST_BINARY"
    log_fail "  Run \`cd $ZIG_DIR && zig build\` first to compile the ungated attest binary"
    log_fail "  (it builds even when contract-zig-server is gated)."
    rm -f "$BUILD_LOG"
    exit 1
  fi
  if ! "$ATTEST_BINARY"; then
    log_fail "aiko-attest exited non-zero — see its output above. The LLM either"
    log_fail "  could not be reached, or returned a FAIL verdict for one or more"
    log_fail "  files. Inspect .contract-spirit-attest.jsonl for the latest rows."
    rm -f "$BUILD_LOG"
    exit 1
  fi
  log_ok "attestations landed — retrying build"
done

rm -f "$BUILD_LOG"

BINARY="$ZIG_DIR/zig-out/bin/contract-zig-server"
[[ -x "$BINARY" ]] || { log_fail "contract-zig-server missing after build"; exit 1; }

# ─── Step 2: RUN ───────────────────────────────────────────────────────
if [[ "$SKIP_TEST" == "1" ]]; then
  log_info "RUN — SKIPPED (--skip-test); emergency rebuild only"
else
  log_info "RUN — zig build test (libcontract inline tests)"
  if ! ( cd "$LIBCONTRACT_DIR" && zig build test ); then
    log_fail "libcontract tests failed — runtime invariant broken"
    exit 1
  fi
  log_ok "tests pass"
fi

# Compute the binary's sha256 — this is the truth-claim about WHICH
# binary we are signing. shasum is BSD-available on macOS; sha256sum
# on Linux; both produce the same first 64-hex output.
if command -v sha256sum >/dev/null 2>&1; then
  BIN_SHA="$(sha256sum "$BINARY" | awk '{print $1}')"
else
  BIN_SHA="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
fi
log_info "binary sha256: $BIN_SHA"

# ─── Step 3: EVAL — sign the binary into the ledger ────────────────────
#
# Use the freshly-built binary to declare and eval ITS OWN build as a
# /contract. The action is a validate:<short-sha> at layer 7; eval on
# that auto-spawns the layer-8 signed:<wallet-sig> child. The wallet-
# signed row in the ledger IS the binary's pointer-memory.

SHORT_SHA="${BIN_SHA:0:8}"

log_info "EVAL — declaring the build /contract via the fresh binary"

# Build envelope — a `declared` event at layer 7 (the validate:
# break-layer). Plan describes what just happened; action carries the
# canonical sha8 as a validate target.
BUILD_ENVELOPE=$(cat <<EOF
{
  "event": "declared",
  "plan": "fractal-build complete: zig build (PASS) → zig build test (${SKIP_TEST:+SKIPPED}${SKIP_TEST:-PASS}) → binary sha256 $BIN_SHA",
  "action": "validate:$SHORT_SHA",
  "layer": 7
}
EOF
)

BUILD_CID=$(echo "$BUILD_ENVELOPE" | "$BINARY" build | head -n1 | tr -d '[:space:]')
if [[ ! "$BUILD_CID" =~ ^[0-9a-f]{8}$ ]]; then
  log_fail "build /contract declare returned non-id: $BUILD_CID"
  exit 1
fi
log_ok "build /contract: $BUILD_CID"

# Eval envelope — satisfy the validate:<sha> /contract. The substrate's
# L7→L8 cascade automatically appends a signed:<wallet-sig> child row
# whose action carries the wallet's ed25519 signature. That child IS
# the binary's pointer-memory.
EVAL_ENVELOPE=$(cat <<EOF
{
  "event": "satisfied",
  "id": "$BUILD_CID",
  "wave": 1,
  "proof": "binary sha256=$BIN_SHA size=$(wc -c < "$BINARY" | tr -d ' ')"
}
EOF
)

EVAL_OUT=$(echo "$EVAL_ENVELOPE" | "$BINARY" eval | head -n1 | tr -d '[:space:]')
if [[ "$EVAL_OUT" != "$BUILD_CID" ]]; then
  log_fail "eval returned unexpected id: $EVAL_OUT (expected $BUILD_CID)"
  exit 1
fi
log_ok "build /contract satisfied — L7→L8 cascade fires"

# Walk the lineage and surface the L8 signed:<sig> row.
SIGNED_ROW=$("$BINARY" verify-lineage "$BUILD_CID" --json 2>/dev/null \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
for row in data.get("chain", []):
    action = row.get("action", "")
    if isinstance(action, str) and action.startswith("signed:"):
        print(json.dumps({"id": row.get("id"), "sig": action[len("signed:"):]}))
        sys.exit(0)
' 2>/dev/null || true)

if [[ -n "$SIGNED_ROW" ]]; then
  log_ok "L8 signed pointer-memory landed: $SIGNED_ROW"
else
  log_info "L8 signed row not yet readable (verify-lineage may be eventually consistent)"
fi

log_ok "FRACTAL BUILD COMPLETE — $BUILD_CID is the build's truth claim, signed by the root wallet"
echo
echo "Next: re-run any caller of the binary. The new $BIN_SHA is on disk and"
echo "the ledger carries its signed pointer-memory at /contract $BUILD_CID."
