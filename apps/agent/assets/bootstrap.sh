#!/usr/bin/env bash
set -euo pipefail
umask 077
TASK_ROOT=/home/daytona/aiko
mkdir -p "$TASK_ROOT/operations"
if [ ! -x /home/daytona/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/daytona/.bun bash -s 'bun-v1.4.0'
fi
echo '[aiko-setup] runtime-ready'
if [ ! -x /usr/bin/chromium ] || [ ! -x /usr/bin/espeak-ng ] || [ ! -x /usr/bin/ffmpeg ] || [ ! -x /usr/bin/pdftotext ] || ! python3 -m venv --help >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium ffmpeg espeak-ng poppler-utils python3-venv ca-certificates fonts-liberation
  else
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium ffmpeg espeak-ng poppler-utils python3-venv ca-certificates fonts-liberation
  fi
fi
test -x /usr/bin/chromium
echo '[aiko-setup] chromium-ready'
/home/daytona/.bun/bin/bun --version
# The trusted VM computes response embeddings locally; only model files are cached.
cd "$TASK_ROOT"
if [ ! -f node_modules/@huggingface/transformers/package.json ] || ! /home/daytona/.bun/bin/bun -e 'if((await Bun.file("node_modules/@huggingface/transformers/package.json").json()).version!=="3.8.1")process.exit(1)' >/dev/null 2>&1; then
  /home/daytona/.bun/bin/bun add --exact @huggingface/transformers@3.8.1
fi

echo '[aiko-setup] dependencies-ready'
