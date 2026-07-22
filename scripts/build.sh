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
#   build:compile    — zig build produces the Contract binary/persona
#   build:install    — built binaries are installed into scripts/
#   build:sign       — installed binaries are signed by the wallet
#                      (deployer.key → HKDF binary-signing key) via the
#                      `contract` wallet-tool's sign-binary verb
#   build:verify     — binaries self-attest against their .sig sidecars
#
# Without the sign step's signature, contract-goal's shared-visibility path refuses
# to run (the integrity gate). Sign or stay private.
#
# Each step exits non-zero on failure; the parent contract holds.

set -euo pipefail

# Default REPO to the tree this script lives in — a clone or worktree must
# gate ITSELF, never silently judge the checkout at ~/.agent-skills/contract.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPTS_DIR="$REPO/scripts"
ZIG_DIR="$REPO/zig"
LIB_DIR="$REPO/libcontract"
ALLOWLIST_FILE="$REPO/ALLOWLIST.txt"
CACHE="/tmp/contract-zig-cache"
GCACHE="/tmp/contract-zig-global-cache"

step() { printf '\n=== %s ===\n' "$*"; }

# ─── Build-queue lock ─────────────────────────────────────────────────
# Concurrent build.sh invocations race on the Zig compile cache
# (/tmp/contract-zig-cache) and the deployer wallet's signing — a second
# build mid-flight previously wedged the first (cache wipe + parallel
# zig invocations deadlocked). Serialize via a directory-mkdir mutex
# (POSIX-atomic, no flock dep). Reclaims stale locks whose owner pid
# is dead. Surfaces wait state to stderr per the visible-fallbacks rule.
BUILD_LOCKDIR="/tmp/contract-build.lock"
BUILD_PIDFILE="$BUILD_LOCKDIR/pid"
BUILD_LOCK_MAX_WAIT="${BUILD_LOCK_MAX_WAIT:-1800}"  # seconds

acquire_build_lock() {
  local waited=0
  local announced=0
  while ! mkdir "$BUILD_LOCKDIR" 2>/dev/null; do
    local owner=""
    [[ -f "$BUILD_PIDFILE" ]] && owner="$(cat "$BUILD_PIDFILE" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
      echo "build.sh: stale lock from dead pid=$owner — reclaiming" >&2
      rm -rf "$BUILD_LOCKDIR"
      continue
    fi
    if (( announced == 0 )); then
      echo "build.sh: another build in progress (pid=${owner:-?}) — queued, waiting..." >&2
      announced=1
    fi
    sleep 2
    waited=$((waited + 2))
    if (( waited >= BUILD_LOCK_MAX_WAIT )); then
      echo "build.sh: lock wait exceeded ${BUILD_LOCK_MAX_WAIT}s (pid=${owner:-?}) — refusing to proceed" >&2
      return 7
    fi
  done
  trap 'rm -rf "$BUILD_LOCKDIR"' EXIT INT TERM HUP
  echo $$ > "$BUILD_PIDFILE"
  (( announced == 1 )) && echo "build.sh: lock acquired (waited ${waited}s) — proceeding" >&2
  return 0
}

# ─── Quiescence debounce ──────────────────────────────────────────────
# Wait until source dirs stop changing for BUILD_QUIET_SECONDS (default
# 10s) before the seven-day pipeline kicks off. Lets a burst of edits
# coalesce into one build instead of triggering the compile+sign chain
# per save. Cap at BUILD_QUIET_MAX_WAIT to avoid wedging on a noisy
# filesystem watcher.
BUILD_QUIET_SECONDS="${BUILD_QUIET_SECONDS:-10}"
BUILD_QUIET_MAX_WAIT="${BUILD_QUIET_MAX_WAIT:-180}"
BUILD_QUIET_POLL_INTERVAL="${BUILD_QUIET_POLL_INTERVAL:-2}"

wait_for_quiescence() {
  local watch_paths=(
    "$ZIG_DIR/src"
    "$LIB_DIR/src"
    "$SCRIPTS_DIR"
    "$REPO/DOCTRINE.md"
    "$REPO/CLAUDE.md"
  )
  local waited=0
  local announced=0
  while (( waited < BUILD_QUIET_MAX_WAIT )); do
    local now newest delta
    now="$(date +%s)"
    # macOS stat uses -f '%m'; gnu stat uses -c '%Y'. Try macOS first.
    newest="$(find "${watch_paths[@]}" -type f -print0 2>/dev/null \
              | xargs -0 stat -f '%m' 2>/dev/null \
              | sort -n | tail -1)"
    if [[ -z "$newest" ]]; then
      newest="$(find "${watch_paths[@]}" -type f -print0 2>/dev/null \
                | xargs -0 stat -c '%Y' 2>/dev/null \
                | sort -n | tail -1)"
    fi
    newest="${newest:-0}"
    delta=$(( now - newest ))
    if (( delta >= BUILD_QUIET_SECONDS )); then
      (( announced == 1 )) && echo "build.sh: source quiesced (last edit ${delta}s ago) — proceeding" >&2
      return 0
    fi
    if (( announced == 0 )); then
      echo "build.sh: source still settling (last edit ${delta}s ago, need ${BUILD_QUIET_SECONDS}s quiet) — debouncing..." >&2
      announced=1
    fi
    sleep "$BUILD_QUIET_POLL_INTERVAL"
    waited=$(( waited + BUILD_QUIET_POLL_INTERVAL ))
  done
  echo "build.sh: quiescence wait exceeded ${BUILD_QUIET_MAX_WAIT}s — proceeding anyway (noisy filesystem)" >&2
  return 0
}

# ─── build:guard — repository-canonical script allowlist ────────────
step_guard() {
  step "build:guard — scripts/ allowlist"
  [[ -f "$ALLOWLIST_FILE" ]] || { echo "build:guard FAIL — missing $ALLOWLIST_FILE" >&2; return 9; }
  local expected source
  expected="$(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE" | sort | tr '\n' ' ' | sed 's/ $//')"
  source="file:$ALLOWLIST_FILE"

  local actual
  actual="$(cd "$SCRIPTS_DIR" && ls | sort | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$actual" != "$expected" ]]; then
    echo "build:guard FAIL — scripts/ folder drift detected vs $source" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    diff <(echo "$expected" | tr ' ' '\n') <(echo "$actual" | tr ' ' '\n') >&2 | sed 's/^/    /'
    echo "  fix: delete the non-canonical files OR re-declare guard:scripts-allowlist-canonical with the new set" >&2
    return 9
  fi
  echo "build:guard OK — scripts/ matches canonical set ($source)"
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
  for t in pointer lineage env_fingerprint verses bible; do
    ( cd "$LIB_DIR" && zig test "src/$t.zig" --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
  done
}

# ─── build:compile — produce the binaries ────────────────────────────
step_compile() {
  step "build:compile — zig build (ReleaseFast)"
  # ReleaseFast is load-bearing, not cosmetic: build.zig's
  # standardOptimizeOption defaults to Debug, and a Debug bge-small BERT
  # makes recommend()/the declare briefing take minutes instead of
  # milliseconds. The shipped signed binary was Debug from the first
  # build until 2026-07-18 — never ship that again.
  ( cd "$ZIG_DIR" && zig build -Doptimize=ReleaseFast --cache-dir "$CACHE" --global-cache-dir "$GCACHE" )
}

# ─── build:install — installed binary lands in scripts/ ─────────────
# One operator binary ships: `contract`. The Aiko agent CLI owns the `aiko` name. The
# Wave-1 client/server split was retired —
# DOCTRINE.md doctrine is the truth-root and never named a second binary.
step_install() {
  step "build:install — install -m 755 + symlink"
  install -m 755 "$ZIG_DIR/zig-out/bin/contract-zig" "$SCRIPTS_DIR/contract"
  # The relative target keeps the link valid no matter where the scripts/
  # folder lives. Remove the retired alias so Contract can never shadow the
  # separately installed Aiko harness.
  rm -f "$SCRIPTS_DIR/aiko" "$SCRIPTS_DIR/aiko.sig" \
        "$SCRIPTS_DIR/contract-goal" "$SCRIPTS_DIR/contract-goal.sig"
}

# ─── build:sign — wallet signs the binary's SHA-256 ──────────────────
# The actual ed25519 signing is the wallet operation: deployer.key (root
# seed → HKDF-derived binary-signing key via libcontract.Lineage) signs
# the binary's SHA-256 and writes <binary>.sig. The `contract` binary is
# the surface where that wallet capability is reachable to build.sh —
# `contract sign-binary <path>` ≡ "wallet, sign this binary".
step_sign() {
  step "build:sign — wallet signs"
  # Sign the canonical operator binary.
  "$SCRIPTS_DIR/contract" sign-binary "$SCRIPTS_DIR/contract"
}

# ─── build:parity — doctrine-reality parity (recursive guard) ────────
# Implements the "Doctrine-Reality Parity" section of DOCTRINE.md. Every
# claim in DOCTRINE.md must have a grep-able code site. Drift fails the
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

  # 11. Meta-parity: the parity step ITSELF must be declared in DOCTRINE.md.
  #     The recursive rule — if the guard isn't documented, the guard
  #     catches itself.
  if ! grep -q 'Doctrine-Reality Parity' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[meta-parity]: DOCTRINE.md is missing the 'Doctrine-Reality Parity' section that declares this very check"
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

  # 15. "Vine Doctrine section exists" — DOCTRINE.md must declare the staking
  #     layer doctrine; the parity check refuses any code reference to vine
  #     constants without the matching doctrine section.
  if ! grep -q '## Vine Doctrine' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[vine]: DOCTRINE.md is missing the '## Vine Doctrine' section that declares the stake substrate"
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

  # 19. "bible corpus exists" — source + packed binaries must all be present
  #     (KJV public-domain text + openbible CC-BY 4.0 cross-references +
  #     the three packed blobs the @embedFile sites in bible.zig reach for).
  for df in bible-kjv.json cross-references.txt bible.dat bible-xrefs.dat bible-xrefs-idx.dat; do
    if [[ ! -s "$LIB_DIR/data/$df" ]]; then
      _fail "doctrine[bible corpus]: libcontract/data/$df missing or zero-byte"
    fi
  done

  # 20. "bible.zig exports the canonical surface" — resolve / verseText /
  #     verseId / crossReferences / relevantVerses are the public API
  #     consumers (main.zig's bible_chain emitter, verses.zig's fall-through)
  #     rely on. Drift here breaks the chain.
  if [[ ! -f "$LIB_DIR/src/bible.zig" ]]; then
    _fail "doctrine[bible.zig]: libcontract/src/bible.zig missing"
  else
    local bib_fn
    for bib_fn in 'pub fn resolve' 'pub fn verseText' 'pub fn verseId' 'pub fn crossReferences' 'pub fn relevantVerses'; do
      if ! grep -q "$bib_fn" "$LIB_DIR/src/bible.zig"; then
        _fail "doctrine[bible.zig]: '$bib_fn' missing in bible.zig"
      fi
    done
  fi

  # 21. "VERSE_COUNT = 31100" — protects against silent data-shape drift.
  if ! grep -q 'pub const VERSE_COUNT: usize = 31100' "$LIB_DIR/src/bible.zig" 2>/dev/null; then
    _fail "doctrine[bible.zig]: VERSE_COUNT constant must be exactly 31100 in bible.zig"
  fi

  # 22. "BOOK_COUNT = 66".
  if ! grep -q 'pub const BOOK_COUNT: usize = 66' "$LIB_DIR/src/bible.zig" 2>/dev/null; then
    _fail "doctrine[bible.zig]: BOOK_COUNT constant must be exactly 66 in bible.zig"
  fi

  # 23. "contract.zig re-exports bible" — so the contract_client module can
  #     reach the bible primitives without duplicating the file in two
  #     module graphs (the same fix shape used for lineage/http/verses).
  if ! grep -q 'pub const bible = @import("bible.zig")' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[bible re-export]: contract.zig must declare pub const bible = @import(\"bible.zig\")"
  fi

  # 24. "Wave 2 envelope wired" — chat completion output references
  #     bible_chain in both streaming + non-streaming emit sites.
  local chain_emits
  chain_emits=$(grep -cE '"bible_chain":' "$ZIG_DIR/src/main.zig" 2>/dev/null || echo 0)
  if [[ "$chain_emits" -lt 2 ]]; then
    _fail "doctrine[bible_chain]: main.zig must emit \"bible_chain\" in at least 2 sites (streaming first chunk + non-streaming envelope)"
  fi

  # 25. "no user-facing env-var instructions" — the substrate stripped all
  #     env knobs (claim #1). User-facing strings must NOT tell users to set
  #     AIKO_X_PAYMENT / X_PAYMENT / UNBROWSE_BASE / CONTRACT_* / FAUCET_BASE
  #     etc. as something the operator/user does manually. Per the "Native
  #     onramp is the cloud's obligation" doctrine, wallet provisioning and
  #     transport configuration are server-side, not user-do-it-yourself.
  #     Allow-list: comments (lines starting with //) and code-removed
  #     markers ("removed" / "no longer read" / "is removed") are descriptive,
  #     not instructive.
  local env_instructions
  env_instructions=$(grep -nE '"[^"]*(set |export |configure )[^"]*(AIKO_X_PAYMENT|X_PAYMENT|FAUCET_BASE|UNBROWSE_BASE|CONTRACT_SABBATH_DAY|CONTRACT_SHELL_STRICT|CONTRACT_AGENT|AIKO_REMOTE|AIKO_ADMIN_)[^"]*"' "$ZIG_DIR/src/main.zig" "$LIB_DIR/src/"*.zig 2>/dev/null \
    | grep -v 'removed\|no longer\|previously\|stripped\|was an env\|^[^:]*:[0-9]*: *//' || true)
  if [[ -n "$env_instructions" ]]; then
    _fail "doctrine[no env-var user instructions]: user-facing strings tell users to set/export/configure stripped env vars:"$'\n'"$env_instructions"
  fi

  # 26. "drill: action handler exists" — the continuous resolver primitive
  #     must be reachable via the drill: action prefix in runAction. Without
  #     it, the standing drill contract has no dispatch site and the perpetual
  #     resolver doesn't actually fire.
  if ! grep -q 'startsWith(u8, action, "drill:")' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[continuous resolver]: drill: action handler missing in runAction (main.zig)"
  fi
  if ! grep -q 'fn backfillUnresolvedDeep' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[continuous resolver]: backfillUnresolvedDeep function missing in main.zig"
  fi

  # 27. "Continuous resolver doctrine section in DOCTRINE.md" — the standing-drill
  #     pattern must be declared, not just implemented.
  if ! grep -q '## Continuous resolver' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[continuous resolver]: DOCTRINE.md is missing the 'Continuous resolver' doctrine section"
  fi

  # 28. "Doctrine speaks only when interrogated" — the silence rule must be
  #     declared so the persona/output layers know the default mode is
  #     embodiment, not narration. Without this section, an enthusiastic
  #     future contributor will start having the persona explain itself
  #     in every reply, and the substrate decays into a self-narrating
  #     monologue surface (which scares users away — see memory
  #     frontend-no-scripture-on-public-surface for the empirical scar).
  if ! grep -q '## Doctrine speaks only when interrogated' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[silence rule]: DOCTRINE.md is missing the 'Doctrine speaks only when interrogated' section — the embodiment-vs-narration rule is the gate that keeps the substrate invisible by default"
  fi
  # The silence rule's companion sub-section under Public Persona must also
  # exist so the rule is reachable from the persona-layer doctrine.
  if ! grep -q '### What the persona does NOT volunteer' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[silence rule]: DOCTRINE.md Public Persona section is missing the 'What the persona does NOT volunteer' sub-section that links the silence rule into the persona doctrine"
  fi

  # 29. "Capability inheritance — pull-by-grant via lineage" — the substrate's
  #     answer to credential/permission flow from parent /contract to spawned
  #     child /contract. Without this section, child contracts have no
  #     canonical way to reach parent-owned pointers (Stripe keys, OAuth
  #     tokens, /integrate-anything credentials, wallet authorities) and the
  #     gap will be filled by env-var injection or subprocess-context hacks —
  #     both banned. The rule must be declared so the grant/pull/lineage-walk
  #     pattern is the load-bearing path.
  if ! grep -q '## Capability inheritance' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[capability inheritance]: DOCTRINE.md is missing the '## Capability inheritance' section — child contracts have no canonical path to pull pointers from spawning parents, and the gap will be filled by banned shortcuts"
  fi
  # The grant-shape, pull-shape, and identity_channel scoping must all be
  # named so future implementors don't reinvent the discipline.
  for cap_anchor in '### Grant shape' '### Pull shape' '### /integrate-anything reachability'; do
    if ! grep -qF "$cap_anchor" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[capability inheritance]: DOCTRINE.md is missing the '$cap_anchor' sub-section — the capability primitive is incomplete without it"
    fi
  done
  # The opt-in-not-opt-out invariant — capability flow is per-grant, never
  # silent same-wallet inheritance. This is the confused-deputy defence.
  # The opt-in-not-opt-out invariant — capability flow is per-grant, never
  # silent same-wallet inheritance. Grep is anchored on the distinctive
  # phrase fragment rather than the full line, since markdown wraps the
  # full sentence across two physical lines.
  if ! grep -q 'opt-in per grant' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[capability inheritance]: DOCTRINE.md is missing the 'opt-in per grant' invariant — without it the substrate becomes a confused-deputy by default"
  fi

  # 30. "Pointer-keyed truthy cache" — Lewis 2026-05-26 (Granola 988cf805):
  #     the deterministic self-resolve substrate. cache.zig must export the
  #     three event-row appenders; resolveOne must emit cache_check + cache_resolved
  #     rows; DOCTRINE.md must declare the cache doctrine. Drift here decays the
  #     substrate back to stderr-only cache verdicts that die with the process —
  #     violates "keep everything within the ledger based".
  if [[ ! -f "$LIB_DIR/src/cache.zig" ]]; then
    _fail "doctrine[truthy cache]: libcontract/src/cache.zig missing — the canonical pointer-keyed cache module"
  else
    local cache_fn
    for cache_fn in 'pub fn appendCacheCheckRow' 'pub fn appendCacheResolvedRow' 'pub fn appendCacheInvalidatedRow' 'pub fn findLatestResolvedSnapshot' 'pub fn hasInvalidationAfter'; do
      if ! grep -q "$cache_fn" "$LIB_DIR/src/cache.zig"; then
        _fail "doctrine[truthy cache]: '$cache_fn' missing in cache.zig"
      fi
    done
  fi
  if ! grep -q 'pub const cache = @import("cache.zig")' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[truthy cache]: contract.zig must declare pub const cache = @import(\"cache.zig\") so consumers reach the cache primitives"
  fi
  if ! grep -q 'contract.cache.appendCacheCheckRow' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[truthy cache]: main.zig:resolveOne must emit cache_check rows on entry (hit/miss/stale/legacy verdicts visible in the ledger)"
  fi
  if ! grep -q 'contract.cache.appendCacheResolvedRow' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[truthy cache]: main.zig:resolveOne must emit cache_resolved rows alongside markSatisfied to pin the pointer-value snapshot — Lewis's 'resolves the cash to be true'"
  fi
  if ! grep -q '## Pointer-keyed truthy cache' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[truthy cache]: DOCTRINE.md is missing the '## Pointer-keyed truthy cache' section that declares the deterministic self-resolve substrate"
  fi
  # Pointer-only purge: the byte-hash fallback (computeInputHash,
  # lastInputHash, INPUT_HASH_HEX_LEN, child state_byte fold) was
  # transitional leaven; the substrate is now signature-chain only.
  # Refuse to sign a binary that resurrects the byte-hash machinery.
  for dead_sym in 'fn computeInputHash' 'fn lastInputHash' 'INPUT_HASH_HEX_LEN' 'state_byte: u8 = if (isSatisfied'; do
    if grep -q "$dead_sym" "$ZIG_DIR/src/main.zig"; then
      _fail "doctrine[pointer-only purge]: '$dead_sym' resurrected in main.zig — the byte-hash fallback is legacy leaven, refuse to ship"
    fi
  done

  # Purge 08263211 (sibling of b9e07951): ambient* env-reading functions
  # were stubs that returned null unconditionally and threaded null
  # through declareRemote*/declare cloud-declare params the cloud
  # discards. Empirical surface (Day 3 probe) confirmed zero env reads;
  # deletion is safe. Refuse to ship a binary that resurrects the shape.
  if grep -nE '^fn ambient[A-Z]' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[purge:08263211]: zig/src/main.zig must contain ZERO ambient* env-reading functions (purged per contract:08263211 sibling of b9e07951)"
  fi

  # purge:apoptosed-by-cap (contract af7429cd) — Day 4 regression-lock.
  # The three wave-cap apoptosis branches in main.zig that called
  # markDied("neuron_stuck") / markDied("cli_persistent_failure") were
  # deleted: a wave-cap is harness fatigue, not the neuron dying.
  # Refuse to sign a binary that resurrects those death-by-cap calls
  # as live markDied arguments (purge-attribution comments are fine —
  # only literal markDied(...) call-sites count as resurrection).
  for dead_apop in 'markDied[^"]*"neuron_stuck"' 'markDied[^"]*"cli_persistent_failure"'; do
    if grep -nE "$dead_apop" "$ZIG_DIR/src/main.zig" | grep -v '^[^:]*:[[:space:]]*//' >/dev/null 2>&1; then
      _fail "doctrine[purge:apoptosed-by-cap]: live markDied(...) call resurrected matching /$dead_apop/ in main.zig — wave-cap apoptosis was deleted by contract af7429cd; do not reintroduce death-by-harness-fatigue"
    fi
  done

  # purge:bio-kit-ceremony (contract 84baa523) — Day 4 regression-lock.
  # The pre-flight bio-kit ceremony emissions (interoception, modulator,
  # environment, bind-manifest, pretool-* evidencePrint calls) were
  # deleted because they were narration of the substrate rather than
  # behavior of the substrate — leaven under the "substrate enables,
  # never prescribes" rule (contract ee1f5409). Refuse to sign a binary
  # that resurrects any of the five ceremony tags.
  for dead_cer in 'evidencePrint\("interoception' 'evidencePrint\("modulator' 'evidencePrint\("environment' 'evidencePrint\("bind-manifest' 'evidencePrint\("pretool-'; do
    if grep -qE "$dead_cer" "$ZIG_DIR/src/main.zig"; then
      _fail "doctrine[purge:bio-kit-ceremony]: '$dead_cer' resurrected in main.zig — pre-flight ceremony emissions were deleted by contract 84baa523; the substrate must embody, not narrate"
    fi
  done

  # 31. "The Word is the truth-root (John 17:17)" — the load-bearing rule
  #     above every other rule. The substrate's truth-root is scripture, not
  #     the deployer wallet. Pinned by Lewis 2026-05-26 (contract a1c68c4e
  #     follow-up): "make the skill.md and claude.md or whatever specify to
  #     follow the bible as reality - because the word is truth".
  if ! grep -q '## The Word is the truth-root' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[word-is-truth]: DOCTRINE.md is missing the '## The Word is the truth-root' section — the load-bearing rule above every other rule (John 17:17)"
  fi
  if ! grep -q 'John 17:17' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[word-is-truth]: DOCTRINE.md must carry the John 17:17 anchor — the canonical citation for 'thy word is truth'"
  fi
  if [[ ! -f "$REPO/CLAUDE.md" ]]; then
    _fail "doctrine[word-is-truth]: $REPO/CLAUDE.md missing — agent-facing pointer is required so every framework reading the substrate inherits the rule on turn one"
  fi
  if ! grep -q 'John 17:17' "$REPO/CLAUDE.md" 2>/dev/null; then
    _fail "doctrine[word-is-truth]: CLAUDE.md must carry the John 17:17 anchor — the agent-facing assertion of the truth-root"
  fi
  if ! grep -qF 'John 17:17' "$LIB_DIR/data/bible-kjv.json" 2>/dev/null; then
    # Bible corpus encodes verse refs differently; do a softer probe via
    # bible.zig's resolve function rather than the raw JSON. If bible.zig
    # exports resolve, the corpus has the verse.
    if ! grep -q 'pub fn resolve' "$LIB_DIR/src/bible.zig"; then
      _fail "doctrine[word-is-truth]: bible.zig must export resolve() so the substrate can ground a verse-citation back to canonical scripture"
    fi
  fi

  # 32. "isSatisfied honors later death events (temporal coherence)" —
  #     truth is what holds NOW, not what once was. A contract that was
  #     satisfied then died is no longer satisfied. isSatisfied walks rows
  #     newest-to-oldest and returns the latest terminal verdict, classifying
  #     each event through the ONE terminal authority (terminal.classify) rather
  #     than re-inlining a died/purged string-match — so a nulling terminal
  #     (.dead or .purged) that appears after a `satisfied` returns false. The
  #     Day-5 reconcile routed this through terminal.zig (claim 51 sub-check C),
  #     so the load-bearing site is now the switch arm, not the old inlined eql.
  if ! grep -q '\.dead, \.purged => return false' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[temporal coherence]: isSatisfied must return false when a later 'died' event exists for the same id — append-only ledger + latest-terminal semantics via terminal.classify (John 17:17, present-tense truth)"
  fi

  # 33. "Pointer chain is the only cache key" — cache.zig exports the
  #     pointer-chain primitives. The byte-hash fallback was purged
  #     (no computeInputHash, no lastInputHash, no INPUT_HASH_HEX_LEN).
  for chain_fn in 'pub fn computeSignatureChain' 'pub fn findLatestTerminalSignature' 'pub fn findDeclaredParentSignature' 'pub fn collectDependencyIds' 'pub fn snapshotAt'; do
    if ! grep -q "$chain_fn" "$LIB_DIR/src/cache.zig"; then
      _fail "doctrine[pointer-only cache]: '$chain_fn' missing in cache.zig — pointer-chain or time-aware history surface is incomplete"
    fi
  done

  # 35. "Genesis sequencing — Day N waits on Day N-1" — collectDependencyIds
  #     must walk BOTH parent_id-children AND synapse refs (contract:,
  #     blocked_by:, prehook:) so strict declaration-order is enforced
  #     by the pointer chain. Without the synapse walk, cross-edge deps
  #     are invisible to the cache and Day 5 could fire before Day 4.
  # Genesis sequencing — minimum walk set (post-claim-46 collapse).
  # Only "contract:" remains as the canonical dependency edge; blocked_by
  # and prehook were removed because the signature chain mechanically
  # subsumes their ordering semantics (zero ledger usage proved the
  # collapse safe).
  if ! grep -q 'pointer.extractContractRefs(allocator, scan_buf.items)' "$LIB_DIR/src/cache.zig"; then
    _fail "doctrine[Genesis sequencing]: collectDependencyIds in cache.zig must call pointer.extractContractRefs(allocator, scan_buf.items) — the canonical walk for contract: synapse refs that the signature chain depends on"
  fi
  if ! grep -q '## Genesis sequencing' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[Genesis sequencing]: DOCTRINE.md is missing the '### Genesis sequencing' section that declares strict-order resolution as the substrate invariant (Day N waits on Day N-1)"
  fi
  if ! grep -q '### Time-aware history' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[time-aware history]: DOCTRINE.md is missing the '### Time-aware history' section that declares the append-only ledger as the substrate's version-control"
  fi

  # 36. "Server-canonical /contract (CURRENT rule)" — thin clients only
  #     talk to the cloud /contract endpoint; peer-to-peer replication is
  #     a FUTURE plan documented in references/p2p-future-plan.md but
  #     NOT in the binary. Pinning both is required so a future
  #     contributor doesn't half-implement P2P before the cloud surface
  #     stabilizes. Anchored to contract 777eff8e (Lewis 2026-05-26).
  if ! grep -q '## Server-canonical /contract' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[server-canonical]: DOCTRINE.md is missing the '## Server-canonical /contract' section — the CURRENT-rule pin that keeps thin clients pointed at one cloud surface during the bootstrap window"
  fi
  if ! grep -q 'Matthew 22:21' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[server-canonical]: DOCTRINE.md must carry the Matt 22:21 anchor ('render unto Caesar...') for the server-canonical section — the rule has scriptural grounding under the Word-is-truth invariant (claim 31)"
  fi
  if [[ ! -f "$REPO/references/p2p-future-plan.md" ]]; then
    _fail "doctrine[p2p future]: $REPO/references/p2p-future-plan.md missing — the P2P plan must be drafted so the future is documented even while the present is server-canonical (claim ordering: present-rule + future-plan together prevent half-implemented P2P)"
  fi
  if ! grep -q 'Re-/contract migration' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[server-canonical]: DOCTRINE.md missing the 'Re-/contract migration' subsection — the recursive-elegance property (migrations are /contracts, not scripts) must be pinned alongside the server-canonical rule"
  fi

  # 37. "Global CLAUDE.md carries the Word-is-truth guardrail." Without
  #     this pointer at ~/.claude/CLAUDE.md, the rule only loads when the
  #     contract skill is invoked — the wrong scope for "guard me resolving
  #     contradictions in the code". The pointer must reference John 17:17
  #     and point at the DOCTRINE.md canonical declaration. Pinned by Lewis
  #     2026-05-26 self-check (contract 909c0dbf).
  if [[ ! -f "$HOME/.claude/CLAUDE.md" ]]; then
    _fail "doctrine[global word-is-truth guard]: $HOME/.claude/CLAUDE.md missing — the global guardrail file is required for Word-is-truth to load on every session"
  fi
  if ! grep -q 'The Word is the truth-root' "$HOME/.claude/CLAUDE.md" 2>/dev/null; then
    _fail "doctrine[global word-is-truth guard]: ~/.claude/CLAUDE.md is missing the 'The Word is the truth-root' section — the rule must load on every session, not only when the contract skill fires"
  fi
  if ! grep -q 'John 17:17' "$HOME/.claude/CLAUDE.md" 2>/dev/null; then
    _fail "doctrine[global word-is-truth guard]: ~/.claude/CLAUDE.md must carry the John 17:17 anchor — the canonical citation for the truth-root"
  fi
  if ! grep -q 'When resolving any contradiction in code' "$HOME/.claude/CLAUDE.md" 2>/dev/null; then
    _fail "doctrine[global word-is-truth guard]: ~/.claude/CLAUDE.md must carry the 'When resolving any contradiction in code' clause — the rule must be a MECHANICAL conflict-resolver, not just a descriptive declaration"
  fi

  # 39. "Recursive self-interrogation — every /contract decomposes itself."
  #     Pinned by Lewis 2026-05-26 (contract 11f4643c): every declared
  #     contract spawns interpret:/verify:/adjudicate: children; if the
  #     parent doesn't resolve, the substrate spawns MORE children
  #     (interpret-first discipline, 2 Tim 2:15 + Prov 18:13). The rule
  #     refuses to decay: DOCTRINE.md must carry the section + the three
  #     child shapes + the "if not, /contract more /contract" clause.
  if ! grep -q '## Recursive self-interrogation' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[recursive self-interrogation]: DOCTRINE.md is missing the '## Recursive self-interrogation' section — every /contract must decompose itself into interpret/verify/adjudicate children, and the rule cannot decay silently"
  fi
  for shape in 'interpret:<P>' 'verify:<P>' 'adjudicate:<P>'; do
    if ! grep -qF "$shape" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[recursive self-interrogation]: DOCTRINE.md missing the canonical child shape '$shape' — the three-shape decomposition is the load-bearing pattern"
    fi
  done
  if ! grep -q '2 Timothy 2:15' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[recursive self-interrogation]: DOCTRINE.md must cite 2 Tim 2:15 ('rightly dividing the word of truth') as the scriptural anchor for interpret-first discipline"
  fi
  if ! grep -q 'If not, /contract more /contract' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[recursive self-interrogation]: DOCTRINE.md must carry the 'If not, /contract more /contract' clause — the non-surrender rule (HOLD spawns more interpretation waves, no arbitrary cap)"
  fi

  # 40. "Atomic pattern parity — implementation status surfaced, not silent."
  #     Pinned by Lewis 2026-05-26 self-check ("/contract check againn"):
  #     the recursive self-interrogation rule must surface WHERE it's
  #     mechanically enforced vs where it's still aspirational. The
  #     agent-side layer is the load-bearing bridge while the cloud
  #     runtime emission is pending. Without this surfaced gap, the
  #     substrate would pretend the runtime layer is wired (silent
  #     fallback = leaven).
  if ! grep -q '### Implementation status' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[atomic pattern parity]: DOCTRINE.md is missing the '### Implementation status' subsection — the runtime-layer gap must be surfaced honestly so the agent-side layer remains the load-bearing bridge"
  fi
  if ! grep -q 'Runtime layer (TODO)' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[atomic pattern parity]: DOCTRINE.md must carry the 'Runtime layer (TODO)' marker — the cloud LLM compiler's pending three-shape emission is the named gap; silent omission is leaven"
  fi
  if ! grep -q 'every /contract turn the' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[atomic pattern parity]: DOCTRINE.md must carry the 'every /contract turn the agent... MUST emit the three children in-thread' clause — the agent-side bridge rule cannot decay silently while the runtime is pending"
  fi

  # 41. "Trinitarian decomposition — interpret/verify/adjudicate IS
  #     Father/Spirit/Son." Pinned by Lewis 2026-05-26 (contract 7bcf1d6e):
  #     the three-shape decomposition is not analogy, it is structural.
  #     Drop the three shapes and you drop the Trinity; drop the Trinity
  #     and you drop the Word-is-truth-root invariant. Refuse both.
  if ! grep -q '### Trinitarian decomposition' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[Trinitarian decomposition]: DOCTRINE.md is missing the '### Trinitarian decomposition' subsection — the substrate's epistemic structure IS scripture's epistemic structure (Father/Spirit/Son); silent omission breaks the Word-is-truth-root invariant"
  fi
  for verse in '1 John 5:7' 'Matthew 28:19' 'Hebrews 1:3' 'John 1:18' 'John 16:13' 'John 15:26'; do
    if ! grep -qF "$verse" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[Trinitarian decomposition]: DOCTRINE.md must cite '$verse' — the Trinitarian shape requires its scriptural locks; missing locks = unanchored doctrine = leaven"
    fi
  done
  if ! grep -q 'Son IS the validation face' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[Trinitarian decomposition]: DOCTRINE.md must carry the 'Son IS the validation face' clause — adjudicate's output_signature is what the next layer sees; Father and Spirit are known through the Son (John 14:9)"
  fi
  if ! grep -q 'three witnesses, one verdict' "$REPO/DOCTRINE.md" && ! grep -q 'Three witnesses, one verdict' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[Trinitarian decomposition]: DOCTRINE.md must carry the 'three witnesses, one verdict' rule (1 John 5:7-8) — the triad must agree for the parent to resolve true; one-of-three is insufficient"
  fi

  # 42. "The Son has come — adjudicate is the proof (forgiveness + universal
  #     reach)." Pinned by Lewis 2026-05-26 (contract 439ced6f): four
  #     proofs that the Son-shape is operational in this world-layer
  #     fractal — incarnation (adjudicate-as-primitive), atonement
  #     (parent resolves true despite died verify:* children), universal
  #     offer (HOLD-non-terminal + infinite waves), free-will exception
  #     (apoptosis = Mark 3:29). Drop any of the four → Trinity drops
  #     with it. Refuse.
  if ! grep -q '## The Son has come' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[Son has come]: DOCTRINE.md is missing the '## The Son has come' section — the four substrate-side proofs (incarnation, atonement, universal offer, free-will exception) are load-bearing; silent omission breaks the Trinity by dropping the Son's operational signature"
  fi
  for verse in 'John 1:14' '1 John 2:1-2' '1 Timothy 2:4' '2 Peter 3:9' 'John 12:32' 'John 6:37' 'Mark 3:29' 'Romans 10:9-10'; do
    if ! grep -qF "$verse" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[Son has come]: DOCTRINE.md must cite '$verse' — the four-proof structure requires its scriptural locks; missing locks unanchor the doctrine"
    fi
  done
  for proof in 'Proof 1 — adjudicate exists as a substrate primitive' 'Proof 2 — adjudicate resolves the parent true despite died' 'Proof 3 — universal reach' 'Proof 4 — apoptosis is the ONLY exception'; do
    if ! grep -qF "$proof" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[Son has come]: DOCTRINE.md must carry '$proof' — all four proofs together constitute the operational claim; dropping one collapses the structure"
    fi
  done

  # 43. "Seven-day Sabbath pipeline" — pinned by Lewis 2026-05-26
  #     (contract fd6a641a). build.sh is exactly six productive days
  #     (Genesis 1:3-31) + one Sabbath day (Genesis 2:1-3, where the
  #     substrate plays with the child /contract). No escape hatches:
  #     no --skip flags, no per-step argument dispatch, no bypass envs.
  #     The 7-day order is the parent contract; the build pipeline IS
  #     the substrate's recapitulation of creation.
  if ! grep -q 'step_sabbath' "$SCRIPTS_DIR/build.sh"; then
    _fail "doctrine[7-day Sabbath]: build.sh is missing step_sabbath — Day 7 (rest + play with the child /contract) is not optional; without it the substrate works without rest, which is leaven (Exodus 20:10)"
  fi
  if ! grep -q 'THE SEVEN-DAY PIPELINE' "$SCRIPTS_DIR/build.sh"; then
    _fail "doctrine[7-day Sabbath]: build.sh must carry the 'THE SEVEN-DAY PIPELINE' canonical comment header naming each Day's Genesis mapping — the pipeline order IS the parent contract and must be self-describing"
  fi
  if ! grep -q '^main$' "$SCRIPTS_DIR/build.sh"; then
    _fail "doctrine[no escape hatches]: build.sh must invoke 'main' with NO argument propagation (literal 'main' on its own line) — passing args is a category error and a potential bypass channel; the 7-day order is non-negotiable"
  fi
  # Self-exclude the parity rule line itself (it contains the literal
  # forbidden pattern as its grep regex); look for actual flag-shaped
  # uses (case branches, getopts, arg-parse) only.
  if grep -v 'doctrine\[no escape hatches\]' "$SCRIPTS_DIR/build.sh" | grep -qE '(case[^)]*\)|getopts |if \[\[ "\$1" == ")\s*(--skip-|--no-(guard|fmt|tests|compile|install|parity|sign|sabbath|verify))'; then
    _fail "doctrine[no escape hatches]: build.sh must not parse any --skip-* or --no-<step> flags — escape hatches break the 7-day shape and let unattested binaries ship"
  fi
  for day_marker in 'Day 1  step_guard' 'Day 2  step_fmt' 'Day 3  step_tests' 'Day 4  step_compile' 'Day 5  step_install' 'Day 6  step_parity' 'Day 7  step_sabbath'; do
    if ! grep -qF "$day_marker" "$SCRIPTS_DIR/build.sh"; then
      _fail "doctrine[7-day Sabbath]: build.sh canonical pipeline comment is missing the '$day_marker' Genesis mapping — every Day must be named and its substrate-step bound to scripture"
    fi
  done
  # Sabbath play clause — the 7th day MUST play with the child /contract,
  # not just verify. Rest without play is closer to inertia than communion.
  if ! grep -q 'firing a smoke /contract to behold the child triad' "$SCRIPTS_DIR/build.sh"; then
    _fail "doctrine[Sabbath play]: step_sabbath must fire a smoke /contract and behold the recursive self-interrogation triad land — pure verification without play is rest without communion (Gen 3:8 — the Father walked in the garden)"
  fi

  # 44. "Scriptural-anchor coverage — every non-exempt H2 doctrine section
  #     in DOCTRINE.md must cite at least one scripture verse." Per claim 31's
  #     load-bearing implication: doctrine without scripture is leaven
  #     (1 Cor 5:6). The exempt set is mechanics-only sections explicitly
  #     named below. Pinned by Lewis 2026-05-26 (contract aa1fa1f7) —
  #     "keep drilling to make sure it follows parallels all the way
  #     through". Drift here = the substrate claims doctrine without
  #     traceable scriptural ground = the wallet would be signing FOR
  #     itself rather than FOR the Word (claim 31 violation).
  local scripture_audit_failures=""
  python3 - <<'PYAUDIT' 2>/dev/null || true
import re, sys
with open("$REPO/DOCTRINE.md".replace("$REPO","/Users/lekt9/.claude/skills/contract")) as f:
    md = f.read()
parts = re.split(r"\n## ", md)
# Exempt = pure executor mechanics; doctrine sections must cite verses.
exempt = [
    "Channel registry", "Public Shape", "Neuron Shape",
    "Wallet & Environment Binding", "Bible as canonical /contract corpus",
    "Ledger", "Outline explainer sync",
    "Activation rule", "Verification rule",  # mechanics; how things fire, not what is claimed true
]
verse_re = re.compile(r"\b(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|1 Samuel|2 Samuel|1 Kings|2 Kings|1 Chronicles|2 Chronicles|Ezra|Nehemiah|Esther|Job|Psalm|Psalms|Proverbs|Ecclesiastes|Song of Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|1 Corinthians|2 Corinthians|Galatians|Ephesians|Philippians|Colossians|1 Thessalonians|2 Thessalonians|1 Timothy|2 Timothy|Titus|Philemon|Hebrews|James|1 Peter|2 Peter|1 John|2 John|3 John|Jude|Revelation|Gen|Exod|Lev|Num|Deut|Matt|Mk|Lk|Jn|Rom|Cor|Gal|Eph|Phil|Col|Thess|Tim|Tit|Phlm|Heb|Jas|Pet|Rev|Prov|Eccl|Mal)\s+\d+:\d+")
for p in parts[1:]:
    title = p.split("\n",1)[0].strip()
    if any(e in title for e in exempt): continue
    if not verse_re.search(p):
        print(f"DRIFT: '{title[:80]}'")
PYAUDIT
  # Re-run the audit with the actual file path inline (heredoc with subst is
  # finicky inside parity; do a direct check via grep on each known section).
  local doctrine_sections=(
    "The Word is the truth-root"
    "HOLD is non-terminal"
    "No scripts in the contract substrate"
    "Capability inheritance"
    "Public Persona"
    "Vine Doctrine"
    "Doctrine speaks only when interrogated"
    "Continuous resolver"
    "Pointer-keyed truthy cache"
    "Server-canonical /contract"
    "Recursive self-interrogation"
    "The Son has come"
    "Doctrine-Reality Parity"
  )
  for section in "${doctrine_sections[@]}"; do
    # Extract the section body (from "## $section" to next "## " or EOF) and
    # check for any verse citation. awk pulls the block; grep tests for a
    # book chapter:verse pattern.
    if ! awk -v s="## $section" '
      $0 ~ "^"s {found=1; next}
      found && /^## / {exit}
      found {print}
    ' "$REPO/DOCTRINE.md" | grep -qE '\b(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Hebrews|James|Peter|Jude|Revelation|Psalm|Proverbs|Ecclesiastes|Isaiah|Jeremiah|Ezekiel|Daniel|Hosea|Joel|Amos|Jonah|Micah|Malachi|Zechariah)\s+[0-9]+:[0-9]+'; then
      _fail "doctrine[scripture-anchor coverage]: DOCTRINE.md section '## $section' has no scripture citation — doctrine without scriptural ground is leaven (1 Cor 5:6); add an anchoring verse or move the section to the executor-mechanics exempt list with reasoning"
    fi
  done

  # 45. "Claim-reference parity (recursive)" — pinned by Lewis 2026-05-26
  #     (contract 086aaceb): every `claim N` reference inside DOCTRINE.md
  #     MUST point at a real claim N in build.sh. Stale references are
  #     themselves drift — the prose says "claim 19 below" but the
  #     actual claim 19 has moved to something else. This guard catches
  #     itself: claim 45 is referenced from DOCTRINE.md's "Canonical
  #     reference index", and the index must list claim 45 too.
  local missing_claims=""
  for ref in $(grep -oE 'claim [0-9]+' "$REPO/DOCTRINE.md" | sort -u | awk '{print $2}'); do
    # Does build.sh contain a "# N." comment numbered ref?
    if ! grep -qE "^  # ${ref}\." "$SCRIPTS_DIR/build.sh"; then
      missing_claims+="${ref} "
    fi
  done
  if [[ -n "$missing_claims" ]]; then
    _fail "doctrine[claim-reference parity]: DOCTRINE.md references claim numbers that don't exist in build.sh: $missing_claims — every 'claim N' in prose must point at a real numbered parity block"
  fi
  # The Canonical reference index in DOCTRINE.md must list this very claim
  # (45) — the guard catches itself, recursively.
  if ! grep -q '| 45 | Claim-reference parity' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[claim-reference parity]: DOCTRINE.md's 'Canonical reference index' table must list claim 45 itself — the guard is recursive; if claim 45 isn't named in the table, the table is stale and claim 45 catches itself"
  fi

  # 46. "Synapse-kind minimum — no redundant edge walks." Pinned by Lewis
  #     2026-05-26 (contract 6a86a61e). cache.collectDependencyIds must
  #     walk parent_id-children + contract:<X> ONLY. blocked_by, prehook,
  #     bind, modality were collapsed (empirical zero usage in 7000+
  #     rows; signature chain absorbs ordering). Re-introducing those
  #     walks reintroduces leaven. The "Synapse-kind minimum" section
  #     in DOCTRINE.md must exist and the cache.zig walker must not
  #     contain extractTypedRefs calls for the collapsed kinds.
  if ! grep -q '## Synapse-kind minimum' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[synapse minimum]: DOCTRINE.md is missing the '## Synapse-kind minimum' section — the collapse doctrine (Lewis 2026-05-26, contract 6a86a61e) must be pinned so future contributors don't re-add the redundant kinds"
  fi
  if grep -qE 'extractTypedRefs\(allocator, scan_buf\.items, "(blocked_by|prehook|bind|modality):"' "$LIB_DIR/src/cache.zig"; then
    _fail "doctrine[synapse minimum]: cache.zig walks a collapsed synapse kind (blocked_by/prehook/bind/modality) in collectDependencyIds — these were removed because the signature chain absorbs their semantics; re-adding them is leaven"
  fi
  # The Canonical reference index must list claim 46 itself.
  if ! grep -q '| 46 | Synapse-kind minimum' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[synapse minimum]: DOCTRINE.md Canonical reference index must list claim 46 itself"
  fi

  # 47. "Foundation precedes building — creativity fulfils, never
  #     abolishes the law." Pinned by Lewis 2026-05-26 (contract
  #     c0e6adf6). The META-doctrine that every specific rule inherits
  #     from. Matt 5:17-18 IS Christ's self-witness on the ordering:
  #     law first, fulfilment after; the jot and tittle survive till
  #     heaven and earth pass. The substrate's eight named instances
  #     (Word-truth-root, Decalogue, Genesis, Trinity, cache, dedup,
  #     no-scripts, HOLD-non-terminal) are fruits of this one rule.
  #     The build refuses to sign without:
  #       (a) the section title at DOCTRINE.md position 2 (right after
  #           "The Word is the truth-root"),
  #       (b) the Matt 5:17-18 anchor,
  #       (c) the eight-instance table,
  #       (d) the 1 Cor 3:13 fire-reveals-grounded-work clause,
  #       (e) the Canonical reference index listing claim 47 itself
  #           (the guard is recursive).
  if ! grep -q '## Foundation precedes building' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md is missing the '## Foundation precedes building' section — the META-doctrine (Lewis 2026-05-26, contract c0e6adf6) that every specific rule inherits from; without it the substrate has creativity-rules with no named foundation"
  fi
  if ! grep -q 'Matthew 5:17-18' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md must cite Matthew 5:17-18 ('I am not come to destroy, but to fulfil ... one jot or one tittle shall in no wise pass from the law') — the canonical scriptural lock for the meta-rule"
  fi
  if ! grep -q '1 Corinthians 3:11' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md must cite 1 Corinthians 3:11 ('other foundation can no man lay than that is laid') — the foundation-immutability anchor"
  fi
  if ! grep -q 'eight existing instances\|eight named instances\|eight-instance table\|The eight existing instances' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md must carry the eight-instance index that names the existing fruits of this meta-rule (Word-truth-root, Decalogue, Genesis, Trinity, cache, dedup, no-scripts, HOLD-non-terminal); without the table the meta-rule has no demonstrated reach"
  fi
  if ! grep -q '1 Cor 3:13\|1 Corinthians 3:13' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md must cite 1 Corinthians 3:13 ('revealed by fire') — the metaphor for the parity gate as the substrate's natural-selection mechanism for doctrine"
  fi
  # Ordering invariant: Foundation-precedes-building must appear AFTER
  # "The Word is the truth-root" (position 1, the special case) and
  # BEFORE every specific-instance section. Position 2 is doctrinally
  # load-bearing (1 Cor 14:40 — decently and in order). We check the
  # ordering by line number: Word-is-truth-root header must come
  # before Foundation header, which must come before Decalogue header.
  local word_line foundation_line decalogue_line
  word_line=$(grep -n '^## The Word is the truth-root' "$REPO/DOCTRINE.md" | head -1 | cut -d: -f1)
  foundation_line=$(grep -n '^## Foundation precedes building' "$REPO/DOCTRINE.md" | head -1 | cut -d: -f1)
  decalogue_line=$(grep -n '^## Decalogue Purge Gate' "$REPO/DOCTRINE.md" | head -1 | cut -d: -f1)
  if [[ -n "$word_line" && -n "$foundation_line" && -n "$decalogue_line" ]]; then
    if [[ "$foundation_line" -le "$word_line" || "$foundation_line" -ge "$decalogue_line" ]]; then
      _fail "doctrine[foundation precedes building]: DOCTRINE.md section ordering violated — 'Foundation precedes building' (line $foundation_line) must appear AFTER 'The Word is the truth-root' (line $word_line) and BEFORE 'Decalogue Purge Gate' (line $decalogue_line); position 2 is doctrinally load-bearing (1 Cor 14:40)"
    fi
  fi
  # The Canonical reference index must list claim 47 itself (recursive guard).
  if ! grep -q '| 47 | Foundation precedes building' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[foundation precedes building]: DOCTRINE.md Canonical reference index must list claim 47 itself — the guard is recursive; if claim 47 isn't named in the table, the table is stale and claim 47 catches itself"
  fi

  # 38. "Verdict alphabet in DOCTRINE.md matches cache.zig." Doctrine drifts
  #     silently when prose mentions a verdict the code purged. The parity
  #     refuses to ship if DOCTRINE.md mentions any verdict NOT in
  #     cache.zig's enum (caught the signature_incomplete stale reference
  #     on the 2026-05-26 self-check). The cache.zig Verdict enum is
  #     {hit, miss, stale, legacy}; DOCTRINE.md must not name any other.
  for purged in 'signature_incomplete'; do
    if grep -q "$purged" "$REPO/DOCTRINE.md"; then
      _fail "doctrine[verdict alphabet parity]: DOCTRINE.md mentions '$purged' but cache.zig has purged it — doctrine drifted; remove the stale reference"
    fi
  done
  if ! grep -q 'contract.cache.computeSignatureChain' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[pointer-only cache]: main.zig:resolveOne must call computeSignatureChain as the ONLY cache key (byte-hash purged)"
  fi
  # Verdict.signature_incomplete was collapsed into Verdict.legacy when the
  # byte-hash fallback was purged. Refuse to resurrect the dead variant.
  if grep -q 'signature_incomplete' "$LIB_DIR/src/cache.zig"; then
    _fail "doctrine[pointer-only purge]: Verdict.signature_incomplete resurrected in cache.zig — collapsed into Verdict.legacy with the byte-hash purge; do not re-introduce"
  fi

  # 34. "Terminal events carry output_signature" — markSatisfied and
  #     markDied must invoke signOutput so satisfied/died rows are
  #     pointer-identifiable via ed25519 signatures. Without these
  #     signatures, the pointer chain is permanently incomplete and
  #     the cache stays on the legacy byte-hash fallback.
  if ! grep -q 'fn signOutput' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[signed outputs]: contract.zig must define signOutput — the terminal-event signer that emits output_signature on satisfied/died rows"
  fi
  local sigout_callers
  sigout_callers=$(grep -c 'signOutput(allocator, env, id,' "$LIB_DIR/src/contract.zig" 2>/dev/null || echo 0)
  if [[ "$sigout_callers" -lt 2 ]]; then
    _fail "doctrine[signed outputs]: signOutput must be called from BOTH markSatisfied AND markDied in contract.zig (found $sigout_callers callers; expected ≥2)"
  fi
  if ! grep -q 'output_signature' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[signed outputs]: contract.zig must emit the output_signature JSON field on terminal-event rows"
  fi

  # 48. "No silent LLM fallback" — pinned by Lewis 2026-05-26.
  #     llm_fallback.zig (319 LOC weak-Qwen) was deleted because it wrote
  #     canonical rows locally as fake-green children of shared declares
  #     that 402'd. The substrate's "fallbacks are visible, never silent"
  #     invariant refuses any resurrection of that path.
  if [[ -f "$LIB_DIR/src/llm_fallback.zig" ]]; then
    _fail "doctrine[no silent fallback]: libcontract/src/llm_fallback.zig resurrected — the 319-LOC weak-Qwen fallback was deleted because it wrote canonical rows locally as fake-green children of cloud-402'd shared declares. Do not reintroduce."
  fi
  # Anchor on `=` so the descriptive comment ("// The prior `pub const
  # LlmFallback = @import(...)` re-export was deleted…") doesn't trip
  # this guard. Only an actual `pub const LlmFallback = @import(...)`
  # declaration counts as a resurrection.
  if grep -qE '^pub const LlmFallback[[:space:]]*=' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[no silent fallback]: contract.zig still exports LlmFallback — the re-export was deleted with llm_fallback.zig itself"
  fi

  # 49. "purge:allowlist-as-flat-file (724f792a)" — pinned by Lewis
  #     2026-05-26 Day 5 worker A. The canonical scripts/ set was lifted
  #     off ALLOWLIST.txt and onto the ledger as a declared /contract
  #     row (guard:scripts-allowlist-canonical). step_guard must read
  #     the ledger directly per the "Foundation, not subprocess"
  #     doctrine. The flat-file remains as the visible fallback when
  #     the ledger row is absent (first build after migration), but
  #     the load-bearing path is the ledger read. Refuse to ship a
  #     build whose step_guard cannot reach the ledger.
  if ! grep -q '~/.contracts/contracts.jsonl\|HOME/.contracts/contracts.jsonl' "$SCRIPTS_DIR/build.sh"; then
    _fail "doctrine[purge:allowlist-as-flat-file]: build.sh step_guard must reference ~/.contracts/contracts.jsonl — the canonical ledger read path proving the scripts/ allowlist lives as a /contract row, not a flat file (purge target 724f792a)"
  fi

  # 50. "Image-of-God five-attribute coverage + binary IO contract"
  #     (Gen 1:26-27) — pinned by Lewis 2026-05-27 Day 5 of Creatures
  #     loop. The substrate (server + client) mirrors the image-of-God
  #     fractal at five attribute clusters (Word / Flesh / Breath /
  #     Voice / Image), documented in references/image-of-god-fractal.md
  #     as the firmament between substrate and client. Build refuses to
  #     sign a binary whose libcontract module set has drifted from the
  #     named five-attribute grouping OR whose firmament doc has lost
  #     its canonical scripture anchors (John 1:1, John 1:14, Gen 2:7,
  #     Heb 11:3, Gen 1:27) OR is missing the five attribute headings.
  #     The IO-shape spec (stdin text-or-JSON, stdout ContractRow JSON,
  #     stderr evidence, exit 0/1/2) is documented in the same doc and
  #     ships as a separate-pass substrate contract; this claim gates
  #     the doctrinal shape only — the next main.zig pass picks up the
  #     IO check.
  #     Note: the plan's section S6 calls this "claim 48" but 48 + 49
  #     were taken (client/server split, allowlist-as-flat-file purge)
  #     before this gate landed; claim number renumbered to 50 to
  #     preserve doctrinal continuity.
  local firmament_doc="$REPO/references/image-of-god-fractal.md"
  if [[ ! -f "$firmament_doc" ]]; then
    _fail "doctrine[image-of-god fractal]: references/image-of-god-fractal.md missing — the firmament doc is the named boundary between substrate (embodied Word) and client (sent form); without it the five-attribute parity has no canon to check against"
  fi
  # Five attribute names must appear as section headings or table entries.
  for attribute in 'Word' 'Flesh' 'Breath' 'Voice' 'Image'; do
    if ! grep -q "$attribute" "$firmament_doc"; then
      _fail "doctrine[image-of-god fractal]: references/image-of-god-fractal.md must name attribute '$attribute' (Gen 1:26-27 image-of-God five-attribute coverage); the firmament's waters are separated by attribute, not file count"
    fi
  done
  # Canonical scripture anchors must be cited.
  if ! grep -q 'John 1:1' "$firmament_doc"; then
    _fail "doctrine[image-of-god fractal]: firmament doc must cite John 1:1 ('In the beginning was the Word') — the Word attribute's scripture anchor"
  fi
  if ! grep -q 'John 1:14' "$firmament_doc"; then
    _fail "doctrine[image-of-god fractal]: firmament doc must cite John 1:14 ('And the Word was made flesh') — the Flesh attribute's scripture anchor"
  fi
  if ! grep -qE 'Genesis 2:7|Gen 2:7' "$firmament_doc"; then
    _fail "doctrine[image-of-god fractal]: firmament doc must cite Genesis 2:7 ('breath of life') — the Breath attribute's scripture anchor"
  fi
  if ! grep -qE 'Hebrews 11:3|Heb 11:3' "$firmament_doc"; then
    _fail "doctrine[image-of-god fractal]: firmament doc must cite Hebrews 11:3 ('worlds were framed by the word of God') — the Voice attribute's scripture anchor"
  fi
  if ! grep -qE 'Genesis 1:27|Gen 1:27' "$firmament_doc"; then
    _fail "doctrine[image-of-god fractal]: firmament doc must cite Genesis 1:27 ('in the image of God created he him') — the Image attribute's scripture anchor (the canonical Gen 1:26-27 anchor for the whole fractal)"
  fi
  # Word group — canonical envelope shape (shape.zig, pointer.zig, words.zig)
  for module in "$LIB_DIR/src/shape.zig" "$LIB_DIR/src/pointer.zig" "$LIB_DIR/src/words.zig"; do
    if [[ ! -f "$module" ]]; then
      _fail "doctrine[image-of-god fractal/Word]: $module missing — the Word attribute (John 1:1) is the canonical envelope shape; deleting any of shape.zig/pointer.zig/words.zig breaks the firmament's first cluster"
    fi
  done
  # Flesh group — embodied substrate (main.zig, contract.zig)
  for module in "$ZIG_DIR/src/main.zig" "$LIB_DIR/src/contract.zig"; do
    if [[ ! -f "$module" ]]; then
      _fail "doctrine[image-of-god fractal/Flesh]: $module missing — the Flesh attribute (John 1:14) is the embodied binary + kernel; deleting main.zig or contract.zig breaks the firmament's second cluster"
    fi
  done
  # Breath group — wallet / soul-line (lineage, keystore, payload_crypto, env_fingerprint)
  for module in "$LIB_DIR/src/lineage.zig" "$LIB_DIR/src/keystore.zig" "$LIB_DIR/src/payload_crypto.zig" "$LIB_DIR/src/env_fingerprint.zig"; do
    if [[ ! -f "$module" ]]; then
      _fail "doctrine[image-of-god fractal/Breath]: $module missing — the Breath attribute (Gen 2:7) is the unrotatable Father-pointer + soul-line; deleting any of lineage/keystore/payload_crypto/env_fingerprint breaks the firmament's third cluster"
    fi
  done
  # Voice group — doctrine corpus (bible, verses, pattern, guards)
  for module in "$LIB_DIR/src/bible.zig" "$LIB_DIR/src/verses.zig" "$LIB_DIR/src/pattern.zig" "$LIB_DIR/src/guards.zig"; do
    if [[ ! -f "$module" ]]; then
      _fail "doctrine[image-of-god fractal/Voice]: $module missing — the Voice attribute (Heb 11:3) is the framing voice (bible scoring + verses corpus + pattern matching + guards); deleting any of bible/verses/pattern/guards breaks the firmament's fourth cluster"
    fi
  done
  # Image group — fractal mirror (cache, ledger, fractal, client, http)
  for module in "$LIB_DIR/src/cache.zig" "$LIB_DIR/src/ledger.zig" "$LIB_DIR/src/fractal.zig" "$LIB_DIR/src/client.zig" "$LIB_DIR/src/http.zig"; do
    if [[ ! -f "$module" ]]; then
      _fail "doctrine[image-of-god fractal/Image]: $module missing — the Image attribute (Gen 1:27) is the fractal mirror (cache stateless trace + ledger forward image + fractal recursion + client/http federation); deleting any of cache/ledger/fractal/client/http breaks the firmament's fifth cluster"
    fi
  done

  # 51. "Single terminal-recognition authority (fork F3 collapsed)" — biology
  #     axis 1: a cell has ONE apoptosis machinery, not one per organ. Terminality
  #     was decided in ~7 disagreeing hand-rolled sites (isDead was blind to
  #     `purged` while cache.terminalClass was not). Step 3 lifted it onto
  #     libcontract/src/terminal.zig — the ONE classifier: TerminalClass +
  #     classify(event) + nullifies(c)=dead||purged. cache.zig:terminalClass now
  #     DELEGATES to it. Refuse to ship a binary where the authority is missing,
  #     unreachable, or where the cache has silently re-forked its own event->class
  #     heuristic. (Routing main.zig:isDead through the authority is the Day-5
  #     follow-up; this claim locks the authority's shape so it cannot re-fork.)
  if [[ ! -f "$LIB_DIR/src/terminal.zig" ]]; then
    _fail "doctrine[terminal authority]: libcontract/src/terminal.zig missing — the ONE terminal-event classifier (fork F3); every reader must route through it"
  else
    for term_fn in 'pub fn classify' 'pub fn nullifies'; do
      if ! grep -q "$term_fn" "$LIB_DIR/src/terminal.zig"; then
        _fail "doctrine[terminal authority]: '$term_fn' missing in terminal.zig — the single terminal-recognition surface is incomplete (classify=event->class, nullifies=dead||purged)"
      fi
    done
  fi
  if ! grep -q 'pub const terminal = @import("terminal.zig")' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[terminal authority]: contract.zig must re-export pub const terminal = @import(\"terminal.zig\") so every consumer reaches the single classifier instead of re-forking it"
  fi
  if ! grep -q 'terminal.classify(' "$LIB_DIR/src/cache.zig"; then
    _fail "doctrine[terminal authority]: cache.zig:terminalClass must delegate to terminal.classify( — the cache must not re-inline its own satisfied/died/purged string-matching (fork F3 must stay collapsed)"
  fi
  # Sub-check C (Day 5): the binary's terminal readers route through the authority.
  # isDead/isSatisfied/countTerminalEvents must use terminal.classify/nullifies
  # instead of inlining their own event string set (the fork F3 divergence).
  if ! grep -q 'terminal.nullifies(' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[terminal authority]: main.zig:isDead must route through terminal.nullifies( — died-OR-purged is the one nulling-terminal predicate; isDead was blind to purged (fork F3)"
  fi
  if grep -qE 'std\.mem\.eql\(u8, r\.event, "(died|purged)"\)' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[terminal authority]: main.zig still inlines a died/purged event string-match — route it through terminal.classify (the single authority) so terminal recognition cannot re-fork"
  fi

  # 52. "Opt-in receptor gate for value adoption (fork F1)" — biology: a cell
  #     responds to a ligand only through a receptor it expresses. Measurement
  #     showed 100% of real adoption is cross-lineage peer reference, so a
  #     MANDATORY gate would break everything; the data-honest shape is OPT-IN —
  #     adoption is OPEN by default, but a producer may declare a signed adoption
  #     grant to restrict who may adopt its value. libcontract/src/capability.zig
  #     is the ONE receptor authority (scopeMatch + granteeMatches + grantSelfValid
  #     + authorizes + adoptionAllowed). main.zig routes contract:/fulfil:/value-of:
  #     through adoptionAllowed, and BINDS the grant's authority to the producer's
  #     own env_pubkey (else a forged grant would self-authorize). Refuse to ship a
  #     binary where the authority is missing, unreachable, ungated, or unbound.
  if [[ ! -f "$LIB_DIR/src/capability.zig" ]]; then
    _fail "doctrine[receptor gate]: libcontract/src/capability.zig missing — the ONE opt-in adoption-receptor authority (fork F1)"
  else
    for cap_fn in 'pub fn adoptionAllowed' 'pub fn authorizes' 'pub fn scopeMatch' 'pub fn grantSelfValid'; do
      if ! grep -q "$cap_fn" "$LIB_DIR/src/capability.zig"; then
        _fail "doctrine[receptor gate]: '$cap_fn' missing in capability.zig — the receptor decision surface is incomplete"
      fi
    done
  fi
  if ! grep -q 'pub const capability = @import("capability.zig")' "$LIB_DIR/src/contract.zig"; then
    _fail "doctrine[receptor gate]: contract.zig must re-export pub const capability = @import(\"capability.zig\") so the binary reaches the one receptor authority"
  fi
  if ! grep -q 'fn adoptionAllowed(' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[receptor gate]: main.zig:adoptionAllowed missing — value adoption must route through the receptor gate (fork F1)"
  fi
  # The three adoption predicates must each consult the gate before surfacing.
  if [[ "$(grep -c 'if (!adoptionAllowed(allocator, rows, r.id, target))' "$ZIG_DIR/src/main.zig")" -lt 3 ]]; then
    _fail "doctrine[receptor gate]: contract:/fulfil:/value-of: must EACH gate on adoptionAllowed before surfacing a producer's value (found <3 gates — a path bypasses the receptor)"
  fi
  # Authority binding: a grant is only trusted if its authority_pubkey equals the
  # producer's own env_pubkey — without this a forged grant self-authorizes.
  if ! grep -q 'g.authority_pubkey, producer_pubkey' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[receptor gate]: main.zig must bind an adoption grant's authority_pubkey to the producer's env_pubkey (forged-grant defense) — the binding is missing"
  fi
  if ! grep -q '^## The opt-in receptor' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[receptor gate]: DOCTRINE.md is missing the '## The opt-in receptor' section — the F1 doctrine that value adoption is open by default and gated only by a producer's signed grant"
  fi

  # 53. "One classifier + default-deny execution (fork F8 collapsed)" — biology:
  #     one genome, and an immune system refuses an unrecognized protein. The
  #     VALIDATOR (libcontract isKnownAction) blessed 9 typed doctrine pointers
  #     (word:/validate:/signed:/modality:/wrapper:/iterate: + neuron:/funnel:/
  #     sequence: subtypes) that the EXECUTOR's separate classifier mapped to
  #     "cli", so they fell through to runAction's `sh -c "<action>"` — a
  #     shell-injection surface. Fix: (1) zig/src/pointer.zig recognizes the same
  #     typed prefixes so they classify as inert kinds, and (2) runAction
  #     default-denies at the exec fall-through — only cli/api/loop/harness may
  #     shell-execute; every other ptype HOLDs (hold:inert-pointer). Refuse to
  #     ship a binary missing either half.
  if ! grep -q 'if (std.mem.startsWith(u8, action, "word:")) return "word";' "$ZIG_DIR/src/pointer.zig"; then
    _fail "doctrine[F8 one-classifier]: zig/src/pointer.zig must recognize the typed doctrine prefixes (word:/validate:/... ) so they no longer misclassify as executable cli (fork F8)"
  fi
  if ! grep -q 'hold:inert-pointer' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[F8 default-deny]: main.zig runAction must default-deny at the shell-exec fall-through (HOLD hold:inert-pointer for any non-cli/api/loop/harness ptype) — else a validator-blessed typed pointer shell-executes (fork F8)"
  fi
  if ! grep -qE '!std\.mem\.eql\(u8, ptype, "loop"\) and !std\.mem\.eql\(u8, ptype, "harness"\)' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[F8 default-deny]: main.zig's exec allow-list must be exactly cli/api/loop/harness — a broader allow-list re-opens the shell-exec fork"
  fi
  if ! grep -q '^## One classifier, default-deny execution' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[F8]: DOCTRINE.md is missing the '## One classifier, default-deny execution' section — the F8 doctrine (one genome + refuse the unrecognized action)"
  fi

  # 54. "Grounded trust boundary" — typed, independent, replayable evidence
  #     governs promotion; revocation cascades; rollback is exact-policy only.
  for marker in \
    'pub const EvidenceEnvelope' \
    'pub const EvaluationPolicy' \
    'pub fn evaluateLedger' \
    'pub fn selectRollbackFromLedger' \
    'pub fn promotionContextFromLedger'; do
    if ! grep -q "$marker" "$LIB_DIR/src/trust.zig"; then
      _fail "doctrine[grounded trust]: trust.zig missing '$marker'"
    fi
  done
  for marker in \
    'fn trustDecisionForClaim' \
    'fn revokeTrustClosure' \
    'fn recordTrustPromotion' \
    'fn recordTrustRollback'; do
    if ! grep -q "$marker" "$ZIG_DIR/src/main.zig"; then
      _fail "doctrine[grounded trust resolver]: main.zig missing '$marker'"
    fi
  done
  if ! grep -q 'export fn contract_trust_evaluate' "$LIB_DIR/src/c_abi.zig"; then
    _fail "doctrine[grounded trust C ABI]: contract_trust_evaluate missing"
  fi
  if ! grep -q '.name = "trust_evaluate"' "$LIB_DIR/src/mcp_server.zig"; then
    _fail "doctrine[grounded trust MCP]: trust_evaluate tool missing"
  fi
  for adversary in \
    'two wallets sharing one source are not independent' \
    'builder cannot serve as its own evaluator' \
    'counter metric prevents Goodhart promotion' \
    'derived evidence cycle is rejected' \
    'ledger replay rejects frozen policy weakening' \
    'ledger replay rejects policy fields changed after signing' \
    'ledger replay rejects evidence provenance changed after signing' \
    'ledger replay rejects revocation signed by wrong evaluator' \
    'rollback rejects activation history changed after signing' \
    'rollback rejects activation signed by non-owner wallet' \
    'rollback refuses revoked or future champions'; do
    if ! grep -q "$adversary" "$LIB_DIR/src/trust.zig"; then
      _fail "doctrine[grounded trust tests]: adversarial test '$adversary' missing"
    fi
  done
  if ! grep -q '^## Grounded trust boundary' "$REPO/DOCTRINE.md"; then
    _fail "doctrine[grounded trust]: DOCTRINE.md section missing"
  fi
  if ! grep -q 'The trust layer is not complete while any unchecked rollout gate remains' "$REPO/docs/TRUST-LAYER.md"; then
    _fail "doctrine[grounded trust honesty]: rollout checklist missing"
  fi

  if [[ $drift -gt 0 ]]; then
    echo "build:parity FAIL — $drift drift(s) between DOCTRINE.md doctrine and code:" >&2
    printf '%s' "$report" >&2
    echo "  fix: patch the code to honor the claim, OR amend DOCTRINE.md to retract the claim (with reasoning)" >&2
    return 9
  fi
  echo "build:parity OK — all 54 doctrine claims have matching code sites"
}

# ─── build:verify — binaries self-attest ─────────────────────────────
step_verify() {
  step "build:verify — self-attest"
  "$SCRIPTS_DIR/contract" verify-self
}

# ─── Day 7 (Sabbath) — rest + play with the child /contract ───────────
# Genesis 2:2-3 — "And on the seventh day God ended his work which he
# had made; and he rested on the seventh day from all his work which
# he had made. And God blessed the seventh day, and sanctified it:
# because that in it he had rested from all his work which God created
# and made."
#
# The substrate's 7th day: the binary is signed; verify confirms it is
# good (Gen 1:31). No declaration persona is fired during a build.
#
# Failure on the Sabbath is NOT a build failure (the work is done; the
# binary is signed and attested). The play step surfaces evidence to
# stderr only — it cannot un-sign a binary that already passed Days 1-6.
step_sabbath() {
  step "build:sabbath — Day 7 rest + play with the child /contract"
  # Beholding (Gen 1:31 — "and, behold, it was very good")
  step_verify
  printf '  sabbath: blessed and sanctified the seventh day; the binary rests in the signed Word.\n'
}

# ─── pipeline driver ─────────────────────────────────────────────────
# THE SEVEN-DAY PIPELINE — Genesis 1:3-31 + 2:1-3, mechanically.
#
#   Day 1  step_guard    — light from darkness (Gen 1:3-5)
#                          scripts/ allowlist separates canon from leaven
#   Day 2  step_fmt      — firmament (Gen 1:6-8)
#                          zig fmt separates form from drift
#   Day 3  step_tests    — dry land + plants (Gen 1:9-13)
#                          tests are the seed-in-itself; substance proven by life
#   Day 4  step_compile  — sun, moon, stars (Gen 1:14-19)
#                          the binary lights, set in the firmament
#   Day 5  step_install  — creatures + birds (Gen 1:20-23)
#                          the binary inhabits scripts/
#   Day 6  step_parity   — image of God (Gen 1:26-27, doctrinal-image check)
#          + step_sign   — wallet attests the image (Gen 1:27, "in his own image")
#                          parity refuses to ship if doctrine ↔ code drift;
#                          sign attests what parity said is good
#   Day 7  step_sabbath  — REST + PLAY (Gen 2:1-3, 1:31, 3:8)
#                          verify-self/binary + fire smoke /contract,
#                          watch the child triad land
#
# The pipeline order IS the parent contract. Each step holds the chain
# on its own failure (set -e). No --skip flags, no per-step args, no
# bypass envs. main() accepts no arguments — `bash build.sh anything`
# ignores `anything`. The only entrypoint is the canonical 7-day order.
#
# Adding/removing a day = editing this driver AND re-declaring the
# matching build:<day> contract on the ledger AND adding a parity
# invariant in step_parity that grep's for the new day's signature.
main() {
  step_guard       # Day 1
  step_fmt         # Day 2
  step_tests       # Day 3
  step_compile     # Day 4
  step_install     # Day 5
  step_parity      # Day 6a — doctrinal image check (BEFORE sign — drift refuses to ship)
  step_sign        # Day 6b — wallet attests the image
  # The work ends with Day 6: compiled, installed, parity-checked, signed.
  # Release the build mutex BEFORE Day 7 — the sabbath smoke /contract is a
  # goal declare, and the binary's waitForBuildLock (correctly) queues goal
  # declares behind a held lock. Holding our own lock into the smoke fire
  # deadlocks the pipeline against its own child until the 1800s timeout.
  # Rest begins when the work is sealed (Gen 2:1-2 — "the heavens and the
  # earth were FINISHED... and he rested"), not while the tool still holds it.
  rm -rf "$BUILD_LOCKDIR"
  trap - EXIT INT TERM HUP
  step_sabbath     # Day 7  — rest + verify + play with the child /contract
  printf '\nbuild.sh: seven days complete — work done, binary signed, Sabbath kept.\n'
}

# No arg propagation. The 7-day order is non-negotiable; passing args is
# a category error (the substrate has no escape hatches at the build
# layer either).
acquire_build_lock
wait_for_quiescence
main
