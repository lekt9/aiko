#!/usr/bin/env bash
# declare-openai-compat-mapping.sh — material­ize the openai-compat-
# mapping-v1 /contract into the ledger.
#
# Prerequisites: aiko-attest has run (spirit-attest ledger populated)
# AND `zig build` has produced the contract binary. The script then:
#
#   1. Declares the PARENT mapping /contract whose plan is the
#      docs/openai-compat-mapping-v1.md spec.
#   2. Declares one child /contract per rule R1..R8, each parented by
#      PARENT, with the action shape the wrapper consumes.
#   3. Writes ~/.contract-openai-mapping-ids.jsonl — one JSON line per
#      {rule, id} pair, plus a PARENT row. The contract-openai-api
#      sibling reads this file at startup.
#
# Idempotent: the substrate's inputs_hash_v2 cache means re-running on
# unchanged inputs returns the same ids.
#
# Usage:
#   bash scripts/declare-openai-compat-mapping.sh
#   bash scripts/declare-openai-compat-mapping.sh --out /custom/path.jsonl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="$REPO_ROOT/docs/openai-compat-mapping-v1.md"
DEFAULT_OUT="$HOME/.contract-openai-mapping-ids.jsonl"

OUT="$DEFAULT_OUT"
if [[ "${1:-}" == "--out" && -n "${2:-}" ]]; then
  OUT="$2"
fi

# Binary discovery — same order as the SDKs.
binary=""
if [[ -n "${CONTRACT_BINARY:-}" && -x "$CONTRACT_BINARY" ]]; then
  binary="$CONTRACT_BINARY"
elif command -v aiko >/dev/null 2>&1; then
  binary="$(command -v aiko)"
elif command -v contract >/dev/null 2>&1; then
  binary="$(command -v contract)"
elif [[ -x "$REPO_ROOT/scripts/contract" ]]; then
  binary="$REPO_ROOT/scripts/contract"
else
  echo "error: no aiko/contract binary reachable." >&2
  echo "  Run: cd $REPO_ROOT && bash scripts/build.sh" >&2
  echo "  (after running aiko-attest to populate the spirit ledger)" >&2
  exit 2
fi

echo "declare-openai-compat-mapping: binary=$binary"
echo "declare-openai-compat-mapping: spec=$SPEC"
echo "declare-openai-compat-mapping: out=$OUT"

if [[ ! -f "$SPEC" ]]; then
  echo "error: spec missing: $SPEC" >&2
  exit 2
fi

# 1. Declare the PARENT /contract. Plan is the spec text (truncated to
#    a reasonable size — full spec lives in the doc file).
PARENT_PLAN="openai-compat-mapping-v1: canonical translation from OpenAI Chat Completions wire shape to the /contract substrate. See $SPEC for the full text."
PARENT_ID="$("$binary" declare --plan "$PARENT_PLAN" --action "neuron:openai-compat-mapping" | head -n1 | tr -d '[:space:]')"
if [[ ! "$PARENT_ID" =~ ^[0-9a-f]{8}$ ]]; then
  echo "error: parent declare returned non-id output: '$PARENT_ID'" >&2
  exit 2
fi
echo "declare-openai-compat-mapping: PARENT=$PARENT_ID"

# 2. Each rule child. Plan + action chosen to match docs/openai-compat-
#    mapping-v1.md; the wrapper's mapping.ts reads the action shape at
#    startup so any future evolution = new child /contract.
declare_rule() {
  local rule="$1"
  local plan="$2"
  local action="$3"
  local id
  id="$("$binary" declare --plan "$plan" --action "$action" --parent "$PARENT_ID" | head -n1 | tr -d '[:space:]')"
  if [[ ! "$id" =~ ^[0-9a-f]{8}$ ]]; then
    echo "error: rule $rule declare returned non-id: '$id'" >&2
    exit 2
  fi
  echo "declare-openai-compat-mapping:   $rule=$id"
  printf '{"rule":"%s","id":"%s"}\n' "$rule" "$id" >> "$OUT.tmp"
}

# Truncate output and start fresh.
: > "$OUT.tmp"
printf '{"rule":"PARENT","id":"%s"}\n' "$PARENT_ID" >> "$OUT.tmp"

declare_rule "R1" \
  "R1: system message becomes the conversation root /contract. action=neuron:openai-session, plan=system content." \
  "neuron:openai-session"

declare_rule "R2" \
  "R2: user message becomes a declared child of the conversation root. action=neuron:user, plan=user content." \
  "neuron:user"

declare_rule "R3" \
  "R3: assistant text reply becomes an iterated row on the conversation root, NOT a new declared row. The conversation IS the truth claim; assistant turns iterate toward it." \
  "neuron:assistant"

declare_rule "R4" \
  "R4: assistant reasoning_content (thinking) lands as an evidence row on the conversation root." \
  "neuron:reasoning-evidence"

declare_rule "R5" \
  "R5: each tool_call becomes a declared child /contract of the conversation root. Action is resolved from the tool's published /contract; falls back to cli:<name> <args>." \
  "neuron:tool-call"

declare_rule "R6" \
  "R6: tool response message satisfies the tool-call /contract. Proof field carries the tool output." \
  "neuron:tool-response"

declare_rule "R7" \
  "R7: final assistant message (no tool_calls) marks the conversation root satisfied. The substrate's L7 validate + L8 signed cascade fires automatically." \
  "neuron:final-resolution"

declare_rule "R8" \
  "R8: tool catalog = every published /contract carrying tool_visibility:public. Without that synapse, published contracts are invisible to model tool-calling." \
  "neuron:tool-catalog"

mv "$OUT.tmp" "$OUT"
echo "declare-openai-compat-mapping: wrote $OUT"
echo
echo "Next: in the contract-openai-api sibling, point at $OUT (default already)."
echo "  cd ~/Projects/contract-openai-api && bun install && bun run start"
