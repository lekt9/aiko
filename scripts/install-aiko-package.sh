#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AIKO_BINARY="$PACKAGE_ROOT/bin/aiko"
CONTRACT_LIBRARY="$PACKAGE_ROOT/lib/libcontract.dylib"
MANIFEST="$PACKAGE_ROOT/manifest.json"
PACKAGED_SKILLS="$PACKAGE_ROOT/skills"

if [ ! -x "$AIKO_BINARY" ] || [ ! -f "$CONTRACT_LIBRARY" ] || [ ! -f "$MANIFEST" ] || \
   [ ! -d "$PACKAGED_SKILLS" ]; then
    echo "Invalid Aiko package: expected bin/aiko, lib/libcontract.dylib, manifest.json, and skills/" >&2
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

EXPECTED_ABI=10
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
mkdir -p "$AIKO_HOME/skills" "$AIKO_HOME/sdk/registry/bin"

BIN_TMP="$AIKO_BIN_DIR/.aiko.install.$$"
LIB_TMP="$AIKO_LIB_DIR/.libcontract.dylib.install.$$"
trap 'rm -f "$BIN_TMP" "$LIB_TMP"' EXIT HUP INT TERM

install -m 755 "$AIKO_BINARY" "$BIN_TMP"
install -m 755 "$CONTRACT_LIBRARY" "$LIB_TMP"
"$BIN_TMP" --version >/dev/null

mv -f "$LIB_TMP" "$AIKO_LIB_DIR/libcontract.dylib"
mv -f "$BIN_TMP" "$AIKO_BIN_DIR/aiko"
for SKILL_DIR in "$PACKAGED_SKILLS"/*; do
    if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/contract-skill.json" ]; then
        SKILL_NAME=$(basename "$SKILL_DIR")
        mkdir -p "$AIKO_HOME/skills/$SKILL_NAME"
        cp -R "$SKILL_DIR/." "$AIKO_HOME/skills/$SKILL_NAME/"
    fi
done
# SDK registry — self-bootstrapping installer for contract + neuron + limbs
PACKAGED_SDK="$PACKAGE_ROOT/sdk/registry"
if [ -d "$PACKAGED_SDK" ]; then
    cp -R "$PACKAGED_SDK/setup.sh" "$AIKO_HOME/sdk/registry/" 2>/dev/null || true
    cp -R "$PACKAGED_SDK/versions.lock" "$AIKO_HOME/sdk/registry/" 2>/dev/null || true
    if [ -d "$PACKAGED_SDK/bin" ]; then
        cp -R "$PACKAGED_SDK/bin/." "$AIKO_HOME/sdk/registry/bin/" 2>/dev/null || true
    fi
    echo "Installed Aiko SDK to $AIKO_HOME/sdk/registry/"
fi
trap - EXIT HUP INT TERM

echo "Installed Aiko to $AIKO_BIN_DIR/aiko"
echo "Installed Contract runtime to $AIKO_LIB_DIR/libcontract.dylib"

if [ "$(uname -s)" = "Darwin" ]; then
    LABEL="net.theclarityproject.aiko.contract-worker"
    LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
    PLIST="$LAUNCH_AGENTS/$LABEL.plist"
    LOG_DIR="$AIKO_HOME/logs"
    mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
    xml_escape() {
        printf '%s' "$1" | sed \
            -e 's/&/\\&amp;/g' \
            -e 's/</\\&lt;/g' \
            -e 's/>/\\&gt;/g' \
            -e 's/"/\\&quot;/g' \
            -e "s/'/\\&apos;/g"
    }
    BIN_XML=$(xml_escape "$AIKO_BIN_DIR/aiko")
    LIB_XML=$(xml_escape "$AIKO_LIB_DIR/libcontract.dylib")
    PATH_XML=$(xml_escape "${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}")
    LOG_XML=$(xml_escape "$LOG_DIR/contract-worker.log")
    PLIST_TMP="$LAUNCH_AGENTS/.$LABEL.plist.install.$$"
    trap 'rm -f "$PLIST_TMP"' EXIT HUP INT TERM
    {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
        printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        printf '%s\n' '<plist version="1.0"><dict>'
        printf '%s\n' '  <key>Label</key><string>net.theclarityproject.aiko.contract-worker</string>'
        printf '%s\n' '  <key>ProgramArguments</key><array>'
        printf '    <string>%s</string>\n' "$BIN_XML"
        printf '%s\n' '    <string>contract-worker</string>'
        printf '%s\n' '    <string>--poll-seconds</string><string>5</string>'
        printf '%s\n' '  </array>'
        printf '%s\n' '  <key>EnvironmentVariables</key><dict>'
        printf '    <key>AIKO_CONTRACT_LIBRARY</key><string>%s</string>\n' "$LIB_XML"
        printf '    <key>PATH</key><string>%s</string>\n' "$PATH_XML"
        printf '%s\n' '  </dict>'
        printf '%s\n' '  <key>RunAtLoad</key><true/>'
        printf '%s\n' '  <key>KeepAlive</key><true/>'
        printf '%s\n' '  <key>ThrottleInterval</key><integer>10</integer>'
        printf '%s\n' '  <key>ProcessType</key><string>Background</string>'
        printf '  <key>StandardOutPath</key><string>%s</string>\n' "$LOG_XML"
        printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$LOG_XML"
        printf '%s\n' '</dict></plist>'
    } > "$PLIST_TMP"
    plutil -lint "$PLIST_TMP" >/dev/null
    mv -f "$PLIST_TMP" "$PLIST"
    trap - EXIT HUP INT TERM
    DOMAIN="gui/$(id -u)"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Installed and started Contract background worker: $LABEL"
fi
