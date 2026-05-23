#!/usr/bin/env bash
# verb-gate: x402 (Π1) — pointer-type for unbrowse-backed payment gates.
#
# Hermetic test — does NOT hit beta-api.unbrowse.ai. Instead spawns a tiny
# python HTTP server that mimics the three response codes (200, 402, 401)
# and asserts the substrate emits the right action_result + the
# === PAYMENT REQUIRED === block on 402.
#
# Catches regressions where:
#   - 402 silently passes (the worst possible bug — paywall bypass)
#   - 200 fails (legitimate paid call rejected)
#   - 401 doesn't surface a sign-in hint
#   - PAYMENT REQUIRED block missing the pay_url body
#   - x402 dispatch doesn't reach _run_action (action mistyped as 'api')
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"; jobs -p | xargs -r kill 2>/dev/null' EXIT

export CONTRACTS_STORE="$TD/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Tiny mock server: route /200 returns 200 OK, /402 returns 402 + JSON body
# with pay_url, /401 returns 401, anything else returns 500.
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
MOCK="$TD/mock.py"
cat > "$MOCK" <<EOF
import sys, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
PAID_FLAG = "$TD/paid.flag"
class H(BaseHTTPRequestHandler):
    def log_message(self, *a, **k): pass
    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())
    def do_GET(self):  self._route()
    def do_POST(self): self._route()
    def _route(self):
        if self.path.endswith("/200"):
            self._send(200, json.dumps({"ok":True,"balance_uc":42}))
        elif self.path.endswith("/402"):
            self._send(402, json.dumps({
                "error":"insufficient_balance",
                "balance_uc":0,
                "pay_url":"https://beta-api.unbrowse.ai/v1/billing/checkout?reason=mock",
                "amount":"\$1.00",
                "asset":"USDC",
            }))
        elif self.path.endswith("/402-ap"):
            # Stateful: 402 until /v1/billing/autopay/charge flips PAID_FLAG, then 200
            if os.path.exists(PAID_FLAG):
                self._send(200, json.dumps({"ok":True,"settled_via":"autopay","balance_uc":100}))
            else:
                self._send(402, json.dumps({
                    "error":"insufficient_balance",
                    "balance_uc":0,
                    "pay_url":"https://beta-api.unbrowse.ai/v1/billing/checkout?reason=mock-ap",
                    "amount":"\$0.10",
                    "asset":"USDC",
                }))
        elif self.path == "/v1/billing/autopay/charge":
            # Π2 — server-side autopay. Settles from the user's account, sets flag.
            open(PAID_FLAG, "w").write("paid")
            self._send(200, json.dumps({"paid": True, "amount_uc": 10000, "method":"stripe_card_on_file"}))
        elif self.path.endswith("/401"):
            self._send(401, json.dumps({"error":"missing or invalid bearer"}))
        else:
            self._send(500, json.dumps({"error":"mock-500"}))
HTTPServer(("127.0.0.1", $PORT), H).serve_forever()
EOF
python3 "$MOCK" >/dev/null 2>&1 &
sleep 0.3

# Sanity: ensure pointer_type is recognized as x402, not api/cli
PTYPE=$(MH_ACTION="x402:http://127.0.0.1:$PORT/200" python3 -c "
import sys, os
sys.path.insert(0, '$HOME/.claude/skills/contract/scripts/lib')
from contract_core import _infer_pointer_type
print(_infer_pointer_type(os.environ['MH_ACTION']))
")
[ "$PTYPE" = "x402" ] || { echo "FAIL: pointer_type for x402: is '$PTYPE', expected 'x402'"; exit 1; }

# === 200 path ===
declare_200=$( UNBROWSE_API_KEY="mock-token-200" "$CLI" declare \
  "credit-debit happy path" --action "x402:http://127.0.0.1:$PORT/200" \
  --no-drive 2>&1 | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1 )
[ -n "$declare_200" ] || { echo "FAIL: 200 declare empty"; exit 1; }
OUT_200=$( UNBROWSE_API_KEY="mock-token-200" "$CLI" iterate "$declare_200" 2>&1 )
echo "$OUT_200" | grep -q "result: PASS (HTTP 200" || { echo "FAIL: 200 did not PASS"; echo "$OUT_200" | head; exit 1; }
echo "$OUT_200" | grep -q "PAYMENT REQUIRED" && { echo "FAIL: 200 emitted PAYMENT REQUIRED block (should not)"; exit 1; }

# === 402 path ===
declare_402=$( UNBROWSE_API_KEY="mock-token-402" "$CLI" declare \
  "credit-debit broke" --action "x402:http://127.0.0.1:$PORT/402" \
  --no-drive 2>&1 | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1 )
OUT_402=$( UNBROWSE_API_KEY="mock-token-402" "$CLI" iterate "$declare_402" 2>&1 )
echo "$OUT_402" | grep -q "result: FAIL (402" || { echo "FAIL: 402 did not FAIL"; echo "$OUT_402" | head; exit 1; }
echo "$OUT_402" | grep -q "PAYMENT REQUIRED"  || { echo "FAIL: 402 missing PAYMENT REQUIRED block"; exit 1; }
echo "$OUT_402" | grep -q "pay_url"           || { echo "FAIL: 402 body missing pay_url"; exit 1; }
echo "$OUT_402" | grep -q "sendInvoice"       || { echo "FAIL: 402 missing Telegram-render hint"; exit 1; }
echo "$OUT_402" | grep -q "wallet payment"    || { echo "FAIL: 402 missing Web-render hint"; exit 1; }

# === 401 path ===
declare_401=$( UNBROWSE_API_KEY="mock-token-401" "$CLI" declare \
  "credit-debit unauth" --action "x402:http://127.0.0.1:$PORT/401" \
  --no-drive 2>&1 | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1 )
OUT_401=$( UNBROWSE_API_KEY="mock-token-401" "$CLI" iterate "$declare_401" 2>&1 )
echo "$OUT_401" | grep -q "result: FAIL (HTTP 401"  || { echo "FAIL: 401 did not surface auth-required"; echo "$OUT_401" | head; exit 1; }
echo "$OUT_401" | grep -q "UNBROWSE_API_KEY"        || { echo "FAIL: 401 missing sign-in hint"; exit 1; }
echo "$OUT_401" | grep -q "SIGN-IN REQUIRED"        || { echo "FAIL: 401 missing SIGN-IN REQUIRED block (generative-UI handoff)"; exit 1; }
echo "$OUT_401" | grep -q "magic-link"              || { echo "FAIL: 401 SIGN-IN block missing Telegram render hint (magic-link)"; exit 1; }
echo "$OUT_401" | grep -q "Privy"                   || { echo "FAIL: 401 SIGN-IN block missing Panel render hint (Privy)"; exit 1; }

# === Phase Π2-A: autopay HINT visible when 402 fires WITHOUT opt-in ===
echo "$OUT_402" | grep -q "autopay_available"       || { echo "FAIL: 402 (no autopay) missing autopay_available opt-in hint"; exit 1; }

# === Phase Π2-B: autopay ON → server settles → retry passes silently ===
declare_ap=$( UNBROWSE_API_KEY="mock-token-ap" CONTRACT_AUTOPAY=1 "$CLI" declare \
  "autopay-happy-path" --action "x402:http://127.0.0.1:$PORT/402-ap" \
  --no-drive 2>&1 | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1 )
[ -n "$declare_ap" ] || { echo "FAIL: autopay declare empty"; exit 1; }
OUT_AP=$( UNBROWSE_API_KEY="mock-token-ap" CONTRACT_AUTOPAY=1 CONTRACT_AUTOPAY_CAP_USD=5 "$CLI" iterate "$declare_ap" 2>&1 )
echo "$OUT_AP" | grep -q "autopay: attempting silent settle"   || { echo "FAIL: autopay attempt line missing. OUT=$OUT_AP"; exit 1; }
echo "$OUT_AP" | grep -q "result: PASS (HTTP 200 — autopay settled" || { echo "FAIL: autopay+retry did not silent-PASS. OUT=$OUT_AP"; exit 1; }
echo "$OUT_AP" | grep -q "PAYMENT REQUIRED" && { echo "FAIL: autopay success still emitted PAYMENT REQUIRED block (should be invisible to user)"; exit 1; } || true

# === Phase Π2-C: declared --autopay implies autopay even without env (TODO: declare-time flag) ===
# Today: env CONTRACT_AUTOPAY is the only opt-in. Declare-time --autopay would
# persist on the row. Document, don't gate. The env path is the load-bearing one.

echo "PASS: x402 gate (Π1+Π2) — 200/402/401 + PAYMENT REQUIRED + SIGN-IN REQUIRED + autopay silent-settle path + autopay-off opt-in hint"
