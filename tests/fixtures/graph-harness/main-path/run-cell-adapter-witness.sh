#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/aiko-cell-adapter-witness.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/src"
ln -s "$ROOT/aiko/crates/codegen/xai-grok-shell/src/contract_native/graph_harness_cell.rs" "$tmp/src/lib.rs"
cat >"$tmp/Cargo.toml" <<EOF
[package]
name = "aiko-cell-adapter-witness"
version = "0.1.0"
edition = "2024"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
thiserror = "2"
tempfile = "3"
tokio = { version = "1", features = ["process", "io-util", "time", "macros", "rt-multi-thread"] }
xai-grok-sandbox = { path = "$ROOT/aiko/crates/codegen/xai-grok-sandbox", default-features = false }
EOF
(cd "$tmp" && CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo test -q)
