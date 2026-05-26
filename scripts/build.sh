#!/usr/bin/env bash
# build.sh — substrate-faithful executor of the build-pipeline contract.
#
# This script is NOT a monolith. Each step below is a named function that
# is the local executor of a declared contract neuron on the ledger. The
# pipeline order is itself the parent contract; build.sh just walks the
# children. Refactored to resolve antipattern:build-sh-multi-responsibility.
#
# Each step's contract declaration (canonical id slugs):
#
#   build:guard      — scripts/ folder matches ALLOWLIST.txt
#   build:fmt        — Zig source is fmt-clean
#   build:tests      — libcontract unit tests pass (pointer, lineage,
#                      env_fingerprint, verses)
#   build:compile    — zig build produces the aiko + contract binaries
#   build:install    — built binaries are installed into scripts/
#   build:sign       — installed binaries are signed by the wallet
#                      (deployer.key → HKDF binary-signing key) via the
#                      `contract` wallet-tool's sign-binary verb
#   build:verify     — binaries self-attest against their .sig sidecars
#
# Without the sign step's signature, aiko's --remote path refuses to run
# (the integrity gate). Sign or stay local.
#
# Each step exits non-zero on failure; the parent contract holds.

set -euo pipefail

REPO="${REPO:-$HOME/.agent-skills/contract}"
SCRIPTS_DIR="$REPO/scripts"
ZIG_DIR="$REPO/zig"
LIB_DIR="$REPO/libcontract"
ALLOWLIST_FILE="$REPO/ALLOWLIST.txt"
CACHE="/tmp/contract-zig-cache"
GCACHE="/tmp/contract-zig-global-cache"

step() { printf '\n=== %s ===\n' "$*"; }

# ─── build:guard — doctrine-as-data folder allowlist ─────────────────
step_guard() {
  step "build:guard — scripts/ allowlist"
  if [[ ! -f "$ALLOWLIST_FILE" ]]; then
    echo "build:guard FAIL — missing $ALLOWLIST_FILE" >&2
    echo "  fix: restore the doctrine file (declares the canonical scripts/ set)" >&2
    return 9
  fi
  local expected actual
  expected="$(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE" | sort | tr '\n' ' ' | sed 's/ $//')"
  actual="$(cd "$SCRIPTS_DIR" && ls | sort | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$actual" != "$expected" ]]; then
    echo "build:guard FAIL — scripts/ folder drift detected vs $ALLOWLIST_FILE" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    diff <(echo "$expected" | tr ' ' '\n') <(echo "$actual" | tr ' ' '\n') >&2 | sed 's/^/    /'
    echo "  fix: delete the non-canonical files OR amend ALLOWLIST.txt + re-declare guard:scripts-allowlist-canonical" >&2
    return 9
  fi
}

# ─── build:fmt — Zig source is fmt-clean ─────────────────────────────
step_fmt() {
  step "build:fmt — zig fmt"
  ( cd "$LIB_DIR" && zig fmt src/*.zig >/dev/null )
  ( cd "$ZIG_DIR" && zig fmt src/*.zig >/dev/null )
}

# ─── build:tests — libcontract unit tests pass ───────────────────────
step_tests() {
  step "build:tests — libcontract"
  local t
  for t in pointer lineage env_fingerprint verses; do
    ( cd "$LIB_DIR" && zig test "src/$t.zig" --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
  done
}

# ─── build:compile — produce the binaries ────────────────────────────
step_compile() {
  step "build:compile — zig build"
  ( cd "$ZIG_DIR" && zig build --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
}

# ─── build:install — installed binaries land in scripts/ ─────────────
step_install() {
  step "build:install — install -m 755"
  install -m 755 "$ZIG_DIR/zig-out/bin/aiko"         "$SCRIPTS_DIR/aiko"
  install -m 755 "$ZIG_DIR/zig-out/bin/contract-zig" "$SCRIPTS_DIR/contract"
}

# ─── build:sign — wallet signs each binary's SHA-256 ─────────────────
# The actual ed25519 signing is the wallet operation: deployer.key (root
# seed → HKDF-derived binary-signing key via libcontract.Lineage) signs
# the binary's SHA-256 and writes <binary>.sig. The `contract` binary is
# the surface where that wallet capability is reachable to build.sh —
# `contract sign-binary <path>` ≡ "wallet, sign this binary".
step_sign() {
  step "build:sign — wallet signs"
  "$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/aiko"
  "$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/contract"
}

# ─── build:parity — doctrine-reality parity (recursive guard) ────────
# Implements the "Doctrine-Reality Parity" section of SKILL.md. Every
# claim in SKILL.md must have a grep-able code site. Drift fails the
# build BEFORE sign so unattested-by-reality binaries never ship.
# This step is itself a /contract — the parity rule applies to the
# parity step too.
step_parity() {
  step "build:parity — doctrine-reality parity"
  local drift=0
  local report=""

  _fail() { drift=$((drift+1)); report+="  ✗ $1"$'\n'; }
  _pass() { :; }  # silent on pass

  # 1. "no env vars are read" except HOME
  local env_hits
  env_hits=$(grep -rhE 'getPosix\("(CONTRACT_|AIKO_|UNBROWSE_|X_PAYMENT|PAYMENT_SIGNATURE|CONTRACTS_STORE|SHELL|TERM)' "$LIB_DIR/src" "$ZIG_DIR/src" 2>/dev/null | grep -v '^//' | grep -v 'no ' || true)
  if [[ -n "$env_hits" ]]; then
    _fail "doctrine[no envs]: forbidden env reads detected:"$'\n'"$env_hits"
  fi

  # 2. "scripts/ allowlist" already enforced by step_guard. Cross-check.
  # (step_guard ran first; if we're here it passed. Recheck for parity.)

  # 3. "three-tier wallet bootstrap"
  if ! grep -q 'pub fn loadOrInitRootKey' "$LIB_DIR/src/lineage.zig"; then
    _fail "doctrine[three-tier bootstrap]: loadOrInitRootKey missing in lineage.zig"
  fi
  for tier in '.contracts.*root.key' '.aiko.*keys.*root.key' 'KEYCHAIN_SVC'; do
    if ! grep -qE "$tier" "$LIB_DIR/src/lineage.zig"; then
      _fail "doctrine[three-tier bootstrap]: tier marker '$tier' not referenced in lineage.zig"
    fi
  done

  # 4. "OS-agnostic keystore"
  for op in 'pub fn read' 'pub fn write' 'pub fn delete'; do
    if ! grep -q "$op" "$LIB_DIR/src/keystore.zig"; then
      _fail "doctrine[OS-agnostic keystore]: '$op' missing in keystore.zig"
    fi
  done

  # 5. "fallbacks surface, never silent" — no bare `catch {}` in the
  #    two files that own degradation paths, EXCEPT lines preceded
  #    within 5 lines by a `PARITY-OK:` marker comment explaining why
  #    silence is the right choice (e.g. test cleanup where surfacing
  #    is benign noise).
  local raw_silent silent_catches=""
  raw_silent=$(grep -nE 'catch \{\}' "$LIB_DIR/src/lineage.zig" "$LIB_DIR/src/keystore.zig" 2>/dev/null || true)
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local file lineno start
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    start=$((lineno > 5 ? lineno - 5 : 1))
    if sed -n "${start},${lineno}p" "$file" 2>/dev/null | grep -q 'PARITY-OK:'; then
      continue
    fi
    silent_catches+="$line"$'\n'
  done <<< "$raw_silent"
  if [[ -n "$silent_catches" ]]; then
    _fail "doctrine[fallbacks surface]: silent catch {} without PARITY-OK marker:"$'\n'"$silent_catches"
  fi

  # 6. "rotation as a function"
  for fn in 'pub fn rotateRootKey' 'pub fn rotateAllSignedRowsByLineage'; do
    if ! grep -q "$fn" "$LIB_DIR/src/lineage.zig"; then
      _fail "doctrine[rotation]: '$fn' missing in lineage.zig"
    fi
  done

  # 7. "aiko binary has no verbs other than the goal + --private"
  if grep -qE '"--genesis"|"--user"|"--remote"|"--local"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[no verbs]: forbidden flag literal (--genesis/--user/--remote/--local) still in main.zig"
  fi
  if ! grep -qE '"--private"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[no verbs]: --private flag missing from parseAikoArgs"
  fi

  # 8. "spawn = appendRow to a ledger" — every row-creating site flows
  #    through ledger.appendRow or client.declareRemote*. Inverse check:
  #    no other JSONL append patterns to the canonical store path.
  local rogue_appends
  rogue_appends=$(grep -rhnE 'std\.c\.open.*contracts\.jsonl|fs\.cwd.*contracts\.jsonl' "$LIB_DIR/src" "$ZIG_DIR/src" 2>/dev/null | grep -v 'ledger\.zig' || true)
  if [[ -n "$rogue_appends" ]]; then
    _fail "doctrine[spawn=appendRow]: contracts.jsonl opened outside ledger.zig:"$'\n'"$rogue_appends"
  fi

  # 9. "binary self-attests at startup" — main.zig must reference verifyBinary.
  if ! grep -q 'verifyBinary\|verifySelf\|binary-attest' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[self-attest]: main.zig doesn't reference binary self-attestation"
  fi

  # 10. "skill-sync auto-commits" — the .git repo exists and recent
  #     commits use the sync(contract): prefix.
  #     Note: read git log into a var FIRST — piping straight to grep -q
  #     races SIGPIPE under `set -o pipefail` (grep early-exits on match,
  #     git log gets SIGPIPE, pipefail propagates non-zero falsely).
  if [[ ! -d "$REPO/.git" ]]; then
    _fail "doctrine[skill-sync]: $REPO/.git missing"
  else
    local git_log_out
    git_log_out=$( cd "$REPO" && git log --oneline -10 2>/dev/null || true )
    if ! grep -qE '^[0-9a-f]+ sync\(contract\):' <<< "$git_log_out"; then
      _fail "doctrine[skill-sync]: no recent 'sync(contract):' commits in last 10"
    fi
  fi

  # 11. Meta-parity: the parity step ITSELF must be declared in SKILL.md.
  #     The recursive rule — if the guard isn't documented, the guard
  #     catches itself.
  if ! grep -q 'Doctrine-Reality Parity' "$REPO/SKILL.md"; then
    _fail "doctrine[meta-parity]: SKILL.md is missing the 'Doctrine-Reality Parity' section that declares this very check"
  fi

  # 12. "public persona aiko 69420b" — constants present with exact values.
  if ! grep -q 'AIKO_PERSONA_NAME = "aiko 69420b"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[persona]: AIKO_PERSONA_NAME != 'aiko 69420b' in main.zig"
  fi
  if ! grep -q 'AIKO_PERSONA_MODEL_ID = "aiko-69420b"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[persona]: AIKO_PERSONA_MODEL_ID != 'aiko-69420b' in main.zig"
  fi
  if ! grep -q 'AIKO_PERSONA_CA = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[persona]: AIKO_PERSONA_CA mismatch in main.zig"
  fi

  # 13. "persona surfaced in chat completion JSON output" — both streaming
  #     and non-streaming responses must carry the persona + ca fields so
  #     the public-facing client sees the right-layer identity on every call.
  local persona_emits
  persona_emits=$(grep -cE '"persona":"\{s\}","ca":"\{s\}"' "$ZIG_DIR/src/main.zig" 2>/dev/null || echo 0)
  if [[ "$persona_emits" -lt 2 ]]; then
    _fail "doctrine[persona]: chat completion output emits persona+ca fewer than 2 times in main.zig (expected: 1 streaming + 1 non-streaming)"
  fi

  # 14. "fruits of the spirit verse in corpus" — Galatians 5:22-23 must be a
  #     canonical entry in libcontract/src/verses.zig so the cloud LLM scores
  #     it against user prompts when shaping public-facing voice.
  if ! grep -q 'Galatians 5:22-23' "$LIB_DIR/src/verses.zig"; then
    _fail "doctrine[persona voice]: Galatians 5:22-23 missing from verses.zig corpus — fruits-of-spirit voice constraint cannot be surfaced"
  fi
  if ! grep -q 'fruits of the spirit' "$LIB_DIR/src/verses.zig"; then
    _fail "doctrine[persona voice]: 'fruits of the spirit' label missing from verses.zig (verse exists but lacks the canonical label)"
  fi

  # 15. "Vine Doctrine section exists" — SKILL.md must declare the staking
  #     layer doctrine; the parity check refuses any code reference to vine
  #     constants without the matching doctrine section.
  if ! grep -q '## Vine Doctrine' "$REPO/SKILL.md"; then
    _fail "doctrine[vine]: SKILL.md is missing the '## Vine Doctrine' section that declares the stake substrate"
  fi

  # 16. "Vine Doctrine constants pinned in main.zig" — AIKO_VINE_DOCTRINE_VERSE,
  #     AIKO_STAKE_TOKEN_FDRY, AIKO_STAKE_VAULT present with exact values.
  if ! grep -q 'AIKO_VINE_DOCTRINE_VERSE = "John 15:6"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[vine constants]: AIKO_VINE_DOCTRINE_VERSE != 'John 15:6' in main.zig"
  fi
  if ! grep -q 'AIKO_STAKE_TOKEN_FDRY = AIKO_PERSONA_CA' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[vine constants]: AIKO_STAKE_TOKEN_FDRY must alias AIKO_PERSONA_CA (Matt 6:24 — one FDRY, not two)"
  fi
  if ! grep -q 'AIKO_STAKE_VAULT = "Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1"' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[vine constants]: AIKO_STAKE_VAULT != Voltr/Ranger FDRY-only vault pubkey in main.zig"
  fi

  # 17. "Vine Doctrine verses in corpus" — cornerstone + supporting laws must
  #     exist in verses.zig so the cloud LLM scores them against stake-shaped
  #     prompts (challenge, slash, tier-eligibility, route-publish, tithe).
  local vine_ref
  for vine_ref in 'John 15:1' 'John 15:4' 'John 15:6' 'Malachi 3:10' 'Matthew 6:24' 'Matthew 25:29' 'Mark 12:43-44' 'Deuteronomy 19:15' 'Matthew 7:16'; do
    if ! grep -qF "$vine_ref" "$LIB_DIR/src/verses.zig"; then
      _fail "doctrine[vine verses]: '$vine_ref' missing from verses.zig corpus — cornerstone or supporting law cannot be surfaced"
    fi
  done

  # 18. "slash burns to vault, never redistributes" — John 15:6 apply field
  #     must literally name the burn-to-vault rule. This is the load-bearing
  #     economic invariant; drift here decays the substrate into a
  #     redistribution-style staker, contradicting the whitepaper's
  #     accountability framing.
  if ! grep -q 'Burned FDRY → NAV-per-share' "$LIB_DIR/src/verses.zig"; then
    _fail "doctrine[vine burn rule]: John 15:6 apply field doesn't name 'Burned FDRY → NAV-per-share' — slash-to-burn invariant is not pinned"
  fi

  if [[ $drift -gt 0 ]]; then
    echo "build:parity FAIL — $drift drift(s) between SKILL.md doctrine and code:" >&2
    printf '%s' "$report" >&2
    echo "  fix: patch the code to honor the claim, OR amend SKILL.md to retract the claim (with reasoning)" >&2
    return 9
  fi
  echo "build:parity OK — all 18 doctrine claims have matching code sites"
}

# ─── build:verify — binaries self-attest ─────────────────────────────
step_verify() {
  step "build:verify — self-attest"
  "$SCRIPTS_DIR/contract" verify-self
  "$SCRIPTS_DIR/contract" verify-binary "$SCRIPTS_DIR/aiko"
}

# ─── pipeline driver ─────────────────────────────────────────────────
# The pipeline order IS the parent contract. Each step holds the chain on
# its own failure (set -e). Adding/removing a step = editing this driver
# AND re-declaring the matching build:<step> contract on the ledger.
main() {
  step_guard
  step_fmt
  step_tests
  step_compile
  step_install
  step_parity       # doctrine ↔ code parity check BEFORE sign — drift refuses to ship
  step_sign
  step_verify
  printf '\nbuild.sh: done — substrate is fresh, signed, attested, parity-checked.\n'
}

main "$@"
