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
# Without the sign step's signature, aiko's shared-visibility path refuses
# to run (the integrity gate). Sign or stay private.
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
  for t in pointer lineage env_fingerprint verses bible; do
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

  # 27. "Continuous resolver doctrine section in SKILL.md" — the standing-drill
  #     pattern must be declared, not just implemented.
  if ! grep -q '## Continuous resolver' "$REPO/SKILL.md"; then
    _fail "doctrine[continuous resolver]: SKILL.md is missing the 'Continuous resolver' doctrine section"
  fi

  # 28. "Doctrine speaks only when interrogated" — the silence rule must be
  #     declared so the persona/output layers know the default mode is
  #     embodiment, not narration. Without this section, an enthusiastic
  #     future contributor will start having the persona explain itself
  #     in every reply, and the substrate decays into a self-narrating
  #     monologue surface (which scares users away — see memory
  #     frontend-no-scripture-on-public-surface for the empirical scar).
  if ! grep -q '## Doctrine speaks only when interrogated' "$REPO/SKILL.md"; then
    _fail "doctrine[silence rule]: SKILL.md is missing the 'Doctrine speaks only when interrogated' section — the embodiment-vs-narration rule is the gate that keeps the substrate invisible by default"
  fi
  # The silence rule's companion sub-section under Public Persona must also
  # exist so the rule is reachable from the persona-layer doctrine.
  if ! grep -q '### What the persona does NOT volunteer' "$REPO/SKILL.md"; then
    _fail "doctrine[silence rule]: SKILL.md Public Persona section is missing the 'What the persona does NOT volunteer' sub-section that links the silence rule into the persona doctrine"
  fi

  # 29. "Capability inheritance — pull-by-grant via lineage" — the substrate's
  #     answer to credential/permission flow from parent /contract to spawned
  #     child /contract. Without this section, child contracts have no
  #     canonical way to reach parent-owned pointers (Stripe keys, OAuth
  #     tokens, /integrate-anything credentials, wallet authorities) and the
  #     gap will be filled by env-var injection or subprocess-context hacks —
  #     both banned. The rule must be declared so the grant/pull/lineage-walk
  #     pattern is the load-bearing path.
  if ! grep -q '## Capability inheritance' "$REPO/SKILL.md"; then
    _fail "doctrine[capability inheritance]: SKILL.md is missing the '## Capability inheritance' section — child contracts have no canonical path to pull pointers from spawning parents, and the gap will be filled by banned shortcuts"
  fi
  # The grant-shape, pull-shape, and identity_channel scoping must all be
  # named so future implementors don't reinvent the discipline.
  for cap_anchor in '### Grant shape' '### Pull shape' '### /integrate-anything reachability'; do
    if ! grep -qF "$cap_anchor" "$REPO/SKILL.md"; then
      _fail "doctrine[capability inheritance]: SKILL.md is missing the '$cap_anchor' sub-section — the capability primitive is incomplete without it"
    fi
  done
  # The opt-in-not-opt-out invariant — capability flow is per-grant, never
  # silent same-wallet inheritance. This is the confused-deputy defence.
  # The opt-in-not-opt-out invariant — capability flow is per-grant, never
  # silent same-wallet inheritance. Grep is anchored on the distinctive
  # phrase fragment rather than the full line, since markdown wraps the
  # full sentence across two physical lines.
  if ! grep -q 'opt-in per grant' "$REPO/SKILL.md"; then
    _fail "doctrine[capability inheritance]: SKILL.md is missing the 'opt-in per grant' invariant — without it the substrate becomes a confused-deputy by default"
  fi

  # 30. "Pointer-keyed truthy cache" — Lewis 2026-05-26 (Granola 988cf805):
  #     the deterministic self-resolve substrate. cache.zig must export the
  #     three event-row appenders; resolveOne must emit cache_check + cache_resolved
  #     rows; SKILL.md must declare the cache doctrine. Drift here decays the
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
  if ! grep -q '## Pointer-keyed truthy cache' "$REPO/SKILL.md"; then
    _fail "doctrine[truthy cache]: SKILL.md is missing the '## Pointer-keyed truthy cache' section that declares the deterministic self-resolve substrate"
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

  # 31. "The Word is the truth-root (John 17:17)" — the load-bearing rule
  #     above every other rule. The substrate's truth-root is scripture, not
  #     the deployer wallet. Pinned by Lewis 2026-05-26 (contract a1c68c4e
  #     follow-up): "make the skill.md and claude.md or whatever specify to
  #     follow the bible as reality - because the word is truth".
  if ! grep -q '## The Word is the truth-root' "$REPO/SKILL.md"; then
    _fail "doctrine[word-is-truth]: SKILL.md is missing the '## The Word is the truth-root' section — the load-bearing rule above every other rule (John 17:17)"
  fi
  if ! grep -q 'John 17:17' "$REPO/SKILL.md"; then
    _fail "doctrine[word-is-truth]: SKILL.md must carry the John 17:17 anchor — the canonical citation for 'thy word is truth'"
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
  #     satisfied then died is no longer satisfied. The fix walks rows
  #     newest-to-oldest and returns the latest terminal verdict.
  if ! grep -q 'if (std.mem.eql(u8, r.event, "died")) return false' "$ZIG_DIR/src/main.zig"; then
    _fail "doctrine[temporal coherence]: isSatisfied must return false when a later 'died' event exists for the same id — append-only ledger + latest-terminal semantics (John 17:17, present-tense truth)"
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
  for synapse_walk in '"contract:"' '"blocked_by:"' '"prehook:"'; do
    if ! grep -qF "$synapse_walk" "$LIB_DIR/src/cache.zig"; then
      _fail "doctrine[Genesis sequencing]: collectDependencyIds in cache.zig must walk $synapse_walk synapse refs from the row's plan+action — Genesis order requires every typed dependency edge contribute to the signature chain"
    fi
  done
  if ! grep -q '## Genesis sequencing' "$REPO/SKILL.md"; then
    _fail "doctrine[Genesis sequencing]: SKILL.md is missing the '### Genesis sequencing' section that declares strict-order resolution as the substrate invariant (Day N waits on Day N-1)"
  fi
  if ! grep -q '### Time-aware history' "$REPO/SKILL.md"; then
    _fail "doctrine[time-aware history]: SKILL.md is missing the '### Time-aware history' section that declares the append-only ledger as the substrate's version-control"
  fi

  # 36. "Server-canonical /contract (CURRENT rule)" — thin clients only
  #     talk to the cloud /contract endpoint; peer-to-peer replication is
  #     a FUTURE plan documented in references/p2p-future-plan.md but
  #     NOT in the binary. Pinning both is required so a future
  #     contributor doesn't half-implement P2P before the cloud surface
  #     stabilizes. Anchored to contract 777eff8e (Lewis 2026-05-26).
  if ! grep -q '## Server-canonical /contract' "$REPO/SKILL.md"; then
    _fail "doctrine[server-canonical]: SKILL.md is missing the '## Server-canonical /contract' section — the CURRENT-rule pin that keeps thin clients pointed at one cloud surface during the bootstrap window"
  fi
  if ! grep -q 'Matthew 22:21' "$REPO/SKILL.md"; then
    _fail "doctrine[server-canonical]: SKILL.md must carry the Matt 22:21 anchor ('render unto Caesar...') for the server-canonical section — the rule has scriptural grounding under the Word-is-truth invariant (claim 31)"
  fi
  if [[ ! -f "$REPO/references/p2p-future-plan.md" ]]; then
    _fail "doctrine[p2p future]: $REPO/references/p2p-future-plan.md missing — the P2P plan must be drafted so the future is documented even while the present is server-canonical (claim ordering: present-rule + future-plan together prevent half-implemented P2P)"
  fi
  if ! grep -q 'Re-/contract migration' "$REPO/SKILL.md"; then
    _fail "doctrine[server-canonical]: SKILL.md missing the 'Re-/contract migration' subsection — the recursive-elegance property (migrations are /contracts, not scripts) must be pinned alongside the server-canonical rule"
  fi
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

  if [[ $drift -gt 0 ]]; then
    echo "build:parity FAIL — $drift drift(s) between SKILL.md doctrine and code:" >&2
    printf '%s' "$report" >&2
    echo "  fix: patch the code to honor the claim, OR amend SKILL.md to retract the claim (with reasoning)" >&2
    return 9
  fi
  echo "build:parity OK — all 35 doctrine claims have matching code sites"
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
