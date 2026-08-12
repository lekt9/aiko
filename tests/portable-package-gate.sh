#!/bin/sh
# Prove the release archive is complete and installs/runs without Zig or pip.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aiko-portable-gate.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/build" "$TMP/packages" "$TMP/limbs/test-limb"
printf '%s
' 'portable limb fixture' > "$TMP/limbs/test-limb/SKILL.md"

cat > "$TMP/build/aiko" <<'SH'
#!/bin/sh
case "${1:-}" in --version) echo 'aiko 0.test' ;; *) echo aiko-test ;; esac
SH
cat > "$TMP/build/neuron" <<'SH'
#!/bin/sh
echo neuron-test
SH
chmod 755 "$TMP/build/aiko" "$TMP/build/neuron"
cat > "$TMP/build/contract.c" <<'C'
#include <stdint.h>
uint32_t contract_abi_version(void) { return 12; }
void contract_declare_turn(void) {}
C
case "$(uname -s)" in
  Darwin) cc -dynamiclib "$TMP/build/contract.c" -o "$TMP/build/libcontract.dylib" ;;
  Linux) cc -shared -fPIC "$TMP/build/contract.c" -o "$TMP/build/libcontract.so" ;;
  *) echo "unsupported test host" >&2; exit 1 ;;
esac
LIB=$(find "$TMP/build" -name 'libcontract.*' ! -name '*.c' -type f | head -1)

AIKO_ROOT="$ROOT"
AIKO_PACKAGE_ROOT="$TMP/packages"
AIKO_PORTABLE_AIKO_BIN="$TMP/build/aiko"
AIKO_PORTABLE_NEURON_BIN="$TMP/build/neuron"
AIKO_PORTABLE_CONTRACT_LIB="$LIB"
AIKO_PORTABLE_CELL_DIR="$ROOT/cell"
AIKO_PORTABLE_LIMBS_DIR="$TMP/limbs"
export AIKO_ROOT AIKO_PACKAGE_ROOT AIKO_PORTABLE_AIKO_BIN AIKO_PORTABLE_NEURON_BIN
export AIKO_PORTABLE_CONTRACT_LIB AIKO_PORTABLE_CELL_DIR AIKO_PORTABLE_LIMBS_DIR
. "$ROOT/scripts/lib/aiko-env.sh"
. "$ROOT/scripts/lib/assemble-portable.sh"
aiko_env_init
PKG=$(assemble_portable_package)

python3 - "$PKG/manifest.json" <<'PY'
import json, pathlib, sys
m = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert all(m["components"].get(x) is True for x in ("aiko", "contract", "neuron", "cell")), m
for key in ("aiko_sha256", "contract_sha256", "neuron_sha256", "cell_sha256", "cell_launcher_sha256", "cell_runtime_sha256", "limbs_sha256"):
    assert len(m.get(key, "")) == 64, (key, m.get(key))
PY
test -x "$PKG/bin/cell"
test -f "$PKG/share/cell/run.py"
test -f "$PKG/share/cell/vendor/yaml/__init__.py"
test -f "$PKG/share/cell/primitives/session.cell.yaml"

# Poison build/package tools. Installation and Cell YAML execution must not call them.
# A package test must not register a real per-user launchd service on macOS.
AIKO_SKIP_BACKGROUND_WORKER=1
export AIKO_SKIP_BACKGROUND_WORKER
mkdir -p "$TMP/poison"
for tool in zig cc gcc clang pip pip3; do
  cat > "$TMP/poison/$tool" <<SH
#!/bin/sh
echo "$tool must not run while installing a portable package" >&2
exit 97
SH
  chmod 755 "$TMP/poison/$tool"
done
HOME="$TMP/home" AIKO_HOME="$TMP/home/.aiko" AIKO_BIN_DIR="$TMP/home/bin" \
AIKO_LIB_DIR="$TMP/home/.aiko/lib" PATH="$TMP/poison:$PATH" PYTHONPATH=/definitely/not/site-packages \
  "$PKG/install.sh"

test -x "$TMP/home/bin/aiko"
test -x "$TMP/home/bin/neuron"
test -x "$TMP/home/bin/cell"
test -f "$TMP/home/.aiko/cell/run.py"
test -f "$TMP/home/.aiko/skills/cell/SKILL.md"
HOME="$TMP/home" AIKO_HOME="$TMP/home/.aiko" PATH="$TMP/poison:$TMP/home/bin:$PATH" \
PYTHONPATH=/definitely/not/site-packages \
  "$TMP/home/bin/cell" build "$TMP/home/.aiko/cell/example/hello.cell.yaml" >/dev/null

# Required means required: one altered component and one false flag must be refused.
cp -R "$PKG" "$TMP/tampered"
printf '\nchanged\n' >> "$TMP/tampered/bin/neuron"
if HOME="$TMP/tamper-home" AIKO_HOME="$TMP/tamper-home/.aiko" AIKO_BIN_DIR="$TMP/tamper-home/bin" \
  "$TMP/tampered/install.sh" >/dev/null 2>&1; then
  echo "tampered Neuron was admitted" >&2; exit 1
fi
cp -R "$PKG" "$TMP/optional"
sed 's/"cell": true/"cell": false/' "$PKG/manifest.json" > "$TMP/optional/manifest.json"
if HOME="$TMP/optional-home" AIKO_HOME="$TMP/optional-home/.aiko" AIKO_BIN_DIR="$TMP/optional-home/bin" \
  "$TMP/optional/install.sh" >/dev/null 2>&1; then
  echo "optional Cell manifest was admitted" >&2; exit 1
fi

echo "portable-package-gate: PASS"
