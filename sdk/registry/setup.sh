#!/usr/bin/env bash
# One-line installation of the complete, verified portable Aiko product.
# Usage: GITEA_TOKEN=… curl -sL <url> | bash
set -euo pipefail

GITEA_URL="${GITEA_URL:-http://100.124.140.92:3000}"
GITEA_ORG="${GITEA_ORG:-Unbrowse}"
GITEA_TOKEN="${GITEA_TOKEN:-${1:-}}"
AIKO_HOME="${AIKO_HOME:-$HOME/.aiko}"
AIKO_BIN_DIR="${AIKO_BIN_DIR:-$HOME/.local/bin}"
AIKO_LIB_DIR="${AIKO_LIB_DIR:-$AIKO_HOME/lib}"
MANIFEST_URL="${MANIFEST_URL:-$GITEA_URL/$GITEA_ORG/aiko-sdk/raw/branch/main/versions.lock}"

if [[ -z "$GITEA_TOKEN" ]]; then
    read -rp "Gitea API token: " GITEA_TOKEN
fi
get() { curl -sfL -H "Authorization: token $GITEA_TOKEN" -o "$2" "$1"; }
platform() {
    case "$(uname -s):$(uname -m)" in
        Linux:x86_64|Linux:amd64) echo linux-x86_64 ;;
        Linux:aarch64|Linux:arm64) echo linux-aarch64 ;;
        Darwin:x86_64|Darwin:amd64) echo macos-x86_64 ;;
        Darwin:arm64|Darwin:aarch64) echo macos-aarch64 ;;
        *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
    esac
}
sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    else shasum -a 256 "$1" | awk '{print $1}'; fi
}
validate_archive() {
    python3 - "$1" <<'PY'
import posixpath, sys, tarfile
archive = sys.argv[1]
with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    symlinks = set()
    for member in members:
        name = member.name
        clean = posixpath.normpath(name)
        if name.startswith("/") or clean == ".." or clean.startswith("../"):
            raise SystemExit(f"unsafe archive member: {name}")
        if member.ischr() or member.isblk() or member.isfifo():
            raise SystemExit(f"special archive member refused: {name}")
        if member.issym() or member.islnk():
            target = member.linkname
            if target.startswith("/"):
                raise SystemExit(f"absolute archive link refused: {name} -> {target}")
            base = posixpath.dirname(clean) if member.issym() else ""
            resolved = posixpath.normpath(posixpath.join(base, target))
            if resolved == ".." or resolved.startswith("../"):
                raise SystemExit(f"escaping archive link refused: {name} -> {target}")
            if member.issym():
                symlinks.add(clean)
    for member in members:
        clean = posixpath.normpath(member.name)
        parts = clean.split("/")
        for i in range(1, len(parts)):
            if "/".join(parts[:i]) in symlinks:
                raise SystemExit(f"archive member traverses symlink: {member.name}")
PY
}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/aiko-setup.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
get "$MANIFEST_URL" "$WORK/versions.lock"
VERSION=$(sed -n 's/^aiko=//p' "$WORK/versions.lock" | head -1)
[[ -n "$VERSION" ]] || { echo "versions.lock has no aiko version" >&2; exit 1; }
PLATFORM=$(platform)
NAME="aiko-${VERSION}-${PLATFORM}.tar.gz"
BASE="$GITEA_URL/api/packages/$GITEA_ORG/generic/aiko/$VERSION"
echo "Downloading complete Aiko $VERSION ($PLATFORM)..."
get "$BASE/$NAME" "$WORK/$NAME"
get "$BASE/$NAME.sha256" "$WORK/$NAME.sha256"
EXPECTED=$(awk 'NF {print $1; exit}' "$WORK/$NAME.sha256")
GOT=$(sha256_file "$WORK/$NAME")
EXPECTED=$(printf '%s' "$EXPECTED" | tr '[:upper:]' '[:lower:]')
GOT=$(printf '%s' "$GOT" | tr '[:upper:]' '[:lower:]')
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ && "$EXPECTED" == "$GOT" ]] || {
    echo "SHA256 mismatch for $NAME" >&2; exit 1;
}
validate_archive "$WORK/$NAME"
mkdir "$WORK/extract"
tar -xzf "$WORK/$NAME" -C "$WORK/extract"
COUNT=$(find "$WORK/extract" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
[[ "$COUNT" == 1 ]] || { echo "Portable archive must contain exactly one root" >&2; exit 1; }
ROOT=$(find "$WORK/extract" -mindepth 1 -maxdepth 1 -print)
[[ -d "$ROOT" && -f "$ROOT/install.sh" ]] || { echo "Portable archive root is missing install.sh" >&2; exit 1; }
chmod 755 "$ROOT/install.sh"
AIKO_HOME="$AIKO_HOME" AIKO_BIN_DIR="$AIKO_BIN_DIR" AIKO_LIB_DIR="$AIKO_LIB_DIR" "$ROOT/install.sh"
echo "Aiko + Neuron + Cell + Contract installed."
