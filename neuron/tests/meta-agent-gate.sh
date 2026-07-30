#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$repo"
zig fmt --check build.zig src
zig build test
zig build

(
  cd "$tmp"
  "$repo/zig-out/bin/neuron" meta-agent-check --json > witness.json
)

python3 - "$tmp/witness.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
result = json.loads(path.read_text())
assert result["status"] == "ok"
assert result["admitted_without_authority"] is True
assert result["normalized_and_planned"] is True
assert result["parallel_workers"] == 2
assert result["join_settled"] is True
assert result["false_proposal_rejected"] is True
assert result["recovery_rerouted"] is True
assert result["generated_limb_attached"] is True
assert result["original_work_succeeded"] is True
assert result["duplicate_effects_skipped"] == 2
assert result["stale_cas_rejected"] is True
assert result["replayed_firings"] == result["committed_firings"]
assert result["replayed_firings"] >= 16
assert result["limb_revoked"] is True
assert result["artifacts_collected"] > 0
assert result["audit_roots_readable"] is True
for field in ("package_digest", "final_snapshot_digest", "trace_digest"):
    assert len(result[field]) == 64
    int(result[field], 16)
PY

mkdir -p "$repo/zig-out"
install -m 600 "$tmp/witness.json" "$repo/zig-out/meta-agent-witness.json"
echo "[meta-agent] PASS — empty-substrate composition, recovery, generation, replay, rollback, and retirement are green"
