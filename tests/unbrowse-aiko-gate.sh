#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="$ROOT/cell/adapters/unbrowse/unbrowse_port.py"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

printf stable > "$TMP/mode"
printf 'tenant-super-secret-7391' > "$TMP/secret"
cat > "$TMP/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        secret = (root/'secret').read_text()
        if self.headers.get('Authorization') != 'Bearer ' + secret:
            self.send_response(401); self.end_headers(); return
        mode = (root/'mode').read_text().strip()
        if mode == 'stable': body = {'workers':[{'id': 7, 'ready': True}], 'tenant_echo': secret}
        elif mode == 'changed-value': body = {'workers':[{'id': 8, 'ready': True}], 'tenant_echo': secret}
        else: body = {'workers': {'7': {'ready': True}}, 'tenant_echo': secret}
        raw=json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port))
server.serve_forever()
PY
python3 "$TMP/server.py" "$TMP" &
SERVER_PID=$!
for _ in $(seq 1 100); do [[ -s "$TMP/port" ]] && break; sleep .02; done
[[ -s "$TMP/port" ]]
URL="http://127.0.0.1:$(cat "$TMP/port")/workers"
export TEST_UNBROWSE_CREDENTIAL="$(cat "$TMP/secret")"

# An observation is not a promoted route and cannot be executed.
python3 "$PORT" observe "$TMP/one" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null
if python3 "$PORT" execute "$TMP/one" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null 2>&1; then
  echo 'single observation was incorrectly promoted' >&2; exit 1
fi
python3 - "$TMP/one/declared-boundary.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); assert x['status']=='observed'; assert x['promotion'] is None
assert x['sealing']=={'raw_request_retained':False,'raw_response_retained':False,'secret_values_retained':False}
PY

# The second, separately issued origin request agrees and earns promotion.
python3 "$PORT" replay "$TMP/one" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null
python3 - "$TMP/one/declared-boundary.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); assert x['status']=='promoted'
p=x['promotion']; assert p['independent'] is True
assert p['basis']=='observation_and_independent_replay_agreement'
assert p['observation_id'] != p['replay_id']
assert x['observation']['source']==x['replay']['source']=='origin_http_fetch'
assert x['observation']['response_digest']==x['replay']['response_digest']
PY
OUT="$(python3 "$PORT" execute "$TMP/one" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL)"
[[ "$OUT" == *'"workers"'* ]]
# Neither the credential nor raw response is retained in learned route state.
if grep -R -F "$(cat "$TMP/secret")" "$TMP/one" >/dev/null; then
  echo 'credential/response secret leaked into learned route' >&2; exit 1
fi
[[ "$(stat -f '%Lp' "$TMP/one/declared-boundary.json" 2>/dev/null || stat -c '%a' "$TMP/one/declared-boundary.json")" == 600 ]]

# Independent replay disagreement demotes rather than promoting a lucky capture.
python3 "$PORT" observe "$TMP/disagree" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null
printf changed-value > "$TMP/mode"
if python3 "$PORT" replay "$TMP/disagree" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null 2>&1; then
  echo 'disagreeing replay was incorrectly promoted' >&2; exit 1
fi
python3 - "$TMP/disagree/declared-boundary.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); assert x['status']=='demoted'
assert x['demotion']['reason']=='independent_replay_disagreed'
PY

# Promote a stable route, then move the upstream response shape. Serving must
# fail closed and the durable declaration must be demoted.
printf stable > "$TMP/mode"
python3 "$PORT" observe "$TMP/drift" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null
python3 "$PORT" replay "$TMP/drift" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null
printf drift > "$TMP/mode"
if python3 "$PORT" execute "$TMP/drift" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >"$TMP/drift.out" 2>/dev/null; then
  echo 'drifted promoted route kept serving' >&2; exit 1
fi
[[ ! -s "$TMP/drift.out" ]]
python3 - "$TMP/drift/declared-boundary.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); assert x['status']=='demoted'
assert x['demotion']['reason']=='response_schema_drift'
assert x['demotion']['expected_schema_digest'] != x['demotion']['actual_schema_digest']
PY
if python3 "$PORT" execute "$TMP/drift" "$URL" --credential-env TEST_UNBROWSE_CREDENTIAL >/dev/null 2>&1; then
  echo 'demoted route remained executable' >&2; exit 1
fi

# The published Cell declaration is itself buildable by the native harness.
python3 "$ROOT/cell/run.py" build "$ROOT/cell/patterns/api-reveng/promote.cell.yaml" >/dev/null

echo 'unbrowse aiko gate: ok'
