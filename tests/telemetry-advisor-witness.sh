#!/usr/bin/env bash
# telemetry-advisor-witness.sh — R4: closed telemetry → policy-advisor loop.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo/zig-out/bin/neuron"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
state="$tmp/state"

# Build journaled state: admit + fire a limb to produce firings.
"$bin" limb admit "$repo/limbs/fanout" "$state" > /dev/null
python3 "$repo/tests/make-fan-stim.py" "$tmp/stim.json"
"$bin" limb run "$state" --package "$repo/limbs/fanout" --neuron fanout --stimulus "$tmp/stim.json" > /dev/null

# Project telemetry.
projection=$("$bin" telemetry project "$state" --json)
echo "projection: $projection"
echo "$projection" | python3 -c "
import json, sys
p = json.loads(sys.stdin.read())
assert p['schema'] == 'neuron.telemetry/v1'
assert p['committed'] >= 2, f'got {p[\"committed\"]}'
assert p['total'] == p['committed'] + p['rejected'] + p['cancelled']
assert p['neurons'] >= 2, f'fanout spawns create neuron records, got {p[\"neurons\"]}'
print('fields verified')
"

# Determinism: same state → identical projection.
p2=$("$bin" telemetry project "$state" --json)
[ "$projection" = "$p2" ] || { echo "non-deterministic projection"; exit 1; }
echo "determinism: identical projections"

# Read-only: projection does not mutate the substrate.
info_before=$("$bin" limb inspect "$state" --json)
"$bin" telemetry project "$state" > /dev/null
info_after=$("$bin" limb inspect "$state" --json)
[ "$info_before" = "$info_after" ] || { echo "telemetry projection mutated substrate"; exit 1; }
echo "read-only: substrate unchanged after projection"

echo "[telemetry-advisor] PASS — projection matches state, deterministic, read-only"
