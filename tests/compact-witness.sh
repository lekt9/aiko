#!/usr/bin/env bash
# compact-witness.sh — W1 operator witness: a journaled substrate grows by
# real MCP-edge commits, `neuron compact` folds the WAL into one snapshot
# record, and the folded state keeps serving and appending (§22).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo/zig-out/bin/neuron"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
state="$tmp/state"
log="$state/substrate.log"

# Two journaled commits through the real MCP edge (fail-closed lifecycle).
"$bin" mcp artifact/compact "$state" > "$tmp/mcp1.out" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"neuron.fire","arguments":{"ref":"mesh/proxy","payload":"{\"schema\":\"mesh.proxy/v2\",\"artifact_id\":\"artifact/compact/a\",\"bytes\":\"alpha\"}","firing_id":"f-compact-1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"neuron.fire","arguments":{"ref":"mesh/proxy","payload":"{\"schema\":\"mesh.proxy/v2\",\"artifact_id\":\"artifact/compact/b\",\"bytes\":\"beta\"}","firing_id":"f-compact-2"}}}
EOF
grep -q 'committed' "$tmp/mcp1.out" || { echo "initial firings did not commit"; cat "$tmp/mcp1.out"; exit 1; }

[ -f "$log" ] || { echo "no journal at $log"; exit 1; }
before_lines="$(wc -l < "$log" | tr -d ' ')"
[ "$before_lines" -ge 2 ] || { echo "expected a growing journal, got $before_lines lines"; exit 1; }
before_size="$(stat -f %z "$log")"

# A live second opener is refused even for compaction (single-writer, §22).
# The pipe holds the MCP edge's stdin open without EOF so it keeps the lock.
sleep 2 | "$bin" mcp artifact/compact "$state" > /dev/null 2>&1 &
holder=$!
sleep 0.5
if "$bin" compact "$state" > "$tmp/compact-locked.out" 2>&1; then
  echo "compact ran against a live-locked substrate"; cat "$tmp/compact-locked.out"; kill "$holder" 2>/dev/null; exit 1
fi
grep -q 'cannot open state dir' "$tmp/compact-locked.out" || { echo "unexpected compact-under-lock output"; cat "$tmp/compact-locked.out"; kill "$holder" 2>/dev/null; exit 1; }
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true

# Compact: the WAL folds into exactly one snapshot record.
compact_out="$("$bin" compact "$state")"
echo "$compact_out"
after_lines="$(wc -l < "$log" | tr -d ' ')"
[ "$after_lines" -eq 1 ] || { echo "expected a 1-line snapshot log, got $after_lines"; exit 1; }
head -n 1 "$log" | grep -q '"op":"snapshot"' || { echo "first record is not a snapshot"; exit 1; }
grep -q 'artifact/compact/a' "$log" || { echo "snapshot lost artifact a"; exit 1; }
grep -q 'artifact/compact/b' "$log" || { echo "snapshot lost artifact b"; exit 1; }
after_size="$(stat -f %z "$log")"
[ "$after_size" -lt "$before_size" ] || { echo "log did not shrink ($before_size -> $after_size)"; exit 1; }

# Replay-from-snapshot keeps serving, and new commits append after the
# snapshot: durability continues across the compaction boundary.
"$bin" mcp artifact/compact "$state" > "$tmp/mcp2.out" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"neuron.fire","arguments":{"ref":"mesh/proxy","payload":"{\"schema\":\"mesh.proxy/v2\",\"artifact_id\":\"artifact/compact/c\",\"bytes\":\"gamma\"}","firing_id":"f-compact-3"}}}
EOF
grep -q 'committed' "$tmp/mcp2.out" || { echo "post-compaction firing did not commit"; cat "$tmp/mcp2.out"; exit 1; }
final_lines="$(wc -l < "$log" | tr -d ' ')"
[ "$final_lines" -eq 2 ] || { echo "expected snapshot + 1 commit, got $final_lines lines"; exit 1; }

echo "[compact-witness] PASS — $before_lines records (${before_size}B) folded to a ${after_size}B snapshot; state survives and appends continue"
