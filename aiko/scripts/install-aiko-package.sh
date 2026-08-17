#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AIKO_BINARY="$PACKAGE_ROOT/bin/aiko"
CONTRACT_CLI_BINARY="$PACKAGE_ROOT/bin/contract"
MANIFEST="$PACKAGE_ROOT/manifest.json"
PACKAGED_SKILLS="$PACKAGE_ROOT/skills"

# Package lib name is platform-native (.dylib / .so / .dll). Runtime install
# keeps the same basename so Linux loaders that look for libcontract.so work.
CONTRACT_LIBRARY=""
for candidate in \
    "$PACKAGE_ROOT/lib/libcontract.so" \
    "$PACKAGE_ROOT/lib/libcontract.dylib" \
    "$PACKAGE_ROOT/lib/contract.dll" \
    "$PACKAGE_ROOT/lib/libcontract.dll"
do
    if [ -f "$candidate" ]; then
        CONTRACT_LIBRARY=$candidate
        break
    fi
done
CONTRACT_LIB_BASENAME=$(basename "${CONTRACT_LIBRARY:-}")

if [ ! -x "$AIKO_BINARY" ] || [ ! -x "$CONTRACT_CLI_BINARY" ] || \
   [ -z "$CONTRACT_LIBRARY" ] || [ ! -f "$MANIFEST" ] || [ ! -d "$PACKAGED_SKILLS" ]; then
    echo "Invalid Aiko package: expected bin/aiko, bin/contract, libcontract, manifest.json, and skills/" >&2
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

EXPECTED_ABI=13
PACKAGE_ABI=$(manifest_number contract_abi)
EXPECTED_AIKO=$(manifest_value aiko_sha256)
EXPECTED_CONTRACT=$(manifest_value contract_sha256)
EXPECTED_CONTRACT_CLI=$(manifest_value contract_cli_sha256)
ACTUAL_AIKO=$(sha256_file "$AIKO_BINARY")
ACTUAL_CONTRACT=$(sha256_file "$CONTRACT_LIBRARY")
ACTUAL_CONTRACT_CLI=$(sha256_file "$CONTRACT_CLI_BINARY")

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
if [ "$ACTUAL_CONTRACT_CLI" != "$EXPECTED_CONTRACT_CLI" ]; then
    echo "Contract CLI package checksum mismatch" >&2
    exit 1
fi

AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/.local/bin"}
AIKO_LIB_DIR="$AIKO_HOME/lib"
mkdir -p "$AIKO_BIN_DIR" "$AIKO_LIB_DIR"
mkdir -p "$AIKO_HOME/skills" "$AIKO_HOME/sdk/registry/bin"

BIN_TMP="$AIKO_BIN_DIR/.aiko.install.$$"
LIB_TMP="$AIKO_LIB_DIR/.${CONTRACT_LIB_BASENAME}.install.$$"
CLI_TMP="$AIKO_BIN_DIR/.contract.install.$$"
CLI_SIG_TMP="$CLI_TMP.sig"
trap 'rm -f "$BIN_TMP" "$LIB_TMP" "$CLI_TMP" "$CLI_SIG_TMP"' EXIT HUP INT TERM

install -m 755 "$AIKO_BINARY" "$BIN_TMP"
install -m 755 "$CONTRACT_LIBRARY" "$LIB_TMP"
"$BIN_TMP" --version >/dev/null
# Contract mutations are attested by the target machine's root, not the build
# machine's root. Sign and verify the staged bytes before atomic activation.
install -m 755 "$CONTRACT_CLI_BINARY" "$CLI_TMP"
"$CLI_TMP" sign-binary "$CLI_TMP" >/dev/null
"$CLI_TMP" verify-self | grep -q 'verify-self: OK' || {
    echo "Packaged contract CLI could not attest itself; refusing installation" >&2
    exit 1
}

mv -f "$LIB_TMP" "$AIKO_LIB_DIR/$CONTRACT_LIB_BASENAME"
# Keep a dual name so macOS-era tooling and Linux loaders both resolve.
case "$CONTRACT_LIB_BASENAME" in
    libcontract.so)
        ln -sfn libcontract.so "$AIKO_LIB_DIR/libcontract.dylib"
        ;;
    libcontract.dylib)
        if [ "$(uname -s)" = "Linux" ]; then
            ln -sfn libcontract.dylib "$AIKO_LIB_DIR/libcontract.so"
        fi
        ;;
esac
mv -f "$BIN_TMP" "$AIKO_BIN_DIR/aiko"
mv -f "$CLI_TMP" "$AIKO_BIN_DIR/contract"
rm -f "$AIKO_BIN_DIR/contract.sig"
mv -f "$CLI_SIG_TMP" "$AIKO_BIN_DIR/contract.sig"
"$AIKO_BIN_DIR/contract" verify-self | grep -q 'verify-self: OK' || {
    echo "Installed Contract CLI failed post-activation attestation" >&2
    exit 1
}
if [ -x "$PACKAGE_ROOT/contract-selfcheck.sh" ]; then
    "$PACKAGE_ROOT/contract-selfcheck.sh" "$AIKO_BIN_DIR/contract"
fi
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
echo "Installed Contract runtime to $AIKO_LIB_DIR/$CONTRACT_LIB_BASENAME"
if [ -x "$AIKO_BIN_DIR/contract" ]; then
    echo "Installed Contract CLI to $AIKO_BIN_DIR/contract"
fi

# Default: self-check that the install actually works, and write each smoke
# as a contract node into the postmortem graph ledger (~/.aiko/postmortem/).
# Skip with AIKO_SKIP_SELFCHECK=1. Soft-record (never fail install) with
# AIKO_SELFCHECK_SOFT=1.
SELFCHECK=""
for candidate in \
    "$PACKAGE_ROOT/selfcheck.sh" \
    "$PACKAGE_ROOT/../scripts/aiko-install-selfcheck.sh" \
    "$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)/scripts/aiko-install-selfcheck.sh"
do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        SELFCHECK=$candidate
        break
    fi
done
if [ -n "$SELFCHECK" ] && [ "${AIKO_SKIP_SELFCHECK:-0}" != "1" ]; then
    AIKO_BIN_DIR="$AIKO_BIN_DIR" AIKO_HOME="$AIKO_HOME" AIKO="$AIKO_BIN_DIR/aiko" \
        sh "$SELFCHECK" || {
            echo "Install self-check failed — binary is in place but not proven working." >&2
            echo "Re-run: AIKO_BIN_DIR=$AIKO_BIN_DIR sh $SELFCHECK" >&2
            echo "Skip (not recommended): AIKO_SKIP_SELFCHECK=1" >&2
            exit 1
        }
elif [ "${AIKO_SKIP_SELFCHECK:-0}" = "1" ]; then
    echo "Skipped install self-check (AIKO_SKIP_SELFCHECK=1)"
else
    echo "Warning: install self-check script not found next to package; install not proven." >&2
fi

# The launchd agent is machine-global: one label, one plist, pointed at
# whatever prefix installed last. An install into a NON-default prefix (a test
# run, a staging tree, a second checkout) therefore silently hijacks the real
# worker and repoints it at a directory that may be deleted minutes later —
# observed, not hypothetical. Register the agent only for a default-prefix
# install, and let anyone opt out explicitly.
SKIP_WORKER=0
if [ "${AIKO_SKIP_WORKER:-0}" = "1" ]; then
    SKIP_WORKER=1
    echo "Skipped Contract worker registration (AIKO_SKIP_WORKER=1)"
elif [ "$AIKO_BIN_DIR" != "$HOME/.local/bin" ] || [ "$AIKO_HOME" != "$HOME/.aiko" ]; then
    SKIP_WORKER=1
    echo "Skipped Contract worker registration: non-default prefix" \
         "(bin=$AIKO_BIN_DIR home=$AIKO_HOME) would hijack the machine-global agent." >&2
fi

if [ "$(uname -s)" = "Darwin" ] && [ "$SKIP_WORKER" = "0" ]; then
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
