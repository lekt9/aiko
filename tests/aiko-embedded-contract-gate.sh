#!/usr/bin/env bash
# aiko-embedded-contract-gate — the shipped host carries its own Contract runtime.
#
# The gbear failure mode: a new aiko binary paired with a stale ~/.aiko/lib
# libcontract, on a seat with no Zig toolchain to rebuild one. The fix is
# packaging, not discovery: the release binary embeds the dylib it was built
# against, extracts it to a content-addressed path, and dlopens that before
# consulting any installed helper. Contract and the neuron ABI surface
# (contract_neuron_fire_json lives in the same dylib) then ship inside the one
# aiko binary; nothing on the seat can skew them.
#
# Two layers of witness:
#   1. wiring anchors — the embed exists in build.rs, wins the candidate order
#      in contract_native.rs, and the packaging pipeline feeds it. Removing
#      any of the three turns this red (contract-library-pin-gate style).
#   2. mechanism, end to end — a standalone crate embeds the real dylib,
#      extracts it under a scratch HOME exactly as the host does (digest dir,
#      staging rename), dlopens it, and reads contract_abi_version. This is
#      byte-level proof the platform allows extract-then-dlopen, not prose.
#
# Falsifier: drop the `#[cfg(bundle_contract)]` push from candidates(), or
# stop exporting AIKO_EMBED_CONTRACT_LIB in contract-runtime.sh — red.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/aiko/crates/codegen/xai-grok-shell/src/contract_native.rs"
BUILD_RS="$ROOT/aiko/crates/codegen/xai-grok-shell/build.rs"
RUNTIME_SH="$ROOT/aiko/scripts/contract-runtime.sh"

fail() { echo "FAIL aiko-embedded-contract: $*" >&2; exit 1; }

[ -f "$SRC" ] || fail "missing $SRC"
[ -f "$BUILD_RS" ] || fail "missing $BUILD_RS"
[ -f "$RUNTIME_SH" ] || fail "missing $RUNTIME_SH"

# --- 1. wiring anchors -------------------------------------------------------

grep -q 'fn embed_contract_library' "$BUILD_RS" || fail "build.rs lost the embed step"
grep -q 'AIKO_EMBED_CONTRACT_LIB' "$BUILD_RS" || fail "build.rs does not honour the pipeline's dylib pin"
grep -q 'names a missing file' "$BUILD_RS" || fail "an explicit embed pin no longer fails closed when the dylib is missing"

grep -q 'EMBEDDED_CONTRACT_LIBRARY' "$SRC" || fail "host no longer carries the embedded runtime bytes"
grep -q 'fn embedded_library' "$SRC" || fail "host lost the extraction path"

grep -q 'AIKO_EMBED_CONTRACT_LIB="\$CONTRACT_DYLIB"' "$RUNTIME_SH" || fail "packaging pipeline no longer embeds the dylib it just built"

# The embedded runtime must outrank every installed copy but never override
# an explicit operator pin. Positional, not just present.
python3 - "$SRC" <<'PY'
import sys

src = open(sys.argv[1]).read()
body = src.split("fn candidates()", 1)
assert len(body) == 2, "candidates() missing"
body = body[1]
pin = body.find("return vec![path]")
embedded = body.find("Self::embedded_library()")
installed = body.find('join("../lib")')
assert pin != -1 and embedded != -1 and installed != -1, "candidate order anchors missing"
assert pin < embedded, "embedded runtime overrides the explicit AIKO_CONTRACT_LIBRARY pin"
assert embedded < installed, "installed helpers outrank the embedded runtime — the skew is back"
print("ok: pin > embedded > installed order holds")
PY

# --- 2. the mechanism, end to end -------------------------------------------

(cd "$ROOT/contract/libcontract" && zig build) || fail "libcontract build failed"
DYLIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.dylib"
[ -f "$DYLIB" ] || DYLIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.so"
[ -f "$DYLIB" ] || fail "no libcontract dylib produced"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/witness/src" "$WORK/home"
LIB_BASENAME="$(basename "$DYLIB")"

cat > "$WORK/witness/Cargo.toml" <<'EOF'
[package]
name = "embedded-contract-witness"
version = "0.0.0"
edition = "2021"

[dependencies]
libloading = "0.8"
sha2 = "0.10"

[profile.dev]
debug = false
EOF

cat > "$WORK/witness/src/main.rs" <<EOF
// Mirrors NativeContract::embedded_library: content-addressed dir, staged
// write, rename, dlopen, ABI read. If this fails here it fails in the host.
static EMBEDDED: &[u8] = include_bytes!("$DYLIB");

fn main() {
    use sha2::Digest;
    let digest = format!("{:x}", sha2::Sha256::digest(EMBEDDED));
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
    let dir = home.join(".aiko/lib/embedded").join(&digest[..16]);
    let path = dir.join("$LIB_BASENAME");
    let reused = path.is_file();
    if !reused {
        std::fs::create_dir_all(&dir).unwrap();
        let staging = dir.join(format!(".extract-{}", std::process::id()));
        std::fs::write(&staging, EMBEDDED).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::rename(&staging, &path).unwrap();
    }
    let library = unsafe { libloading::Library::new(&path) }.expect("dlopen extracted runtime");
    let abi: libloading::Symbol<unsafe extern "C" fn() -> u32> =
        unsafe { library.get(b"contract_abi_version\0") }.expect("contract_abi_version symbol");
    let neuron = unsafe { library.get::<unsafe extern "C" fn() -> u32>(b"contract_abi_version\0") }.is_ok();
    let fire = unsafe {
        library.get::<*const std::ffi::c_void>(b"contract_neuron_fire_json\0")
    }
    .is_ok();
    println!(
        "abi={} reused={} neuron_symbol={} fire_symbol={}",
        unsafe { abi() },
        reused,
        neuron,
        fire
    );
}
EOF

(cd "$WORK/witness" && cargo build -q) || fail "witness crate did not build"
WITNESS="$WORK/witness/target/debug/embedded-contract-witness"

FIRST="$(HOME="$WORK/home" "$WITNESS")" || fail "first extraction run failed"
SECOND="$(HOME="$WORK/home" "$WITNESS")" || fail "second run failed"
echo "first:  $FIRST"
echo "second: $SECOND"

case "$FIRST" in
    *"reused=false"*) : ;;
    *) fail "first run claims reuse in an empty HOME" ;;
esac
case "$SECOND" in
    *"reused=true"*) : ;;
    *) fail "extraction is not idempotent — second run re-extracted" ;;
esac
case "$FIRST" in
    *"fire_symbol=true"*) : ;;
    *) fail "embedded runtime lacks contract_neuron_fire_json — the neuron surface did not ship" ;;
esac

ABI="$(printf '%s' "$FIRST" | sed -n 's/^abi=\([0-9]*\).*/\1/p')"
[ -n "$ABI" ] || fail "witness did not report an ABI"
[ "$ABI" -ge 13 ] || fail "embedded runtime reports ABI $ABI < 13"

# No stray staging files: a crashed extraction must not leave dlopenable bytes.
LEFTOVER="$(find "$WORK/home/.aiko/lib/embedded" -name '.extract-*' | wc -l | tr -d ' ')"
[ "$LEFTOVER" = "0" ] || fail "staging residue left behind: $LEFTOVER file(s)"

echo "PASS aiko-embedded-contract-gate (abi=$ABI)"
