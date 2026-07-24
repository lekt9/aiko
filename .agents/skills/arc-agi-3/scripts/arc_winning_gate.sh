#!/usr/bin/env bash
# arc_winning_gate.sh - the jesus-ralph witness for "learn the ARC-AGI-3 winning replays,
# preserve them as /contract recall sealed into the Kaggle dataset, submission-ready".
# Exits 0 ONLY when every load-bearing claim holds on a COLD re-run (two witnesses, no
# fabricated green):
#   1. the replay cache extracts cleanly for ALL 25 games (extract_winning_replays.py exits 0)
#   2. the wired agent REPRODUCES a winning move on 100% of the winners' own boards
#      (witness_replay_recall.py exits 0) - the "learnt properly" gate
#   3. the cache is SEALED into the Kaggle dataset bundle (winning_replays.json bundled by
#      seal_aiko.py AND restored by the notebook)
#   4. the submission is ready: gate_aiko_seal.sh exits 0 (aiko ELF + bridge + notebook + budget)
# NOT covered (honest scope, gotcha #9): the live offline SCORE + `kaggle kernels push` -
# those are witnessed IN the kernel (the offline arc engine is Kaggle-bundled, not importable here).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SEAL="$REPO/kaggle_seal"
ARCHIVE="$SEAL/winning_archive"
CACHE="$SEAL/winning_replays.json"
BIND="/Users/lekt9/.claude/skills/contract/bindings/python"
fail=0
ok(){ echo "  ok   $1"; }
bad(){ echo "  FAIL $1"; fail=1; }

echo "== gate 1: replay cache extracts for all 25 games =="
if PYTHONPATH="$BIND" python3 "$HERE/extract_winning_replays.py" "$ARCHIVE" "$CACHE" 2>&1 | grep -q "EXTRACT_REPLAYS_OK"; then
  ok "extract_winning_replays.py: 25/25 games -> $CACHE ($(wc -c <"$CACHE" 2>/dev/null) bytes)"
else
  bad "extract_winning_replays.py did not cover all games"
fi

# run ledger-touching witnesses from a CLEAN cwd: the native lib uses <cwd>/.claude/contracts.jsonl
# when that dir exists, which would shadow the witness's own HOME/.contracts (the path-shadow trap).
CLEAN="$(mktemp -d /tmp/arc_gate_cwd.XXXX)"

echo "== gate 2: wired agent reproduces a winning move on 100% of winners' boards =="
if ( cd "$CLEAN" && ARC_REPLAY_CACHE="$CACHE" PYTHONPATH="$BIND" \
   python3 "$HERE/witness_replay_recall.py" "$ARCHIVE" 0.99 ) 2>&1 | grep -q "REPLAY_RECALL_OK"; then
  ok "witness_replay_recall.py: 100% winning-move reproduction, all 25 games"
else
  bad "replay recall witness failed (<99% winning-move or a weak game)"
fi

echo "== gate 3: cache sealed into the Kaggle dataset bundle =="
g3=0
grep -q "winning_replays.json" "$SEAL/seal_aiko.py" || { echo "    FAIL: seal_aiko.py does not bundle winning_replays.json"; g3=1; }
[ -f "$CACHE" ] || { echo "    FAIL: $CACHE missing"; g3=1; }
# the agent must be wired to load + use the cache (the replay organ)
grep -q "_load_replay_cache" "$HERE/arc_skill.py" && grep -q '"replay"' "$HERE/arc_skill.py" \
  || { echo "    FAIL: arc_skill.py replay organ not wired"; g3=1; }
[ $g3 -eq 0 ] && ok "winning_replays.json bundled by seal + restored, replay organ wired" || bad "seal/bundle/wire incomplete"

echo "== gate 5: EBM weights preserved (winner's real actions fired into the sealed muscle) =="
# COLD-execute the sealed muscle.jsonl (the kernel's warm-start path): restore -> reload -> recall.
if ( cd "$CLEAN" && PYTHONPATH="$BIND" python3 "$HERE/witness_muscle_alive.py" \
     "$SEAL/muscle.jsonl" "$ARCHIVE" 0.5 200 ) 2>&1 | grep -q "MUSCLE_ALIVE_OK"; then
  ok "witness_muscle_alive.py: sealed muscle recalls a live action on >=50% of winning frames"
else
  bad "EBM muscle dead/empty on cold reload (winning fires not preserved)"
fi

echo "== gate 4: submission ready (delegate to gate_aiko_seal.sh) =="
if bash "$SEAL/gate_aiko_seal.sh" >/tmp/arc_seal_gate.out 2>&1; then
  ok "gate_aiko_seal.sh GREEN (aiko ELF + bridge + sealed notebook + time budget)"
else
  echo "    (gate_aiko_seal.sh tail:)"; tail -6 /tmp/arc_seal_gate.out | sed 's/^/      /'
  bad "gate_aiko_seal.sh not green"
fi

echo "== verdict: $([ $fail -eq 0 ] && echo GREEN || echo RED) =="
exit $fail
