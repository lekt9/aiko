#!/usr/bin/env bash
# Bidirectional neuron communication gate (§10 conversations).
#
# Binds the claim "each neuron communicates bidirectionally" to runnable
# proof at both boundaries:
#
#   - the Zig interpreter and pump (canonical runtime tests), and
#   - the external script-neuron protocol, through real admitted limbs
#     firing across separate processes against a durable substrate.
#
# The load-bearing claim is that a neuron with NO send capability can still
# answer a peer it was never configured with, because reply authority is
# conferred by possession of an attested request — while a script that
# bypasses the SDK to forge its own provenance is rejected at the valve.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== canonical runtime: conversation semantics =="
zig build test
echo "   zig build test: PASS"

echo
echo "== build the CLI the limb witness fires through =="
zig build
echo "   zig build: PASS"

echo
echo "== admitted script-neuron limbs hold a real conversation =="
python3 limbs/conversation/tests/conformance.py

echo
echo "conversation gate: PASS"
