#!/usr/bin/env bash
#
# verify-signer.sh — pre-flight check for "do we hold the signing key for
# wallet pubkey X?" Run this BEFORE publishing any wallet address (QR,
# plain-text, deposit instruction) to a user for fund deposit.
#
# Origin: 2026-05-23. Agent gave Lewis a QR for Solana pubkey
#   6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn
# whose documented keypair file ~/.unbrowse/platform-wallet.json was
# missing. $100 of SOL landed at a wallet with no local signer. This
# script makes that class of mistake mechanically impossible at the
# substrate layer.
#
# Usage:
#   bash verify-signer.sh <target-pubkey-base58>
#
# Exit codes:
#   0  — PASS: at least one readable keypair on disk derives to the
#        target pubkey. The matching path is printed to stdout.
#   1  — FAIL: no candidate matched. Refuse to publish the address.
#   2  — usage error
#
# Where it looks for candidate keypairs:
#   - paths in env $SOLANA_KEYPAIR_PATHS (colon-separated, like PATH)
#   - default common locations: ~/.config/solana/id.json,
#     ~/.unbrowse/platform-wallet.json, ~/.fdry/hot-wallet.json,
#     and any other path listed in env $SIGNER_HUNT_PATHS
#   - base58 secrets in env vars whose name ends in _KEY (loaded from
#     .env-style files via env $SIGNER_HUNT_ENV_FILES — colon-separated)
#
# The script NEVER prints secret material. On match it prints only:
#   PASS signer <pubkey> <path-or-env-var-name>
# On miss:
#   FAIL signer <pubkey> none-of-<N>-candidates-matched
#
# Composition: substrate-level safety primitive. Bundled with /contract
# because the pre-flight rule (don't publish an address without a signer)
# is fractal — it applies in every project that does any wallet flow.

set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: verify-signer.sh <target-pubkey-base58>" >&2
  exit 2
fi

TARGET="$1"

# Validate target is plausibly base58 (Solana pubkeys are 32-44 chars b58)
if ! [[ "$TARGET" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  echo "FAIL signer $TARGET invalid-base58-format" >&2
  exit 1
fi

# Build candidate-paths list
CANDIDATE_PATHS=()
DEFAULTS=(
  "$HOME/.config/solana/id.json"
  "$HOME/.unbrowse/platform-wallet.json"
  "$HOME/.fdry/hot-wallet.json"
  "$HOME/.config/unbrowse/vault.key"
)
for p in "${DEFAULTS[@]}"; do
  [[ -f "$p" ]] && CANDIDATE_PATHS+=("$p")
done

# Env-driven additions (colon-separated)
if [[ -n "${SOLANA_KEYPAIR_PATHS:-}" ]]; then
  IFS=':' read -ra extra_paths <<< "$SOLANA_KEYPAIR_PATHS"
  for p in "${extra_paths[@]}"; do [[ -f "$p" ]] && CANDIDATE_PATHS+=("$p"); done
fi
if [[ -n "${SIGNER_HUNT_PATHS:-}" ]]; then
  IFS=':' read -ra extra_paths <<< "$SIGNER_HUNT_PATHS"
  for p in "${extra_paths[@]}"; do [[ -f "$p" ]] && CANDIDATE_PATHS+=("$p"); done
fi

CANDIDATE_COUNT="${#CANDIDATE_PATHS[@]}"

# Try each candidate — derive pubkey, compare
# Python derives the pubkey from either:
#   - Solana JSON keypair (64-byte array; bytes[32..64] = pubkey)
#   - base58-encoded 64-byte secret (.b58 format)
match=""
if [[ "$CANDIDATE_COUNT" -gt 0 ]]; then
  match=$(python3 - "$TARGET" "${CANDIDATE_PATHS[@]}" <<'PY' || true
import sys, json, base58
target = sys.argv[1]
for path in sys.argv[2:]:
    try:
        with open(path, 'r') as f:
            raw = f.read().strip()
        bytes_arr = None
        # Solana CLI JSON format: array of 64 ints
        if raw.startswith('['):
            try:
                arr = json.loads(raw)
                if isinstance(arr, list) and len(arr) == 64:
                    bytes_arr = bytes(arr)
            except Exception:
                pass
        # Base58 string format (64 bytes encoded ~88 chars)
        if bytes_arr is None:
            try:
                cand = base58.b58decode(raw)
                if len(cand) == 64:
                    bytes_arr = cand
            except Exception:
                pass
        if bytes_arr is None:
            continue
        pub = base58.b58encode(bytes_arr[32:64]).decode()
        if pub == target:
            print(path)
            sys.exit(0)
    except Exception:
        continue
sys.exit(1)
PY
)
fi

if [[ -n "$match" ]]; then
  echo "PASS signer $TARGET $match"
  exit 0
fi

# Env-var fallback — check vars whose names end in _KEY in declared .env files
ENV_MATCH=""
if [[ -n "${SIGNER_HUNT_ENV_FILES:-}" ]]; then
  IFS=':' read -ra envfiles <<< "$SIGNER_HUNT_ENV_FILES"
  for f in "${envfiles[@]}"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^([A-Z_]+_KEY)=(.+)$ ]] || continue
      varname="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      # Strip surrounding quotes
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      derived=$(python3 - "$val" "$TARGET" <<'PY' 2>/dev/null || true
import sys, base58, binascii
val, target = sys.argv[1], sys.argv[2]
bytes_arr = None
# hex (128 chars) — common for Solana secrets pasted as hex
try:
    if len(val) == 128:
        bytes_arr = bytes.fromhex(val)
except Exception:
    pass
# base58 (~88 chars)
if bytes_arr is None:
    try:
        cand = base58.b58decode(val)
        if len(cand) == 64:
            bytes_arr = cand
    except Exception:
        pass
if bytes_arr and len(bytes_arr) == 64:
    pub = base58.b58encode(bytes_arr[32:64]).decode()
    if pub == target:
        print(pub)
PY
)
      if [[ -n "$derived" ]]; then
        ENV_MATCH="env:$varname (in $f)"
        break 2
      fi
    done < "$f"
  done
fi

if [[ -n "$ENV_MATCH" ]]; then
  echo "PASS signer $TARGET $ENV_MATCH"
  exit 0
fi

echo "FAIL signer $TARGET none-of-${CANDIDATE_COUNT}-candidates-matched"
exit 1
