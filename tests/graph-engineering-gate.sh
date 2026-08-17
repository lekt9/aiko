#!/usr/bin/env bash
# Cross-layer graph-engineering acceptance. The substrate analyzes, Cell runs
# deterministic frontiers, Neuron projects only committed provenance, and Aiko
# aggregates those surfaces without inventing another scheduler.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL graph-engineering: $*" >&2; exit 1; }

# Direct invocation must rebuild a stale root exactly once. Under `zig build
# gate` the install dependency has already done so, avoiding a nested root build.
if [ ! -x zig-out/bin/aiko-doctor ] || \
   find src build.zig contract/libcontract/src/graph_plan.zig -newer zig-out/bin/aiko-doctor -print -quit | grep -q .; then
  zig build
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-graph-engineering.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/walk.json" <<'JSON'
{"nodes":[
 {"id":"publish","plan":"publish","depends_on":["analyze"],"status":"pending","writes":["out/report.json"],"invoke_skills":["cell"],"witness":"test -s out/report.json"},
 {"id":"analyze","plan":"analyze","depends_on":[],"status":"pending","writes":[],"invoke_skills":["jesus-graph"],"witness":"true"},
 {"id":"notify","plan":"notify","depends_on":["analyze"],"status":"pending","writes":["out/report.json"],"invoke_skills":["cell"],"witness":"true"}
]}
JSON
zig-out/bin/aiko-doctor graph-plan "$tmp/walk.json" >"$tmp/verdict.json"
python3 - "$tmp/verdict.json" <<'PY'
import json, sys
v=json.load(open(sys.argv[1], encoding="utf-8"))
assert v["waves"] == [["analyze"], ["notify", "publish"]], v
assert v["ready"] == ["analyze"] and v["cycle_list"] == [], v
assert v["write_collisions"] == [
    {"a":"notify", "b":"publish", "shared":["out/report.json <-> out/report.json"]}
], v
assert v["ungrounded"] == [] and v["ungated"] == [], v
PY
# Malformed input is a refusal with structured stdout, never an empty plan.
printf '{"nodes":{}}\n' >"$tmp/bad.json"
if zig-out/bin/aiko-doctor graph-plan "$tmp/bad.json" >"$tmp/bad.out" 2>/dev/null; then
  fail "root graph-plan admitted malformed nodes"
fi
python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == {"error":"invalid_walk"}' "$tmp/bad.out"

# The exact settled witnesses: Contract exercises the installed native ABI;
# Cell exercises deterministic serial Kahn frontiers; Neuron builds standalone
# and proves live/redacted provenance projection from another process.
bash aiko/scripts/witness-graph-frontier.sh
bash cell/tests/gate.sh
bash neuron/tests/observe-live-gate.sh
if [ "${AIKO_MAIN_PATH_ALREADY_GATED:-0}" != 1 ]; then
  bash tests/graph-harness-main-path-gate.sh
fi

# Current authority is deliberately bounded: review/audit/transcript files preserve
# historical claims and must not make this recurrence check false-positive.
authoritative_graph_docs=(
  docs/graph-engineering/README.md
  docs/graph-engineering/ARCHITECTURE.md
  docs/graph-engineering/EXAMPLES.md
  docs/graph-engineering/MIGRATION.md
  cell/AGENTS.md
  cell/SPEC.md
  cell/docs/architecture.md
  cell/docs/constraints.md
  cell/docs/harness.md
  cell/SKILL.md
  cell/skills/cell/SKILL.md
  cell/skills/cell/references/SPEC.md
  cell/patterns/README.md
  cell/patterns/graph-cell/graph.cell.yaml
)
if rg -n -i \
  'safe same-frontier Python concurrency|effect-free Python (leaves|siblings).*concurrent|typed concurrent Kahn|first violated port or cap|only effect-free Python siblings run concurrently' \
  "${authoritative_graph_docs[@]}" >"$tmp/stale-concurrency-claims.txt"; then
  cat "$tmp/stale-concurrency-claims.txt" >&2
  fail "authoritative docs advertise unconfined Cell concurrency or cap enforcement"
fi
for doc in "${authoritative_graph_docs[@]}"; do
  rg -q 'topological|Kahn' "$doc" || fail "$doc omits topological frontier semantics"
done

# Direction is executable architecture, not prose. Neuron must remain able to
# build without either upper layer, and Contract must not acquire Cell/desktop.
if find neuron -name '*.zig' -print0 | xargs -0 rg -n \
    '@import\([^)]*(contract|libcontract)|contract_graph_plan' >"$tmp/reverse.txt"; then
  cat "$tmp/reverse.txt" >&2
  fail "Neuron imports Contract"
fi
if find contract/libcontract/src -name '*.zig' -print0 | xargs -0 rg -n \
    'cell/run\.py|apps/desktop|aiko/crates' >"$tmp/upward.txt"; then
  cat "$tmp/upward.txt" >&2
  fail "Contract imports an upper-layer runtime"
fi
rg -q 'b\.dependency\("libcontract"' build.zig || fail "root no longer composes Contract"
rg -q 'b\.dependency\("neuron"' build.zig || fail "root no longer composes Neuron"
rg -q 'root_source_file = b\.path\("contract/libcontract/src/graph_plan\.zig"\)' build.zig || \
  fail "root graph surface no longer uses Contract analyzer source"

# Compile the Rust host and exercise the strict admitted-graph parser. The
# native Contract witness above proves the producer; this focused test proves
# the consumer rejects held, malformed, mismatched, or non-runnable responses.
case "$(uname -s)" in
  Linux) CONTRACT_DYLIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.so" ;;
  Darwin) CONTRACT_DYLIB="$ROOT/contract/libcontract/zig-out/lib/libcontract.dylib" ;;
  *) fail "unsupported platform for Rust Contract ABI witness" ;;
esac
(
  cd aiko
  # The exact GraphHarness core/Cell/orchestration modules already execute in
  # dependency-minimal witnesses above. Compile the full host test composition
  # without linking its documented >16GB monolithic test binary.
  CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 AIKO_CONTRACT_LIBRARY="$CONTRACT_DYLIB"     cargo check -q -p xai-grok-shell --tests
)
HOST=aiko/crates/codegen/xai-grok-shell/src/contract_native.rs
rg -q 'library\.get\(b"contract_graph_plan\\0"\)' "$HOST" || fail "host graph ABI source anchor missing"
rg -q 'pub async fn graph_plan_analyze' "$HOST" || fail "host graph projection source anchor missing"
rg -q 'ADVISORY DRY-RUN; NOT LAUNCH AUTHORITY' "$HOST" || fail "host advisory boundary source anchor missing"
rg -q 'dry_run_graph_analysis_never_issues_launch_directives' "$HOST" || fail "host authority regression test source anchor missing"
rg -q 'fn validate_admitted_turn_graph' "$HOST" || fail "host native turn-graph validation missing"
rg -q 'normal_turn_requires_a_complete_matching_native_graph' "$HOST" || fail "host fail-closed turn-graph test missing"
rg -q 'async fn abandon_turn_graph' "$HOST" || fail "host graph-abandon cleanup missing"
rg -q 'native graph expansion aborted before response' contract/libcontract/src/c_abi.zig ||   fail "Contract partial-expansion cleanup missing"
rg -q 'export fn contract_abandon_graph' contract/libcontract/src/c_abi.zig ||   fail "Contract observable graph-abandon ABI missing"
rg -q '"contract_abi": 13' aiko/scripts/contract-runtime.sh ||   fail "packaged Contract runtime is not labeled ABI 13"
rg -q '^EXPECTED_ABI=13$' aiko/scripts/install-aiko-package.sh ||   fail "package installer does not require Contract ABI 13"
rg -q 'failure after the first child declaration must' aiko/scripts/witness-graph-frontier.sh ||   fail "partial-expansion ledger witness missing"
rg -q 'Aiko could not admit this turn to the native Contract ledger' "$HOST" || fail "host turn admission is no longer mandatory"
rg -q 'retain_isolated_local_skills' "$HOST" || fail "IsolatedLocal no longer drops external-effect skills before prepare"
rg -q 'contract_graph_expand_failed: Contract rejected graph expansion' "$HOST" || fail "host graph expansion is no longer mandatory"
PROMPT_ENTRY=aiko/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs
rg -q 'Native Contract graph admission failed; Aiko did not start the worker' "$PROMPT_ENTRY" ||   fail "normal Aiko prompt entry no longer refuses before worker start"
if rg -q 'continuing without ledger registration' "$HOST"; then
  fail "normal Aiko turns may still bypass native Contract admission"
fi
python3 - "$PROMPT_ENTRY" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
# Anchor on the call-site prefix, not the full argument list: the grounding
# entry point has already been renamed once (ground_turn -> ground_turn_with_facts)
# and the property under witness is the ORDER, not the arity.
admit = source.index("let grounded = crate::contract_native::ground_turn")
dispatch = source.index(".send(SessionCommand::Prompt {", admit)
assert admit < dispatch, "reasoning worker dispatch moved before native graph admission"
PY
if rg -U -q 'declare_context\(&request\).*\.or_else\(\|\| native\.declare' "$HOST"; then
  fail "contextual Contract rejection still falls back to a weaker declaration"
fi
if rg -q 'This turn.s admitted plan' "$HOST"; then
  fail "host dry-run analysis still contains a launch directive"
fi

printf '%s\n' 'graph-engineering gate: PASS (Contract ABI · Cell frontier · Neuron standalone/live · Aiko root + compiled Rust admission)'
