#!/bin/bash
# Falsifiers: delete the authorize expiry check, accept raw api_key at the Cell
# membrane, or allow rotate to add an action; this gate goes red.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL credential-envelope: $*" >&2; exit 1; }

python3 "$ROOT/cell/run.py" build "$ROOT/cell/patterns/fde/credential-envelope.cell.yaml" >/dev/null

# Raw secrets must be refused before the host vault is touched.
printf '%s\n' '{"request":{"operation":"inventory","tenant":"acme","api_key":"sk-must-not-cross"}}' > "$tmp/raw.json"
set +e
out=$(python3 "$ROOT/cell/run.py" run "$ROOT/cell/patterns/fde/credential-envelope.cell.yaml" --inputs "$tmp/raw.json" --out "$tmp/raw-out" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "Cell admitted a raw API key"
echo "$out" | grep -qi 'refused raw secret' || fail "raw-secret refusal was not explicit: $out"
[ ! -e "$tmp/raw-out/result.json" ] || fail "refused firing wrote a result"

python3 - "$ROOT" "$tmp/evidence.json" <<'PY'
import importlib.util, json, pathlib, sys
root, evidence_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
mod_path = root / "cell/primitives/credential-envelope/vault.py"
spec = importlib.util.spec_from_file_location("credential_vault", mod_path)
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)

clock = [1_700_000_000]
ids = iter(["cred:" + "1" * 32, "cred:" + "2" * 32])
vault = m.SyntheticVault()
env = m.CredentialEnvelope(vault, now=lambda: clock[0], id_factory=lambda: next(ids))
secret = b"synthetic-password-never-evidence"
handle = env.enroll(tenant="acme", origin="https://chat.example/path", account_id="aiko-ops",
                    secret=secret, allowed_actions=["observe", "send"],
                    expires_at=clock[0] + 60, mfa="required")
assert handle["handle"] == "cred:" + "1" * 32
assert "secret" not in json.dumps(handle).lower()
assert env.inventory(tenant="other") == []
inv = env.inventory(tenant="acme")
assert inv == [handle] and secret.decode() not in json.dumps(inv)

# Exact tenant/origin/account/action scope is required; possessing the opaque id
# cannot widen the capability it denotes.
def refuses(fn, contains):
    try: fn()
    except m.VaultRefusal as exc:
        assert contains.lower() in str(exc).lower(), (contains, exc)
    else: raise AssertionError("expected refusal: " + contains)

refuses(lambda: env.authorize(handle["handle"], tenant="acme", origin="https://chat.example",
                              account_id="aiko-ops", action="send"), "MFA")
refuses(lambda: env.complete_mfa(handle["handle"], approved=False), "approval")
env.complete_mfa(handle["handle"], approved=True)
assert env.authorize(handle["handle"], tenant="acme", origin="https://chat.example/anything",
                     account_id="aiko-ops", action="send") == secret
refuses(lambda: env.authorize(handle["handle"], tenant="other", origin="https://chat.example",
                              account_id="aiko-ops", action="send"), "scope")
refuses(lambda: env.authorize(handle["handle"], tenant="acme", origin="https://chat.example",
                              account_id="aiko-ops", action="admin"), "authority")

# Rotation retains the id, can narrow, forces a new MFA handoff, and cannot widen.
rot = env.rotate(handle["handle"], secret=b"replacement", expires_at=clock[0] + 120,
                 allowed_actions=["observe"])
assert rot["handle"] == handle["handle"] and rot["generation"] == 2
assert rot["allowed_actions"] == ["observe"] and rot["mfa"] == "required"
refuses(lambda: env.rotate(handle["handle"], secret=b"bad", expires_at=clock[0] + 120,
                           allowed_actions=["observe", "admin"]), "never widen")
env.complete_mfa(handle["handle"], approved=True)

# The expiry check is on every authorization, not merely enrollment.
clock[0] += 121
refuses(lambda: env.authorize(handle["handle"], tenant="acme", origin="https://chat.example",
                              account_id="aiko-ops", action="observe"), "expired")
refuses(lambda: env.enroll(tenant="acme", origin="https://chat.example", account_id="late",
                           secret=b"x", allowed_actions=["observe"], expires_at=clock[0]), "expired")

revoked = env.revoke(handle["handle"]); assert revoked["status"] == "revoked"
refuses(lambda: env.authorize(handle["handle"], tenant="acme", origin="https://chat.example",
                              account_id="aiko-ops", action="observe"), "revoked")
logged = env.logout(handle["handle"]); assert logged["status"] == "logged-out"
assert env.inventory(tenant="acme") == []
refuses(lambda: env.mfa_handoff(handle["handle"]), "unknown")

# Corruption and absent native vault fail closed. There is no disk store to inspect.
vault.write("__inventory__", b"not-json")
refuses(lambda: env.inventory(), "corrupt")
old_system, old_which = m.platform.system, m.shutil.which
m.platform.system = lambda: "Plan9"; m.shutil.which = lambda _: None
try: refuses(lambda: m.OSCredentialVault(), "plaintext fallback")
finally: m.platform.system, m.shutil.which = old_system, old_which

# Durable synthetic evidence contains claims/digests, never credential material.
evidence = {"vault_contract":"os-native-only", "handle":handle["handle"],
            "inventory_after_logout":[], "expiry_refused":True,
            "mfa_handoff":"pending-until-approved", "rotate_widens":False,
            "revoked_authorizes":False, "logout_deleted":True}
evidence_path.write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n")
assert secret.decode() not in evidence_path.read_text()
print("synthetic lifecycle evidence ok")
PY

# Mechanical check: production boundary must name the OS implementation directly;
# the synthetic double cannot be selected by an environment flag.
grep -q 'CredentialEnvelope(OSCredentialVault())' "$ROOT/cell/primitives/credential-envelope/manage.py" || fail "production is not hard-wired to OS vault"
! grep -R -E 'open\(|write_text|\.credentials|plaintext' "$ROOT/cell/primitives/credential-envelope/manage.py" >/dev/null || fail "production boundary contains a file fallback"

echo "PASS credential-envelope: OS-only vault, opaque scope, expiry, MFA, revoke, rotate, logout"
