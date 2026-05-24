#!/usr/bin/env bash
# verb-gate: eq — the abstraction-layer gate (substrate-mechanical EQ).
#
# Gathers a person's domain understanding programmatically and returns the
# right layer + voice for the agent to emit at. Replaces Ψ1/Α2 agent
# discipline with a mechanical lookup contract every transport reads BEFORE
# rendering a public-facing surface.
#
# Catches regressions where:
#   - absent profile silently returns wrong defaults (would surface jargon to a non-dev)
#   - 'identity set' doesn't persist (the JSON file never lands on disk)
#   - layer-out-of-range writes succeed (corrupts the schema)
#   - voice not in {substrate, aiko} silently accepted (forbidden surface)
#   - --json output isn't parseable JSON (transports can't consume it)
#   - missing identity arg exits 0 (silent failure)
#   - identity_profile audit row not appended (no history)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"

# === Phase 1: absent identity → defaults L3 / substrate ===
OUT1=$("$CLI" eq stranger@example.com 2>&1)
echo "$OUT1" | grep -q "layer:     L3"          || { echo "FAIL P1: default layer not L3. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "voice:     substrate"   || { echo "FAIL P1: default voice not substrate. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "source:    default"     || { echo "FAIL P1: source not 'default'. OUT=$OUT1"; exit 1; }

# === Phase 2: identity set persists + writes profile JSON ===
OUT2=$("$CLI" identity set lewis@example.com --domain solana-dev --domain ml-research --layer 1 --voice substrate 2>&1)
echo "$OUT2" | grep -q "layer:     L1"               || { echo "FAIL P2: set didn't surface L1. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "audit_row: identity_profile" || { echo "FAIL P2: no audit_row line. OUT=$OUT2"; exit 1; }
PROFILE="$TD/.contracts/identities/lewis@example.com.json"
[ -f "$PROFILE" ]                                    || { echo "FAIL P2: profile JSON not written at $PROFILE"; exit 1; }
JSONOK=$(python3 -c "import json; p=json.load(open('$PROFILE')); print('OK' if p.get('layer')==1 and p.get('voice')=='substrate' and p.get('domain')==['solana-dev','ml-research'] else 'FAIL')")
[ "$JSONOK" = "OK" ]                                 || { echo "FAIL P2: profile JSON content wrong: $JSONOK"; exit 1; }

# === Phase 3: eq on profiled identity returns declared values ===
OUT3=$("$CLI" eq lewis@example.com 2>&1)
echo "$OUT3" | grep -q "layer:     L1"               || { echo "FAIL P3: profile not honored on lookup. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "source:    profile"          || { echo "FAIL P3: source should be 'profile'. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "solana-dev, ml-research"     || { echo "FAIL P3: domain list not surfaced. OUT=$OUT3"; exit 1; }

# === Phase 4: --json output is parseable + complete ===
OUT4=$("$CLI" eq lewis@example.com --json 2>&1)
PARSED=$(echo "$OUT4" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ok = (d['layer'] == 1 and d['voice'] == 'substrate' and
      d['source'] == 'profile' and 'solana-dev' in d['domain'])
print('OK' if ok else f'FAIL: {d}')
")
[ "$PARSED" = "OK" ]                                 || { echo "FAIL P4: --json mismatch: $PARSED"; exit 1; }

# === Phase 5: ledger has identity_profile audit row for the set call ===
HAS_ROW=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'identity_profile' and r.get('id') == 'lewis@example.com']
print('OK' if matches and matches[-1]['profile']['layer'] == 1 else 'FAIL')
")
[ "$HAS_ROW" = "OK" ]                                || { echo "FAIL P5: identity_profile row missing/wrong: $HAS_ROW"; exit 1; }

# === Phase 6: invalid layer / voice rejected with exit 2 ===
set +e
OUT_BADL=$("$CLI" identity set bad@example.com --layer 9 2>&1); RC_BADL=$?
OUT_BADV=$("$CLI" identity set bad@example.com --voice yelling 2>&1); RC_BADV=$?
set -e
[ "$RC_BADL" = "2" ]                                 || { echo "FAIL P6a: invalid --layer didn't exit 2 (got $RC_BADL)"; exit 1; }
[ "$RC_BADV" = "2" ]                                 || { echo "FAIL P6b: invalid --voice didn't exit 2 (got $RC_BADV)"; exit 1; }
echo "$OUT_BADL" | grep -q "layer must be 0..4"      || { echo "FAIL P6a: no layer-range error. OUT=$OUT_BADL"; exit 1; }
echo "$OUT_BADV" | grep -q "voice must be substrate" || { echo "FAIL P6b: no voice-enum error. OUT=$OUT_BADV"; exit 1; }
# Profile must NOT have been written for the invalid attempts
[ ! -f "$TD/.contracts/identities/bad@example.com.json" ] || { echo "FAIL P6: invalid set wrote a profile anyway"; exit 1; }

# === Phase 7: missing identity arg → usage + exit 2 ===
set +e
OUT_USAGE=$("$CLI" eq 2>&1); RC_U=$?
set -e
[ "$RC_U" = "2" ]                                    || { echo "FAIL P7: empty eq didn't exit 2 (got $RC_U)"; exit 1; }
echo "$OUT_USAGE" | grep -q "usage: contract eq"     || { echo "FAIL P7: no usage line. OUT=$OUT_USAGE"; exit 1; }

# === Phase 8: aiko voice + L4 (the non-developer end-user case) ===
"$CLI" identity set buyer@telegram.example --layer 4 --voice aiko --domain non-developer > /dev/null 2>&1
OUT8=$("$CLI" eq buyer@telegram.example --json 2>&1)
AIKO_OK=$(echo "$OUT8" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('OK' if d['layer'] == 4 and d['voice'] == 'aiko' and 'non-developer' in d['domain'] else f'FAIL: {d}')
")
[ "$AIKO_OK" = "OK" ]                                || { echo "FAIL P8: non-dev L4/aiko profile wrong: $AIKO_OK"; exit 1; }

echo "PASS: eq gate — absent identity defaults to L3/substrate, identity set persists + writes JSON + appends identity_profile audit row, eq lookup returns declared layer/voice/domain, --json output parseable, invalid layer (0..4 only) and voice (substrate|aiko only) rejected with exit 2 + no partial write, missing identity arg → usage+exit 2, aiko-voice L4 non-developer profile roundtrips correctly"
