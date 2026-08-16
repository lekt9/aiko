#!/usr/bin/env bash
# Negative ownership witness: the retired Python FDE authority stores and root
# workflow control cannot return after their native Contract/Neuron/Smithers
# replacements have taken ownership. Cell/runCell remains the typed harness.
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
fail(){ printf 'FAIL no-duplicate-fde-primitives: %s\n' "$*" >&2; exit 1; }

obsolete=(
  cell/primitives/context-plane
  cell/primitives/credential-envelope
  cell/patterns/fde/credential-envelope.cell.yaml
  cell/adapters/authored
  cell/adapters/unbrowse
  cell/adapters/telethon
  cell/patterns/api-reveng/promote.cell.yaml
  src/workflow_binding.zig
  tests/credential-envelope-gate.sh
  tests/fde-context-gate.sh
  tests/unbrowse-aiko-gate.sh
  tests/fde-authoring-gate.sh
  tests/telethon-fde-gate.sh
  tests/fde-workflow-gate.sh
)
for path in "${obsolete[@]}"; do
  [ ! -e "$path" ] || fail "obsolete authority path restored: $path"
done

# Restoring either the old Zig import or either root authority command must make
# this witness red even if the deleted module itself is renamed.
if grep -Eq 'workflow_binding|bind-workflow|workflow-control' src/main.zig; then
  fail 'aiko-doctor re-exported retired root workflow authority'
fi

# Renaming a retired directory must not evade the ownership refusal. These are
# the durable schemas/imports used by the deleted Python authorities; none may
# be reintroduced anywhere in Cell or Smithers production source.
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
markers = (
    "aiko.credential-handle-contract/v1",
    "aiko.cited-context-lineage/v1",
    "aiko.durable-pause-resume/v1",
    "aiko.admitted-adapter-family/v1",
    "credential-envelope.cell.yaml",
    "context_plane.py",
    "telethon_vertical.py",
    "unbrowse_port.py",
)
for base in (root / "cell", root / "aiko-flow" / "packages"):
    for path in base.rglob("*"):
        if not path.is_file() or "node_modules" in path.parts or "tests" in path.parts:
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for marker in markers:
            if marker in text:
                raise SystemExit(f"obsolete durable authority marker restored: {path}: {marker}")
PY

# The replacements are concrete owners, not documentation promises.
required=(
  contract/libcontract/src/context_projection.zig
  aiko/crates/codegen/xai-grok-shell/src/auth/credential_handle.rs
  neuron/limbs/unbrowse/SKILL.md
  neuron/limbs/telethon/SKILL.md
  neuron/src/limb_ops.zig
  aiko-flow/packages/components/src/components/ContractCell.js
  aiko-flow/packages/components/src/components/Cell.js
  aiko-flow/packages/components/src/components/runCell.js
  aiko-flow/packages/components/tests/runCell.test.js
  aiko-flow/packages/components/tests/hoysanRunCell.test.js
  aiko-flow/packages/components/tests/contractCell.test.js
)
for path in "${required[@]}"; do
  [ -s "$path" ] || fail "native replacement or Smithers Cell harness missing: $path"
done

# Smoke the typed harness that this cleanup must never confuse with a duplicate
# authority store. ContractCell must compose it rather than replace it.
(
  cd aiko-flow
  AIKO_CELL_RUNNER="$ROOT/cell/run.py" bun test --timeout=30000 \
    packages/components/tests/runCell.test.js \
    packages/components/tests/hoysanRunCell.test.js \
    packages/components/tests/contractCell.test.js
)

printf '%s\n' 'no-duplicate-fde-primitives gate: PASS (obsolete authority absent; native owners present; Smithers Cell/runCell green)'
