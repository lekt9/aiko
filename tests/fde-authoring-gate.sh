#!/usr/bin/env bash
# Native adapter authoring witness. Falsifier: any catalogue transform that
# reads gap criteria is refused; compiling generated code grants/retains nothing.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUTHOR="$ROOT/cell/adapters/authored/author.py"
PORT="$ROOT/cell/adapters/unbrowse/unbrowse_port.py"
TMP="$(mktemp -d)"; SERVER_PID=""
cleanup(){ [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
fail(){ echo "FAIL fde-authoring: $*" >&2; exit 1; }

# The declared boundary is earned by two origin reads, not fabricated here.
printf 'tenant-authoring-secret' >"$TMP/secret"
cat >"$TMP/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get('Authorization')!='Bearer '+(root/'secret').read_text(): self.send_response(401); self.end_headers(); return
  raw=json.dumps({'workers':[{'id':7,'ready':True}]}).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
 def log_message(self,*a): pass
s=ThreadingHTTPServer(('127.0.0.1',0),H); (root/'port').write_text(str(s.server_port)); s.serve_forever()
PY
python3 "$TMP/server.py" "$TMP" & SERVER_PID=$!
for _ in $(seq 1 100); do [[ -s "$TMP/port" ]] && break; sleep .02; done
[[ -s "$TMP/port" ]] || fail 'origin did not start'
URL="http://127.0.0.1:$(cat "$TMP/port")/workers"
export FDE_AUTH_CREDENTIAL="$(cat "$TMP/secret")"
python3 "$PORT" observe "$TMP/boundary" "$URL" --credential-env FDE_AUTH_CREDENTIAL >/dev/null
python3 "$PORT" replay "$TMP/boundary" "$URL" --credential-env FDE_AUTH_CREDENTIAL >/dev/null

# Consume the credential-envelope contract: only its opaque scoped handle is
# durable; the secret remains invocation material. Its id matches the declared
# Unbrowse boundary exactly.
python3 - "$ROOT" "$TMP/boundary/declared-boundary.json" "$TMP/credential.json" <<'PY'
import importlib.util,json,pathlib,sys,time
root,bp,out=map(pathlib.Path,sys.argv[1:]); boundary=json.loads(bp.read_text()); handle=boundary['auth']['credential_handle']
p=root/'cell/primitives/credential-envelope/vault.py'; spec=importlib.util.spec_from_file_location('fde_vault',p); m=importlib.util.module_from_spec(spec); sys.modules[spec.name]=m; spec.loader.exec_module(m)
env=m.CredentialEnvelope(m.SyntheticVault(),id_factory=lambda:handle)
record=env.enroll(tenant='acme',origin='http://127.0.0.1',account_id='fde',secret=b'not-retained',allowed_actions=['observe'],expires_at=int(time.time())+600,mfa='satisfied')
contract={'schema':'aiko.credential-handle-contract/v1','handle':record['handle'],'tenant':'acme','origin':'http://127.0.0.1','account_id':'fde','allowed_actions':record['allowed_actions'],'expires_at':record['expires_at'],'status':'active','revoked':False,'secret_retained':False}
out.write_text(json.dumps(contract,sort_keys=True,indent=2)+'\n')
assert 'not-retained' not in out.read_text()
PY
BOUNDARY="$TMP/boundary/declared-boundary.json"; CRED="$TMP/credential.json"; WORK="$TMP/work"

# FALSIFIER: the live author audits its bounded catalogue, and the same author
# copied with a transform reading the gap's criterion must go red.
python3 "$AUTHOR" audit-catalog >/dev/null
cp "$AUTHOR" "$TMP/malicious.py"
python3 - "$TMP/malicious.py" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); s=p.read_text(); marker='# TRANSFORM_CATALOG_END'
s=s.replace(marker,'def malicious(schema, gap):\n    return gap.get("expect_contains")\n\n'+marker); p.write_text(s)
PY
if python3 "$TMP/malicious.py" audit-catalog >/dev/null 2>&1; then fail 'catalogue transform read gap criterion'; fi

author_out=$(python3 "$AUTHOR" author "$WORK" --boundary "$BOUNDARY" --credential-contract "$CRED")
[[ "$author_out" == *'authored-inert'* ]] || fail 'package was not written inert'
[[ -x "$WORK/packages/worker-directory/adapter.py" ]] || fail 'new adapter family was not written'
[[ ! -e "$WORK/registry" && ! -e "$WORK/attachments" ]] || fail 'authoring retained authority before proof'

# Compilation alone is explicitly non-retaining.
python3 "$AUTHOR" compile "$WORK" >/dev/null
[[ ! -e "$WORK/registry" && ! -e "$WORK/attachments" ]] || fail 'compilation retained admission/authority'

# Behavior runs through Unbrowse execute to the real origin before admission.
python3 "$AUTHOR" test "$WORK" --port "$PORT" --boundary-state "$TMP/boundary" --url "$URL" --credential-env FDE_AUTH_CREDENTIAL --expected-worker-id 7 >/dev/null
[[ -f "$WORK/receipts/behavior.json" && ! -e "$WORK/registry" ]] || fail 'behavior did not precede admission'

# Changing one tested byte invalidates admission by digest.
cp -R "$WORK" "$TMP/tampered"; printf '\n# changed after test\n' >>"$TMP/tampered/packages/worker-directory/adapter.py"
if python3 "$AUTHOR" admit "$TMP/tampered" >/dev/null 2>&1; then fail 'changed bytes were admitted on an old test receipt'; fi

python3 "$AUTHOR" admit "$WORK" >/dev/null
python3 "$AUTHOR" attach "$WORK" --boundary "$BOUNDARY" --credential-contract "$CRED" >/dev/null
python3 "$AUTHOR" retry "$WORK" --port "$PORT" --boundary-state "$TMP/boundary" --url "$URL" --credential-env FDE_AUTH_CREDENTIAL --expected-worker-id 7 >/dev/null
python3 "$AUTHOR" judge "$WORK" --boundary "$BOUNDARY" --credential-contract "$CRED" --expected-worker-id 7 >/dev/null

python3 - "$WORK/state/admitted-adapter-family.json" "$WORK/attachments/active.json" <<'PY'
import json,sys
j,a=(json.load(open(x)) for x in sys.argv[1:])
assert j['family']=='worker-directory/v1' and len(j['package_digest'])==64
assert j['written_inert'] and j['behavior_tested_before_admission'] and j['admitted_by_digest']
assert j['real_path_retry'] and j['judgment']=='accepted' and j['compilation_retains_nothing']
auth=a['authority']; assert auth['actions']==['observe'] and auth['write_prefixes']==[]
assert len(auth['credential_handles'])==1 and auth['credential_handles'][0].startswith('cred:')
assert auth['network_origins']==[j['least_authority_attached']['network_origins'][0]]
print('  inert -> real test -> digest admission -> least attach -> real retry -> accepted')
PY

# An unrelated response family is refused rather than synthesized to a claim.
python3 - "$BOUNDARY" "$TMP/impossible.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); x['observation']['response_schema']={'type':'object','fields':{'message':{'type':'string'}}}; json.dump(x,open(sys.argv[2],'w'))
PY
if python3 "$AUTHOR" author "$TMP/impossible-work" --boundary "$TMP/impossible.json" --credential-contract "$CRED" >/dev/null 2>&1; then fail 'unbounded family was fabricated'; fi

echo 'PASS fde-authoring: new worker-directory family admitted only after real behavior'
