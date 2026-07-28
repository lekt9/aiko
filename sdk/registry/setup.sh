#!/usr/bin/env bash
# Aiko one-line setup — installs contract + neuron + limbs from Gitea package registry
# Usage: curl -sL <url> | bash

set -euo pipefail

GITEA_URL="http://100.124.140.92:3000"
AIKO_HOME="${AIKO_HOME:-$HOME/.aiko}"
AIKO_BIN_DIR="${AIKO_BIN_DIR:-$HOME/.local/bin}"
AIKO_LIB_DIR="${AIKO_LIB_DIR:-$AIKO_HOME/lib}"

# Colors
C='\033[0;36m' G='\033[0;32m' Y='\033[1;33m' N='\033[0m'

echo -e "${C}╔══════════════════════════════════════╗${N}"
echo -e "${C}║${N}  Aiko Setup — Contract + Neuron + Limbs  ${C}║${N}"
echo -e "${C}╚══════════════════════════════════════╝${N}"
echo ""

# ─── Platform ───
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
[[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]] && ARCH="arm64"
[[ "$ARCH" == "x86_64" || "$ARCH" == "amd64" ]] && ARCH="x86_64"
PLATFORM="${OS}-${ARCH}"
echo -e "Platform: ${G}${PLATFORM}${N}"

# ─── Token ───
if [[ -z "${GITEA_TOKEN:-}" ]] && [[ -n "${1:-}" ]]; then
    GITEA_TOKEN="$1"
fi
if [[ -z "${GITEA_TOKEN:-}" ]]; then
    echo ""
    echo -e "${Y}Set GITEA_TOKEN to skip this prompt:${N}"
    echo "  export GITEA_TOKEN=your_token"
    echo ""
    read -rp "Gitea API token: " GITEA_TOKEN
fi

# ─── Dirs ───
mkdir -p "$AIKO_BIN_DIR" "$AIKO_LIB_DIR" "$AIKO_HOME/limbs"

# ─── Fetch versions ───
echo -e "\n${C}Fetching version manifest...${N}"
VERSIONS=$(curl -sfL -H "Authorization: token $GITEA_TOKEN" \
    "$GITEA_URL/Unbrowse/aiko-sdk/raw/branch/main/versions.lock")
CONTRACT_VER=$(echo "$VERSIONS" | grep "^contract=" | cut -d= -f2)
NEURON_VER=$(echo "$VERSIONS" | grep "^neuron=" | cut -d= -f2)
LIMBS_VER=$(echo "$VERSIONS" | grep "^neuron-limbs=" | cut -d= -f2)
echo "  contract: v${CONTRACT_VER}  neuron: v${NEURON_VER}  limbs: v${LIMBS_VER}"

# ─── Download function ───
download_and_extract() {
    local name="$1" version="$2" filename="$3" dest="$4" binary="${5:-}"
    echo -n "  ${name}... "
    local url="$GITEA_URL/api/packages/Unbrowse/generic/${name}/${version}/${filename}"
    local tmp="/tmp/aiko-${name}.tar.gz"
    if curl -sfL -H "Authorization: token $GITEA_TOKEN" -o "$tmp" "$url"; then
        tar -xzf "$tmp" -C "$dest" 2>/dev/null
        if [[ -n "$binary" ]]; then chmod +x "$dest/$binary" 2>/dev/null || true; fi
        rm -f "$tmp"
        local size=$(du -sh "$dest/${binary:-$filename}" 2>/dev/null | cut -f1)
        echo -e "${G}✓${N} ($size)"
    else
        echo -e "${Y}✗ not published for $PLATFORM${N}"
    fi
}

# ─── Install ───
echo -e "\n${C}Installing packages for ${PLATFORM}...${N}"
download_and_extract "contract" "$CONTRACT_VER" "libcontract-${CONTRACT_VER}-${PLATFORM}.tar.gz" "$AIKO_LIB_DIR" "libcontract.dylib"
download_and_extract "neuron" "$NEURON_VER" "neuron-${NEURON_VER}-${PLATFORM}.tar.gz" "$AIKO_BIN_DIR" "neuron"
download_and_extract "neuron-limbs" "$LIMBS_VER" "limbs.tar.gz" "$AIKO_HOME"

# ─── PATH ───
ADDED=""
if ! echo "$PATH" | grep -q "$AIKO_BIN_DIR"; then
    echo -e "\n${C}Adding ${AIKO_BIN_DIR} to PATH...${N}"
    echo "export PATH=\"$AIKO_BIN_DIR:\$PATH\"" >> "$HOME/.zshrc"
    echo "export PATH=\"$AIKO_BIN_DIR:\$PATH\"" >> "$HOME/.bashrc" 2>/dev/null || true
    export PATH="$AIKO_BIN_DIR:$PATH"
    ADDED="added to ~/.zshrc"
fi

if [[ -n "${CI:-}" ]]; then
    # CI: add to GITHUB_PATH
    echo "$AIKO_BIN_DIR" >> "${GITHUB_PATH:-/tmp/aiko-path}" 2>/dev/null || true
fi

# ─── Done ───
echo ""
echo -e "${G}╔══════════════════════════════════════╗${N}"
echo -e "${G}║${N}  Aiko stack installed!              ${G}║${N}"
echo -e "${G}╚══════════════════════════════════════╝${N}"
echo ""
echo "  neuron --help          neuron CLI"
echo "  ls ~/.aiko/lib/        libcontract.dylib"
echo "  ls ~/.aiko/limbs/      neuron limbs (preemptor, auto-attacher, etc.)"
echo "  export PATH=\"$AIKO_BIN_DIR:\$PATH\""
echo ""
if [[ -n "$ADDED" ]]; then
    echo -e "  (${G}${ADDED}${N} — restart your shell or run:)"
    echo "  source ~/.zshrc"
    echo ""
fi
echo "  To update later: curl -sL <url> | bash"
