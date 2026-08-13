#!/bin/sh
# Install one portable Aiko stack package (required Aiko + Neuron + Contract + Cell).
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
NEURON_BINARY="$PACKAGE_ROOT/bin/neuron"
CELL_LAUNCHER="$PACKAGE_ROOT/bin/cell"
CELL_RUNTIME="$PACKAGE_ROOT/share/cell"
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

if [ ! -x "$AIKO_BINARY" ] || [ ! -x "$NEURON_BINARY" ] || [ ! -x "$CELL_LAUNCHER" ] ||    [ -z "$CONTRACT_LIBRARY" ] || [ ! -f "$MANIFEST" ] ||    [ ! -f "$CELL_RUNTIME/run.py" ] || [ ! -f "$CELL_RUNTIME/helpers.py" ] ||    [ ! -f "$CELL_RUNTIME/SKILL.md" ] || [ ! -f "$CELL_RUNTIME/vendor/yaml/__init__.py" ] || [ ! -d "$PACKAGED_LIMBS" ]; then
    echo "Invalid Aiko package: Aiko, Contract, Neuron, Cell (with vendored PyYAML), and limbs are mandatory" >&2
    exit 1
fi
for _dir in primitives patterns schemas system; do
    [ -d "$CELL_RUNTIME/$_dir" ] || { echo "Invalid Aiko package: missing share/cell/$_dir" >&2; exit 1; }
done
for _component in aiko contract neuron cell limbs; do
    grep -Eq '"'"$_component"'"[[:space:]]*:[[:space:]]*true' "$MANIFEST" || {
        echo "Invalid Aiko package: manifest component $_component is not true" >&2; exit 1;
    }
done
[ -d "$PACKAGED_SKILLS" ] || { echo "Invalid Aiko package: skills directory missing" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Aiko portable stack requires Python 3" >&2; exit 1; }

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

tree_sha256() {
    python3 - "$1" <<'PY'
import hashlib, os, pathlib, sys
root = pathlib.Path(sys.argv[1]); h = hashlib.sha256()
for path in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
    rel = path.relative_to(root).as_posix().encode()
    if path.is_symlink(): kind, payload = b"L", os.readlink(path).encode()
    elif path.is_file(): kind, payload = b"F", path.read_bytes()
    else: continue
    h.update(kind + b"\0" + rel + b"\0" + payload + b"\0")
print(h.hexdigest())
PY
}

host_platform() {
    case "$(uname -s):$(uname -m)" in
        Linux:x86_64|Linux:amd64) echo linux-x86_64 ;;
        Linux:aarch64|Linux:arm64) echo linux-aarch64 ;;
        Darwin:x86_64|Darwin:amd64) echo macos-x86_64 ;;
        Darwin:arm64|Darwin:aarch64) echo macos-aarch64 ;;
        *) echo "Unsupported install host: $(uname -s) $(uname -m)" >&2; return 1 ;;
    esac
}

manifest_value() {
    sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST" | head -1
}

manifest_number() {
    sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$MANIFEST" | head -1
}

manifest_bool() {
    sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' "$MANIFEST" | head -1
}


MIN_ABI=2
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for Cell and Contract ABI verification" >&2; exit 1; }
PACKAGE_ABI=$(manifest_number contract_abi)
PACKAGE_PLATFORM=$(manifest_value platform)
EXPECTED_AIKO=$(manifest_value aiko_sha256)
EXPECTED_CONTRACT=$(manifest_value contract_sha256)
EXPECTED_NEURON=$(manifest_value neuron_sha256)
EXPECTED_CELL=$(manifest_value cell_sha256)
EXPECTED_CELL_LAUNCHER=$(manifest_value cell_launcher_sha256)
EXPECTED_CELL_RUNTIME=$(manifest_value cell_runtime_sha256)
EXPECTED_LIMBS=$(manifest_value limbs_sha256)

[ "$PACKAGE_PLATFORM" = "$(host_platform)" ] || {
    echo "Wrong Aiko package platform: ${PACKAGE_PLATFORM:-none}; host is $(host_platform)" >&2; exit 1;
}
[ -n "$PACKAGE_ABI" ] && [ "$PACKAGE_ABI" -ge "$MIN_ABI" ] || {
    echo "Incompatible Contract ABI: package has ${PACKAGE_ABI:-none}, need >= $MIN_ABI" >&2; exit 1;
}
for _expected in "$EXPECTED_AIKO" "$EXPECTED_CONTRACT" "$EXPECTED_NEURON" "$EXPECTED_CELL" "$EXPECTED_CELL_LAUNCHER" "$EXPECTED_CELL_RUNTIME" "$EXPECTED_LIMBS"; do
    [ -n "$_expected" ] || { echo "Invalid Aiko package: a mandatory hash is absent" >&2; exit 1; }
done
[ "$(sha256_file "$AIKO_BINARY")" = "$EXPECTED_AIKO" ] || { echo "Aiko package checksum mismatch" >&2; exit 1; }
[ "$(sha256_file "$CONTRACT_LIBRARY")" = "$EXPECTED_CONTRACT" ] || { echo "Contract package checksum mismatch" >&2; exit 1; }
[ "$(sha256_file "$NEURON_BINARY")" = "$EXPECTED_NEURON" ] || { echo "Neuron package checksum mismatch" >&2; exit 1; }
[ "$(sha256_file "$CELL_RUNTIME/run.py")" = "$EXPECTED_CELL" ] || { echo "Cell entrypoint checksum mismatch" >&2; exit 1; }
[ "$(sha256_file "$CELL_LAUNCHER")" = "$EXPECTED_CELL_LAUNCHER" ] || { echo "Cell launcher checksum mismatch" >&2; exit 1; }
[ "$(tree_sha256 "$CELL_RUNTIME")" = "$EXPECTED_CELL_RUNTIME" ] || { echo "Cell runtime checksum mismatch" >&2; exit 1; }
[ "$(tree_sha256 "$PACKAGED_LIMBS")" = "$EXPECTED_LIMBS" ] || { echo "Neuron limbs checksum mismatch" >&2; exit 1; }

# Load the library exactly as the host will. Unlike nm -D this works on Linux
# and macOS and proves callable ABI rather than merely symbol-table spelling.
PROBED_ABI=$(python3 - "$CONTRACT_LIBRARY" <<'PY'
import ctypes, sys
lib = ctypes.CDLL(sys.argv[1])
for symbol in ("contract_abi_version", "contract_declare_turn"):
    if not hasattr(lib, symbol): raise SystemExit("Contract library missing " + symbol)
lib.contract_abi_version.restype = ctypes.c_uint
print(int(lib.contract_abi_version()))
PY
) || { echo "Contract ABI load probe failed" >&2; exit 1; }
[ "$PROBED_ABI" = "$PACKAGE_ABI" ] || {
    echo "Contract ABI mismatch: manifest $PACKAGE_ABI, library $PROBED_ABI" >&2; exit 1;
}

# SSOT destinations
AIKO_HOME=${AIKO_HOME:-"$HOME/.aiko"}
AIKO_BIN_DIR=${AIKO_BIN_DIR:-"$HOME/.local/bin"}
AIKO_LIB_DIR=${AIKO_LIB_DIR:-"$AIKO_HOME/lib"}

mkdir -p "$AIKO_BIN_DIR" "$AIKO_LIB_DIR"
mkdir -p "$AIKO_HOME/skills" "$AIKO_HOME/sdk/registry/bin" "$AIKO_HOME/limbs" "$AIKO_HOME/cell"

case ":${PATH:-}:" in
    *:"$AIKO_BIN_DIR":*) ;;
    *)
        echo "Warning: $AIKO_BIN_DIR is not on PATH" >&2
        echo "  Add: export PATH=\"$AIKO_BIN_DIR:\$PATH\"" >&2
        ;;
esac

BIN_TMP="$AIKO_BIN_DIR/.aiko.install.$$"
NEURON_TMP="$AIKO_BIN_DIR/.neuron.install.$$"
CELL_TMP="$AIKO_BIN_DIR/.cell.install.$$"
DOCTOR_TMP=""
LIB_TMP="$AIKO_LIB_DIR/.${CONTRACT_INSTALL_NAME}.install.$$"
CELL_RUNTIME_TMP="$AIKO_HOME/.cell.install.$$"
trap 'rm -rf "$BIN_TMP" "$NEURON_TMP" "$CELL_TMP" "$LIB_TMP" "$CELL_RUNTIME_TMP" ${DOCTOR_TMP:+"$DOCTOR_TMP"}' EXIT HUP INT TERM

install -m 755 "$AIKO_BINARY" "$BIN_TMP"
install -m 755 "$NEURON_BINARY" "$NEURON_TMP"
install -m 755 "$CELL_LAUNCHER" "$CELL_TMP"
install -m 755 "$CONTRACT_LIBRARY" "$LIB_TMP"
if [ -x "$PACKAGE_ROOT/bin/aiko-doctor" ]; then
    DOCTOR_TMP="$AIKO_BIN_DIR/.aiko-doctor.install.$$"
    install -m 755 "$PACKAGE_ROOT/bin/aiko-doctor" "$DOCTOR_TMP"
fi
cp -R "$CELL_RUNTIME" "$CELL_RUNTIME_TMP"
"$BIN_TMP" --version >/dev/null

mv -f "$LIB_TMP" "$AIKO_LIB_DIR/$CONTRACT_INSTALL_NAME"
if [ "$CONTRACT_INSTALL_NAME" = "libcontract.so" ]; then
    ln -sfn libcontract.so "$AIKO_LIB_DIR/libcontract.dylib"
elif [ "$CONTRACT_INSTALL_NAME" = "libcontract.dylib" ]; then
    ln -sfn libcontract.dylib "$AIKO_LIB_DIR/libcontract.so" 2>/dev/null || true
fi

rm -f "$AIKO_BIN_DIR/aiko"
mv -f "$BIN_TMP" "$AIKO_BIN_DIR/aiko"
rm -f "$AIKO_BIN_DIR/neuron"
mv -f "$NEURON_TMP" "$AIKO_BIN_DIR/neuron"
rm -f "$AIKO_BIN_DIR/cell"
mv -f "$CELL_TMP" "$AIKO_BIN_DIR/cell"
if [ -n "$DOCTOR_TMP" ] && [ -x "$DOCTOR_TMP" ]; then
    rm -f "$AIKO_BIN_DIR/aiko-doctor"
    mv -f "$DOCTOR_TMP" "$AIKO_BIN_DIR/aiko-doctor"
fi
rm -rf "$AIKO_HOME/cell"
mv "$CELL_RUNTIME_TMP" "$AIKO_HOME/cell"
mkdir -p "$AIKO_HOME/skills/cell"
cp "$AIKO_HOME/cell/SKILL.md" "$AIKO_HOME/skills/cell/SKILL.md"
# Versioned package current — same bytes, updateable without reversing deps.
_STACK_VER=$(manifest_value version)
[ -n "$_STACK_VER" ] || _STACK_VER=unknown
mkdir -p "$AIKO_HOME/packages/cell"
ln -sfn "$AIKO_HOME/cell" "$AIKO_HOME/packages/cell/current"
if [ -f "$PACKAGE_ROOT/sdk/registry/stack.lock.json" ]; then
    cp "$PACKAGE_ROOT/sdk/registry/stack.lock.json" "$AIKO_HOME/packages/stack.lock.json"
elif [ -n "${AIKO_ROOT:-}" ] && [ -f "$AIKO_ROOT/sdk/registry/stack.lock.json" ]; then
    cp "$AIKO_ROOT/sdk/registry/stack.lock.json" "$AIKO_HOME/packages/stack.lock.json"
fi
# Shadows
for _shadow in "$HOME/bin/aiko" /usr/local/bin/aiko "$HOME/bin/neuron" "$HOME/bin/cell"; do
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
echo "  neuron   → $AIKO_BIN_DIR/neuron"
echo "  cell     → $AIKO_BIN_DIR/cell (runtime $AIKO_HOME/cell)"
if [ -x "$AIKO_BIN_DIR/aiko-doctor" ]; then
    echo "  doctor   → $AIKO_BIN_DIR/aiko-doctor"
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
echo "PATH resolves neuron → $(command -v neuron)"
echo "PATH resolves cell → $(command -v cell)"
"$AIKO_BIN_DIR/cell" --help >/dev/null

if [ "$(uname -s)" = "Darwin" ] && [ "${AIKO_SKIP_BACKGROUND_WORKER:-0}" != 1 ]; then
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
