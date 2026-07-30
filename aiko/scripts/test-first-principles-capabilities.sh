#!/usr/bin/env bash
# End-to-end capability gate for docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md.
# Runs the strongest safe witness for every capability the document marks
# Wired, plus a mutation test proving that the documentation guard can go red.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_ROOT="$(cd "$ROOT/../contract" 2>/dev/null && pwd || true)"
DOC="$ROOT/docs/PHOTON-POSITRON-FIRST-PRINCIPLES.md"
PASS=0

run() {
  local label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  "$@"
  PASS=$((PASS + 1))
  printf 'PASS  %s\n' "$label"
}

if [[ -z "${CONTRACT_ROOT:-}" || ! -d "$CONTRACT_ROOT/libcontract" ]]; then
  printf 'FAIL  sibling Contract checkout with libcontract is required\n' >&2
  exit 1
fi

run "law map + Aiko bridge + upstream source witness" \
  bash "$ROOT/scripts/witness-first-principles.sh"

run "resident tick/lease/worker surface" \
  bash "$ROOT/scripts/witness-plan3-resident.sh"

run "Contract kernel behavior (terminal, EBM, DAG, gate, reflex, lease, compact)" \
  sh -c 'cd "$1/libcontract" && zig build test --summary all' sh "$CONTRACT_ROOT"

run "Aiko contract-native behavior (bounds, privacy, prompt identity, routing)" \
  cargo test --manifest-path "$ROOT/Cargo.toml" \
    -p xai-grok-shell contract_native::tests --

# Falsifier: delete a mandatory section in an isolated copy. The structural
# witness must reject it. This does not touch the working document or ledger.
MUTATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aiko-first-principles.XXXXXX")"
trap 'rm -rf "$MUTATION_DIR"' EXIT
MUTANT="$MUTATION_DIR/PHOTON-POSITRON-FIRST-PRINCIPLES.md"
sed '/^## 3\. Antiparticle catalog$/d' "$DOC" >"$MUTANT"
printf '\n=== mutation falsifier (missing antiparticle catalog must fail) ===\n'
if FIRST_PRINCIPLES_DOC="$MUTANT" \
  bash "$ROOT/scripts/witness-first-principles.sh" >"$MUTATION_DIR/output" 2>&1; then
  printf 'FAIL  mutated law map incorrectly passed\n' >&2
  cat "$MUTATION_DIR/output" >&2
  exit 1
fi
if ! rg -q 'FAIL  antiparticle catalog' "$MUTATION_DIR/output"; then
  printf 'FAIL  mutation failed for an unrelated reason\n' >&2
  cat "$MUTATION_DIR/output" >&2
  exit 1
fi
PASS=$((PASS + 1))
printf 'PASS  mutation falsifier rejected missing antiparticle catalog\n'

printf '\nALL PASS — %d first-principles capability layers witnessed\n' "$PASS"
