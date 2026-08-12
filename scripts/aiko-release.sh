#!/usr/bin/env bash
# aiko-release.sh — install / package / publish the portable Aiko stack.
#
# One product: aiko + full-ABI libcontract + neuron + limbs (not three installs).
# Prefer prebuilts (this host often OOMs on cargo release builds).
#
# Usage:
#   scripts/aiko-release.sh install                 # best local package for this platform
#   scripts/aiko-release.sh install --path DIR|TGZ  # explicit package dir or tarball
#   scripts/aiko-release.sh install --url URL       # download tarball and install
#   scripts/aiko-release.sh install --tag v0.2.103  # Gitea release asset for this platform
#   scripts/aiko-release.sh install --hash SHA256   # archive hash with --url; binary hash for local package
#   scripts/aiko-release.sh list                    # local packages + remote releases
#   scripts/aiko-release.sh package                 # assemble portable stack (no rebuild)
#   scripts/aiko-release.sh publish [--tag TAG]     # upload latest package as Gitea release asset
#
# Env:
#   GITEA_URL / GITEA_TOKEN
#   AIKO_HOME / AIKO_BIN_DIR (defaults: ~/.aiko, ~/.local/bin)
#   AIKO_PORTABLE_AIKO_BIN / AIKO_PORTABLE_CONTRACT_LIB /
#   AIKO_PORTABLE_NEURON_BIN / AIKO_PORTABLE_LIMBS_DIR

set -euo pipefail

AIKO_ROOT=${AIKO_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
# shellcheck source=lib/aiko-env.sh
. "$AIKO_ROOT/scripts/lib/aiko-env.sh"
aiko_env_init
PACKAGE_ROOT="${AIKO_PACKAGE_ROOT}"
GITEA_URL="${GITEA_URL:-http://100.124.140.92:3000}"
GITEA_ORG="${GITEA_ORG:-Unbrowse}"
GITEA_REPO="${GITEA_REPO:-aiko}"

info() { printf 'ℹ  %s\n' "$*"; }
ok()   { printf '✓  %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
err()  { printf '✗  %s\n' "$*" >&2; }

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

verify_sidecar() {
    local archive="$1" sidecar="$2" expected got
    expected=$(awk 'NF {print $1; exit}' "$sidecar")
    got=$(sha256_file "$archive")
    [[ "$expected" =~ ^[0-9a-fA-F]{64}$ && "${expected,,}" == "$got" ]] || {
        err "SHA256 mismatch for $(basename "$archive")"
        return 1
    }
}

validate_archive() {
    python3 - "$1" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as tf:
    members = tf.getmembers(); symlinks = set()
    for member in members:
        clean = posixpath.normpath(member.name)
        if member.name.startswith("/") or clean == ".." or clean.startswith("../"):
            raise SystemExit(f"unsafe archive member: {member.name}")
        if member.ischr() or member.isblk() or member.isfifo():
            raise SystemExit(f"special archive member refused: {member.name}")
        if member.issym() or member.islnk():
            target = member.linkname
            base = posixpath.dirname(clean) if member.issym() else ""
            resolved = posixpath.normpath(posixpath.join(base, target))
            if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                raise SystemExit(f"escaping archive link refused: {member.name} -> {target}")
            if member.issym(): symlinks.add(clean)
    for member in members:
        parts = posixpath.normpath(member.name).split("/")
        if any("/".join(parts[:i]) in symlinks for i in range(1, len(parts))):
            raise SystemExit(f"archive member traverses symlink: {member.name}")
PY
}

platform_name() { aiko_platform; }
cargo_version() { aiko_cargo_version; }
resolve_aiko_bin_dir() { printf '%s\n' "$AIKO_BIN_DIR"; }

http_get() {
    local url="$1" dest="${2:-}"
    local args=(-sfL)
    if [[ -n "${GITEA_TOKEN:-}" ]]; then
        args+=(-H "Authorization: token $GITEA_TOKEN")
    fi
    if [[ -n "$dest" ]]; then
        curl "${args[@]}" -o "$dest" "$url"
    else
        curl "${args[@]}" "$url"
    fi
}

# ─── Discover local packages ───────────────────────────────────────────────

list_local_packages() {
    local plat
    plat=$(platform_name)
    shopt -s nullglob
    local dirs=("$PACKAGE_ROOT"/aiko-*-"$plat")
    local tgzs=("$PACKAGE_ROOT"/aiko-*-"$plat".tar.gz)
    if [[ ${#dirs[@]} -eq 0 && ${#tgzs[@]} -eq 0 ]]; then
        info "No local packages under $PACKAGE_ROOT for $plat"
        return 0
    fi
    info "Local packages for $plat:"
    for d in "${dirs[@]}"; do
        [[ -d "$d" ]] || continue
        local ver bin sha
        ver=$(basename "$d" | sed -E "s/^aiko-(.+)-${plat}\$/\1/")
        bin="$d/bin/aiko"
        if [[ -x "$bin" ]]; then
            sha=$(sha256_file "$bin")
            printf '  dir  %-12s %s\n      sha256 %s\n' "$ver" "$d" "$sha"
        else
            printf '  dir  %-12s %s (missing bin/aiko)\n' "$ver" "$d"
        fi
    done
    for t in "${tgzs[@]}"; do
        [[ -f "$t" ]] || continue
        printf '  tgz  %s  (%s)\n' "$(basename "$t")" "$(du -h "$t" | awk '{print $1}')"
    done
}

latest_local_package_dir() {
    local plat want_hash="${1:-}"
    plat=$(platform_name)
    shopt -s nullglob
    local best="" best_mtime=0
    local d
    for d in "$PACKAGE_ROOT"/aiko-*-"$plat"; do
        [[ -d "$d" && -x "$d/bin/aiko" && -f "$d/install.sh" ]] || continue
        if [[ -n "$want_hash" ]]; then
            [[ "$(sha256_file "$d/bin/aiko")" == "$want_hash" ]] || continue
        fi
        local m
        m=$(stat -c %Y "$d/bin/aiko" 2>/dev/null || stat -f %m "$d/bin/aiko")
        if [[ "$m" -ge "$best_mtime" ]]; then
            best_mtime=$m
            best=$d
        fi
    done
    if [[ -n "$best" ]]; then
        printf '%s\n' "$best"
        return 0
    fi
    return 1
}

# ─── Unpack / normalize package ────────────────────────────────────────────

# Accept only a complete package directory or complete portable tarball.
prepare_package() {
    local src="$1"
    local work
    work=$(mktemp -d "${TMPDIR:-/tmp}/aiko-release.XXXXXX")
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" RETURN

    if [[ -d "$src" ]]; then
        if [[ -x "$src/bin/aiko" && -f "$src/install.sh" ]]; then
            printf '%s\n' "$src"
            trap - RETURN
            return 0
        fi
        err "Directory is not a full Aiko package (need bin/aiko + install.sh): $src"
        return 1
    fi

    if [[ ! -f "$src" ]]; then
        err "Not found: $src"
        return 1
    fi

    case "$src" in
        *.tar.gz|*.tgz)
            validate_archive "$src"
            tar -xzf "$src" -C "$work"
            ;;
        *)
            err "Expected directory or .tar.gz: $src"
            return 1
            ;;
    esac

    # A portable archive has exactly one root and that root owns its installer.
    local count root name
    count=$(find "$work" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
    if [[ "$count" == 1 ]]; then
        root=$(find "$work" -mindepth 1 -maxdepth 1 -print)
        if [[ -d "$root" && -f "$root/install.sh" ]]; then
            name=$(basename "$root")
            mkdir -p "$PACKAGE_ROOT"
            rm -rf "$PACKAGE_ROOT/$name.extracting"
            mv "$root" "$PACKAGE_ROOT/$name.extracting"
            rm -rf "$PACKAGE_ROOT/$name"
            mv "$PACKAGE_ROOT/$name.extracting" "$PACKAGE_ROOT/$name"
            chmod 755 "$PACKAGE_ROOT/$name/install.sh"
            printf '%s\n' "$PACKAGE_ROOT/$name"
            trap - RETURN
            return 0
        fi
    fi

    err "Archive is not a complete portable Aiko package (one root with install.sh required)"
    err "Bare Aiko binaries and component archives are not installable"
    return 1
}

# ─── Install ───────────────────────────────────────────────────────────────

install_package_dir() {
    local dest="$1" want_hash="${2:-}"
    if [[ ! -x "$dest/install.sh" ]]; then
        err "Missing install.sh in $dest"
        return 1
    fi
    if [[ -n "$want_hash" ]]; then
        local got
        got=$(sha256_file "$dest/bin/aiko")
        if [[ "$got" != "$want_hash" ]]; then
            err "Hash mismatch: package aiko is $got, required $want_hash"
            return 1
        fi
        ok "Hash matches $want_hash"
    fi
    aiko_assert_version_sync || warn "versions.lock out of sync with VERSION"
    info "Installing from $dest → SSOT bin dir $AIKO_BIN_DIR"
    # Pass AIKO_ROOT so install.sh can sync versions.lock from the checkout
    AIKO_ROOT="$AIKO_ROOT" AIKO_HOME="$AIKO_HOME" AIKO_BIN_DIR="$AIKO_BIN_DIR" \
        "$dest/install.sh"
    # Always write SSOT lock into the runtime home
    mkdir -p "$AIKO_HOME/sdk/registry"
    cp "$AIKO_VERSIONS_LOCK" "$AIKO_HOME/sdk/registry/versions.lock"
    aiko_path_export
    aiko_verify_path || true
}

download_release_asset() {
    local tag="$1"
    local plat
    plat=$(platform_name)
    # Normalize tag
    local tag_bare="${tag#v}"
    local tag_v="v${tag_bare}"

    if [[ -z "${GITEA_TOKEN:-}" ]]; then
        err "GITEA_TOKEN required to download private Gitea releases"
        return 1
    fi

    info "Looking up Gitea release $tag_v for $plat..."
    local json
    json=$(http_get "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/tags/$tag_v") || {
        err "No release $tag_v on $GITEA_ORG/$GITEA_REPO"
        return 1
    }

    local asset_name=""
    asset_name=$(printf '%s' "$json" | python3 -c "
import sys, json
plat = '''$plat'''
tag_bare = '''$tag_bare'''
candidates = [
    f'aiko-{tag_bare}-{plat}.tar.gz',
    f'aiko-{plat}.tar.gz',
]
data = json.load(sys.stdin)
assets = {a['name']: a for a in data.get('assets', [])}
for c in candidates:
    if c in assets:
        print(c)
        break
else:
    # fuzzy: any asset containing platform
    for name in assets:
        if plat in name and name.endswith('.tar.gz'):
            print(name)
            break
")

    if [[ -z "$asset_name" ]]; then
        err "Release $tag_v has no asset for platform $plat"
        printf '%s' "$json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
names = [a['name'] for a in data.get('assets', [])]
print('  assets:', names or '(none)')
" >&2
        return 1
    fi

    # Prefer browser_download_url via API attachment id
    local url
    url=$(printf '%s' "$json" | python3 -c "
import sys, json
want = '''$asset_name'''
data = json.load(sys.stdin)
for a in data.get('assets', []):
    if a['name'] == want:
        # Gitea attachment download
        print(a.get('browser_download_url') or '')
        break
")
    if [[ -z "$url" ]]; then
        err "Could not resolve download URL for $asset_name"
        return 1
    fi
    local sidecar_name="$asset_name.sha256" sidecar_url
    sidecar_url=$(printf '%s' "$json" | python3 -c "
import sys, json
want = '''$sidecar_name'''
for asset in json.load(sys.stdin).get('assets', []):
    if asset['name'] == want:
        print(asset.get('browser_download_url') or '')
        break
")
    [[ -n "$sidecar_url" ]] || { err "Release $tag_v is missing $sidecar_name"; return 1; }

    local out="$PACKAGE_ROOT/$asset_name" sidecar="$PACKAGE_ROOT/$sidecar_name"
    mkdir -p "$PACKAGE_ROOT"
    info "Downloading $asset_name and SHA256 sidecar..." >&2
    http_get "$url" "$out"
    http_get "$sidecar_url" "$sidecar"
    verify_sidecar "$out" "$sidecar"
    ok "Verified $out" >&2
    printf '%s\n' "$out"

}

cmd_list() {
    list_local_packages
    echo
    if [[ -n "${GITEA_TOKEN:-}" ]]; then
        info "Gitea releases ($GITEA_ORG/$GITEA_REPO):"
        http_get "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases?limit=10" \
            | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception as e:
    print('  (failed to list)', e)
    sys.exit(0)
if not data:
    print('  (none)')
for r in data:
    assets = [a['name'] for a in r.get('assets', [])]
    print(f\"  {r.get('tag_name')}  assets={assets or ['(none)']}\")
" || warn "Could not list remote releases"
    else
        warn "Set GITEA_TOKEN to list remote releases"
    fi
    echo
    info "Installed:"
    if command -v aiko >/dev/null 2>&1; then
        local p
        p=$(command -v aiko)
        printf '  PATH  %s\n  ver   %s\n  sha   %s\n' "$p" \
            "$(aiko --version 2>/dev/null || echo '?')" \
            "$(sha256_file "$p")"
    else
        printf '  (aiko not on PATH)\n'
    fi
}

cmd_install() {
    local path="" url="" tag="" want_hash=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --path) path="$2"; shift 2 ;;
            --url)  url="$2"; shift 2 ;;
            --tag)  tag="$2"; shift 2 ;;
            --hash) want_hash="$2"; shift 2 ;;
            -h|--help)
                sed -n '2,30p' "$0" | sed 's/^# \?//'
                return 0
                ;;
            *) err "Unknown arg: $1"; return 2 ;;
        esac
    done

    local src=""
    if [[ -n "$path" ]]; then
        src="$path"
    elif [[ -n "$url" ]]; then
        if [[ -z "$want_hash" ]]; then
            err "--url requires --hash SHA256"
            return 2
        fi
        mkdir -p "$PACKAGE_ROOT"
        local fname
        fname=$(basename "$url")
        [[ "$fname" == *tar* ]] || fname="aiko-download.tar.gz"
        info "Downloading $url and SHA256 sidecar"
        http_get "$url" "$PACKAGE_ROOT/$fname"
        http_get "$url.sha256" "$PACKAGE_ROOT/$fname.sha256" || {
            err "Missing SHA256 sidecar: $url.sha256"; return 1;
        }
        verify_sidecar "$PACKAGE_ROOT/$fname" "$PACKAGE_ROOT/$fname.sha256"
        local archive_hash
        archive_hash=$(sha256_file "$PACKAGE_ROOT/$fname" | tr '[:upper:]' '[:lower:]')
        want_hash=$(printf '%s' "$want_hash" | tr '[:upper:]' '[:lower:]')
        [[ "$want_hash" =~ ^[0-9a-f]{64}$ && "$archive_hash" == "$want_hash" ]] || {
            err "Archive checksum does not match --hash for $fname"
            return 1
        }
        src="$PACKAGE_ROOT/$fname"
        want_hash=""
    elif [[ -n "$tag" ]]; then
        src=$(download_release_asset "$tag")
    else
        # Prefer local package matching optional hash
        if src=$(latest_local_package_dir "$want_hash"); then
            info "Using local package $src"
        else
            err "No local package for $(platform_name)${want_hash:+ with hash $want_hash}"
            err "Build on a machine with RAM, then:"
            err "  scripts/aiko-release.sh package && scripts/aiko-release.sh publish --tag v\$(version)"
            err "Or install a tarball: scripts/aiko-release.sh install --path /path/to/aiko-…tar.gz"
            list_local_packages
            return 1
        fi
    fi

    local dest
    dest=$(prepare_package "$src")
    install_package_dir "$dest" "$want_hash"
}

# Package full portable stack from existing binaries (no cargo/zig rebuild).
cmd_package() {
    # shellcheck source=lib/assemble-portable.sh
    . "$AIKO_ROOT/scripts/lib/assemble-portable.sh"
    aiko_env_init
    local archive
    archive=$(assemble_portable_tarball) || {
        err "Portable package assembly failed"
        return 1
    }
    ok "Portable stack archive: $archive"
    local dest="${archive%.tar.gz}"
    if [[ -f "$dest/manifest.json" ]]; then
        info "manifest: $(python3 -c "import json;print(json.load(open('$dest/manifest.json'))['product'], json.load(open('$dest/manifest.json'))['components'])" 2>/dev/null || cat "$dest/manifest.json" | head -5)"
    fi
    printf '%s\n' "$archive"
}

cmd_publish() {
    local tag=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tag) tag="$2"; shift 2 ;;
            *) err "Unknown arg: $1"; return 2 ;;
        esac
    done
    if [[ -z "${GITEA_TOKEN:-}" ]]; then
        err "GITEA_TOKEN required to publish"
        return 1
    fi

    local ver plat archive
    ver=$(cargo_version)
    plat=$(platform_name)
    tag="${tag:-v$ver}"
    archive="$PACKAGE_ROOT/aiko-${ver}-${plat}.tar.gz"
    if [[ ! -f "$archive" ]]; then
        info "No archive yet — packaging from existing binaries..."
        cmd_package >/dev/null
    fi
    if [[ ! -f "$archive" ]]; then
        err "Missing $archive"
        return 1
    fi

    info "Ensuring release $tag exists..."
    local release_json rid
    release_json=$(http_get "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/tags/$tag" 2>/dev/null || true)
    if [[ -z "$release_json" || "$release_json" == *'"message"'* && "$release_json" == *'404'* ]]; then
        release_json=$(curl -sfL -X POST \
            -H "Authorization: token $GITEA_TOKEN" \
            -H "Content-Type: application/json" \
            "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases" \
            -d "{\"tag_name\":\"$tag\",\"name\":\"Aiko $tag\",\"body\":\"Prebuilt package for $plat (no on-device rebuild).\",\"draft\":false,\"prerelease\":false}") || {
            err "Failed to create release $tag (tag must exist on the repo)"
            return 1
        }
    fi
    rid=$(printf '%s' "$release_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

    local asset_name sidecar sidecar_name
    asset_name=$(basename "$archive")
    sidecar="$archive.sha256"
    sidecar_name="$asset_name.sha256"
    printf '%s  %s\n' "$(sha256_file "$archive")" "$asset_name" > "$sidecar"

    # Upload both the archive and its independently downloadable checksum.
    local upload_name upload_path
    for upload_name in "$asset_name" "$sidecar_name"; do
        if [[ "$upload_name" == "$asset_name" ]]; then upload_path="$archive"; else upload_path="$sidecar"; fi
        printf '%s' "$release_json" | python3 -c "
import sys, json
want = '''$upload_name'''
data = json.load(sys.stdin)
for a in data.get('assets', []):
    if a['name'] == want:
        print(a['id'])
        break
" | while read -r aid; do
            [[ -n "$aid" ]] || continue
            curl -sfL -X DELETE -H "Authorization: token $GITEA_TOKEN" \
                "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/assets/$aid" >/dev/null || true
        done
        info "Uploading $upload_name to release $tag (id=$rid)..."
        curl -sfL -X POST -H "Authorization: token $GITEA_TOKEN" \
            "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/$rid/assets?name=$upload_name" \
            -F "attachment=@$upload_path" >/dev/null
    done
    ok "Published $asset_name and $sidecar_name → $tag"

    # The legacy installers consume the same pair from the generic registry.
    local generic_base="$GITEA_URL/api/packages/$GITEA_ORG/generic/aiko/${ver}"
    for upload_name in "$asset_name" "$sidecar_name"; do
        if [[ "$upload_name" == "$asset_name" ]]; then upload_path="$archive"; else upload_path="$sidecar"; fi
        local generic_url="$generic_base/$upload_name"
        if curl -sfL -X PUT -H "Authorization: token $GITEA_TOKEN" \
            --data-binary @"$upload_path" "$generic_url" >/dev/null 2>&1; then
            ok "Published generic package aiko/${ver}/$upload_name"
        else
            err "Generic package upload failed: $upload_name"
            return 1
        fi
    done
    ok "Install elsewhere with aiko-install --version $ver"

}

main() {
    local cmd="${1:-}"
    shift || true
    case "$cmd" in
        install)  cmd_install "$@" ;;
        list)     cmd_list "$@" ;;
        package)  cmd_package "$@" ;;
        publish)  cmd_publish "$@" ;;
        -h|--help|help|"")
            sed -n '2,30p' "$0" | sed 's/^# \?//'
            ;;
        *)
            err "Unknown command: $cmd (install|list|package|publish)"
            exit 2
            ;;
    esac
}

main "$@"
