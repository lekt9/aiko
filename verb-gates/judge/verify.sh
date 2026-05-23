#!/usr/bin/env bash
# verb-gate: judge (Λ1) — runtime-agnostic KEY 2 via configured LLM endpoint.
#
# Catches regressions where:
#   - missing config silently passes (substrate would auto-promote on no-judge)
#   - PROMOTE verdict doesn't exit 0
#   - HOLD/REJECT verdicts don't exit 1 with the right "next" hint
#   - unknown contract id doesn't refuse cleanly
#   - unparseable verdict token from the LLM silently passes
#   - the substrate hits any endpoint OTHER than /chat/completions
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"; jobs -p | xargs -r kill 2>/dev/null' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# Mock LLM server: route /chat/completions returns a verdict whose first token
# is read from $TD/verdict.txt (so each phase can flip the expected verdict).
PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
MOCK="$TD/mock.py"
VERDICT_FILE="$TD/verdict.txt"
cat > "$MOCK" <<EOF
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
VFILE = "$VERDICT_FILE"
class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k): pass
    def do_POST(self):
        verdict = open(VFILE).read().strip() if os.path.exists(VFILE) else "PROMOTE"
        body = json.dumps({"choices":[{"message":{"content": verdict + "\\nbecause the mock said so"}}]})
        if self.path == "/chat/completions":
            self.send_response(200)
        else:
            # Substrate must hit /chat/completions only; 404 anything else
            self.send_response(404)
            body = "{}"
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())
HTTPServer(("127.0.0.1", $PORT), H).serve_forever()
EOF
python3 "$MOCK" >/dev/null 2>&1 &
sleep 0.3

export CONTRACT_LLM_URL="http://127.0.0.1:$PORT"
export CONTRACT_LLM_KEY="mock-key"
export CONTRACT_LLM_MODEL="mock-model"

# Declare a real contract in this tempdir-scoped ledger so judge has a row to read
CID=$("$CLI" declare "test judge target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID" ] || { echo "FAIL: setup declare returned no id"; exit 1; }
"$CLI" iterate "$CID" >/dev/null 2>&1

# === Phase 0: no LLM config exits 2 ===
( unset CONTRACT_LLM_URL CONTRACT_LLM_KEY; "$CLI" judge "$CID" 2>/dev/null && \
  { echo "FAIL: judge without LLM config should exit 2"; exit 1; } ) || true

# === Phase 1: unknown id refused ===
"$CLI" judge "deadbeef" 2>&1 | grep -q "unknown id" \
  || { echo "FAIL: unknown id not refused"; exit 1; }

# === Phase 2: PROMOTE verdict exits 0 ===
echo "PROMOTE" > "$VERDICT_FILE"
OUT_P=$("$CLI" judge "$CID" 2>&1)
echo "$OUT_P" | grep -q "verdict: PROMOTE" || { echo "FAIL: PROMOTE verdict line missing. OUT=$OUT_P"; exit 1; }
echo "$OUT_P" | grep -q "_mark $CID satisfied" || { echo "FAIL: PROMOTE didn't emit _mark hint"; exit 1; }
"$CLI" judge "$CID" >/dev/null 2>&1 || { echo "FAIL: PROMOTE exit code != 0"; exit 1; }

# === Phase 3: HOLD verdict exits 1 with iterate hint ===
echo "HOLD" > "$VERDICT_FILE"
OUT_H=$("$CLI" judge "$CID" 2>&1 || true)
echo "$OUT_H" | grep -q "verdict: HOLD" || { echo "FAIL: HOLD verdict line missing"; exit 1; }
echo "$OUT_H" | grep -q "contract iterate" || { echo "FAIL: HOLD didn't suggest iterate"; exit 1; }
"$CLI" judge "$CID" >/dev/null 2>&1 && { echo "FAIL: HOLD should exit non-zero"; exit 1; } || true

# === Phase 4: REJECT verdict exits 1 with supersede/revise hint ===
echo "REJECT" > "$VERDICT_FILE"
OUT_R=$("$CLI" judge "$CID" 2>&1 || true)
echo "$OUT_R" | grep -q "verdict: REJECT" || { echo "FAIL: REJECT verdict line missing"; exit 1; }
echo "$OUT_R" | grep -qE "supersede|revise" || { echo "FAIL: REJECT didn't suggest supersede/revise"; exit 1; }

# === Phase 5: garbage verdict exits 2 (no silent pass) ===
echo "MAYBE" > "$VERDICT_FILE"
"$CLI" judge "$CID" 2>/dev/null && { echo "FAIL: unparseable verdict should exit 2"; exit 1; } || true

echo "PASS: judge gate (Λ1) — no-config refused, unknown id refused, PROMOTE exits 0 with _mark hint, HOLD exits 1 with iterate hint, REJECT exits 1 with supersede hint, unparseable verdict refused"
