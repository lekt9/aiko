#!/usr/bin/env bash
# roadmap-wave1-gate.sh — the pinned jesus-ralph witness for the 2026-07-27
# roadmap wave:
#   W1  journal compaction/GC — snapshot + truncate the A1 WAL with
#       retention-root preservation (§22); replay-from-snapshot must equal
#       replay-from-full-log, with fail-closed rejection paths.
#   W2  daemon availability — connection-per-connection concurrency with a
#       per-connection monotonic read/write deadline, so one slow-loris peer
#       cannot wedge every other peer (mirror of the B2 client bound).
#   W3  outbox-drainer generative-limb lifecycle — admit by digest → attach
#       with a narrow grant → operate → judge → revoke → detach → GC, with
#       honest duplicate-suppression/retry/dead-letter rows (§30, R1).
#
# Exits 0 only when every stage's runnable witness is green. File presence,
# prose, and document validators are not completion (reference/ROADMAP.md).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

echo "=== [wave1] zig test suite (W1 compaction + W2 slow-loris witnesses) ==="
zig build test

echo "=== [wave1] exe build (test build does not compile main.zig) ==="
zig build

echo "=== [wave1] W1 operator witness: CLI compaction round-trip ==="
bash tests/compact-witness.sh

echo "=== [wave1] W3 witness: outbox-drainer admitted-limb lifecycle ==="
python3 limbs/outbox-drainer/tests/lifecycle.py

echo "=== [wave1] runtime gate (regression: mesh, tailnet, MCP, meta-agent) ==="
bash tests/runtime-gate.sh

echo "=== [wave1] document + jespa + neuron gate ==="
bash tests/gate.sh

echo "=== ROADMAP WAVE1 OK ==="
