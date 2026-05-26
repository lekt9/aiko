#!/usr/bin/env bash
# build-fractal.sh — substrate self-attesting build pipeline.
#
# Lewis 2026-05-27 redesign: no external LLM judge, no spirit-check
# gate, no retry-on-attest. The substrate signs ITSELF via the same
# parent_signature lineage primitive already used by /contract rows:
#
#   1. BUILD  — `zig build` compiles. Gated only by pattern.zig's
#               comptime invariants (which refuse the source if the
#               layer-pattern is broken). No runtime gate.
#   2. TEST   — `zig build test` exercises libcontract inline tests.
#   3. SIGN   — parent-sign the new binary into the ledger:
#               • if a previous binary exists (saved aside as
#                 `.previous-binary`): run `.previous-binary _sign-child
#                 <new-binary-path>`. The parent's wallet-derived
#                 keypair signs the new sha into an L8 row.
#               • else (first ever build): run `<new-binary>
#                 _bootstrap-self-sign`. The root wallet self-signs.
#                 This is single-use; subsequent builds MUST parent-sign.
#
# The runtime gate refuses to run any binary whose sha has no L8 row.
# Bootstrap is solved because this script lands the L8 row in step 3.
#
# Usage:
#   bash scripts/build-fractal.sh
#   bash scripts/build-fractal.sh --skip-test   # NOT RECOMMENDED

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIG_DIR="$REPO_ROOT/zig"
LIBCONTRACT_DIR="$REPO_ROOT/libcontract"
PREV_BINARY_PATH="$REPO_ROOT/.previous-binary"
NEW_BINARY_PATH="$ZIG_DIR/zig-out/bin/contract-zig-server"

SKIP_TEST=0
if [[ "${1:-}" == "--skip-test" ]]; then
  SKIP_TEST=1
fi

if [[ -t 1 ]]; then
  C_INFO="\033[1;36m"; C_OK="\033[1;32m"; C_FAIL="\033[1;31m"; C_RESET="\033[0m"
else
  C_INFO=""; C_OK=""; C_FAIL=""; C_RESET=""
fi
log_info() { printf "${C_INFO}» %s${C_RESET}\n" "$*"; }
log_ok()   { printf "${C_OK}✓ %s${C_RESET}\n"   "$*"; }
log_fail() { printf "${C_FAIL}✗ %s${C_RESET}\n" "$*"; }

# ─── Step 0: preflight ─────────────────────────────────────────────────
log_info "preflight: source tree present?"
[[ -d "$ZIG_DIR" ]]         || { log_fail "missing zig/";        exit 2; }
[[ -d "$LIBCONTRACT_DIR" ]] || { log_fail "missing libcontract/"; exit 2; }
[[ -f "$ZIG_DIR/build.zig" ]] || { log_fail "missing zig/build.zig"; exit 2; }
log_ok "source tree present"

# Save current binary as the parent BEFORE the rebuild overwrites it.
# This is what `_sign-child` will execute later to sign the new one.
if [[ -x "$NEW_BINARY_PATH" ]]; then
  cp "$NEW_BINARY_PATH" "$PREV_BINARY_PATH"
  chmod +x "$PREV_BINARY_PATH"
  log_info "saved current binary aside → .previous-binary (for parent-sign)"
fi

# ─── Step 1: BUILD ─────────────────────────────────────────────────────
log_info "BUILD — zig build (gated by pattern.zig comptime invariants)"
if ! ( cd "$ZIG_DIR" && zig build ); then
  log_fail "zig build failed — pattern violation or compile error"
  log_fail "  Read the zig build output above; fix the source and retry."
  exit 1
fi
log_ok "binary compiled"
[[ -x "$NEW_BINARY_PATH" ]] || { log_fail "$NEW_BINARY_PATH missing after build"; exit 1; }

# ─── Step 2: TEST ──────────────────────────────────────────────────────
if [[ "$SKIP_TEST" == "1" ]]; then
  log_info "TEST — SKIPPED (--skip-test); emergency rebuild only"
else
  log_info "TEST — zig build test (libcontract inline tests)"
  if ! ( cd "$LIBCONTRACT_DIR" && zig build test ); then
    log_fail "libcontract tests failed — runtime invariant broken"
    exit 1
  fi
  log_ok "tests pass"
fi

# Compute new binary's sha for log readability.
if command -v sha256sum >/dev/null 2>&1; then
  NEW_SHA="$(sha256sum "$NEW_BINARY_PATH" | awk '{print $1}')"
else
  NEW_SHA="$(shasum -a 256 "$NEW_BINARY_PATH" | awk '{print $1}')"
fi
log_info "new binary sha256: ${NEW_SHA:0:16}…"

# ─── Step 3: SIGN — parent-sign into the ledger ────────────────────────
# Two paths:
#   parent-sign  — `.previous-binary _sign-child <new>` (normal case)
#   bootstrap    — `<new> _bootstrap-self-sign` (very first build only)
log_info "SIGN — landing L8 signed:<sha> row in the ledger"
if [[ -x "$PREV_BINARY_PATH" ]]; then
  # Parent-sign. The previous binary still has its own L8 row from the
  # prior build, so it can use that as parent_id for the new row.
  if ( cd "$REPO_ROOT" && "$PREV_BINARY_PATH" _sign-child "$NEW_BINARY_PATH" ); then
    log_ok "new binary parent-signed by .previous-binary"
    rm -f "$PREV_BINARY_PATH"
  else
    # Transitional case: the saved-aside binary is from before this
    # pipeline existed (no L8 row of its own). Fall through to
    # bootstrap so the operator doesn't have to manually clean up.
    log_info ".previous-binary has no L8 row — falling through to bootstrap"
    rm -f "$PREV_BINARY_PATH"
    if ( cd "$REPO_ROOT" && "$NEW_BINARY_PATH" _bootstrap-self-sign ); then
      log_ok "root L8 row landed (bootstrap fallback)"
    else
      log_fail "bootstrap fallback also failed; inspect the ledger manually"
      exit 1
    fi
  fi
else
  # Bootstrap. First-ever build, OR the previous binary was deleted.
  log_info "no .previous-binary on disk — running _bootstrap-self-sign (first build path)"
  if ! ( cd "$REPO_ROOT" && "$NEW_BINARY_PATH" _bootstrap-self-sign ); then
    log_fail "_bootstrap-self-sign failed — likely an L8 row already exists for this sha"
    log_fail "  (which means a previous build already signed this exact binary content)."
    log_fail "  If you really want a fresh chain, delete the existing signed:<sha> rows"
    log_fail "  from the ledger and re-run."
    exit 1
  fi
  log_ok "root L8 row landed (chain rooted at root wallet)"
fi

log_ok "FRACTAL BUILD COMPLETE — binary is signed and runnable"
echo
echo "verify:    $NEW_BINARY_PATH verify-self"
echo "use:       $NEW_BINARY_PATH self --json"
