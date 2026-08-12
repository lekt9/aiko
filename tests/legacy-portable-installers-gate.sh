#!/bin/sh
# Legacy registry installers must consume one verified portable product without builds.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aiko-legacy-portable.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
PLATFORM=linux-x86_64
case "$(uname -s):$(uname -m)" in
  Linux:aarch64|Linux:arm64) PLATFORM=linux-aarch64 ;;
  Darwin:x86_64|Darwin:amd64) PLATFORM=macos-x86_64 ;;
  Darwin:arm64|Darwin:aarch64) PLATFORM=macos-aarch64 ;;
esac
VERSION=9.8.7
NAME="aiko-$VERSION-$PLATFORM.tar.gz"
mkdir -p "$TMP/registry" "$TMP/package/aiko-$VERSION-$PLATFORM/bin"   "$TMP/package/aiko-$VERSION-$PLATFORM/lib" "$TMP/package/aiko-$VERSION-$PLATFORM/share/cell"
for component in aiko neuron cell; do printf '%s\n' "$component" > "$TMP/package/aiko-$VERSION-$PLATFORM/bin/$component"; done
printf '%s\n' contract > "$TMP/package/aiko-$VERSION-$PLATFORM/lib/libcontract.so"
cat > "$TMP/package/aiko-$VERSION-$PLATFORM/install.sh" <<'INSTALL'
#!/bin/sh
set -eu
P=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test -f "$P/bin/aiko" && test -f "$P/bin/neuron" && test -f "$P/bin/cell"
test -f "$P/lib/libcontract.so"
mkdir -p "$AIKO_HOME"
printf 'complete\n' > "$AIKO_HOME/bundled-install-invoked"
INSTALL
chmod 755 "$TMP/package/aiko-$VERSION-$PLATFORM/install.sh"
tar -czf "$TMP/registry/$NAME" -C "$TMP/package" "aiko-$VERSION-$PLATFORM"
if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$TMP/registry/$NAME" | awk '{print $1}')
else HASH=$(shasum -a 256 "$TMP/registry/$NAME" | awk '{print $1}'); fi
printf '%s  %s\n' "$HASH" "$NAME" > "$TMP/registry/$NAME.sha256"
printf 'aiko=%s\ncontract=old\nneuron=old\n' "$VERSION" > "$TMP/registry/versions.lock"

mkdir "$TMP/mockbin"
cat > "$TMP/mockbin/curl" <<'CURL'
#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >> "$CURL_LOG"
case "$url" in
  */versions.lock) src="$MOCK_REGISTRY/versions.lock" ;;
  *.tar.gz.sha256) src="$MOCK_REGISTRY/${url##*/}" ;;
  *.tar.gz) src="$MOCK_REGISTRY/${url##*/}" ;;
  *) echo "unexpected URL: $url" >&2; exit 22 ;;
esac
cp "$src" "$out"
CURL
chmod 755 "$TMP/mockbin/curl"
for tool in cargo zig cc gcc clang pip pip3; do
  cat > "$TMP/mockbin/$tool" <<EOF
#!/bin/sh
echo "$tool was invoked" >&2
exit 97
EOF
  chmod 755 "$TMP/mockbin/$tool"
done
export MOCK_REGISTRY="$TMP/registry" CURL_LOG="$TMP/curl.log"
COMMON_PATH="$TMP/mockbin:$PATH"

HOME="$TMP/home-install" AIKO_HOME="$TMP/home-install/.aiko" AIKO_BIN_DIR="$TMP/home-install/bin" GITEA_URL=https://gitea.invalid GITEA_TOKEN=test MANIFEST_URL=https://gitea.invalid/versions.lock PATH="$COMMON_PATH"   "$ROOT/sdk/registry/bin/aiko-install"
test "$(cat "$TMP/home-install/.aiko/bundled-install-invoked")" = complete

after_install=$(wc -l < "$TMP/curl.log")
HOME="$TMP/home-setup" AIKO_HOME="$TMP/home-setup/.aiko" AIKO_BIN_DIR="$TMP/home-setup/bin" GITEA_URL=https://gitea.invalid GITEA_TOKEN=test MANIFEST_URL=https://gitea.invalid/versions.lock PATH="$COMMON_PATH"   "$ROOT/sdk/registry/setup.sh"
test "$(cat "$TMP/home-setup/.aiko/bundled-install-invoked")" = complete
test "$(wc -l < "$TMP/curl.log")" -eq $((after_install + 3))
grep -q "/generic/aiko/$VERSION/$NAME$" "$TMP/curl.log"
grep -q "/generic/aiko/$VERSION/$NAME.sha256$" "$TMP/curl.log"

# A bad sidecar is rejected before the archive can be extracted or invoked.
BAD_NAME="aiko-6.6.5-$PLATFORM.tar.gz"
cp "$TMP/registry/$NAME" "$TMP/registry/$BAD_NAME"
printf '%064d  %s\n' 0 "$BAD_NAME" > "$TMP/registry/$BAD_NAME.sha256"
if HOME="$TMP/hash-home" AIKO_HOME="$TMP/hash-home/.aiko" GITEA_URL=https://gitea.invalid \
  GITEA_TOKEN=test PATH="$COMMON_PATH" "$ROOT/sdk/registry/bin/aiko-install" \
  --version 6.6.5 >"$TMP/hash.out" 2>&1; then
  echo "bad SHA256 sidecar was accepted" >&2; exit 1
fi
test ! -e "$TMP/hash-home/.aiko/bundled-install-invoked"
grep -q 'SHA256 mismatch' "$TMP/hash.out"

# Valid checksums do not authorize tar path or link escapes.
python3 - "$TMP/registry" "$PLATFORM" <<'PY'
import hashlib, io, pathlib, sys, tarfile
root, platform = pathlib.Path(sys.argv[1]), sys.argv[2]
for version, kind in (("6.6.6", "path"), ("6.6.7", "link")):
    name = f"aiko-{version}-{platform}.tar.gz"
    archive = root / name
    with tarfile.open(archive, "w:gz") as tf:
        if kind == "path":
            data = b"escaped\n"; member = tarfile.TarInfo("../escaped")
            member.size = len(data); tf.addfile(member, io.BytesIO(data))
        else:
            member = tarfile.TarInfo(f"aiko-{version}-{platform}/link")
            member.type = tarfile.SYMTYPE; member.linkname = "../../escaped"
            tf.addfile(member)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (root / f"{name}.sha256").write_text(f"{digest}  {name}\n")
PY
for bad_version in 6.6.6 6.6.7; do
  if HOME="$TMP/bad-home" AIKO_HOME="$TMP/bad-home/.aiko" GITEA_URL=https://gitea.invalid \
    GITEA_TOKEN=test PATH="$COMMON_PATH" "$ROOT/sdk/registry/bin/aiko-install" \
    --version "$bad_version" >"$TMP/bad-$bad_version.out" 2>&1; then
    echo "unsafe archive $bad_version was accepted" >&2; exit 1
  fi
done
test ! -e "$TMP/escaped"
grep -Eq 'unsafe archive member|escaping archive link' "$TMP/bad-6.6.6.out" "$TMP/bad-6.6.7.out"

# No component-only escape hatch and no old bare-binary synthesis.
if PATH="$COMMON_PATH" "$ROOT/sdk/registry/bin/aiko-install" neuron >/dev/null 2>&1; then
  echo "component-only install was accepted" >&2; exit 1
fi
mkdir "$TMP/bare"; printf '#!/bin/sh\n' > "$TMP/bare/aiko"; tar -czf "$TMP/bare.tar.gz" -C "$TMP/bare" aiko
if AIKO_PACKAGE_ROOT="$TMP/packages" "$ROOT/scripts/aiko-release.sh" install --path "$TMP/bare.tar.gz" >"$TMP/bare.out" 2>&1; then
  echo "bare Aiko archive was accepted" >&2; exit 1
fi
grep -q 'Bare Aiko binaries' "$TMP/bare.out"

echo "legacy-portable-installers-gate: PASS"
