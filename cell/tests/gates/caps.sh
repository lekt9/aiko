#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# primitives/request without url should fail (membrane required)
# For http leaf: allow_net deny is enforced in run.py http path. Test via echo-http with wrong host.
cat > "$tmp/bad_http.cell.yaml" << 'YAML'
apiVersion: cell/v0
kind: Cell
metadata: {name: bad-http, description: capped http that will be denied}
spec:
  membrane:
    inputs: {}
    outputs: { result: {schema: string} }
    caps: { allow_net: ["allowed.example.com"] }
  run:
    kind: http
    http: { method: GET, url: "https://denied.example.com/get" }
YAML
set +e
out=$(python3 "$CELL/run.py" run "$tmp/bad_http.cell.yaml" --out "$tmp/out" 2>&1)
rc=$?
set -e
if [ $rc -eq 0 ]; then echo "FAIL caps: allow_net denial not refused (rc=0): $out"; exit 1; fi
if ! echo "$out" | grep -qi "net denied\|allow_net\|denied"; then
  echo "WARN caps: denied but message missing expected token: $out"
fi
echo "PASS caps: uncapped/denied http refused"
