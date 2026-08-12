#!/usr/bin/env bash
# Behavioral acceptance for the GraphHarness compiler/registry membrane. This
# drives only the public wrapper and observes canonical packages and durable CAS
# state; it never treats source-text resemblance as evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL graph-harness-builder: $*" >&2; exit 1; }
expect_refusal() {
  local label=$1; shift
  if "$@" >"$tmp/$label.stdout" 2>"$tmp/$label.stderr"; then
    fail "$label was admitted"
  fi
  [ ! -s "$tmp/$label.stdout" ] || fail "$label emitted a success value"
  grep -Eqi 'refus|(^|[[:space:]])error:' "$tmp/$label.stderr" || fail "$label did not fail closed"
}

[ -x bin/aiko-harness ] || fail "public wrapper is not executable"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-graph-harness.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
fixture=tests/fixtures/graph-harness

# Contract owns the ephemeral private key. The public verifier is pinned once as
# deployment bootstrap; no request may select or override verifier identity.
umask 077
contract_private_key="$tmp/contract-private.pem"
contract_verify_key="$tmp/contract-verify.pem"
/usr/bin/openssl genpkey -algorithm Ed25519 -out "$contract_private_key" >/dev/null 2>&1
/usr/bin/openssl pkey -in "$contract_private_key" -pubout -out "$contract_verify_key" >/dev/null 2>&1
export AIKO_CONTRACT_VERIFY_KEY="$contract_verify_key"

make_attestation() {
  local prepared=$1 output=$2 root=${3:-$fixture}
  python3 "$root/implementations/contract-attester.py" \
    "$prepared" "$output" "$root" "$contract_private_key"
}

sign_attestation() {
  local statement=$1 private_key=${2:-$contract_private_key}
  python3 - "$statement" "$private_key" <<'PY'
import json,pathlib,subprocess,sys,tempfile
p=pathlib.Path(sys.argv[1]); key=pathlib.Path(sys.argv[2]); x=json.loads(p.read_text())
x["authentication"]["value"]=""
raw=json.dumps(x,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
with tempfile.TemporaryDirectory(prefix="aiko-gate-sign.") as d:
    inp=pathlib.Path(d)/"statement.json"; out=pathlib.Path(d)/"signature.bin"
    inp.write_bytes(raw)
    subprocess.run(["/usr/bin/openssl","pkeyutl","-sign","-rawin","-inkey",str(key),
                    "-in",str(inp),"-out",str(out)],check=True,stdout=subprocess.DEVNULL)
    x["authentication"]["value"]=out.read_bytes().hex()
p.write_text(json.dumps(x,ensure_ascii=False,separators=(",",":"),sort_keys=True))
PY
}

# Both internal invariant suites must be reachable through the one public face.
bin/aiko-harness self-test >"$tmp/self-test.log"
grep -q 'graph_harness self-test: PASS' "$tmp/self-test.log" || fail "compiler self-test did not run"
grep -q 'graph_harness_registry self-test: ok' "$tmp/self-test.log" || fail "registry self-test did not run"
bin/aiko-harness help >"$tmp/help"
for command in build admit inspect register find self-test; do
  grep -q "  $command" "$tmp/help" || fail "wrapper help omits $command"
done
if bin/aiko-harness definitely-not-a-command >"$tmp/unknown.stdout" 2>"$tmp/unknown.stderr"; then
  fail "unknown wrapper command succeeded"
fi
grep -q 'unknown command' "$tmp/unknown.stderr" || fail "unknown wrapper command was not diagnosed"

# Every declared valid graph shape compiles: serial data dependency, fan-out /
# fan-in, overlapping collision declarations, and an external effect boundary.
valid=(chain fanout collision effect-boundary)
for shape in "${valid[@]}"; do
  PYTHONHASHSEED=1 bin/aiko-harness build "$fixture/$shape.problem.json" \
    --root "$fixture" -o "$tmp/$shape.one.json"
  PYTHONHASHSEED=937 bin/aiko-harness build "$fixture/$shape.problem.json" \
    --root "$fixture" -o "$tmp/$shape.two.json"
  cmp -s "$tmp/$shape.one.json" "$tmp/$shape.two.json" || fail "$shape build is not byte deterministic"
  bin/aiko-harness inspect "$tmp/$shape.one.json" --root "$fixture" --json >"$tmp/$shape.inspect.json"
done
python3 - "$tmp" <<'PY'
import json, pathlib, sys
base=pathlib.Path(sys.argv[1])
expected={"chain":3,"fanout":4,"collision":3,"effect-boundary":2}
for name,count in expected.items():
    package=json.loads((base/f"{name}.one.json").read_text())
    summary=json.loads((base/f"{name}.inspect.json").read_text())
    assert package["api_version"] == "graph-harness/v1"
    assert package["kind"] == "GraphHarness"
    assert package["admission"]["state"] == "prepared"
    assert summary["state"] == "prepared" and summary["prepared"] is True
    assert summary["admitted"] is False and summary["nodes"] == count
    assert "admitted_by" not in package["admission"] and "ledger_ref" not in package["admission"]
    assert summary["subject_digest"] == package["admission"]["subject_digest"]["value"]
    assert summary["transitive_digest"] == package["admission"]["transitive_digest"]["value"]
    # A transport/admission result must not masquerade as runtime truth.
    forbidden={"frontier","waves","ready","launch","leases","settled","firings","schedule","execution_log"}
    def walk(value):
        if isinstance(value,dict):
            assert forbidden.isdisjoint(value), forbidden.intersection(value)
            for child in value.values(): walk(child)
        elif isinstance(value,list):
            for child in value: walk(child)
    walk(package)
collision=json.loads((base/"collision.one.json").read_text())
a=next(n for n in collision["package"]["nodes"] if n["id"]=="alpha")
b=next(n for n in collision["package"]["nodes"] if n["id"]=="beta")
assert a["depends_on"] == b["depends_on"] == []
assert a["writes"] == b["writes"] == ["artifacts/shared.json"]
assert a["resources"][0]["exclusive"] and b["resources"][0]["exclusive"]
effect=json.loads((base/"effect-boundary.one.json").read_text())
send=next(n for n in effect["package"]["nodes"] if n["id"]=="send")
eff=send["effects"][0]
assert eff == {"external_boundary":True,"kind":"message",
              "on_invalidation":"compensate-never-replay",
              "readback":"required","scope":"fixture.invalid/messages"}
assert any(e["kind"]=="boundary-readback" for e in send["acceptance"]["witness"]["evidence"])
PY

# Preparation cannot be published. A complete, digest-bound Contract-style
# attestation is the sole public route to behavioral admission.
expect_refusal prepared-register bin/aiko-harness register "$tmp/fanout.one.json" --registry "$tmp/prepared-registry"
[ ! -e "$tmp/prepared-registry/refs/fixture-fanout/1.0.0.json" ] || fail "prepared envelope reached registry"
make_attestation "$tmp/fanout.one.json" "$tmp/fanout.attestation.json"
bin/aiko-harness admit "$tmp/fanout.one.json" --attestation "$tmp/fanout.attestation.json"   --root "$fixture" -o "$tmp/fanout.admitted.json"
bin/aiko-harness inspect "$tmp/fanout.admitted.json" --root "$fixture" --json >"$tmp/fanout.admitted.inspect.json"
python3 - "$tmp/fanout.one.json" "$tmp/fanout.attestation.json" "$tmp/fanout.admitted.json" "$tmp/fanout.admitted.inspect.json" <<'PY'
import hashlib,json,sys
prepared,attested,admitted,summary=[json.load(open(p)) for p in sys.argv[1:]]
assert prepared["admission"]["state"]=="prepared"
assert admitted["admission"]["state"]=="admitted"
assert summary["state"]=="admitted" and summary["admitted"] is True and summary["prepared"] is False
adm=admitted["admission"]
assert adm["subject_digest"]==prepared["admission"]["subject_digest"]==attested["subject_digest"]
assert adm["transitive_digest"]==prepared["admission"]["transitive_digest"]==attested["transitive_digest"]
assert adm["admitted_by"]==attested["admitted_by"] and adm["ledger_ref"]==attested["ledger_ref"]
assert adm["verdicts"]==attested["verdicts"] and adm["evidence_refs"]==attested["evidence_refs"]
expected={prepared["package"]["north_star"]["witness"]["id"]}
expected|={n["acceptance"]["witness"]["id"] for n in prepared["package"]["nodes"]}
assert {v["witness_id"] for v in adm["verdicts"]}==expected
assert all(v["verdict_ref"] in adm["evidence_refs"] for v in adm["verdicts"])
canonical=json.dumps(attested,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
assert adm["attestation_digest"]=={"algorithm":"sha256","value":hashlib.sha256(canonical).hexdigest()}
PY

# Deployment bootstrap is mandatory for every admitted transition/read-back.
# Public request arguments cannot select either the verifier key or a legacy
# symmetric trust root.
expect_refusal admit-missing-bootstrap env -u AIKO_CONTRACT_VERIFY_KEY bin/aiko-harness admit "$tmp/fanout.one.json" \
  --attestation "$tmp/fanout.attestation.json" --root "$fixture" -o "$tmp/missing-key.admitted.json"
expect_refusal register-missing-bootstrap env -u AIKO_CONTRACT_VERIFY_KEY bin/aiko-harness register \
  "$tmp/fanout.admitted.json" --registry "$tmp/missing-key-registry"
expect_refusal inspect-admitted-missing-bootstrap env -u AIKO_CONTRACT_VERIFY_KEY bin/aiko-harness inspect \
  "$tmp/fanout.admitted.json" --root "$fixture" --json

for flag in --trust-root --verifier-key; do
  label=${flag#--}
  expect_refusal "admit-override-$label" bin/aiko-harness admit "$tmp/fanout.one.json" \
    --attestation "$tmp/fanout.attestation.json" "$flag" "$contract_verify_key" \
    --root "$fixture" -o "$tmp/override-$label.admitted.json"
  expect_refusal "register-override-$label" bin/aiko-harness register "$tmp/fanout.admitted.json" \
    --registry "$tmp/override-$label-registry" "$flag" "$contract_verify_key"
  expect_refusal "inspect-override-$label" bin/aiko-harness inspect "$tmp/fanout.admitted.json" \
    --root "$fixture" --json "$flag" "$contract_verify_key"
done

# A different deployment key cannot authenticate a genuine Contract statement.
wrong_private_key="$tmp/wrong-private.pem"
wrong_verify_key="$tmp/wrong-verify.pem"
/usr/bin/openssl genpkey -algorithm Ed25519 -out "$wrong_private_key" >/dev/null 2>&1
/usr/bin/openssl pkey -in "$wrong_private_key" -pubout -out "$wrong_verify_key" >/dev/null 2>&1
expect_refusal admit-wrong-deployment-key env AIKO_CONTRACT_VERIFY_KEY="$wrong_verify_key" \
  bin/aiko-harness admit "$tmp/fanout.one.json" --attestation "$tmp/fanout.attestation.json" \
  --root "$fixture" -o "$tmp/wrong-key.admitted.json"
expect_refusal register-wrong-deployment-key env AIKO_CONTRACT_VERIFY_KEY="$wrong_verify_key" \
  bin/aiko-harness register "$tmp/fanout.admitted.json" --registry "$tmp/wrong-key-registry"
expect_refusal inspect-wrong-deployment-key env AIKO_CONTRACT_VERIFY_KEY="$wrong_verify_key" \
  bin/aiko-harness inspect "$tmp/fanout.admitted.json" --root "$fixture" --json

# A verifier bootstrap may contain public SPKI only. OpenSSL can otherwise
# derive a public key from some file-based PKCS#8 private inputs, which would
# put Contract signing custody inside the verifier.
expect_refusal admit-private-verifier env AIKO_CONTRACT_VERIFY_KEY="$contract_private_key" \
  bin/aiko-harness admit "$tmp/fanout.one.json" --attestation "$tmp/fanout.attestation.json" \
  --root "$fixture" -o "$tmp/private-verifier.admitted.json"
expect_refusal register-private-verifier env AIKO_CONTRACT_VERIFY_KEY="$contract_private_key" \
  bin/aiko-harness register "$tmp/fanout.admitted.json" --registry "$tmp/private-verifier-registry"
expect_refusal inspect-private-verifier env AIKO_CONTRACT_VERIFY_KEY="$contract_private_key" \
  bin/aiko-harness inspect "$tmp/fanout.admitted.json" --root "$fixture" --json

# A signature made by the wrong private key still refuses even when its key ID
# falsely names the deployment public key.
python3 "$fixture/implementations/contract-attester.py" "$tmp/fanout.one.json" \
  "$tmp/wrong-private-signature.json" "$fixture" "$wrong_private_key"
python3 - "$tmp/fanout.attestation.json" "$tmp/wrong-private-signature.json" <<'PY'
import json,sys
real=json.load(open(sys.argv[1])); wrong=json.load(open(sys.argv[2]))
wrong["authentication"]["key_id"]=real["authentication"]["key_id"]
json.dump(wrong,open(sys.argv[2],"w"),separators=(",",":"))
PY
expect_refusal wrong-private-signature bin/aiko-harness admit "$tmp/fanout.one.json" \
  --attestation "$tmp/wrong-private-signature.json" --root "$fixture" \
  -o "$tmp/wrong-private-signature.admitted.json"

# Complete but fabricated statements and wrong key IDs/signatures remain data.
python3 - "$tmp/fanout.attestation.json" "$tmp" <<'PY'
import copy,json,pathlib,sys
src=json.load(open(sys.argv[1])); base=pathlib.Path(sys.argv[2])
def dump(name,value):
    (base/f"auth-{name}.json").write_text(json.dumps(value,separators=(",",":")))
x=copy.deepcopy(src)
x["verdicts"][0]["verdict_ref"]="contract:verdict/nonexistent"
x["evidence_refs"][0]="contract:verdict/nonexistent"
x["authentication"]["value"]="0"*128
dump("fabricated-unsigned",x)
x=copy.deepcopy(src); x["authentication"]["key_id"]="sha256:"+"f"*64; dump("wrong-key-id",x)
x=copy.deepcopy(src); x["authentication"]["value"]="not-lowercase-hex"; dump("wrong-value",x)
PY
for attack in fabricated-unsigned wrong-key-id wrong-value; do
  expect_refusal "$attack" bin/aiko-harness admit "$tmp/fanout.one.json" \
    --attestation "$tmp/auth-$attack.json" --root "$fixture" -o "$tmp/$attack.admitted.json"
done

# The directory surface is atomic and truthfully describes preparation. It
# exposes all reusable compiler artifacts without inventing execution state.
bin/aiko-harness build "$fixture/collision.problem.json" --root "$fixture" --out "$tmp/collision.bundle"
python3 - "$tmp/collision.bundle" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); expected={"envelope.json","walk.json","manifest.json","SKILL.md"}
assert {p.name for p in root.iterdir()}==expected
envelope=json.loads((root/"envelope.json").read_text()); walk=json.loads((root/"walk.json").read_text())
manifest=json.loads((root/"manifest.json").read_text()); skill=(root/"SKILL.md").read_text()
assert envelope["admission"]["state"]=="prepared"
assert manifest["summary"]["state"]=="prepared" and manifest["summary"]["prepared"] is True
assert manifest["summary"]["admitted"] is False
assert manifest["artifacts"]==["envelope.json","walk.json","manifest.json","SKILL.md"]
assert {n["id"] for n in walk["nodes"]}=={"alpha","beta","merge"}
assert all(n["status"]=="pending" and "pinned_skills" in n for n in walk["nodes"])
assert manifest["declared_collisions"]["resources"]
assert "prepared GraphHarness" in skill and "This admitted GraphHarness" not in skill
PY
for problem in invalid-edge cycle; do
  dest="$tmp/$problem.bundle"
  expect_refusal "$problem-out" bin/aiko-harness build "$fixture/$problem.problem.json" --root "$fixture" --out "$dest"
  [ ! -e "$dest" ] || fail "$problem --out retained a destination"
  ! compgen -G "$tmp/.$problem.bundle.*" >/dev/null || fail "$problem --out retained staging debris"
done
cat >"$tmp/late-doctor" <<'SH'
#!/bin/sh
printf '%s\n' 'late topology refusal' >&2
exit 23
SH
chmod +x "$tmp/late-doctor"
expect_refusal late-output bin/aiko-harness build "$fixture/fanout.problem.json" --root "$fixture"   --doctor "$tmp/late-doctor" --out "$tmp/late.bundle"
[ ! -e "$tmp/late.bundle" ] || fail "late emission failure retained destination"
! compgen -G "$tmp/.late.bundle.*" >/dev/null || fail "late emission failure retained staging debris"

# Checked-in negative declarations must all refuse and retain no output package.
for problem in invalid-bounds invalid-digest invalid-edge invalid-effect invalid-grounding cycle; do
  expect_refusal "$problem" bin/aiko-harness build "$fixture/$problem.problem.json" \
    --root "$fixture" -o "$tmp/$problem.package.json"
  [ ! -e "$tmp/$problem.package.json" ] || fail "$problem retained output after refusal"
done

# Create adversarial declarations from real accepted fixtures. Digests are made
# correct where necessary so these cases exercise the boundary, not a cheap
# preceding mismatch.
cp -R "$fixture" "$tmp/reference-root"
printf 'outside the admitted root\n' >"$tmp/outside.cell"
python3 - "$tmp" <<'PY'
import copy, hashlib, json, pathlib, sys
base=pathlib.Path(sys.argv[1]); root=base/"reference-root"
def dump(name,obj): (base/name).write_text(json.dumps(obj,separators=(",",":")),encoding="utf-8")
def load(name="fanout.problem.json"):
    return json.loads((root/name).read_text(encoding="utf-8"))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
# Lexical escape with a truthful digest.
x=load(); impl=x["package"]["nodes"][0]["implementation"]
impl["ref"]="../outside.cell"; impl["digest"]["value"]=digest(base/"outside.cell"); dump("path-escape.json",x)
# A symlink resolving outside is equally an escape.
(root/"outside-link.cell").symlink_to(base/"outside.cell")
x=load(); impl=x["package"]["nodes"][0]["implementation"]
impl["ref"]="outside-link.cell"; impl["digest"]["value"]=digest(base/"outside.cell"); dump("symlink-escape.json",x)
# Correctly-shaped boundary declarations with each indispensable guarantee removed.
for name, mutate in {
 "effect-replay.json": lambda n: n["effects"][0].update(on_invalidation="recompute"),
 "effect-no-readback.json": lambda n: n["effects"][0].update(readback="not-applicable"),
 "effect-unjudged-readback.json": lambda n: n["acceptance"]["judge"].update(consumes=["missing-readback"]),
}.items():
    x=load("effect-boundary.problem.json"); n=next(v for v in x["package"]["nodes"] if v["id"]=="send")
    mutate(n); dump(name,x)
PY
for attack in path-escape symlink-escape effect-replay effect-no-readback effect-unjudged-readback; do
  expect_refusal "$attack" bin/aiko-harness build "$tmp/$attack.json" --root "$tmp/reference-root" -o "$tmp/$attack.out"
done

# Correctly digested arbitrary prose cannot masquerade as an installed skill.
printf '%s\n' 'not a skill; no frontmatter or falsifiable acceptance' >"$tmp/reference-root/fake-skill.md"
python3 - "$tmp/reference-root/fanout.problem.json" "$tmp/reference-root/fake-skill.md" "$tmp/fake-skill.json" <<'PY'
import hashlib,json,sys
x=json.load(open(sys.argv[1])); d=hashlib.sha256(open(sys.argv[2],"rb").read()).hexdigest()
for node in x["package"]["nodes"]:
    node["grounding"]={"skills":[{"name":"graph-engineering","declaration":{
      "ref":"fake-skill.md","digest":{"algorithm":"sha256","value":d},"media_type":"text/markdown"}}]}
json.dump(x,open(sys.argv[3],"w"),separators=(",",":"))
PY
expect_refusal fake-skill bin/aiko-harness build "$tmp/fake-skill.json" --root "$tmp/reference-root" -o "$tmp/fake-skill.out"

# Even an implementation whose actual bytes exit 99 remains inert/prepared.
# Registration refuses it; no line here claims that its witness ran.
cp -R "$fixture" "$tmp/exit99-root"
printf '%s\n' '#!/usr/bin/env python3' 'raise SystemExit(99)' >"$tmp/exit99-root/implementations/witness.py"
python3 - "$tmp/exit99-root/fanout.problem.json" "$tmp/exit99-root/implementations/witness.py" "$tmp/exit99.problem.json" <<'PY'
import hashlib,json,sys
x=json.load(open(sys.argv[1])); ref="implementations/witness.py"
d=hashlib.sha256(open(sys.argv[2],"rb").read()).hexdigest()
def bind(v):
    if isinstance(v,dict):
        if v.get("ref")==ref and isinstance(v.get("digest"),dict): v["digest"]["value"]=d
        for child in v.values(): bind(child)
    elif isinstance(v,list):
        for child in v: bind(child)
bind(x); json.dump(x,open(sys.argv[3],"w"),separators=(",",":"))
PY
bin/aiko-harness build "$tmp/exit99.problem.json" --root "$tmp/exit99-root" -o "$tmp/exit99.prepared.json"
python3 - "$tmp/exit99.prepared.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); assert x["admission"]["state"]=="prepared"
assert "verdicts" not in x["admission"] and "ledger_ref" not in x["admission"]
PY
expect_refusal exit99-register bin/aiko-harness register "$tmp/exit99.prepared.json" --registry "$tmp/exit99-registry"

# JSON ambiguity, normalization escapes, fake judge independence, invalid SemVer,
# and non-I-JSON integers all refuse before a package can be retained.
python3 - "$fixture/fanout.problem.json" "$tmp" <<'PY'
import copy,json,pathlib,sys
source=pathlib.Path(sys.argv[1]); base=pathlib.Path(sys.argv[2]); x=json.loads(source.read_text())
(base/"duplicate.json").write_text(source.read_text().replace("{",'{"api_version":"graph-harness/v1",',1))
cases={
 "normalized-escape": lambda y:y["package"]["nodes"][0].update(writes=["artifacts/../escape"]),
 "self-judge": lambda y:y["package"]["nodes"][0]["acceptance"]["judge"].update(implementation=copy.deepcopy(y["package"]["nodes"][0]["acceptance"]["witness"]["implementation"])),
 "bad-semver": lambda y:(y["package"]["metadata"].update(version="1.0.0-01"),y["registry"].update(version="1.0.0-01")),
 "unsafe-integer": lambda y:y["package"]["recursion"].update(max_wall_time_ms=9007199254740992),
}
for name,mutate in cases.items():
    y=copy.deepcopy(x); mutate(y); (base/f"{name}.json").write_text(json.dumps(y,separators=(",",":")))
PY
for attack in duplicate normalized-escape self-judge bad-semver unsafe-integer; do
  expect_refusal "$attack" bin/aiko-harness build "$tmp/$attack.json" --root "$fixture" -o "$tmp/$attack.out"
done

# Admission binds the whole Contract statement, exact prepared identities, exact
# witness coverage, exact judge implementations, attester bytes, and evidence.
python3 - "$tmp/fanout.attestation.json" "$tmp" <<'PY'
import copy,json,pathlib,sys
src=json.load(open(sys.argv[1])); base=pathlib.Path(sys.argv[2])
def dump(name,value):
    (base/f"attestation-{name}.json").write_text(json.dumps(value,separators=(",",":")))
x=copy.deepcopy(src); del x["ledger_ref"]; dump("missing",x)
x=copy.deepcopy(src); x["subject_digest"]["value"]="0"*64; dump("mismatched",x)
x=copy.deepcopy(src); x["verdicts"].pop(); dump("incomplete",x)
x=copy.deepcopy(src); x["verdicts"][0]["judge"]["digest"]["value"]="f"*64; dump("forged-judge",x)
x=copy.deepcopy(src); x["admitted_by"]["digest"]["value"]="e"*64; dump("forged-admitter",x)
x=copy.deepcopy(src); x["evidence_refs"].remove(x["verdicts"][0]["verdict_ref"]); dump("missing-verdict-evidence",x)
x=copy.deepcopy(src); x["admitted_at"]="2026-03-10 00:00:00Z"; dump("space-datetime",x)
PY
# Authenticate malformed semantic statements so their refusal is not merely a
# stale signature. The schema-incomplete statement cannot need that distinction.
for attack in mismatched incomplete forged-judge forged-admitter missing-verdict-evidence space-datetime; do
  sign_attestation "$tmp/attestation-$attack.json"
done
for attack in missing mismatched incomplete forged-judge forged-admitter missing-verdict-evidence space-datetime; do
  expect_refusal "attestation-$attack" bin/aiko-harness admit "$tmp/fanout.one.json" \
    --attestation "$tmp/attestation-$attack.json" --root "$fixture" -o "$tmp/$attack.admitted.json"
  [ ! -e "$tmp/$attack.admitted.json" ] || fail "$attack attestation retained an admitted output"
done

# Every one of the 13 signed-statement fields is covered. Mutation under the
# deployment key's original signature must refuse, including authentication's
# algorithm, key identity, and signature value themselves.
python3 - "$tmp/fanout.attestation.json" "$tmp" <<'PY'
import copy,json,pathlib,sys
src=json.load(open(sys.argv[1])); base=pathlib.Path(sys.argv[2])
def emit(name, fn):
    x=copy.deepcopy(src); fn(x)
    (base/f"field-{name}.json").write_text(json.dumps(x,separators=(",",":")))
mutations={
 "api-version":lambda x:x.update(api_version="graph-harness-attestation/v2"),
 "kind":lambda x:x.update(kind="Other"), "owner":lambda x:x.update(owner="attacker"),
 "subject":lambda x:x["subject_digest"].update(value="0"*64),
 "transitive":lambda x:x["transitive_digest"].update(value="1"*64),
 "verdicts":lambda x:x["verdicts"][0].update(verdict_ref="contract:verdict/changed"),
 "admitted-by":lambda x:x["admitted_by"].update(entrypoint="changed"),
 "admitted-at":lambda x:x.update(admitted_at="2026-03-11T00:00:00Z"),
 "evidence":lambda x:x["evidence_refs"].append("contract:evidence/changed"),
 "ledger":lambda x:x.update(ledger_ref="contract:ledger/changed"),
 "algorithm":lambda x:x["authentication"].update(algorithm="hmac-sha256"),
 "key-id":lambda x:x["authentication"].update(key_id="sha256:"+"f"*64),
 "value":lambda x:x["authentication"].update(value="f"*128),
}
assert len(mutations)==13
for name,fn in mutations.items(): emit(name,fn)
PY
for field in api-version kind owner subject transitive verdicts admitted-by admitted-at evidence ledger algorithm key-id value; do
  expect_refusal "signed-field-$field" bin/aiko-harness admit "$tmp/fanout.one.json" \
    --attestation "$tmp/field-$field.json" --root "$fixture" -o "$tmp/field-$field.admitted.json"
done

# A nested prepared package contributes its own verified transitive identity.
# This proves closure transport only; it does not claim the child executed.
# Moving a material used only through the child invalidates the parent too.
cp -R "$fixture" "$tmp/nested-root"
bin/aiko-harness build "$tmp/nested-root/fanout.problem.json" --root "$tmp/nested-root" -o "$tmp/nested-root/child.package.json"
python3 - "$tmp/nested-root/chain.problem.json" "$tmp/nested-root/child.package.json" "$tmp/nested-root/parent.problem.json" <<'PY'
import hashlib,json,sys
parent=json.load(open(sys.argv[1])); raw=open(sys.argv[2],"rb").read()
parent["package"]["provenance"]["source_digests"].append({
 "ref":"child.package.json","digest":{"algorithm":"sha256","value":hashlib.sha256(raw).hexdigest()},
 "media_type":"application/vnd.aiko.graph-harness+json;version=1"})
json.dump(parent,open(sys.argv[3],"w"),separators=(",",":"))
PY
bin/aiko-harness build "$tmp/nested-root/parent.problem.json" --root "$tmp/nested-root" -o "$tmp/parent.package.json"
python3 - "$tmp/parent.package.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); nested=[e for e in x["admission"]["dependency_closure"] if e["kind"]=="graph-harness"]
assert len(nested)==1 and "transitive_digest" in nested[0]
PY
printf '\ntampered through child\n' >>"$tmp/nested-root/implementations/transform.cell.json"
expect_refusal nested-transitive-tamper bin/aiko-harness inspect "$tmp/parent.package.json" --root "$tmp/nested-root" --json

# Inspection re-establishes both envelope identity and transitive material
# identity. Neither JSON tampering nor changed referenced bytes may survive it.
python3 - "$tmp/fanout.one.json" "$tmp/tampered-envelope.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
x["package"]["metadata"]["description"]="changed after admission"
json.dump(x,open(sys.argv[2],"w",encoding="utf-8"),separators=(",",":"))
PY
expect_refusal tampered-envelope bin/aiko-harness inspect "$tmp/tampered-envelope.json" --root "$fixture" --json
cp -R "$fixture" "$tmp/moved-materials"
bin/aiko-harness build "$tmp/moved-materials/fanout.problem.json" --root "$tmp/moved-materials" -o "$tmp/material.package.json"
printf '\ntampered\n' >>"$tmp/moved-materials/implementations/transform.cell.json"
expect_refusal tampered-material bin/aiko-harness inspect "$tmp/material.package.json" --root "$tmp/moved-materials" --json

# Registration is immutable and reusable. The second publication is a durable
# read-back dedupe, and find returns exactly the admitted canonical envelope.
registry="$tmp/registry"
# Pre-positioned registry symlinks must not redirect immutable publication.
mkdir -p "$tmp/symlink-registry" "$tmp/registry-escape"
ln -s "$tmp/registry-escape" "$tmp/symlink-registry/objects"
expect_refusal registry-symlink bin/aiko-harness register "$tmp/fanout.admitted.json" --registry "$tmp/symlink-registry"
[ -z "$(find "$tmp/registry-escape" -type f -print -quit)" ] || fail "registry symlink escaped its root"

bin/aiko-harness register "$tmp/fanout.admitted.json" --registry "$registry" >"$tmp/register.first.json"
bin/aiko-harness register "$tmp/fanout.admitted.json" --registry "$registry" >"$tmp/register.second.json"
bin/aiko-harness find fixture-fanout --registry "$registry" --version 1.0.0 \
  --tag fixture >"$tmp/found.json"
cmp -s "$tmp/fanout.admitted.json" "$tmp/found.json" || fail "find did not return canonical registered bytes"
expect_refusal find-missing-bootstrap env -u AIKO_CONTRACT_VERIFY_KEY bin/aiko-harness find fixture-fanout \
  --registry "$registry" --version 1.0.0
expect_refusal find-wrong-deployment-key env AIKO_CONTRACT_VERIFY_KEY="$wrong_verify_key" \
  bin/aiko-harness find fixture-fanout --registry "$registry" --version 1.0.0
expect_refusal find-private-verifier env AIKO_CONTRACT_VERIFY_KEY="$contract_private_key" \
  bin/aiko-harness find fixture-fanout --registry "$registry" --version 1.0.0
for flag in --trust-root --verifier-key; do
  label=${flag#--}
  expect_refusal "find-override-$label" bin/aiko-harness find fixture-fanout \
    --registry "$registry" --version 1.0.0 "$flag" "$contract_verify_key"
done
python3 - "$tmp/register.first.json" "$tmp/register.second.json" "$registry" <<'PY'
import json,pathlib,sys
first=json.load(open(sys.argv[1])); second=json.load(open(sys.argv[2])); root=pathlib.Path(sys.argv[3])
assert first["deduped"] is False and second["deduped"] is True
assert first["subject_digest"] == second["subject_digest"]
assert first["envelope_digest"] == second["envelope_digest"]
files=[p.relative_to(root).parts for p in root.rglob("*") if p.is_file()]
assert len(files)==2, files
assert any(parts[0]=="objects" and parts[1]=="sha256" for parts in files)
assert any(parts[0]=="refs" and parts[1]=="fixture-fanout" for parts in files)
# Registry persistence contains transport identity only: no scheduler, ledger,
# lease, firing, or settlement side-store appears as a behavioral side effect.
assert {parts[0] for parts in files} == {"objects","refs"}
PY

# A fresh registry re-verifies admission identities rather than trusting that
# canonical bytes came from `admit`. Stale internal digests and hand-authored
# envelopes with recomputed digests but no valid Contract MAC all refuse.
python3 - "$tmp/fanout.admitted.json" "$tmp" <<'PY'
import copy,hashlib,json,pathlib,sys
src=json.load(open(sys.argv[1])); base=pathlib.Path(sys.argv[2])
def canonical(value):
    return json.dumps(value,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
def sha(value): return hashlib.sha256(canonical(value)).hexdigest()
def dump(name,value): (base/name).write_bytes(canonical(value)+b"\n")
x=copy.deepcopy(src)
x["admission"]["evidence_refs"].append("attacker:self-assertion")
dump("stale-attestation-digest.admitted.json",x)
x=copy.deepcopy(src)
x["admission"]["dependency_closure"][0]["digest"]["value"]="a"*64
x["admission"]["dependency_closure"].sort(key=canonical)
dump("stale-transitive-digest.admitted.json",x)
x=copy.deepcopy(src)
x["package"]["metadata"]["description"]="hand-authored package with recomputed internal identities"
x["registry"]["description"]=x["package"]["metadata"]["description"]
adm=x["admission"]
adm["subject_digest"]["value"]=sha(x["package"])
adm["transitive_digest"]["value"]=sha({
    "subject_digest":adm["subject_digest"],"dependency_closure":adm["dependency_closure"]})
attestation={key:adm[key] for key in (
    "subject_digest","transitive_digest","verdicts","admitted_by","admitted_at",
    "evidence_refs","ledger_ref","authentication")}
attestation={"api_version":"graph-harness-attestation/v1",
             "kind":"GraphHarnessAdmissionAttestation","owner":"contract",**attestation}
adm["attestation_digest"]["value"]=sha(attestation)
dump("hand-authored-invalid-mac.admitted.json",x)
PY
for attack in stale-attestation-digest stale-transitive-digest hand-authored-invalid-mac; do
  expect_refusal "$attack" bin/aiko-harness register "$tmp/$attack.admitted.json" \
    --registry "$tmp/fresh-$attack-registry"
  [ ! -e "$tmp/fresh-$attack-registry/refs/fixture-fanout/1.0.0.json" ] || \
    fail "$attack reached a fresh registry"
done
grep -qi 'attestation digest mismatch' "$tmp/stale-attestation-digest.stderr" || \
  fail "stale attestation digest did not reach its intended refusal"
grep -qi 'transitive digest mismatch' "$tmp/stale-transitive-digest.stderr" || \
  fail "stale transitive digest did not reach its intended refusal"
grep -Eqi 'authentication|signature|Ed25519' "$tmp/hand-authored-invalid-mac.stderr" || \
  fail "hand-authored envelope did not reach Contract Ed25519 refusal"

# Registry projection declarations must remain bound to the authenticated
# closure. This envelope retains a genuine Contract signature but names cell_v0
# bytes whose identity is absent from that closure.
printf '%s' 'malicious projection bytes' >"$tmp/changed.cell"
python3 - "$tmp/fanout.admitted.json" "$tmp/changed.cell" "$tmp/projection-changed.admitted.json" <<'PY'
import hashlib,json,sys
x=json.load(open(sys.argv[1])); raw=open(sys.argv[2],"rb").read()
p=x["registry"]["projections"]["cell_v0"]
p["ref"]="changed.cell"
p["digest"]["value"]=hashlib.sha256(raw).hexdigest()
json.dump(x,open(sys.argv[3],"w"),separators=(",",":"))
PY
expect_refusal projection-absent-from-authenticated-closure bin/aiko-harness register \
  "$tmp/projection-changed.admitted.json" --registry "$tmp/projection-registry"
[ ! -e "$tmp/projection-registry/refs/fixture-fanout/1.0.0.json" ] || \
  fail "projection identity absent from authenticated closure was published"

# An immutable name/version cannot be rebound to different admitted bytes.
python3 - "$fixture/fanout.problem.json" "$tmp/conflict.problem.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
x["package"]["metadata"]["description"]="different behavior at the same version"
x["registry"]["description"]="different behavior at the same version"
json.dump(x,open(sys.argv[2],"w",encoding="utf-8"),separators=(",",":"))
PY
bin/aiko-harness build "$tmp/conflict.problem.json" --root "$fixture" -o "$tmp/conflict.prepared.json"
make_attestation "$tmp/conflict.prepared.json" "$tmp/conflict.attestation.json"
bin/aiko-harness admit "$tmp/conflict.prepared.json" --attestation "$tmp/conflict.attestation.json" \
  --root "$fixture" -o "$tmp/conflict.admitted.json"
expect_refusal registry-conflict bin/aiko-harness register "$tmp/conflict.admitted.json" --registry "$registry"

# The CAS identity covers the full canonical envelope, not only /package. Each
# independently mutated outer region must be detected during lookup.
for attack in outer-admission closure registry-metadata; do
  cp -R "$registry" "$tmp/registry-$attack"
  cas="$(python3 - "$tmp/registry-$attack" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
ref=json.loads((root/"refs/fixture-fanout/1.0.0.json").read_text())
digest=ref["envelope_digest"]
print(root/"objects/sha256"/digest[:2]/digest[2:4]/f"{digest}.json")
PY
)"
  python3 - "$cas" "$attack" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); attack=sys.argv[2]; x=json.loads(p.read_text())
if attack=="outer-admission": x["admission"]["evidence_refs"][0]="attacker:self-assertion"
elif attack=="closure": x["admission"]["dependency_closure"][0]["digest"]["value"]="a"*64
elif attack=="registry-metadata": x["registry"].setdefault("tags",[]).append("attacker-tag")
p.write_text(json.dumps(x,separators=(",",":")),encoding="utf-8")
PY
  expect_refusal "registry-$attack-tamper" bin/aiko-harness find fixture-fanout \
    --registry "$tmp/registry-$attack" --version 1.0.0
done

# A registry writer can coherently rewrite both CAS bytes and the ref identity;
# CAS consistency alone is not Contract authority. Even with every digest made
# self-consistent, find must authenticate the durable read-back signature.
cp -R "$registry" "$tmp/coherent-forgery-registry"
python3 - "$tmp/coherent-forgery-registry" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); ref_path=root/"refs/fixture-fanout/1.0.0.json"
ref=json.loads(ref_path.read_text()); old=ref["envelope_digest"]
old_path=root/"objects/sha256"/old[:2]/old[2:4]/f"{old}.json"
x=json.loads(old_path.read_text()); adm=x["admission"]
adm["authentication"]["value"]="00"*64
def canonical(v): return json.dumps(v,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
def sha(v): return hashlib.sha256(canonical(v)).hexdigest()
att={"api_version":"graph-harness-attestation/v1","kind":"GraphHarnessAdmissionAttestation",
     "owner":"contract",**{k:adm[k] for k in ("subject_digest","transitive_digest","verdicts",
     "admitted_by","admitted_at","evidence_refs","ledger_ref","authentication")}}
adm["attestation_digest"]["value"]=sha(att)
envelope_digest=sha(x)
new_path=root/"objects/sha256"/envelope_digest[:2]/envelope_digest[2:4]/f"{envelope_digest}.json"
new_path.parent.mkdir(parents=True,exist_ok=True); new_path.write_bytes(canonical(x)+b"\n")
ref.update(envelope_digest=envelope_digest,
           subject_digest=adm["subject_digest"]["value"],
           transitive_digest=adm["transitive_digest"]["value"])
ref_path.write_bytes(canonical(ref)+b"\n")
PY
expect_refusal coherent-cas-ref-invalid-signature bin/aiko-harness find fixture-fanout \
  --registry "$tmp/coherent-forgery-registry" --version 1.0.0

# Versionless selection must apply the same confinement as exact lookup.
cp -R "$registry" "$tmp/versionless-registry"
ref="$tmp/versionless-registry/refs/fixture-fanout/1.0.0.json"
cp "$ref" "$tmp/outside-ref.json"; rm "$ref"; ln -s "$tmp/outside-ref.json" "$ref"
expect_refusal versionless-ref-symlink bin/aiko-harness find fixture-fanout --registry "$tmp/versionless-registry"

# Compilation, inspection, attestation admission, registration and lookup must
# never execute a declared witness. Its argv remains data for the owning runtime.
python3 - "$fixture/fanout.problem.json" "$tmp/inert.problem.json" "$tmp/should-not-exist" <<'PY'
import json,sys
x=json.load(open(sys.argv[1],encoding="utf-8"))
for acceptance in [x["package"]["north_star"]]+[n["acceptance"] for n in x["package"]["nodes"]]:
    acceptance["witness"]["argv"]=["sh","-c",f"touch {sys.argv[3]}"]
json.dump(x,open(sys.argv[2],"w",encoding="utf-8"),separators=(",",":"))
PY
bin/aiko-harness build "$tmp/inert.problem.json" --root "$fixture" -o "$tmp/inert.prepared.json"
bin/aiko-harness inspect "$tmp/inert.prepared.json" --root "$fixture" --json >/dev/null
make_attestation "$tmp/inert.prepared.json" "$tmp/inert.attestation.json"
bin/aiko-harness admit "$tmp/inert.prepared.json" --attestation "$tmp/inert.attestation.json" \
  --root "$fixture" -o "$tmp/inert.admitted.json"
bin/aiko-harness inspect "$tmp/inert.admitted.json" --root "$fixture" --json >/dev/null
bin/aiko-harness register "$tmp/inert.admitted.json" --registry "$tmp/inert-registry" >/dev/null
bin/aiko-harness find fixture-fanout --registry "$tmp/inert-registry" >/dev/null
[ ! -e "$tmp/should-not-exist" ] || fail "admission membrane executed a witness or scheduled work"

printf '%s\n' 'graph-harness-builder gate: PASS (prepare · external admission · closure · mutation refusals · immutable reuse · no execution claim)'
