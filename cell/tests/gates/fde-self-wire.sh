#!/bin/bash
# Falsifier: delete the forbidden-key check in account_handle.py and this
# gate goes red — a payload with api_key would be admitted.
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
RUN=(python3 "$CELL/run.py" run)

fail() { echo "FAIL fde-self-wire: $*" >&2; exit 1; }

# 1. Raw API key must be refused.
printf '%s\n' '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops","api_key":"sk-secret"},"role":"ops","outcome":"own roster"}' > "$tmp/secret.json"
set +e
out=$("${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/secret.json" --out "$tmp/secret-out" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "accepted api_key (rc=0): $out"
echo "$out" | grep -qi "refused\|api_key\|secret" || fail "refusal did not name the secret key: $out"

# 2. Bearer token must be refused.
printf '%s\n' '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops","token":"tok"},"role":"ops","outcome":"own roster"}' > "$tmp/token.json"
set +e
out=$("${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/token.json" --out "$tmp/token-out" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "accepted token (rc=0): $out"

# Caller-chosen handles are not trusted as vault capabilities.
printf '%s
' '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops","id":"cred:forged"},"role":"ops","outcome":"own roster"}' > "$tmp/forged.json"
set +e
out=$("${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/forged.json" --out "$tmp/forged-out" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "accepted a caller-supplied credential id"

# 3. Opaque account handle is admitted and seats Aiko.
printf '%s\n' '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops"},"role":"ops-staffer","outcome":"own daily roster confirmation"}' > "$tmp/ok.json"
"${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/ok.json" --out "$tmp/ok" >/dev/null
hid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$tmp/ok/handle.json")
[[ "$hid" =~ ^cred:[0-9a-f]{32}$ ]] || fail "handle is not opaque: $hid"
digest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "$tmp/ok/workflow_digest.json")
digest=${digest//\"/}
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "digest not sha256: $digest"
python3 - "$tmp/ok" <<'PY'
import json, sys, pathlib
out = pathlib.Path(sys.argv[1])
handoff = json.loads(out.joinpath("handoff.json").read_text())
cell = json.loads(out.joinpath("cell.json").read_text())
assert handoff["agent"] == "aiko", handoff
assert handoff["seat"] == "employee", handoff
assert handoff["auth"] == "account-handle", handoff
assert handoff["handle_id"].startswith("cred:"), handoff
orgs = (cell.get("spec") or {}).get("organelles") or []
assert any("deploy-aiko" in str(o.get("cell","")) for o in orgs), cell
blob = out.joinpath("handle.json").read_text() + out.joinpath("handoff.json").read_text()
for forbidden in ("sk-secret", "api_key", "password", "token"):
    assert forbidden not in blob, forbidden
print("ok seat")
PY

# The generated harness must itself build and fire. A plausible parent
# handoff is not evidence that the child harness was wired.
mkdir -p "$tmp/materialized/neurons"
cp "$CELL/patterns/fde/deploy-aiko.cell.yaml" "$tmp/materialized/deploy-aiko.cell.yaml"
cp "$CELL/patterns/fde/neurons/deploy_aiko.py" "$tmp/materialized/neurons/deploy_aiko.py"
python3 - "$tmp/ok" "$tmp/materialized" <<'PY'
import hashlib, json, pathlib, sys, yaml
out, target = map(pathlib.Path, sys.argv[1:])
cell=json.loads((out/"cell.json").read_text())
canonical=json.dumps(cell,sort_keys=True,ensure_ascii=False,separators=(",",":"))
digest=json.loads((out/"workflow_digest.json").read_text())
assert hashlib.sha256(canonical.encode()).hexdigest()==digest
(target/"aiko-seat.cell.yaml").write_text(yaml.safe_dump(cell,sort_keys=False))
inputs={"role":"ops-staffer","handle":json.loads((out/"handle.json").read_text()),"workflow_digest":digest}
(target/"inputs.json").write_text(json.dumps(inputs))
PY
python3 "$CELL/run.py" build "$tmp/materialized/aiko-seat.cell.yaml" >/dev/null
python3 "$CELL/run.py" run "$tmp/materialized/aiko-seat.cell.yaml" --inputs "$tmp/materialized/inputs.json" --out "$tmp/materialized/out" >/dev/null
cmp "$tmp/ok/handoff.json" "$tmp/materialized/out/handoff.json" >/dev/null || fail "materialized child handoff differs from parent"

# 4. A different outcome is a different digest (workflow identity).
printf '%s\n' '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops"},"role":"ops-staffer","outcome":"own weekly payroll close"}' > "$tmp/other.json"
"${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/other.json" --out "$tmp/other" >/dev/null
other=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "$tmp/other/workflow_digest.json")
other=${other//\"/}
[ "$digest" != "$other" ] || fail "outcome change did not move digest"

# 5. Determinism: same inputs, same bytes.
"${RUN[@]}" "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/ok.json" --out "$tmp/ok2" >/dev/null
diff -q "$tmp/ok/workflow_digest.json" "$tmp/ok2/workflow_digest.json" >/dev/null || fail "digest not deterministic"
diff -q "$tmp/ok/handoff.json" "$tmp/ok2/handoff.json" >/dev/null || fail "handoff not deterministic"

echo "PASS fde-self-wire: secrets refused, Aiko seated, digest moves, deterministic"
