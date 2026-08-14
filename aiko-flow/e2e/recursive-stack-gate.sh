#!/usr/bin/env bash
# recursive-stack-gate.sh — the depth-2 recursive seal.
#
# Composes the two proven edges into one witnessed chain:
#   Smithers ──runs──▶ Aiko ──spawns──▶ Smithers
# An OUTER Smithers run executes its task on the aiko harness; that aiko's one
# job is to start the INNER Smithers run with --parent-run-id "$SMITHERS_RUN_ID"
# so the provenance edge lands in the durable store. The INNER workflow is
# INERT (pure function task, no agent, spawns nothing): the depth cap is the
# termination proof for the recursion — a capability with a bound, not a
# runaway — exactly as redrive and authoring are bounded searches.
#
# Exit 0 ONLY when ALL hold:
#   CHECK 0  composition base: e2e/aiko-harness-gate.sh exits 0 (Smithers→Aiko
#            alone is green before the composed chain is attempted).
#   CHECK A  the OUTER run reached the runner's own terminal success surface
#            (exit 0, status=finished, our outer run id).
#   CHECK B  the INNER run row exists in the SAME workspace store with
#            parent_run_id = the outer run id, status finished — the
#            provenance edge, asserted from durable state, never from stdout.
#   CHECK C  the inner task's sentinel product exists with EXACT content
#            (fresh nonce per gate run, so reruns cannot alias old rows).
#
# Machine pins (inherited from aiko-harness-gate.sh, discovered the hard way):
#   - run UNPINNED against the installed aiko+libcontract pair;
#   - --root "$FLOW_ROOT" for every run: a headless aiko only completes when
#     its effective cwd is the flow root; the durable store still anchors at
#     the temp workspace because the runner is started from $WS (createSmithers
#     resolves the nearest .smithers/ from process.cwd).
#
# Falsification affordance (never the default): RECURSIVE_GATE_FALSIFY=1 makes
# the spawn command target a workflow id that does not exist, so no inner row
# can ever appear — the gate must then fail at CHECK_A or CHECK_B, proving the
# assertions bind to durable state rather than to the script's own optimism.
set -u

FLOW_ROOT="/home/deck/work/aiko/aiko-flow"
CLI="$FLOW_ROOT/apps/cli/src/index.js"
FIXTURE="$FLOW_ROOT/e2e/fixtures/recursive-stack"
HARNESS_GATE="$FLOW_ROOT/e2e/aiko-harness-gate.sh"
RUN_TIMEOUT_S=420

WS=""
STATUS=fail
cleanup() {
  if [ "$STATUS" = pass ]; then
    [ -n "$WS" ] && rm -rf "$WS"
  elif [ -n "$WS" ]; then
    echo "workspace kept for debugging: $WS" >&2
  fi
}
trap cleanup EXIT

fail() { # fail <CHECK-NAME> <message...>
  local check="$1"; shift
  echo "GATE FAIL [$check]: $*" >&2
  exit 1
}

# --- preflight -------------------------------------------------------------
command -v bun >/dev/null 2>&1 || fail PREFLIGHT "bun not on PATH"
command -v aiko >/dev/null 2>&1 || fail PREFLIGHT "aiko not on PATH"
command -v bunx >/dev/null 2>&1 || fail PREFLIGHT "bunx not on PATH"
[ -f "$CLI" ] || fail PREFLIGHT "smithers CLI entry missing: $CLI"
[ -f "$FIXTURE/.smithers/workflows/recursive-outer.tsx" ] || fail PREFLIGHT "outer fixture missing"
[ -f "$FIXTURE/.smithers/workflows/recursive-inner.tsx" ] || fail PREFLIGHT "inner fixture missing"
[ -f "$FIXTURE/.smithers/agents.ts" ] || fail PREFLIGHT "fixture agents.ts missing"
[ -f "$HARNESS_GATE" ] || fail PREFLIGHT "composition base missing: $HARNESS_GATE"

# --- CHECK 0: composition base --------------------------------------------
if [ "${RECURSIVE_GATE_SKIP_BASE:-0}" = "1" ]; then
  echo "EVIDENCE[CHECK0]: composition base SKIPPED by caller (RECURSIVE_GATE_SKIP_BASE=1)"
else
  bash "$HARNESS_GATE" > /dev/null 2>&1 || fail CHECK0 "composition base e2e/aiko-harness-gate.sh is red — fix Smithers→Aiko before composing"
  echo "EVIDENCE[CHECK0]: composition base aiko-harness-gate.sh green"
fi

# --- workspace -------------------------------------------------------------
mkdir -p "$FLOW_ROOT/tmp"
WS=$(mktemp -d "$FLOW_ROOT/tmp/recursive-stack-gate.XXXXXX") || fail PREFLIGHT "mktemp failed"
cp -R "$FIXTURE/.smithers" "$WS/" || fail PREFLIGHT "fixture copy failed"
mkdir -p "$WS/out"
NONCE=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
OUTER_RUN_ID="rec-outer-$NONCE"
INNER_RUN_ID="rec-inner-$NONCE"
SENTINEL="$WS/out/inner-sentinel.txt"
EXPECTED="RECURSIVE_SEAL_OK_$NONCE"
INNER_WORKFLOW="recursive-inner"
if [ "${RECURSIVE_GATE_FALSIFY:-0}" = "1" ]; then
  INNER_WORKFLOW="recursive-inner-nonexistent"
  echo "EVIDENCE: FALSIFICATION MODE — spawn targets nonexistent workflow $INNER_WORKFLOW"
fi
echo "workspace: $WS"
echo "outer run: $OUTER_RUN_ID   inner run: $INNER_RUN_ID"
echo "sentinel:  $SENTINEL (expected: $EXPECTED)"

# The spawn command the aiko agent must execute, quoted here so the fixture
# never re-quotes it. $SMITHERS_RUN_ID is single-quoted INTO the string: it
# expands in the aiko worker's shell (taskContextEnv injected it), not here.
INNER_INPUT="{\"sentinelPath\":\"$SENTINEL\",\"sentinelContent\":\"$EXPECTED\"}"
SPAWN_CMD="cd $WS && bunx smthrs workflow run $INNER_WORKFLOW --run-id $INNER_RUN_ID --parent-run-id \"\$SMITHERS_RUN_ID\" --root $FLOW_ROOT --input '$INNER_INPUT' --no-post-failure --no-monitor --no-report --format json"

# --- the composed run ------------------------------------------------------
cd "$WS" || fail PREFLIGHT "cannot cd $WS"
timeout "$RUN_TIMEOUT_S" \
  bun "$CLI" workflow run recursive-outer \
    --run-id "$OUTER_RUN_ID" \
    --root "$FLOW_ROOT" \
    --input "{\"spawnCommand\":$(printf '%s' "$SPAWN_CMD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"innerRunId\":\"$INNER_RUN_ID\"}" \
    --no-post-failure --no-monitor --no-report \
    --format json > "$WS/outer-output.json" 2> "$WS/outer-stderr.log"
RC=$?

# --- CHECK A: outer run on the runner's own success surface ----------------
if [ "$RC" -ne 0 ]; then
  echo "--- outer runner stderr tail ---" >&2
  tail -25 "$WS/outer-stderr.log" >&2 || true
  fail CHECK_A "outer workflow run exited $RC (124 = ${RUN_TIMEOUT_S}s timeout), expected 0"
fi
CHECKA=$(bun -e '
const fs = await import("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
let result;
try { result = JSON.parse(raw); } catch { console.error("outer runner stdout is not JSON"); process.exit(1); }
if (result.status !== "finished") { console.error("outer status is " + JSON.stringify(result.status) + ", expected finished"); process.exit(1); }
if (result.runId !== process.argv[2]) { console.error("outer runId is " + JSON.stringify(result.runId) + ", expected " + process.argv[2]); process.exit(1); }
console.log("outer exit=0, status=" + result.status + ", runId=" + result.runId);
' "$WS/outer-output.json" "$OUTER_RUN_ID" 2>&1) || fail CHECK_A "$CHECKA"
echo "EVIDENCE[CHECK_A]: $CHECKA"

# --- CHECK B: the provenance edge in the durable store ---------------------
[ -f "$WS/smithers.db" ] || fail CHECK_B "no smithers.db in workspace $WS"
CHECKB=$(bun -e '
const { Database } = await import("bun:sqlite");
const db = new Database(process.argv[1], { readonly: true });
const row = db.query("SELECT run_id, parent_run_id, workflow_name, status FROM _smithers_runs WHERE run_id = ?").get(process.argv[2]);
if (!row) { console.error("no inner run row for " + process.argv[2] + " — the recursion never happened"); process.exit(1); }
if (row.parent_run_id !== process.argv[3]) { console.error("inner parent_run_id is " + JSON.stringify(row.parent_run_id) + ", expected " + process.argv[3] + " — rows exist but the provenance edge is missing"); process.exit(1); }
if (row.workflow_name !== "recursive-inner") { console.error("inner workflow_name is " + JSON.stringify(row.workflow_name)); process.exit(1); }
if (row.status !== "finished") { console.error("inner status is " + JSON.stringify(row.status) + ", expected finished"); process.exit(1); }
console.log("provenance edge: " + JSON.stringify(row));
' "$WS/smithers.db" "$INNER_RUN_ID" "$OUTER_RUN_ID" 2>&1) || fail CHECK_B "$CHECKB"
echo "EVIDENCE[CHECK_B]: $CHECKB"

# --- CHECK C: the inner product, byte-exact --------------------------------
[ -f "$SENTINEL" ] || fail CHECK_C "inner sentinel missing at $SENTINEL"
CHECKC=$(bun -e '
const fs = await import("node:fs");
const got = fs.readFileSync(process.argv[1], "utf8");
const want = process.argv[2] + "\n";
if (got !== want) { console.error("inner sentinel mismatch: got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); process.exit(1); }
console.log("inner sentinel bytes: " + JSON.stringify(got));
' "$SENTINEL" "$EXPECTED" 2>&1) || fail CHECK_C "$CHECKC"
echo "EVIDENCE[CHECK_C]: $CHECKC"

STATUS=pass
echo "GATE PASS: the depth-2 recursive seal held — Smithers ran Aiko, that Aiko started a Smithers run, and the provenance edge (parent_run_id) is durable"
exit 0
