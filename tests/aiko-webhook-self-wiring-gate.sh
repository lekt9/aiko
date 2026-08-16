#!/usr/bin/env bash
# End-to-end synthetic witness for Contract-owned webhook self-wiring.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW="$ROOT/aiko-flow/.smithers/workflows/wire-webhook.tsx"
FIXTURE="$ROOT/tests/fixtures/aiko-webhook-self-wiring"
test -f "$WORKFLOW"
test -f "$FIXTURE/manifest.json"
test -f "$FIXTURE/scenario.json"
test -f "$FIXTURE/run.ts"
grep -q 'ContractCell id="authorize"' "$WORKFLOW"
grep -q 'sealEndpointManifest' "$WORKFLOW"
grep -q 'liveDeploymentClaim: false' "$WORKFLOW"
grep -q 'replayCrossed: false' "$WORKFLOW"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/fixture" "$TMP/state"
cp "$FIXTURE"/* "$TMP/fixture/"
test -z "$(find "$TMP/state" -mindepth 1 -print -quit)"
(
  cd "$TMP/fixture"
  FORCE_COLOR=0 bun run.ts "$ROOT" "$TMP/state" > "$TMP/output.json"
)
test -s "$TMP/state/journal.jsonl"
test -s "$TMP/state/result.json"

node - "$TMP/state/result.json" "$TMP/state/journal.jsonl" <<'NODE'
const fs=require("fs");
const result=JSON.parse(fs.readFileSync(process.argv[2]));
const rows=fs.readFileSync(process.argv[3],"utf8").trim().split("\n").map(JSON.parse);
const eq=(actual,expected,name)=>{ if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); };
eq(result.schema,"aiko.webhook-self-wiring.fixture-result.v1","schema");
eq(result.emptyState,true,"empty state");
eq(result.authorizedBeforeInfrastructure,true,"authority gate");
eq(result.inboundOccurrences,1,"exact-once Contract occurrence");
eq(result.outboundSends,1,"outbound sends");
eq(result.independentReadbacks,1,"independent callback read-back");
eq(result.finalGeneration,6,"final generation");
eq(result.finalStatus,"revoked","terminal revocation survives invalidation");
eq(result.compensations,5,"mutation compensation diffs");
eq(result.replayedCrossedEffects,0,"crossed-effect replay");
eq(result.liveDeploymentClaim,false,"hermetic release claim");
eq(result.generationDiff.map(x=>x.generation),[1,2,3,4,5,6],"Contract/Smithers/Worker generations");
eq(result.generationDiff.map(x=>x.status),["active","active","active","paused","revoked","revoked"],"mutation status diff");
if(!/^[a-f0-9]{64}$/.test(result.manifestDigest)||!/^[a-f0-9]{64}$/.test(result.journalDigest)) throw Error("digest receipt missing");
const count=k=>rows.filter(r=>r.kind===k).length;
eq(count("manifest-admitted"),1,"manifest admission");
eq(count("inbound-accepted"),1,"new inbound occurrence");
eq(count("inbound-adopted"),1,"duplicate adoption");
eq(count("neuron-crossed"),1,"crossing count");
eq(count("neuron-readback"),1,"readback count");
eq(count("neuron-compensation-diff"),5,"compensation count");
eq(count("contract-transition"),5,"Contract mutation count");
eq(count("smithers-generation"),6,"Smithers projection count");
eq(count("worker-generation"),6,"Worker generation count");
eq(count("neuron-fence"),5,"Neuron generation fence count");
eq(count("limb-admission-pin"),1,"admitted outbound limb pin");
const refuses=rows.filter(r=>r.kind==="refusal").map(r=>r.text).sort();
eq(refuses,["approval-before-infrastructure","old-generation-inbound-fenced","same-delivery-changed-bytes-conflict"].sort(),"required refusals");
const endpointUploads=rows.filter(r=>r.kind==="provider-upload" && r.versionId===result.providerVersionId);
eq(endpointUploads.length,1,"immutable endpoint artifact upload");
if(rows.some(r=>r.liveDeploymentClaim===true || JSON.stringify(r).match(/secretValue|apiToken|bearer/i))) throw Error("fixture leaked a secret or claimed live deploy");
NODE

# Falsifier: mutation of a crossed effect into replay must make the witness red.
cp "$WORKFLOW" "$TMP/wire-mutant.tsx"
python3 - "$TMP/wire-mutant.tsx" "$ROOT" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2]); s=p.read_text(); old="replayCrossed: false"
assert s.count(old)==1
s=s.replace(old,"replayCrossed: true")
s=s.replace('"../../packages/', '"'+str(root/'aiko-flow/packages')+'/')
p.write_text(s)
PY
mkdir "$TMP/mutant-state"
set +e
(cd "$TMP/fixture" && FORCE_COLOR=0 bun run.ts "$ROOT" "$TMP/mutant-state" "$TMP/wire-mutant.tsx" > /dev/null 2>&1)
MUTANT_STATUS=$?
set -e
test "$MUTANT_STATUS" -ne 0
! grep -q '"replayCrossed":true' "$TMP/state/journal.jsonl"

echo "aiko webhook self-wiring gate: ok"
