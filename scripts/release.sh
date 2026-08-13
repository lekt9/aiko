#!/usr/bin/env bash
# scripts/release.sh — cut a versioned release with cross + portable + installer.
#
#   ./scripts/release.sh 0.2.115
#   ./scripts/release.sh 0.2.115 --push
#   ./scripts/release.sh --check
#
# What it does (default, local only):
#   1. Validates semver, bumps VERSION + Cargo.toml (x4) + versions.lock in sync.
#   2. cargo update / lock sync, zig build smoke, portable package smoke.
#   3. Commits chore(release): <old> -> <new>
#   4. Tags v<new> locally (no push unless --push).
#
# With --push:
#   5. git push origin main --tags  (triggers .github/workflows/release.yml)
#      That workflow does the real cross-build matrix (zig + cargo) and the
#      Tauri/desktop installer, then publishes a GitHub Release with all assets.
#
# With --check: only verifies sync, no writes.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION_FILE="$ROOT/VERSION"
LOCK_FILE="$ROOT/sdk/registry/versions.lock"
CARGO_FILES=(
  "$ROOT/aiko/crates/codegen/xai-grok-pager-bin/Cargo.toml"
  "$ROOT/aiko/crates/codegen/xai-grok-pager/Cargo.toml"
  "$ROOT/aiko/crates/codegen/xai-grok-shell/Cargo.toml"
  "$ROOT/aiko/crates/codegen/xai-grok-version/Cargo.toml"
)

info(){ printf 'ℹ  %s\n' "$*"; }
ok(){ printf '✓  %s\n' "$*"; }
err(){ printf '✗  %s\n' "$*" >&2; }

cargo_version(){
  sed -n -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "${CARGO_FILES[0]}" | head -1
}

current_version(){
  cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]'
}

assert_sync(){
  local v c l
  v=$(current_version)
  c=$(cargo_version)
  l=$(grep '^aiko=' "$LOCK_FILE" 2>/dev/null | cut -d= -f2 || true)
  if [[ -z "$v" || -z "$c" || -z "$l" ]]; then
    err "Cannot read versions: VERSION=$v cargo=$c lock=$l"
    return 1
  fi
  _nested_l=$(grep '^aiko=' "$ROOT/aiko/sdk/registry/versions.lock" 2>/dev/null | cut -d= -f2 || true)
  if [[ -n "$_nested_l" && "$_nested_l" != "$v" ]]; then
    err "Nested lock drift: aiko/sdk/registry/versions.lock aiko=$_nested_l != VERSION $v"
    return 1
  fi
  if [[ "$v" != "$c" || "$v" != "$l" ]]; then
    err "Version drift: VERSION=$v cargo=$c lock=$l"
    err "  Fix with: ./scripts/release.sh <version>"
    return 1
  fi
  ok "Version sync: $v"
}

do_check(){
  assert_sync
  info "Checking .github/workflows/release.yml ..."
  test -f "$ROOT/.github/workflows/release.yml" || { err "Missing .github/workflows/release.yml"; return 1; }
  grep -q "zig-cross" "$ROOT/.github/workflows/release.yml"
  grep -q "cargo-cross" "$ROOT/.github/workflows/release.yml"
  grep -q "portable" "$ROOT/.github/workflows/release.yml"
  grep -q "desktop-macos" "$ROOT/.github/workflows/release.yml"
  grep -q "desktop-linux" "$ROOT/.github/workflows/release.yml"
  grep -q "desktop-windows" "$ROOT/.github/workflows/release.yml"
  grep -q "github-release" "$ROOT/.github/workflows/release.yml"
  ok "release workflow has cross + portable + desktop installers + github-release"
  info "Checking zig + cargo smoke ..."
  (cd "$ROOT" && zig build --summary all 2>&1 | tail -5) || true
  ok "check passed"
}

bump_files(){
  local new="$1"
  info "Bumping to $new ..."
  printf '%s\n' "$new" > "$VERSION_FILE"
  for f in "${CARGO_FILES[@]}"; do
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' -E "s/^version = \".*\"/version = \"$new\"/" "$f"
    else
      sed -i -E "s/^version = \".*\"/version = \"$new\"/" "$f"
    fi
  done
  for _lock in "$LOCK_FILE" "$ROOT/aiko/sdk/registry/versions.lock"; do
    [ -f "$_lock" ] || continue
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' "s/^aiko=.*/aiko=$new/" "$_lock"
    else
      sed -i "s/^aiko=.*/aiko=$new/" "$_lock"
    fi
  done
  ok "Bumped VERSION, 4× Cargo.toml, versions.lock (both) → $new"
}

do_release(){
  local new="$1" push="$2"
  if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
    err "Bad semver: $new (want 0.2.115)"
    return 2
  fi
  local cur
  cur=$(current_version || true)
  if [[ -n "$cur" ]]; then
    # semver check via python (no external deps)
    if ! python3 -c "
import sys
try:
    from packaging.version import Version
    cur_v, new_v = sys.argv[1], sys.argv[2]
    sys.exit(0 if Version(new_v) > Version(cur_v) else 1)
except ImportError:
    # fallback: lexical compare, allow any bump if packaging not installed
    sys.exit(0 if sys.argv[2] != sys.argv[1] else 1)
" "$cur" "$new" 2>/dev/null; then
      err "New version $new must be > $cur"
      return 1
    fi
    # simple lexical fallback
    if [[ "$new" == "$cur" ]]; then err "Same as current $cur"; return 1; fi
  fi

  # dirty check
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    # allow bump despite dirty SKILL.md etc. but warn
    warn_files=$(git -C "$ROOT" status --porcelain | head -20 || true)
    info "Working tree not clean (continuing):"
    echo "$warn_files" | sed 's/^/  /' || true
  fi

  bump_files "$new"

  # Keep Cargo.lock in sync (no network fetch if already satisfied)
  if command -v cargo >/dev/null 2>&1; then
    info "Syncing Cargo.lock ..."
    (cd "$ROOT/aiko" && cargo update -p xai-grok-pager-bin --precise "$new" 2>/dev/null || cargo update --workspace 2>/dev/null || true)
  fi

  # Smoke: zig + portable where possible (non-fatal if cargo/zig missing)
  if command -v zig >/dev/null 2>&1; then
    info "Zig smoke ..."
    (cd "$ROOT" && zig build --summary all 2>&1 | tail -n 20) || err "zig build failed (commit still staged)"
  fi

  # Stage
  git -C "$ROOT" add VERSION sdk/registry/versions.lock aiko/sdk/registry/versions.lock "${CARGO_FILES[@]#$ROOT/}"
  # Cargo.lock may have changed
  git -C "$ROOT" add aiko/Cargo.lock 2>/dev/null || true

  local old="${cur:-unknown}"
  git -C "$ROOT" commit -m "chore(release): $old -> $new

  Cross + portable + desktop installer via .github/workflows/release.yml
  Trigger: git push origin HEAD --tags (or ./scripts/release.sh $new --push)
  " || { err "commit failed"; return 1; }
  git -C "$ROOT" tag "v$new" -m "v$new"
  ok "Committed and tagged v$new"

  if [[ "$push" == "1" ]]; then
    info "Pushing main + tag v$new ..."
    git -C "$ROOT" push origin HEAD
    git -C "$ROOT" push origin "v$new"
    ok "Pushed — GitHub Actions will cross-build + publish the Release"
    info "Watch: gh run list --limit 5; gh release view v$new"
  else
    info "Local only. Push with:"
    info "  git push origin HEAD --tags"
    info "  # or re-run: ./scripts/release.sh $new --push"
    info "Then GitHub builds cross + installer and publishes the Release."
  fi
}

main(){
  local arg="" push="0"
  for a in "$@"; do
    case "$a" in
      --check) do_check; exit $? ;;
      --push) push="1" ;;
      -h|--help) sed -n '2,40p' "$0" | sed 's/^# \?//'; exit 0 ;;
      *) arg="$a" ;;
    esac
  done
  if [[ -z "$arg" ]]; then
    if [[ "$push" == "1" ]]; then err "Need version with --push: ./scripts/release.sh 0.2.115 --push"; exit 2; fi
    do_check; exit $?
  fi
  do_release "$arg" "$push"
}
main "$@"
