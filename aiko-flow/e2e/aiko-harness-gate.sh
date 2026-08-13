#!/usr/bin/env bash
# aiko-harness-gate.sh — the harness-within-the-harness gate.
#
# Proves, from a clean temp workspace, that Smithers can run a REAL workflow
# whose single task executes on the **aiko** harness (AikoAgent from
# @smthrs/agents, re-exported by smthrs), and that the aiko agent actually
# performs a consequential effect (writes a sentinel file with exact content).
#
# Exit 0 ONLY when ALL hold:
#   CHECK 0  the CONSTRUCTORS["aiko"] mapping is live: generateAgentsTs()
#            renders an aiko provider line and no longer warns
#            'skipping detected agent "aiko" (no SDK constructor mapping yet)'
#            (apps/cli/src/agent-detection.js), and `smthrs` exports AikoAgent
#            (packages/smithers/src/index.js) — the import path both the
#            generated agents.ts and this gate's fixture use.
#   CHECK A  the run reached the runner's own terminal success surface:
#            `bun apps/cli/src/index.js workflow run aiko-sentinel --format json`
#            exits 0 AND its JSON says status=finished with our run id
#            (exit code set by formatStatusExitCode, apps/cli/src/index.js).
#   CHECK B  the sentinel file exists with EXACT content (the nonce line,
#            with or without one trailing newline — the prompt asks for one).
#   CHECK C  a durable run row exists in the temp workspace's own store
#            (<ws>/smithers.db, table _smithers_runs — the anchor
#            createSmithers() resolves from the workspace's .smithers/):
#            run_id = ours, workflow_name = aiko-sentinel, status = finished.
#
# Machine pins this gate depends on (both discovered the hard way):
#   1. Contract library: run UNPINNED against the installed pair, honoring an
#      explicit caller-exported AIKO_CONTRACT_LIBRARY. History: aiko 0.2.108
#      negotiated ABI 12 against an installed ABI-13 lib, so this gate
#      originally pinned tmp/libcontract-abi12.so (without it the Contract
#      membrane HOLDed every consequential tool, contract_native.rs:6420).
#      The 2026-08-13 reinstall shipped aiko 0.2.115 with a MATCHED ABI-13
#      libcontract, and the ABI-12 pin now kills startup with
#      contract_graph_expand_failed (verified both ways with headless probes).
#   2. --root "$FLOW_ROOT" — pins the Task rootDir (and therefore the
#      spawned aiko's process cwd AND its --cwd flag,
#      packages/agents/src/AikoAgent.js buildCommand) to the flow root:
#      on this machine a headless `aiko --single` only completes when its
#      effective working directory is the flow root; fresh temp dirs hang
#      the turn. All durable run state still lands in the temp workspace
#      because createSmithers() anchors the DB at the nearest .smithers/
#      from process.cwd() (packages/smithers/src/create.js:398-400).
#
# Hermetic-ish: fresh mktemp workspace under tmp/, its own smithers.db,
# --no-post-failure --no-monitor --no-report, run bounded at 300s.
# On PASS the workspace is deleted; on FAIL it is kept and named.
set -u

FLOW_ROOT="/home/deck/work/aiko/aiko-flow"
CLI="$FLOW_ROOT/apps/cli/src/index.js"
FIXTURE="$FLOW_ROOT/e2e/fixtures/aiko-harness"
RUN_TIMEOUT_S=300

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
[ -f "$CLI" ] || fail PREFLIGHT "smithers CLI entry missing: $CLI"
[ -f "$FIXTURE/.smithers/workflows/aiko-sentinel.tsx" ] || fail PREFLIGHT "fixture workflow missing under $FIXTURE"
[ -f "$FIXTURE/.smithers/agents.ts" ] || fail PREFLIGHT "fixture agents.ts missing under $FIXTURE"
# Contract-library selection (see machine pin 1 in the header).
if [ -n "${AIKO_CONTRACT_LIBRARY:-}" ]; then
  [ -f "$AIKO_CONTRACT_LIBRARY" ] || fail PREFLIGHT "caller-set AIKO_CONTRACT_LIBRARY missing: $AIKO_CONTRACT_LIBRARY"
  echo "EVIDENCE[preflight]: AIKO_CONTRACT_LIBRARY caller override=$AIKO_CONTRACT_LIBRARY"
else
  INSTALLED_LIB="$HOME/.aiko/lib/libcontract.so"
  LIB_ABI=""
  if command -v python3 >/dev/null 2>&1 && [ -f "$INSTALLED_LIB" ]; then
    LIB_ABI=$(python3 -c "import ctypes,sys; print(ctypes.CDLL(sys.argv[1]).contract_abi_version())" "$INSTALLED_LIB" 2>/dev/null)
  fi
  echo "EVIDENCE[preflight]: unpinned — $(aiko --version 2>/dev/null | head -1) with installed $INSTALLED_LIB (abi=${LIB_ABI:-unknown})"
fi

# --- CHECK 0: constructor mapping is live ---------------------------------
cd "$FLOW_ROOT" || fail PREFLIGHT "cannot cd $FLOW_ROOT"
CHECK0=$(bun -e '
const smthrs = await import("smthrs");
if (typeof smthrs.AikoAgent !== "function") { console.error("smthrs does not export AikoAgent"); process.exit(1); }
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
const { generateAgentsTs } = await import("./apps/cli/src/agent-detection.js");
const src = generateAgentsTs(process.env);
console.warn = origWarn;
const skips = warnings.filter((w) => w.includes("\"aiko\""));
if (skips.length > 0) { console.error("generateAgentsTs still skips aiko: " + skips[0]); process.exit(1); }
if (!src.includes("aiko: new SmithersAikoAgent()")) { console.error("generated agents.ts has no aiko provider line"); process.exit(1); }
const importLine = src.split("\n").find((l) => l.includes("AikoAgent as SmithersAikoAgent"));
console.log("aiko import line: " + (importLine ?? "(commented/absent)").trim());
console.log("aiko provider line rendered, no skip warning");
' 2>&1) || fail CHECK0 "CONSTRUCTORS[aiko] mapping not live: $CHECK0"
echo "EVIDENCE[CHECK0]: $CHECK0"

# --- workspace -------------------------------------------------------------
mkdir -p "$FLOW_ROOT/tmp"
WS=$(mktemp -d "$FLOW_ROOT/tmp/aiko-harness-gate.XXXXXX") || fail PREFLIGHT "mktemp failed"
cp -R "$FIXTURE/.smithers" "$WS/" || fail PREFLIGHT "fixture copy failed"
mkdir -p "$WS/out"
NONCE=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
RUN_ID="aiko-gate-$NONCE"
SENTINEL="$WS/out/sentinel.txt"
EXPECTED="AIKO_IN_SMITHERS_OK_$NONCE"
echo "workspace: $WS"
echo "run id:    $RUN_ID"
echo "sentinel:  $SENTINEL (expected content: $EXPECTED)"

# --- the real run ----------------------------------------------------------
cd "$WS" || fail PREFLIGHT "cannot cd $WS"
timeout "$RUN_TIMEOUT_S" \
  bun "$CLI" workflow run aiko-sentinel \
    --run-id "$RUN_ID" \
    --root "$FLOW_ROOT" \
    --input "{\"sentinelPath\":\"$SENTINEL\",\"sentinelContent\":\"$EXPECTED\"}" \
    --no-post-failure --no-monitor --no-report \
    --format json > "$WS/run-output.json" 2> "$WS/run-stderr.log"
RC=$?

# --- CHECK A: runner's own terminal success surface ------------------------
if [ "$RC" -ne 0 ]; then
  echo "--- runner stderr tail ---" >&2
  tail -25 "$WS/run-stderr.log" >&2 || true
  fail CHECK_A "workflow run exited $RC (124 = ${RUN_TIMEOUT_S}s timeout), expected 0"
fi
CHECKA=$(bun -e '
const fs = await import("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
let result;
try { result = JSON.parse(raw); } catch { console.error("runner stdout is not JSON"); process.exit(1); }
if (result.status !== "finished") { console.error("run status is " + JSON.stringify(result.status) + ", expected finished"); process.exit(1); }
if (result.runId !== process.argv[2]) { console.error("runId is " + JSON.stringify(result.runId) + ", expected " + process.argv[2]); process.exit(1); }
console.log("exit=0, status=" + result.status + ", runId=" + result.runId);
' "$WS/run-output.json" "$RUN_ID" 2>&1) || fail CHECK_A "$CHECKA"
echo "EVIDENCE[CHECK_A]: $CHECKA"

# --- CHECK B: sentinel exists with exact content ---------------------------
[ -f "$SENTINEL" ] || fail CHECK_B "sentinel file missing at $SENTINEL"
CHECKB=$(bun -e '
const fs = await import("node:fs");
const got = fs.readFileSync(process.argv[1], "utf8");
const want = process.argv[2];
if (got !== want && got !== want + "\n") {
  console.error("sentinel content mismatch: got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + " (one trailing newline allowed)");
  process.exit(1);
}
console.log("sentinel bytes: " + JSON.stringify(got));
' "$SENTINEL" "$EXPECTED" 2>&1) || fail CHECK_B "$CHECKB"
echo "EVIDENCE[CHECK_B]: $CHECKB"

# --- CHECK C: durable run row in the workspace store -----------------------
[ -f "$WS/smithers.db" ] || fail CHECK_C "no smithers.db in workspace $WS (createSmithers should anchor it at the .smithers/ dir)"
CHECKC=$(bun -e '
const { Database } = await import("bun:sqlite");
const db = new Database(process.argv[1], { readonly: true });
const row = db.query("SELECT run_id, workflow_name, status FROM _smithers_runs WHERE run_id = ?").get(process.argv[2]);
if (!row) { console.error("no _smithers_runs row for " + process.argv[2]); process.exit(1); }
if (row.workflow_name !== "aiko-sentinel") { console.error("run row workflow_name is " + JSON.stringify(row.workflow_name) + ", expected aiko-sentinel"); process.exit(1); }
if (row.status !== "finished") { console.error("run row status is " + JSON.stringify(row.status) + ", expected finished"); process.exit(1); }
console.log("durable row: " + JSON.stringify(row));
' "$WS/smithers.db" "$RUN_ID" 2>&1) || fail CHECK_C "$CHECKC"
echo "EVIDENCE[CHECK_C]: $CHECKC"

STATUS=pass
echo "GATE PASS: aiko ran INSIDE Smithers (constructor mapping live, run finished, sentinel exact, durable run row)"
exit 0
