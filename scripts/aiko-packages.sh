#!/bin/sh
# Compatible stack packages: neuron, contract, cell, optional control.
#   scripts/aiko-packages.sh check|list|install|update
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
chmod +x "$ROOT/scripts/aiko-packages.py" 2>/dev/null || true
exec python3 "$ROOT/scripts/aiko-packages.py" "$@"
