#!/usr/bin/env bash
# Aggregate witness for entrypoint plan Phases 3-7 (§14 of
# reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md).
#
# Each phase settles only through its own named runnable gate. This script does
# not prove anything itself: it asserts every phase gate exists and runs them in
# dependency order. A missing gate is an unbuilt phase and fails honestly —
# there is no partial credit for source that exists without a witness.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

gates=(
    "tests/remote-interface-chain-gate.sh"          # Phase 3
    "tests/model-device-human-interface-gate.sh"    # Phase 4
    "tests/paid-interface-gate.sh"                  # Phase 5
    "tests/interface-morphogenesis-gate.sh"         # Phase 6
    "tests/multi-machine-agent-gate.sh"             # Phase 7
)

missing=0
for gate in "${gates[@]}"; do
    if [ ! -f "$gate" ]; then
        echo "[phases] UNBUILT: $gate" >&2
        missing=$((missing + 1))
    fi
done
if [ "$missing" -ne 0 ]; then
    echo "[phases] FAIL — $missing of ${#gates[@]} phase witnesses do not exist yet" >&2
    exit 1
fi

for gate in "${gates[@]}"; do
    echo "=== $gate ==="
    bash "$gate"
done

echo "[phases] PASS — plan Phases 3-7 are each witnessed by their own gate"
