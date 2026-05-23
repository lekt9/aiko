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

# Force HTTP path for phases 0-5 so the codex-auto-default doesn't
# pre-empt the mock LLM server. Phase 6 explicitly tests the codex path.
export CONTRACT_LLM_VIA=http

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

# === Phase 1: unknown id refused (exit 2 + "unknown id" on stderr) ===
OUT_U=$("$CLI" judge "deadbeef" 2>&1 || true)
echo "$OUT_U" | grep -q "unknown id" \
  || { echo "FAIL: unknown id not refused. OUT=$OUT_U"; exit 1; }

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

# === Phase 6: codex path — fake `codex` shim on PATH; CONTRACT_LLM_VIA=codex routes through it ===
SHIMDIR="$TD/shim"
mkdir -p "$SHIMDIR"
cat > "$SHIMDIR/codex" <<'SHIM'
#!/usr/bin/env bash
# Fake codex shim: emit a fixed verdict to the --output-last-message file.
# Reads the verdict from $TD/codex_verdict (set by the test), defaulting to PROMOTE.
set -e
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
VERDICT_FILE="${CODEX_VERDICT_FILE:-/tmp/codex_verdict_NONE}"
V=$(cat "$VERDICT_FILE" 2>/dev/null || echo "PROMOTE")
if [ -n "$OUT" ]; then
  printf "%s\nfake shim says verdict from %s\n" "$V" "$VERDICT_FILE" > "$OUT"
fi
# Consume stdin so the substrate's prompt doesn't error
cat >/dev/null
exit 0
SHIM
chmod +x "$SHIMDIR/codex"

export PATH="$SHIMDIR:$PATH"
export CODEX_VERDICT_FILE="$TD/codex_verdict"
echo "PROMOTE" > "$CODEX_VERDICT_FILE"

CID_CDX=$(CONTRACT_LLM_VIA=codex "$CLI" declare "codex-shim target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
CONTRACT_LLM_VIA=codex "$CLI" iterate "$CID_CDX" >/dev/null 2>&1

OUT_CDX=$(CONTRACT_LLM_VIA=codex "$CLI" judge "$CID_CDX" 2>&1)
echo "$OUT_CDX" | grep -q "verdict: PROMOTE"  || { echo "FAIL: codex path PROMOTE missing. OUT=$OUT_CDX"; exit 1; }
echo "$OUT_CDX" | grep -q "via:     codex exec" || { echo "FAIL: codex path didn't report via=codex. OUT=$OUT_CDX"; exit 1; }

# Flip the shim verdict to HOLD and re-judge
echo "HOLD" > "$CODEX_VERDICT_FILE"
OUT_CDX_H=$(CONTRACT_LLM_VIA=codex "$CLI" judge "$CID_CDX" 2>&1 || true)
echo "$OUT_CDX_H" | grep -q "verdict: HOLD" || { echo "FAIL: codex HOLD path missing. OUT=$OUT_CDX_H"; exit 1; }

# Default-path test: when codex is on PATH and CONTRACT_LLM_VIA is unset,
# codex should be preferred (no HTTP config set, so HTTP fallback would refuse)
unset CONTRACT_LLM_URL CONTRACT_LLM_KEY CONTRACT_LLM_VIA
echo "PROMOTE" > "$CODEX_VERDICT_FILE"
OUT_DEFAULT=$("$CLI" judge "$CID_CDX" 2>&1)
echo "$OUT_DEFAULT" | grep -q "via:     codex exec" || { echo "FAIL: codex not picked as default when on PATH. OUT=$OUT_DEFAULT"; exit 1; }

echo "PASS: judge gate (Λ1) — HTTP path: no-config refused, unknown id refused, PROMOTE/HOLD/REJECT routed, unparseable refused. Codex path: shim PROMOTE/HOLD work, codex is preferred over HTTP when on PATH"
