#!/usr/bin/env bash
# Install the resume queue onto this machine (the Steam Deck).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
STATE="${HOME}/.local/state/session-resume-queue"
mkdir -p "$BIN" "$UNIT_DIR" "$STATE/logs"

ln -sfn "$ROOT/inventory.py" "$BIN/srq-inventory"
ln -sfn "$ROOT/jobqueue.py" "$BIN/srq-queue"
ln -sfn "$ROOT/dispatch.py" "$BIN/srq-dispatch"
ln -sfn "$ROOT/witness.py" "$BIN/srq-witness"

sed "s|@ROOT@|$ROOT|g" "$ROOT/systemd/session-resume-queue.service" \
  > "$UNIT_DIR/session-resume-queue.service"

systemctl --user daemon-reload
systemctl --user enable --now session-resume-queue.service
echo "installed session-resume-queue.service"
systemctl --user --no-pager --full status session-resume-queue.service | head -20
