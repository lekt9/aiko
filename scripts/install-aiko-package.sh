#!/bin/sh
# Install one portable Aiko stack package (aiko + contract + optional neuron/limbs).
# Destinations (SSOT — scripts/lib/aiko-env.sh):
#   $AIKO_BIN_DIR/aiko      default ~/.local/bin/aiko
#   $AIKO_BIN_DIR/neuron    default ~/.local/bin/neuron
#   $AIKO_LIB_DIR/libcontract.{so,dylib}
#   $AIKO_HOME/limbs/
#   $AIKO_HOME/skills/
#   $AIKO_HOME/sdk/registry/
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AIKO_BINARY="$PACKAGE_ROOT/bin/aiko"
NEURON_BINARY=""
if [ -x "$PACKAGE_ROOT/bin/neuron" ]; then
    NEURON_BINARY="$PACKAGE_ROOT/bin/neuron"
fi
CONTRACT_LIBRARY=""
for _cand in \
    "$PACKAGE_ROOT/lib/libcontract.so" \
    "$PACKAGE_ROOT/lib/libcontract.dylib"; do
    if [ -f "$_cand" ] && [ ! -L "$_cand" ]; then
        CONTRACT_LIBRARY="$_cand"
        break
    fi
done
# Prefer real file; fall back to symlink target
if [ -z "$CONTRACT_LIBRARY" ]; then
    for _cand in \
        "$PACKAGE_ROOT/lib/libcontract.so" \
        "$PACKAGE_ROOT/lib/libcontract.dylib"; do
        if [ -f "$_cand" ]; then
            CONTRACT_LIBRARY="$_cand"
            break
        fi
    done
fi
MANIFEST="$PACKAGE_ROOT/manifest.json"
PACKAGED_SKILLS="$PACKAGE_ROOT/skills"
PACKAGED_LIMBS="$PACKAGE_ROOT/limbs"

if [ ! -x "$AIKO_BINARY" ] || [ -z "$CONTRACT_LIBRARY" ] || [ ! -f "$MANIFEST" ]; then
    echo "Invalid Aiko package: need bin/aiko, lib/libcontract.{so,dylib}, manifest.json" >&2
    exit 1
fi
# skills/ optional for bare stacks but preferred
if [ ! -d "$PACKAGED_SKILLS" ]; then
    mkdir -p "$PACKAGED_SKILLS"
fi

case "$(uname -s)" in
    Darwin) CONTRACT_INSTALL_NAME=libcontract.dylib ;;
    *)      CONTRACT_INSTALL_NAME=libcontract.so ;;
esac

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

MIN_ABI=2
PACKAGE_ABI=$(manifest_number contract_abi)
EXPECTED_AIKO=$(manifest_value aiko_sha256)
EXPECTED_CONTRACT=$(manifest_value contract_sha256)
EXPECTED_NEURON=$(manifest_value neuron_sha256)
ACTUAL_AIKO=$(sha256_file "$AIKO_BINARY")
ACTUAL_CONTRACT=$(sha256_file "$CONTRACT_LIBRARY")

if [ -z "$PACKAGE_ABI" ] || [ "$PACKAGE_ABI" -lt "$MIN_ABI" ]; then
    echo "Incompatible Contract ABI: package has ${PACKAGE_ABI:-none}, need >= $MIN_ABI" >&2
    exit 1
fi
if [ -n "$EXPECTED_AIKO" ] && [ "$ACTUAL_AIKO" != "$EXPECTED_AIKO" ]; then
    echo "Aiko package checksum mismatch" >&2
    exit 1
fi
if [ -n "$EXPECTED_CONTRACT" ] && [ "$ACTUAL_CONTRACT" != "$EXPECTED_CONTRACT" ]; then
    echo "Contract package checksum mismatch" >&2
    exit 1
fi
if [ -n "$NEURON_BINARY" ] && [ -n "$EXPECTED_NEURON" ]; then
    ACTUAL_NEURON=$(sha256_file "$NEURON_BINARY")
    if [ "$ACTUAL_NEURON" != "$EXPECTED_NEURON" ]; then
        echo "Neuron package checksum mismatch" >&2
        exit 1
    fi
fi

# Full-ABI gate: auto turn roots require declare_turn
if command -v nm >/dev/null 2>&1; then
    if ! nm -D "$CONTRACT_LIBRARY" 2>/dev/null | grep -q 'contract_declare_turn'; then
        echo "Contract library missing contract_declare_turn — refusing install (tools would hold)" >&2
        exit 1
    fi
    if ! nm -D "$CONTRACT_LIBRARY" 2>/dev/null | grep -q 'contract_abi_version'; then
        echo "Contract library missing contract_abi_version — refusing install" >&2
        exit 1
    fi
fi

# SSOT destinations
AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/.local/bin"}
AIKO_LIB_DIR=${AIKO_LIB_DIR:-"$AIKO_HOME/lib"}

mkdir -p "$AIKO_BIN_DIR" "$AIKO_LIB_DIR"
mkdir -p "$AIKO_HOME/skills" "$AIKO_HOME/sdk/registry/bin" "$AIKO_HOME/limbs"

case ":${PATH:-}:" in
    *:"$AIKO_BIN_DIR":*) ;;
    *)
        echo "Warning: $AIKO_BIN_DIR is not on PATH" >&2
        echo "  Add: export PATH=\"$AIKO_BIN_DIR:\$PATH\"" >&2
        ;;
esac

BIN_TMP="$AIKO_BIN_DIR/.aiko.install.$$"
NEURON_TMP="$AIKO_BIN_DIR/.neuron.install.$$"
LIB_TMP="$AIKO_LIB_DIR/.${CONTRACT_INSTALL_NAME}.install.$$"
trap 'rm -f "$BIN_TMP" "$NEURON_TMP" "$LIB_TMP"' EXIT HUP INT TERM

install -m 755 "$AIKO_BINARY" "$BIN_TMP"
install -m 755 "$CONTRACT_LIBRARY" "$LIB_TMP"
"$BIN_TMP" --version >/dev/null
if [ -n "$NEURON_BINARY" ]; then
    install -m 755 "$NEURON_BINARY" "$NEURON_TMP"
fi

mv -f "$LIB_TMP" "$AIKO_LIB_DIR/$CONTRACT_INSTALL_NAME"
if [ "$CONTRACT_INSTALL_NAME" = "libcontract.so" ]; then
    ln -sfn libcontract.so "$AIKO_LIB_DIR/libcontract.dylib"
elif [ "$CONTRACT_INSTALL_NAME" = "libcontract.dylib" ]; then
    ln -sfn libcontract.dylib "$AIKO_LIB_DIR/libcontract.so" 2>/dev/null || true
fi

rm -f "$AIKO_BIN_DIR/aiko"
mv -f "$BIN_TMP" "$AIKO_BIN_DIR/aiko"
if [ -n "$NEURON_BINARY" ] && [ -f "$NEURON_TMP" ]; then
    rm -f "$AIKO_BIN_DIR/neuron"
    mv -f "$NEURON_TMP" "$AIKO_BIN_DIR/neuron"
fi

# Shadows
for _shadow in "$HOME/bin/aiko" /usr/local/bin/aiko "$HOME/bin/neuron"; do
    if [ -e "$_shadow" ] || [ -L "$_shadow" ]; then
        case "$_shadow" in
            "$AIKO_BIN_DIR"/*) ;;
            *)
                echo "Removing shadow binary $_shadow (SSOT: $AIKO_BIN_DIR/)"
                rm -f "$_shadow"
                ;;
        esac
    fi
done

# Skills
for SKILL_DIR in "$PACKAGED_SKILLS"/*; do
    if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/contract-skill.json" ]; then
        SKILL_NAME=$(basename "$SKILL_DIR")
        mkdir -p "$AIKO_HOME/skills/$SKILL_NAME"
        cp -R "$SKILL_DIR/." "$AIKO_HOME/skills/$SKILL_NAME/"
    fi
done

# Limbs
if [ -d "$PACKAGED_LIMBS" ] && [ -n "$(ls -A "$PACKAGED_LIMBS" 2>/dev/null || true)" ]; then
    cp -R "$PACKAGED_LIMBS/." "$AIKO_HOME/limbs/"
    echo "Installed limbs to $AIKO_HOME/limbs/"
fi

# SDK registry
PACKAGED_SDK="$PACKAGE_ROOT/sdk/registry"
if [ -d "$PACKAGED_SDK" ]; then
    cp -R "$PACKAGED_SDK/setup.sh" "$AIKO_HOME/sdk/registry/" 2>/dev/null || true
    cp -R "$PACKAGED_SDK/versions.lock" "$AIKO_HOME/sdk/registry/" 2>/dev/null || true
    if [ -d "$PACKAGED_SDK/bin" ]; then
        cp -R "$PACKAGED_SDK/bin/." "$AIKO_HOME/sdk/registry/bin/" 2>/dev/null || true
    fi
    echo "Installed Aiko SDK to $AIKO_HOME/sdk/registry/"
fi
if [ -n "${AIKO_ROOT:-}" ] && [ -f "$AIKO_ROOT/sdk/registry/versions.lock" ]; then
    cp "$AIKO_ROOT/sdk/registry/versions.lock" "$AIKO_HOME/sdk/registry/versions.lock"
fi

trap - EXIT HUP INT TERM

echo "Installed Aiko stack:"
echo "  aiko     → $AIKO_BIN_DIR/aiko"
if [ -x "$AIKO_BIN_DIR/neuron" ]; then
    echo "  neuron   → $AIKO_BIN_DIR/neuron"
fi
echo "  contract → $AIKO_LIB_DIR/$CONTRACT_INSTALL_NAME (ABI ${PACKAGE_ABI})"
if [ -d "$AIKO_HOME/limbs" ]; then
    echo "  limbs    → $AIKO_HOME/limbs/ ($(ls -1 "$AIKO_HOME/limbs" 2>/dev/null | wc -l | tr -d ' ') entries)"
fi

export PATH="$AIKO_BIN_DIR:$PATH"
PATH_AIKO=$(command -v aiko 2>/dev/null || true)
if [ "$PATH_AIKO" = "$AIKO_BIN_DIR/aiko" ]; then
    echo "PATH resolves aiko → $PATH_AIKO (SSOT)"
    "$PATH_AIKO" --version 2>/dev/null || true
else
    echo "Warning: PATH resolves aiko → ${PATH_AIKO:-none} (expected $AIKO_BIN_DIR/aiko)" >&2
fi
if command -v neuron >/dev/null 2>&1; then
    echo "PATH resolves neuron → $(command -v neuron)"
fi

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
    LIB_XML=$(xml_escape "$AIKO_LIB_DIR/$CONTRACT_INSTALL_NAME")
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
