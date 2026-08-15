#!/bin/sh
set -eu
# Rebuild telegram-daemon if missing or stale
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
AIKO_DIR="$REPO_ROOT/aiko"
BIN="$AIKO_DIR/target/release/telegram-daemon"
if [ -x "$BIN" ]; then
  echo "daemon exists at $BIN"
  ls -lh "$BIN" | awk '{print $5, $9}'
  exit 0
fi
echo "building telegram-daemon..."
cargo build --manifest-path "$AIKO_DIR/Cargo.toml" -p xai-telegram-daemon --bin telegram-daemon --release
ls -lh "$BIN"
