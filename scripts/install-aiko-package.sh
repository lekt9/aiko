#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AIKO_BINARY="$PACKAGE_ROOT/bin/aiko"
CONTRACT_LIBRARY="$PACKAGE_ROOT/lib/libcontract.dylib"
MANIFEST="$PACKAGE_ROOT/manifest.json"

if [ ! -x "$AIKO_BINARY" ] || [ ! -f "$CONTRACT_LIBRARY" ] || [ ! -f "$MANIFEST" ]; then
    echo "Invalid Aiko package: expected bin/aiko, lib/libcontract.dylib, and manifest.json" >&2
    exit 1
fi

sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

manifest_value() {
    sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST" | head -1
}

manifest_number() {
    sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$MANIFEST" | head -1
}

EXPECTED_ABI=2
PACKAGE_ABI=$(manifest_number contract_abi)
EXPECTED_AIKO=$(manifest_value aiko_sha256)
EXPECTED_CONTRACT=$(manifest_value contract_sha256)
ACTUAL_AIKO=$(sha256_file "$AIKO_BINARY")
ACTUAL_CONTRACT=$(sha256_file "$CONTRACT_LIBRARY")

if [ "$PACKAGE_ABI" != "$EXPECTED_ABI" ]; then
    echo "Incompatible Contract ABI: package has ${PACKAGE_ABI:-none}, Aiko requires $EXPECTED_ABI" >&2
    exit 1
fi
if [ "$ACTUAL_AIKO" != "$EXPECTED_AIKO" ]; then
    echo "Aiko package checksum mismatch" >&2
    exit 1
fi
if [ "$ACTUAL_CONTRACT" != "$EXPECTED_CONTRACT" ]; then
    echo "Contract package checksum mismatch" >&2
    exit 1
fi

AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/bin"}
AIKO_LIB_DIR="$AIKO_HOME/lib"
mkdir -p "$AIKO_BIN_DIR" "$AIKO_LIB_DIR"

BIN_TMP="$AIKO_BIN_DIR/.aiko.install.$$"
LIB_TMP="$AIKO_LIB_DIR/.libcontract.dylib.install.$$"
trap 'rm -f "$BIN_TMP" "$LIB_TMP"' EXIT HUP INT TERM

install -m 755 "$AIKO_BINARY" "$BIN_TMP"
install -m 755 "$CONTRACT_LIBRARY" "$LIB_TMP"
"$BIN_TMP" --version >/dev/null

mv -f "$LIB_TMP" "$AIKO_LIB_DIR/libcontract.dylib"
mv -f "$BIN_TMP" "$AIKO_BIN_DIR/aiko"
trap - EXIT HUP INT TERM

echo "Installed Aiko to $AIKO_BIN_DIR/aiko"
echo "Installed Contract runtime to $AIKO_LIB_DIR/libcontract.dylib"
