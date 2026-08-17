#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
work="${TMPDIR:-/tmp}/aiko-graph-harness-core-witness"
rm -rf "$work"
mkdir -p "$work/src"
python3 - "$repo" "$work/src/lib.rs" <<'PY'
from pathlib import Path
import sys
repo, output = map(Path, sys.argv[1:])
source = (repo / "aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness.rs").read_text()
old = 'Path::new(env!("CARGO_MANIFEST_DIR"))\n            .join("../../../../tests/fixtures/graph-harness/main-path")'
source = source.replace(old, f'Path::new("{repo}/tests/fixtures/graph-harness/main-path")')
Path(output).write_text(source)
PY
cat >"$work/Cargo.toml" <<'EOF'
[package]
name = "aiko-graph-harness-core-witness"
version = "0.1.0"
edition = "2024"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
sha2 = "0.10"
thiserror = "2"
tempfile = "3"
ed25519-dalek = "2.2"
EOF
AIKO_GRAPH_HARNESS_FIXTURES="$repo/tests/fixtures/graph-harness/main-path" \
AIKO_EMBEDDED_CORE_MANIFEST="$repo/aiko/.agents/skills/aiko-meta-agent/contract-skill.json" \
cargo test --manifest-path "$work/Cargo.toml"
rustfmt --edition 2024 --check "$repo/aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness.rs"
python3 -m json.tool "$repo/schemas/aiko-workflow-route-v1.schema.json" >/dev/null
for fixture in "$repo"/tests/fixtures/graph-harness/main-path/*.json; do
  python3 -m json.tool "$fixture" >/dev/null
done
