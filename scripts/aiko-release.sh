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
#   scripts/aiko-release.sh install --hash SHA256   # require aiko binary matches hash
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

# Accept package dir, full tarball, or bare binary tarball (aiko only).
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
            tar -xzf "$src" -C "$work"
            ;;
        *)
            err "Expected directory or .tar.gz: $src"
            return 1
            ;;
    esac

    # Full package: aiko-VERSION-PLATFORM/ with install.sh
    local found
    found=$(find "$work" -maxdepth 2 -type f -name install.sh 2>/dev/null | head -1 || true)
    if [[ -n "$found" ]]; then
        local root
        root=$(CDPATH= cd -- "$(dirname -- "$found")" && pwd)
        # Keep work dir alive by moving to PACKAGE_ROOT extract path
        local name
        name=$(basename "$root")
        mkdir -p "$PACKAGE_ROOT"
        if [[ -e "$PACKAGE_ROOT/$name" ]]; then
            rm -rf "$PACKAGE_ROOT/$name.extracting"
            mv "$root" "$PACKAGE_ROOT/$name.extracting"
            rm -rf "$PACKAGE_ROOT/$name"
            mv "$PACKAGE_ROOT/$name.extracting" "$PACKAGE_ROOT/$name"
        else
            mv "$root" "$PACKAGE_ROOT/$name"
        fi
        # Refresh installer to current PATH-aware script when in a checkout
        if [[ -f "$AIKO_ROOT/scripts/install-aiko-package.sh" ]]; then
            install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$PACKAGE_ROOT/$name/install.sh"
        fi
        printf '%s\n' "$PACKAGE_ROOT/$name"
        trap - RETURN
        return 0
    fi

    # Bare binary tarball: contains just `aiko`
    local bin
    bin=$(find "$work" -type f -name aiko 2>/dev/null | head -1 || true)
    if [[ -z "$bin" ]]; then
        err "Archive has neither install.sh package nor aiko binary"
        return 1
    fi

    # Need Contract dylib from current install or sibling build
    local lib=""
    if [[ -f "$AIKO_HOME/lib/libcontract.dylib" ]]; then
        lib="$AIKO_HOME/lib/libcontract.dylib"
    elif [[ -f "$AIKO_HOME/lib/libcontract.so" ]]; then
        lib="$AIKO_HOME/lib/libcontract.so"
    else
        case "$(uname -s)" in
            Darwin) lib_candidate="$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.dylib" ;;
            *)      lib_candidate="$AIKO_ROOT/../contract/libcontract/zig-out/lib/libcontract.so" ;;
        esac
        if [[ -f "$lib_candidate" ]]; then
            lib="$lib_candidate"
        fi
    fi
    if [[ -z "$lib" ]]; then
        err "Bare aiko binary archive needs Contract library at ~/.aiko/lib/ or sibling contract build"
        return 1
    fi

    local ver plat name dest
    ver=$(cargo_version)
    plat=$(platform_name)
    name="aiko-${ver}-${plat}"
    dest="$PACKAGE_ROOT/$name"
    mkdir -p "$dest/bin" "$dest/lib" "$dest/skills" "$dest/sdk/registry/bin"
    install -m 755 "$bin" "$dest/bin/aiko"
    install -m 755 "$lib" "$dest/lib/libcontract.dylib"
    install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$dest/install.sh"
    if [[ -d "$AIKO_ROOT/sdk/registry" ]]; then
        cp -R "$AIKO_ROOT/sdk/registry/bin" "$dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/setup.sh" "$dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/versions.lock" "$dest/sdk/registry/" 2>/dev/null || true
        cp "$AIKO_ROOT/sdk/registry/package.json" "$dest/sdk/registry/" 2>/dev/null || true
    fi
    for skill in "$AIKO_ROOT"/.agents/skills/*; do
        if [[ -f "$skill/contract-skill.json" ]]; then
            cp -R "$skill" "$dest/skills/"
        fi
    done
    # Empty skills dir is invalid for installer — seed a placeholder marker package needs dir
    mkdir -p "$dest/skills"
    local aiko_sha contract_sha
    aiko_sha=$(sha256_file "$dest/bin/aiko")
    contract_sha=$(sha256_file "$dest/lib/libcontract.dylib")
    cat > "$dest/manifest.json" <<EOF
{
  "format": 1,
  "version": "$ver",
  "platform": "$plat",
  "contract_abi": 10,
  "application_runtime": "aiko-native-cdp-v1",
  "aiko_sha256": "$aiko_sha",
  "aiko_commit": "$(git -C "$AIKO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)",
  "aiko_dirty": false,
  "contract_sha256": "$contract_sha",
  "contract_commit": "unknown",
  "contract_dirty": false,
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "bare-binary-archive"
}
EOF
    printf '%s\n' "$dest"
    trap - RETURN
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
    # Always use PATH-aware installer from this checkout when available
    if [[ -f "$AIKO_ROOT/scripts/install-aiko-package.sh" ]]; then
        install -m 755 "$AIKO_ROOT/scripts/install-aiko-package.sh" "$dest/install.sh"
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

    local out="$PACKAGE_ROOT/$asset_name"
    mkdir -p "$PACKAGE_ROOT"
    info "Downloading $asset_name..."
    http_get "$url" "$out"
    ok "Saved $out"
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
        mkdir -p "$PACKAGE_ROOT"
        local fname
        fname=$(basename "$url")
        [[ "$fname" == *tar* ]] || fname="aiko-download.tar.gz"
        info "Downloading $url"
        http_get "$url" "$PACKAGE_ROOT/$fname"
        src="$PACKAGE_ROOT/$fname"
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

    local asset_name
    asset_name=$(basename "$archive")
    info "Uploading $asset_name to release $tag (id=$rid)..."
    # Delete existing same-named asset if present
    printf '%s' "$release_json" | python3 -c "
import sys, json
want = '''$asset_name'''
data = json.load(sys.stdin)
for a in data.get('assets', []):
    if a['name'] == want:
        print(a['id'])
        break
" | while read -r aid; do
        [[ -n "$aid" ]] || continue
        curl -sfL -X DELETE \
            -H "Authorization: token $GITEA_TOKEN" \
            "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/assets/$aid" >/dev/null \
            && info "Removed previous asset id=$aid" || true
    done

    curl -sfL -X POST \
        -H "Authorization: token $GITEA_TOKEN" \
        "$GITEA_URL/api/v1/repos/$GITEA_ORG/$GITEA_REPO/releases/$rid/assets?name=$asset_name" \
        -F "attachment=@$archive" >/dev/null

    ok "Published $asset_name → $tag"
    ok "Install elsewhere: GITEA_TOKEN=… scripts/aiko-release.sh install --tag $tag"

    # Also publish generic package for aiko-install consumers
    local generic_url="$GITEA_URL/api/packages/$GITEA_ORG/generic/aiko/${ver}/$asset_name"
    if curl -sfL -X PUT \
        -H "Authorization: token $GITEA_TOKEN" \
        -F "package=@$archive" \
        "$generic_url" >/dev/null 2>&1 \
        || curl -sfL -X PUT \
        -H "Authorization: token $GITEA_TOKEN" \
        --data-binary @"$archive" \
        "$generic_url" >/dev/null 2>&1; then
        ok "Also published generic package aiko/${ver}/$asset_name"
    else
        warn "Generic package upload failed (release asset is enough for --tag install)"
    fi
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
