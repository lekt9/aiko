#!/usr/bin/env bash
# build.sh — substrate-faithful executor of the build-pipeline contract.
#
# This script is NOT a monolith. Each step below is a named function that
# is the local executor of a declared contract neuron on the ledger. The
# pipeline order is itself the parent contract; build.sh just walks the
# children. Refactored to resolve antipattern:build-sh-multi-responsibility.
#
# Each step's contract declaration (canonical id slugs):
#
#   build:guard      — scripts/ folder matches ALLOWLIST.txt
#   build:fmt        — Zig source is fmt-clean
#   build:tests      — libcontract unit tests pass (pointer, lineage,
#                      env_fingerprint, verses)
#   build:compile    — zig build produces the aiko + contract binaries
#   build:install    — built binaries are installed into scripts/
#   build:sign       — installed binaries are signed by the wallet
#                      (deployer.key → HKDF binary-signing key) via the
#                      `contract` wallet-tool's sign-binary verb
#   build:verify     — binaries self-attest against their .sig sidecars
#
# Without the sign step's signature, aiko's --remote path refuses to run
# (the integrity gate). Sign or stay local.
#
# Each step exits non-zero on failure; the parent contract holds.

set -euo pipefail

REPO="${REPO:-$HOME/.agent-skills/contract}"
SCRIPTS_DIR="$REPO/scripts"
ZIG_DIR="$REPO/zig"
LIB_DIR="$REPO/libcontract"
ALLOWLIST_FILE="$REPO/ALLOWLIST.txt"
CACHE="/tmp/contract-zig-cache"
GCACHE="/tmp/contract-zig-global-cache"

step() { printf '\n=== %s ===\n' "$*"; }

# ─── build:guard — doctrine-as-data folder allowlist ─────────────────
step_guard() {
  step "build:guard — scripts/ allowlist"
  if [[ ! -f "$ALLOWLIST_FILE" ]]; then
    echo "build:guard FAIL — missing $ALLOWLIST_FILE" >&2
    echo "  fix: restore the doctrine file (declares the canonical scripts/ set)" >&2
    return 9
  fi
  local expected actual
  expected="$(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE" | sort | tr '\n' ' ' | sed 's/ $//')"
  actual="$(cd "$SCRIPTS_DIR" && ls | sort | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$actual" != "$expected" ]]; then
    echo "build:guard FAIL — scripts/ folder drift detected vs $ALLOWLIST_FILE" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    diff <(echo "$expected" | tr ' ' '\n') <(echo "$actual" | tr ' ' '\n') >&2 | sed 's/^/    /'
    echo "  fix: delete the non-canonical files OR amend ALLOWLIST.txt + re-declare guard:scripts-allowlist-canonical" >&2
    return 9
  fi
}

# ─── build:fmt — Zig source is fmt-clean ─────────────────────────────
step_fmt() {
  step "build:fmt — zig fmt"
  ( cd "$LIB_DIR" && zig fmt src/*.zig >/dev/null )
  ( cd "$ZIG_DIR" && zig fmt src/*.zig >/dev/null )
}

# ─── build:tests — libcontract unit tests pass ───────────────────────
step_tests() {
  step "build:tests — libcontract"
  local t
  for t in pointer lineage env_fingerprint verses; do
    ( cd "$LIB_DIR" && zig test "src/$t.zig" --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
  done
}

# ─── build:compile — produce the binaries ────────────────────────────
step_compile() {
  step "build:compile — zig build"
  ( cd "$ZIG_DIR" && zig build --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
}

# ─── build:install — installed binaries land in scripts/ ─────────────
step_install() {
  step "build:install — install -m 755"
  install -m 755 "$ZIG_DIR/zig-out/bin/aiko"         "$SCRIPTS_DIR/aiko"
  install -m 755 "$ZIG_DIR/zig-out/bin/contract-zig" "$SCRIPTS_DIR/contract"
}

# ─── build:sign — wallet signs each binary's SHA-256 ─────────────────
# The actual ed25519 signing is the wallet operation: deployer.key (root
# seed → HKDF-derived binary-signing key via libcontract.Lineage) signs
# the binary's SHA-256 and writes <binary>.sig. The `contract` binary is
# the surface where that wallet capability is reachable to build.sh —
# `contract sign-binary <path>` ≡ "wallet, sign this binary".
step_sign() {
  step "build:sign — wallet signs"
  "$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/aiko"
  "$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/contract"
}

# ─── build:verify — binaries self-attest ─────────────────────────────
step_verify() {
  step "build:verify — self-attest"
  "$SCRIPTS_DIR/contract" verify-self
  "$SCRIPTS_DIR/contract" verify-binary "$SCRIPTS_DIR/aiko"
}

# ─── pipeline driver ─────────────────────────────────────────────────
# The pipeline order IS the parent contract. Each step holds the chain on
# its own failure (set -e). Adding/removing a step = editing this driver
# AND re-declaring the matching build:<step> contract on the ledger.
main() {
  step_guard
  step_fmt
  step_tests
  step_compile
  step_install
  step_sign
  step_verify
  printf '\nbuild.sh: done — substrate is fresh, signed, attested.\n'
}

main "$@"
