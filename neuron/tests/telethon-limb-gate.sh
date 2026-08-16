#!/usr/bin/env bash
# Exact public witness for the standalone admitted provider-neutral effect limb.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-telethon-limb.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail(){ echo "FAIL: $*" >&2; exit 1; }
export HOME="$root" PYTHONDONTWRITEBYTECODE=1
binary="$repo/neuron/zig-out/bin/neuron"
[ -x "$binary" ] || (cd "$repo/neuron" && zig build)
node="$root/node"; state="$node/state"; package="$repo/neuron/limbs/telethon"
"$binary" agent init "$node" effect >/dev/null
admission="$("$binary" limb admit "$package" "$state")" || fail "package admission refused"
echo "$admission" | grep -Eq '[0-9a-f]{64}' || fail "admission did not publish a package digest"

payload_digest="$(printf hello | shasum -a 256 | awk '{print $1}')"
request="$(python3 - "$payload_digest" <<'PY'
import json,sys
print(json.dumps({"effect_id":"effect-gate-000001","execution":"exec-gate-1","conversation_id":"chat-A","recipient_id":"recipient-A","payload_digest":sys.argv[1],"credential_handle":"cred:synthetic","expires_at":100},sort_keys=True,separators=(",",":")))
PY
)"
digest="$(printf %s "$request" | shasum -a 256 | awk '{print $1}')"
python3 - "$request" "$digest" >"$root/stimulus.json" <<'PY'
import json,sys
body,digest=sys.argv[1:]
json.dump({"schema":"neuron.stimulus/v1","firing_id":"telethon-gate-1","receptor_schema":"neuron.telethon-effect-request/v1","reads":[{"id":"telethon/gate/request","schema":"neuron.telethon-effect-request/v1","digest":digest,"bytes":body}],"permitted_reads":["telethon/gate/request"],"messages":[]},sys.stdout)
PY
"$binary" limb run "$state" --package "$package" --neuron effect --stimulus "$root/stimulus.json" >/dev/null
python3 - "$state/substrate.log" <<'PY'
import json,sys
found=[]
for line in open(sys.argv[1]):
 r=json.loads(line)
 for a in r.get("artifacts",[]):
  if a.get("id")=="artifact/telethon/outbox/effect-gate-000001": found.append(a)
assert len(found)==1, "planner did not durably write the exact outbox intent"
body=json.loads(bytes.fromhex(found[0]["bytes"]))
assert body["recipient_id"]=="recipient-A" and body["execution"]=="exec-gate-1"
PY
python3 "$package/tests/conformance.py"
python3 "$package/tests/mutations.py"
# The package is hermetic: no live Telethon dependency or production-contact claim.
! grep -RIE '(^|[[:space:]])(from|import)[[:space:]]+telethon|TelegramClient|api_hash|api_id' "$package" --include='*.py' >/dev/null || fail "live Telethon dependency entered hermetic limb"
echo "telethon-limb-gate: PASS (synthetic provider only; no production Telegram claim)"
