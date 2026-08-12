#!/bin/sh
# One-command install / reinstall of Aiko.
#
# Prefer prebuilt packages (this host often OOMs on full cargo release builds):
#
#   ./install.sh                 # install latest local package (no rebuild)
#   ./install.sh reinstall       # same as default
#   ./install.sh from-release    # scripts/aiko-release.sh install (local / tag / url)
#   ./install.sh build           # full source build → package → install (heavy)
#
# Destinations: PATH entry for aiko (else ~/.local/bin), ~/.aiko/lib, skills, sdk.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CMD=${1:-reinstall}
case "$CMD" in
    install|reinstall|from-release)
        shift || true
        exec "$ROOT/scripts/aiko-release.sh" install "$@"
        ;;
    build|from-source)
        exec "$ROOT/scripts/contract-runtime.sh" install
        ;;
    list)
        exec "$ROOT/scripts/aiko-release.sh" list
        ;;
    package|publish)
        shift
        exec "$ROOT/scripts/aiko-release.sh" "$CMD" "$@"
        ;;
    -h|--help|help)
        cat <<'EOF'
Usage: ./install.sh [reinstall|from-release|build|list|package|publish]

  reinstall / install   Install latest local portable stack (no cargo).
  from-release          Same; pass --tag / --url / --path / --hash through.
  build                 Full from-source build + package + install (needs RAM).
  list                  Show local packages, remote releases, PATH binary.
  package               Assemble portable stack: Aiko+Neuron+Cell+Contract (all required).
  publish               Upload package + SHA256 sidecar (needs GITEA_TOKEN).

One verified product tarball; component-only installs are not supported.
SSOT: ~/.local/bin + ~/.aiko  (scripts/lib/aiko-env.sh).
EOF
        exit 0
        ;;
    *)
        echo "Unknown command: $CMD (see ./install.sh --help)" >&2
        exit 2
        ;;
esac
