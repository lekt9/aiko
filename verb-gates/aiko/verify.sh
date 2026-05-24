#!/usr/bin/env bash
# verb-gate: aiko — Solana-wallet-bound identity with traceable lineage DAG.
#
# Each aiko = Σ1 identity tied to an Ed25519 keypair (Solana convention).
# Spawn generates a new keypair, persists it 0600, writes aiko_spawned row
# with parent_pubkey for lineage walking. fund emits TRANSFER REQUIRED block
# (substrate names intent + lineage; transport signs on-chain).
#
# Catches regressions where:
#   - spawn doesn't write keypair file owner-readable only (key leak risk)
#   - spawn doesn't append aiko_spawned ledger row (un-traceable)
#   - lineage doesn't extend correctly through 2+ hops
#   - fund accepts a non-ancestor as --from (cross-tree drain attack)
#   - fund doesn't emit TRANSFER REQUIRED block with all custody render hints
#   - tree query on unknown id doesn't exit 1
#   - issues view doesn't aggregate aikos + mailboxes + deferred contracts
#   - missing args don't exit 2
#   - custody=privy|lobster doesn't warn about deferred external custody
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/ledger.jsonl"
mkdir -p "$TD/.contracts/hooks"

# === Phase 1: spawn root aiko writes keypair (0600) + aiko_spawned row ===
ROOT_OUT=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" aiko spawn --handle root 2>&1)
echo "$ROOT_OUT" | grep -q "result:         PASS"                || { echo "FAIL P1: spawn didn't PASS. OUT=$ROOT_OUT"; exit 1; }
ROOT_PUB=$(echo "$ROOT_OUT" | awk '/^  pubkey:/{print $2; exit}')
ROOT_ID=$(echo "$ROOT_OUT" | awk '/^  aiko_id:/{print $2; exit}')
[ -n "$ROOT_PUB" ] && [ -n "$ROOT_ID" ]                          || { echo "FAIL P1: couldn't parse pubkey/id. OUT=$ROOT_OUT"; exit 1; }
KEYFILE="$TD/.contracts/aikos/$ROOT_ID/keypair.json"
[ -f "$KEYFILE" ]                                                || { echo "FAIL P1: keypair file missing at $KEYFILE"; exit 1; }
PERMS=$(stat -f '%Lp' "$KEYFILE" 2>/dev/null || stat -c '%a' "$KEYFILE" 2>/dev/null)
[ "$PERMS" = "600" ]                                             || { echo "FAIL P1: keypair file is $PERMS (not 600) — key leak risk"; exit 1; }
[ -f "$TD/.contracts/aikos/$ROOT_ID/pubkey.txt" ]                || { echo "FAIL P1: pubkey.txt missing"; exit 1; }
# Ledger row check
HAS_ROW=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'aiko_spawned' and r.get('short_id') == '$ROOT_ID']
print('OK' if matches and matches[0].get('parent_pubkey') is None and matches[0].get('depth') == 0 else 'FAIL')
")
[ "$HAS_ROW" = "OK" ]                                            || { echo "FAIL P1: aiko_spawned row wrong (expect root with depth=0)"; exit 1; }

# === Phase 2: child + grandchild — lineage chain extends correctly ===
CHILD_OUT=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" aiko spawn --parent "$ROOT_PUB" --handle child 2>&1)
CHILD_ID=$(echo "$CHILD_OUT" | awk '/^  aiko_id:/{print $2; exit}')
CHILD_PUB=$(echo "$CHILD_OUT" | awk '/^  pubkey:/{print $2; exit}')
GC_OUT=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" aiko spawn --parent "$CHILD_PUB" --handle grandchild 2>&1)
GC_ID=$(echo "$GC_OUT" | awk '/^  aiko_id:/{print $2; exit}')
[ -n "$CHILD_ID" ] && [ -n "$GC_ID" ]                            || { echo "FAIL P2: couldn't parse child/gc ids"; exit 1; }
# Lineage chain check
LINEAGE_OK=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
gc = next((r for r in rows if r.get('event') == 'aiko_spawned' and r.get('short_id') == '$GC_ID'), None)
if not gc: print('FAIL: no gc row'); exit(0)
if gc.get('depth') != 2: print(f'FAIL: gc depth={gc.get(\"depth\")} (expected 2)'); exit(0)
if len(gc.get('lineage', [])) != 2: print(f'FAIL: lineage len={len(gc.get(\"lineage\",[]))}'); exit(0)
if gc['lineage'][0] != '$ROOT_PUB' or gc['lineage'][1] != '$CHILD_PUB': print('FAIL: lineage order wrong'); exit(0)
print('OK')
")
[ "$LINEAGE_OK" = "OK" ]                                         || { echo "FAIL P2: $LINEAGE_OK"; exit 1; }

# === Phase 3: tree command shows both ancestors + self marker ===
TREE_OUT=$(bash "$CLI" aiko tree "$GC_ID" 2>&1)
echo "$TREE_OUT" | grep -q "ancestors (2 hops"                   || { echo "FAIL P3: tree didn't show 2 ancestors. OUT=$TREE_OUT"; exit 1; }
echo "$TREE_OUT" | grep -q "root"                                || { echo "FAIL P3: root handle missing in tree"; exit 1; }
echo "$TREE_OUT" | grep -q "child"                               || { echo "FAIL P3: child handle missing in tree"; exit 1; }
echo "$TREE_OUT" | grep -q "← THIS aiko"                         || { echo "FAIL P3: no THIS aiko marker"; exit 1; }

# === Phase 4: list shows tree with indent matching depth ===
LIST_OUT=$(bash "$CLI" aiko list 2>&1)
echo "$LIST_OUT" | grep -q "AIKO ROSTER (3 aikos)"               || { echo "FAIL P4: roster count wrong. OUT=$LIST_OUT"; exit 1; }
echo "$LIST_OUT" | grep -q "parent=$ROOT_ID"                     || { echo "FAIL P4: parent linkage not surfaced"; exit 1; }

# === Phase 5: fund ancestor → descendant succeeds + writes audit row + emits TRANSFER REQUIRED ===
FUND_OUT=$(bash "$CLI" aiko fund "$GC_ID" --from "$ROOT_PUB" --amount-sol 0.5 --note "gift" 2>&1)
echo "$FUND_OUT" | grep -q "=== TRANSFER REQUIRED ==="           || { echo "FAIL P5: no TRANSFER REQUIRED block. OUT=$FUND_OUT"; exit 1; }
echo "$FUND_OUT" | grep -q "kind:         aiko_fund"             || { echo "FAIL P5: kind missing"; exit 1; }
echo "$FUND_OUT" | grep -q "amount_sol:   0.5"                   || { echo "FAIL P5: amount missing"; exit 1; }
echo "$FUND_OUT" | grep -q "privy:"                              || { echo "FAIL P5: no privy render hint"; exit 1; }
echo "$FUND_OUT" | grep -q "lobster:"                            || { echo "FAIL P5: no lobster render hint"; exit 1; }
echo "$FUND_OUT" | grep -q "self:"                               || { echo "FAIL P5: no self render hint"; exit 1; }
echo "$FUND_OUT" | grep -q "INTENT_RECORDED"                     || { echo "FAIL P5: no INTENT_RECORDED result"; exit 1; }
HAS_FUND=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'aiko_fund_requested' and r.get('amount_sol') == '0.5']
print('OK' if matches and matches[0].get('from_pubkey') == '$ROOT_PUB' else 'FAIL')
")
[ "$HAS_FUND" = "OK" ]                                           || { echo "FAIL P5: aiko_fund_requested audit row wrong"; exit 1; }

# === Phase 6: BUG GUARD — fund from non-ancestor refuses with exit 1 ===
STRANGER_OUT=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" aiko spawn --handle stranger 2>&1)
STRANGER_PUB=$(echo "$STRANGER_OUT" | awk '/^  pubkey:/{print $2; exit}')
set +e
REFUSE_OUT=$(bash "$CLI" aiko fund "$CHILD_ID" --from "$STRANGER_PUB" --amount-sol 1 2>&1)
REFUSE_RC=$?
set -e
[ "$REFUSE_RC" = "1" ]                                           || { echo "FAIL P6: non-ancestor fund exited $REFUSE_RC, expected 1"; exit 1; }
echo "$REFUSE_OUT" | grep -q "not an ancestor"                   || { echo "FAIL P6: no ancestor-required error"; exit 1; }
echo "$REFUSE_OUT" | grep -q "prevents cross-tree drains"        || { echo "FAIL P6: no security-rationale message"; exit 1; }

# === Phase 7: tree on unknown id exits 1 ===
set +e
UNKNOWN_OUT=$(bash "$CLI" aiko tree zzzzzzzz 2>&1)
UNKNOWN_RC=$?
set -e
[ "$UNKNOWN_RC" = "1" ]                                          || { echo "FAIL P7: tree on unknown exited $UNKNOWN_RC, expected 1"; exit 1; }
echo "$UNKNOWN_OUT" | grep -q "no aiko with id"                  || { echo "FAIL P7: no clear error"; exit 1; }

# === Phase 8: custody=privy emits warning about deferred external custody ===
PRIVY_OUT=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" aiko spawn --handle privy-test --custody privy 2>&1)
echo "$PRIVY_OUT" | grep -q "custody='privy' is recorded"        || { echo "FAIL P8: privy warning missing. OUT=$PRIVY_OUT"; exit 1; }
echo "$PRIVY_OUT" | grep -q "migrate later"                      || { echo "FAIL P8: no migrate hint"; exit 1; }
PRIVY_ROW_OK=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'aiko_spawned' and r.get('handle') == 'privy-test']
print('OK' if matches and matches[0].get('custody') == 'privy' else 'FAIL')
")
[ "$PRIVY_ROW_OK" = "OK" ]                                       || { echo "FAIL P8: custody not on row"; exit 1; }

# === Phase 9: issues view aggregates aikos + mailboxes + perms ===
# Seed an open mailbox + a deferred contract for the aggregation test
CONTRACT_AGENT="lewis@x.com" bash "$CLI" mailbox send agent@x.com --brief "test mail" --steps 2 > /dev/null
CONTRACT_AGENT="lewis@x.com" bash "$CLI" declare "DEFERRED-aiko-test: do later" --action "agent-judges" --no-drive > /dev/null 2>&1 || true
ISSUES_OUT=$(bash "$CLI" aiko issues 2>&1)
echo "$ISSUES_OUT" | grep -q "AIKO MANAGEMENT VIEW"              || { echo "FAIL P9: no header. OUT=$ISSUES_OUT"; exit 1; }
echo "$ISSUES_OUT" | grep -q "OPEN MAILBOXES (1)"                || { echo "FAIL P9: mailbox count wrong. OUT=$ISSUES_OUT"; exit 1; }
echo "$ISSUES_OUT" | grep -q "DEFERRED CONTRACTS"                || { echo "FAIL P9: deferred section missing"; exit 1; }
echo "$ISSUES_OUT" | grep -q "AIKO ROSTER"                       || { echo "FAIL P9: roster section missing"; exit 1; }
echo "$ISSUES_OUT" | grep -q "max depth:    2"                   || { echo "FAIL P9: max depth wrong (expect 2 from grandchild)"; exit 1; }

# === Phase 10: missing args → exit 2 with usage ===
set +e
EU=$(bash "$CLI" aiko 2>&1); RU=$?
ES=$(bash "$CLI" aiko spawn --custody bogus 2>&1); RS=$?
ET=$(bash "$CLI" aiko tree 2>&1); RT=$?
EF=$(bash "$CLI" aiko fund 2>&1); RF=$?
set -e
[ "$RU" = "2" ]                                                   || { echo "FAIL P10a: empty aiko exit=$RU"; exit 1; }
[ "$RS" = "2" ]                                                   || { echo "FAIL P10b: bad custody exit=$RS"; exit 1; }
[ "$RT" = "2" ]                                                   || { echo "FAIL P10c: empty tree exit=$RT"; exit 1; }
[ "$RF" = "2" ]                                                   || { echo "FAIL P10d: empty fund exit=$RF"; exit 1; }

echo "PASS: aiko gate — spawn writes 0600 keypair + aiko_spawned row, lineage chain extends across hops, tree shows ancestors + descendants + self marker, list/issues aggregate roster + mailboxes + deferred + perm-requests, fund from ancestor emits TRANSFER REQUIRED with privy/lobster/self render hints + writes aiko_fund_requested audit row, BUG GUARD non-ancestor fund refused exit 1 with cross-tree-drain warning, tree on unknown exit 1, custody=privy records + warns about deferred external custody, all bad args exit 2"
