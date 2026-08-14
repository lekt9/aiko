#!/usr/bin/env bash
# telegram-selfwire-gate.sh — the SELF-WIRING arc, end to end.
#
# The two upstream nodes each proved one half:
#   tmp/witness-self-integrate-skill.sh   the PROCEDURE exists and aiko resolves it
#   tmp/witness-telegram-bridge.sh        the WIRE exists and holds one kind (photo)
#
# Neither proves the thing the failure transcript actually cost: that when a
# credential is handed over, the procedure is the one that gets picked, that
# following it lands a durable boundary, and that the boundary covers the whole
# capability surface at the layer that keeps lineage. This gate asserts that arc
# as one claim. It MAY invoke the two witnesses as a composition base (CHECK 0,
# the way a stack gate re-runs the layer beneath it), but every other check here
# asserts something neither witness asserts.
#
#   CHECK 0  COMPOSITION BASE   both upstream witnesses exit 0.
#                               Skip with SELFWIRE_GATE_SKIP_BASE=1 for iteration
#                               speed — the skip is printed, never silent.
#   CHECK A  DISCOVERABLE AT THE MOMENT OF NEED
#                               `aiko inspect --json` in the aiko repo is the
#                               binary's OWN resolution; of the ~195 skills it
#                               resolves there, `self-integrate` must be the
#                               top-ranked one for three credential-handover
#                               prompt shapes (BM25, untuned) and its description
#                               must contain the trigger phrases those prompts
#                               match on. There is no skill-selection dry-run
#                               verb on the binary (checked: `aiko --help`,
#                               `aiko inspect --help`), so ranking aiko's own
#                               corpus is the closest honest proxy for "she
#                               would read this now".
#   CHECK B  THE WIRE IS DURABLE
#                               the bridge workflow is DISCOVERED by the runner
#                               in a clean workspace (`workflow list`, eligible)
#                               and a real hermetic run leaves a `_smithers_runs`
#                               row plus one typed reply-union row per turn.
#   CHECK C  CAPABILITY COMPLETENESS
#                               all FIVE reply kinds driven through the real
#                               workflow — five turns, one per kind — each
#                               selecting its matching verb, with the typing
#                               indicator sent BEFORE the turn and REFRESHED
#                               during it. Read off the fixture's recorded HTTP
#                               requests, never off a log or the bridge's own
#                               `dispatch` row (which is written from a
#                               different table than the bytes go out through).
#   CHECK D  RIGHT LAYER / LINEAGE
#                               the workflow binds `providers.aiko` as the
#                               worker, every turn's `worker` node reaches
#                               `finished`, and the REAL AikoAgent class spawns
#                               its child with AIKO_CONTRACT_PARENT_ID/ROOT_ID/
#                               DEPTH inherited plus SMITHERS_* from
#                               taskContextEnv — so Contract lineage reaches a
#                               worker turn instead of starting a new root.
#   CHECK E  HYGIENE            zero token-shaped strings across every artifact,
#                               every run output and the workspace database; and
#                               this gate never reads the transcript file that
#                               holds the compromised token.
#   CHECK F  FALSIFICATION      two independent red legs: (F1) the self-integrate
#                               skill quarantined → CHECK A red; (F2) a mutant
#                               COPY of the router with video→sendDocument →
#                               CHECK C red. Then both subjects are re-asserted
#                               green. A gate that cannot go red proves nothing.
#   TIER 2   LIVE (optional)    only with TELEGRAM_BOT_TOKEN set; otherwise SKIP,
#                               never PASS, and never touching the exit code.
#
# SECURITY. TELEGRAM_BOT_TOKEN is unset on this machine and tier 1 is hermetic:
# a real Bun.serve Bot API fixture on loopback, a fake token passed to children
# through the environment only, never argv. The one real token this repository
# has seen was pasted into the aiko-side failure transcript; it is COMPROMISED
# and must be rotated at @BotFather. This gate never opens that file — CHECK E
# asserts that about this very script.
#
# Bounded everywhere, EXIT-trapped: no orphan fixture, no surviving mutant, no
# file left moved, even when a check fails.
set -u

FLOW_ROOT="/home/deck/work/aiko/aiko-flow"
AIKO_REPO="/home/deck/work/aiko/aiko"
CLI="$FLOW_ROOT/apps/cli/src/index.js"
FIXTURE="$FLOW_ROOT/e2e/fixtures/telegram-selfwire"
BRIDGE_FIXTURE="$FLOW_ROOT/e2e/fixtures/telegram-bridge"
TELEGRAM_SRC="$FLOW_ROOT/packages/integrations/src/telegram"
WORKFLOW="$FLOW_ROOT/.smithers/workflows/telegram-aiko-bridge.tsx"
HOST="$TELEGRAM_SRC/bridgeHost.js"
WITNESS_SKILL="$FLOW_ROOT/tmp/witness-self-integrate-skill.sh"
WITNESS_BRIDGE="$FLOW_ROOT/tmp/witness-telegram-bridge.sh"
SKILL_DIR="$AIKO_REPO/.agents/skills/self-integrate"
SKILL_MD="$SKILL_DIR/SKILL.md"
# The fixture's fake token travels under this name. The production default
# (TELEGRAM_BOT_TOKEN) is never used in tier 1.
FIXTURE_TOKEN_ENV="SELFWIRE_TELEGRAM_BOT_TOKEN"
TOKEN_SHAPED='[0-9]{8,}:[A-Za-z0-9_-]{30,}'
# Written as a regex, never as a literal path: CHECK E asserts this gate has no
# non-comment line naming the transcript, and a literal here would match itself.
TRANSCRIPT_RE='test[.]md'
CHAT_ID="9911"
MUTANT_CHAT_ID="9922"

export PATH="$HOME/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export CODEDB_NO_HOOKS=1

NONCE=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
WS=""
MUT_WS=""
FIXTURE_PID=""
HOST_PID=""
SKILL_QUARANTINE=""
STATUS=fail

cleanup() {
  [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  # A moved skill must never outlive the gate that moved it.
  if [ -n "$SKILL_QUARANTINE" ] && [ -d "$SKILL_QUARANTINE" ] && [ ! -d "$SKILL_DIR" ]; then
    mv "$SKILL_QUARANTINE" "$SKILL_DIR" \
      && echo "restored quarantined skill to $SKILL_DIR" >&2
  fi
  if [ ! -f "$SKILL_MD" ]; then
    echo "CRITICAL: $SKILL_MD is MISSING after this gate — restore it from git before anything else" >&2
  fi
  [ -n "$MUT_WS" ] && rm -rf "$MUT_WS"
  wait 2>/dev/null
  if [ "$STATUS" = pass ]; then
    [ -n "$WS" ] && rm -rf "$WS"
  elif [ -n "$WS" ]; then
    echo "workspace kept for debugging: $WS" >&2
  fi
}
# INT/TERM as well as EXIT: a gate killed mid-falsification must still put the
# quarantined skill back. The handler re-raises so the exit code stays honest.
trap cleanup EXIT
trap 'cleanup; trap - INT TERM; kill -s INT $$' INT
trap 'cleanup; trap - EXIT INT TERM; exit 143' TERM

fail() { # fail <CHECK> <message...>
  local check="$1"; shift
  echo "GATE FAIL [$check]: $*" >&2
  exit 1
}

# --- preflight -------------------------------------------------------------
command -v bun >/dev/null 2>&1 || fail PREFLIGHT "bun not on PATH"
command -v curl >/dev/null 2>&1 || fail PREFLIGHT "curl not on PATH"
command -v python3 >/dev/null 2>&1 || fail PREFLIGHT "python3 not on PATH"
command -v aiko >/dev/null 2>&1 || fail PREFLIGHT "aiko not on PATH"
for path in "$CLI" "$WORKFLOW" "$HOST" "$SKILL_MD" \
  "$BRIDGE_FIXTURE/fixture-host.js" "$BRIDGE_FIXTURE/.smithers/agents.ts" \
  "$FIXTURE/select-skill.py" "$FIXTURE/prompt-shapes.json" "$FIXTURE/assert-arc.js" \
  "$FIXTURE/lineage-probe.mjs" "$FIXTURE/bin/aiko" \
  "$TELEGRAM_SRC/reply.js" "$TELEGRAM_SRC/typing.js"; do
  [ -f "$path" ] || fail PREFLIGHT "missing artifact: $path"
done
[ -d "$BRIDGE_FIXTURE/assets" ] || fail PREFLIGHT "missing media assets: $BRIDGE_FIXTURE/assets"
[ -x "$FIXTURE/bin/aiko" ] || chmod +x "$FIXTURE/bin/aiko"
mkdir -p "$FLOW_ROOT/tmp"
echo "EVIDENCE[preflight]: aiko $(aiko --version 2>/dev/null | head -1); nonce=$NONCE; TELEGRAM_BOT_TOKEN ${TELEGRAM_BOT_TOKEN:+is set (tier 2 will run)}${TELEGRAM_BOT_TOKEN:-is unset (tier 2 will SKIP; tier 1 is hermetic)}"

# =========================== CHECK 0 =======================================
echo
echo "=== CHECK 0: composition base — the two upstream witnesses ==="
if [ -n "${SELFWIRE_GATE_SKIP_BASE:-}" ]; then
  echo "EVIDENCE[CHECK_0]: SKIPPED (SELFWIRE_GATE_SKIP_BASE=$SELFWIRE_GATE_SKIP_BASE) — the base was NOT run;"
  echo "EVIDENCE[CHECK_0]: a full acceptance run must leave this variable unset."
else
  for witness in "$WITNESS_SKILL" "$WITNESS_BRIDGE"; do
    [ -f "$witness" ] || fail CHECK_0 "composition base missing: $witness"
    BASE_LOG="$FLOW_ROOT/tmp/selfwire-base-$(basename "$witness" .sh)-$NONCE.log"
    timeout 1200 bash "$witness" > "$BASE_LOG" 2>&1
    BASE_RC=$?
    BASE_TAIL=$(tail -3 "$BASE_LOG" | tr -s '\n' ' | ')
    if [ "$BASE_RC" -ne 0 ]; then
      tail -25 "$BASE_LOG" >&2
      rm -f "$BASE_LOG"
      fail CHECK_0 "$(basename "$witness") exited $BASE_RC (124 = timeout); the composition base is not green"
    fi
    rm -f "$BASE_LOG"
    echo "EVIDENCE[CHECK_0]: $(basename "$witness") exit=0 — $BASE_TAIL"
  done
fi

# =========================== CHECK A =======================================
echo
echo "=== CHECK A: the principle is discoverable at the moment of need ==="
WS=$(mktemp -d "$FLOW_ROOT/tmp/telegram-selfwire-gate.XXXXXX") || fail PREFLIGHT "mktemp failed"
echo "workspace: $WS"
( cd "$AIKO_REPO" && timeout 120 aiko inspect --json ) > "$WS/inspect.json" 2>/dev/null \
  || fail CHECK_A "'aiko inspect --json' failed in $AIKO_REPO"
CHECK_A_OUT=$(timeout 120 python3 "$FIXTURE/select-skill.py" "$WS/inspect.json" "$FIXTURE/prompt-shapes.json" "$SKILL_MD" 2>&1)
CHECK_A_RC=$?
echo "$CHECK_A_OUT"
[ "$CHECK_A_RC" -eq 0 ] || fail CHECK_A "the handover prompt would not select self-integrate (see above)"

# =========================== CHECK B/C setup ===============================
echo
echo "=== CHECK B/C: the wire, driven for all five reply kinds ==="
FIXTURE_INFO="$WS/fixture.json"
bun "$BRIDGE_FIXTURE/fixture-host.js" --out "$FIXTURE_INFO" --duration-ms 900000 > "$WS/fixture.log" 2>&1 &
FIXTURE_PID=$!
for _ in $(seq 1 50); do [ -s "$FIXTURE_INFO" ] && break; sleep 0.2; done
[ -s "$FIXTURE_INFO" ] || { cat "$WS/fixture.log" >&2; fail CHECK_B "the Bot API fixture did not start"; }
read_info() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$FIXTURE_INFO" "$1"; }
API_BASE_URL=$(read_info apiBaseUrl)
CONTROL_URL=$(read_info controlUrl)
FIXTURE_TOKEN=$(read_info token)
echo "EVIDENCE[CHECK_B/fixture]: real Bot API fixture at $API_BASE_URL, control at $CONTROL_URL"

# A clean workspace: the REAL workflow file, the telegram-bridge fixture's
# deterministic agent (reused, not rebuilt), and the media the worker names.
mkdir -p "$WS/.smithers/workflows"
cp "$BRIDGE_FIXTURE/.smithers/agents.ts" "$WS/.smithers/agents.ts" || fail CHECK_B "agents.ts copy failed"
cp "$WORKFLOW" "$WS/.smithers/workflows/telegram-aiko-bridge.tsx" || fail CHECK_B "workflow copy failed"
cp -R "$BRIDGE_FIXTURE/assets" "$WS/" || fail CHECK_B "assets copy failed"

# (B1) the runner DISCOVERS the workflow in that clean workspace ------------
( cd "$WS" && timeout 120 bun "$CLI" workflow list --format json ) > "$WS/workflow-list.json" 2>"$WS/workflow-list.err" \
  || { tail -5 "$WS/workflow-list.err" >&2; fail CHECK_B "'workflow list' failed in the workspace"; }
B1=$(bun -e '
const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const hit = (list.workflows ?? []).find((w) => w.id === "telegram-aiko-bridge");
if (!hit) { console.error("telegram-aiko-bridge is not discovered in .smithers/workflows"); process.exit(1); }
if (hit.eligible !== true) { console.error("discovered but not eligible: " + JSON.stringify(hit.ineligibleReasons)); process.exit(1); }
if (hit.entryFile !== process.argv[2]) { console.error("entryFile is " + hit.entryFile); process.exit(1); }
console.log("id=" + hit.id + " scope=" + hit.scope + " sourceType=" + hit.sourceType + " eligible=" + hit.eligible);
' "$WS/workflow-list.json" "$WS/.smithers/workflows/telegram-aiko-bridge.tsx" 2>&1) \
  || fail CHECK_B "$B1"
echo "EVIDENCE[CHECK_B/discovery]: $B1"

# (B2) admit the run: it must PARK on the durable inbound wait --------------
RUN_ID="selfwire-$NONCE"
(
  cd "$WS" || exit 1
  export "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN"
  timeout 300 bun "$CLI" workflow run telegram-aiko-bridge \
    --run-id "$RUN_ID" --root "$FLOW_ROOT" \
    --input "{\"chatId\":\"$CHAT_ID\",\"apiBaseUrl\":\"$API_BASE_URL\",\"botTokenEnv\":\"$FIXTURE_TOKEN_ENV\",\"maxTurns\":5,\"waitTimeoutMs\":300000,\"typingIntervalMs\":300,\"typingMaxMs\":1200,\"agentTimeoutMs\":120000}" \
    --no-post-failure --no-monitor --no-report --format json > "$WS/admit.json" 2> "$WS/admit.err"
)
run_status() { bun -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)}catch{console.log("unreadable")}' "$1"; }
ADMIT_STATUS=$(run_status "$WS/admit.json")
[ "$ADMIT_STATUS" = "waiting-event" ] || {
  tail -20 "$WS/admit.err" >&2
  fail CHECK_B "admit status=\"$ADMIT_STATUS\", expected waiting-event (the run must park on <OnMessage>)"
}
echo "EVIDENCE[CHECK_B/admit]: run $RUN_ID parked on <OnMessage>, status=$ADMIT_STATUS"

# String(): bun colourizes a bare number even through a pipe, and the escape
# codes turn every later `-ge` into "integer expression expected".
signal_count() {
  bun -e '
const { Database } = require("bun:sqlite");
try {
  const db = new Database(process.argv[1], { readonly: true });
  console.log(String(db.query("SELECT COUNT(*) AS c FROM _smithers_signals WHERE run_id = ?").get(process.argv[2]).c));
} catch { console.log("0"); }
' "$1" "$2" 2>/dev/null | tr -cd '0-9'
}

# Stop the source host FOR REAL, bounded.
#
# Learned here the hard way: `( ... bun host ... ) & kill $!` kills the
# subshell and leaves the poller running. An orphaned host keeps long-polling
# the shared fixture, and `getUpdates` ACKS what it reads — so it silently
# swallows an update meant for a later leg, which then waits forever for a
# signal that was already consumed into a different database. The host is
# therefore started WITHOUT a subshell (so the pid is `timeout`, which
# forwards the signal to bun) and this function refuses to return until no
# process is polling for that database any more.
stop_host() { # stop_host <db-path>
  [ -n "$HOST_PID" ] || return 0
  kill "$HOST_PID" 2>/dev/null
  wait "$HOST_PID" 2>/dev/null
  HOST_PID=""
  for _ in $(seq 1 40); do
    pgrep -f "bridgeHost.js --db $1" > /dev/null 2>&1 || return 0
    sleep 0.25
  done
  fail HOST "a source host is still polling for $1 — a stray poller acks updates meant for the next leg"
}

# drive_turn <n> <text> <expect-status> — one inbound message, ingested by the
# real source host (getUpdates long-poll → durable cursor → durable signal),
# then one resumed turn. The fixture recorder is reset first so the turn's
# window on the wire contains that turn and nothing else.
drive_turn() {
  local turn="$1" text="$2" expect="$3"
  curl -s -m 5 -X POST "$CONTROL_URL/reset" > /dev/null || fail CHECK_C "turn $turn: could not reset the recorder"
  curl -s -m 5 -X POST "$CONTROL_URL/push" -H 'content-type: application/json' \
    -d "{\"message\":{\"message_id\":$((7000 + turn)),\"date\":1770000000,\"chat\":{\"id\":$CHAT_ID,\"type\":\"private\"},\"from\":{\"id\":77,\"first_name\":\"Owner\"},\"text\":\"$text\"}}" \
    > /dev/null || fail CHECK_C "turn $turn: could not seed the inbound update"
  env "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN" timeout 90 bun "$HOST" \
    --db "$WS/smithers.db" --token-env "$FIXTURE_TOKEN_ENV" \
    --api-base-url "$API_BASE_URL" --poll-timeout-seconds 1 --poll-interval-ms 100 \
    --duration-ms 30000 > "$WS/host-$turn.log" 2>&1 &
  HOST_PID=$!
  local seen=0
  for _ in $(seq 1 120); do
    seen=$(signal_count "$WS/smithers.db" "$RUN_ID")
    [ "${seen:-0}" -ge "$turn" ] && break
    sleep 0.5
  done
  seen=${seen:-0}
  stop_host "$WS/smithers.db"
  [ "$seen" -ge "$turn" ] || {
    tail -10 "$WS/host-$turn.log" >&2
    fail CHECK_B "turn $turn: the source host never delivered a durable signal (count=$seen)"
  }
  (
    cd "$WS" || exit 1
    export "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN"
    timeout 300 bun "$CLI" workflow run telegram-aiko-bridge \
      --resume "$RUN_ID" --root "$FLOW_ROOT" \
      --no-post-failure --no-monitor --no-report --format json > "$WS/resume-$turn.json" 2> "$WS/resume-$turn.err"
  )
  local status
  status=$(run_status "$WS/resume-$turn.json")
  [ "$status" = "$expect" ] || {
    tail -20 "$WS/resume-$turn.err" >&2
    fail CHECK_B "turn $turn: resumed status=\"$status\", expected \"$expect\""
  }
  curl -s -m 5 "$CONTROL_URL/requests" > "$WS/req-$turn.json" \
    || fail CHECK_C "turn $turn: could not read the fixture's recorded requests"
  echo "EVIDENCE[CHECK_B/turn$turn]: signal delivered, run resumed to \"$status\""
}

drive_turn 1 "please send a photo of the roster now" waiting-event
drive_turn 2 "please send a video of the roster now" waiting-event
drive_turn 3 "please send a audio briefing now" waiting-event
drive_turn 4 "please send a voice note now" waiting-event
drive_turn 5 "just reply in words please" finished

PLAN="$WS/plan.json"
{
  printf '['
  printf '{"turn":1,"kind":"photo","verb":"sendPhoto","filename":"reply.png","requests":"%s/req-1.json"},' "$WS"
  printf '{"turn":2,"kind":"video","verb":"sendVideo","filename":"reply.mp4","requests":"%s/req-2.json"},' "$WS"
  printf '{"turn":3,"kind":"audio","verb":"sendAudio","filename":"reply.mp3","requests":"%s/req-3.json"},' "$WS"
  printf '{"turn":4,"kind":"voice","verb":"sendVoice","filename":"reply.ogg","requests":"%s/req-4.json"},' "$WS"
  printf '{"turn":5,"kind":"text","verb":"sendMessage","requests":"%s/req-5.json"}' "$WS"
  printf ']\n'
} > "$PLAN"

ARC_OUT=$(timeout 120 bun "$FIXTURE/assert-arc.js" --db "$WS/smithers.db" --run-id "$RUN_ID" \
  --chat-id "$CHAT_ID" --plan "$PLAN" --expect-status finished 2>&1)
ARC_RC=$?
echo "$ARC_OUT"
if [ "$ARC_RC" -ne 0 ]; then
  ARC_CHECK=$(printf '%s\n' "$ARC_OUT" | sed -n 's/^CHECK_\([A-Z]\) FAIL.*/\1/p' | head -1)
  fail "CHECK_${ARC_CHECK:-B}" "the driven arc did not hold (see above)"
fi

# =========================== CHECK D =======================================
echo
echo "=== CHECK D: right layer — the worker is an Aiko task, and lineage reaches it ==="
grep -q 'agent={providers.aiko}' "$WS/.smithers/workflows/telegram-aiko-bridge.tsx" \
  || fail CHECK_D "the workflow's worker task does not bind providers.aiko"
grep -q 'import { providers } from "../agents"' "$WS/.smithers/workflows/telegram-aiko-bridge.tsx" \
  || fail CHECK_D "the workflow does not resolve providers from the workspace's agents module"
echo "EVIDENCE[CHECK_D/binding]: <Task id=\"worker\" agent={providers.aiko}> — the worker runs on the aiko harness"
echo "EVIDENCE[CHECK_D/binding]: the production mapping providers.aiko = AikoAgent is asserted by e2e/aiko-harness-gate.sh CHECK 0;"
echo "EVIDENCE[CHECK_D/binding]: this run substitutes the telegram-bridge fixture's deterministic stand-in so five kinds fit in one bounded run."

for name in AIKO_CONTRACT_PARENT_ID AIKO_CONTRACT_ROOT_ID AIKO_CONTRACT_DEPTH; do
  grep -a -q "$name" "$(command -v aiko)" \
    || fail CHECK_D "the installed aiko binary carries no $name literal — nothing would be exported to a worker turn"
done
echo "EVIDENCE[CHECK_D/exporter]: installed $(aiko --version 2>/dev/null | head -1) carries the PARENT_ID/ROOT_ID/DEPTH export literals (dynamic proof: tmp/witness-lineage-env.sh, tmp/witness-one-aiko.sh)"

LINEAGE_DUMP="$WS/lineage-dump.txt"
rm -f "$LINEAGE_DUMP"
LINEAGE_OUT=$(
  cd "$FLOW_ROOT" && \
  PATH="$FIXTURE/bin:$PATH" \
  AIKO_CONTRACT_PARENT_ID=a1b2c3d4 AIKO_CONTRACT_ROOT_ID=a1b2c3d4 AIKO_CONTRACT_DEPTH=1 \
  SELFWIRE_LINEAGE_DUMP="$LINEAGE_DUMP" \
  timeout 120 bun "$FIXTURE/lineage-probe.mjs" "$LINEAGE_DUMP" 2>&1
)
LINEAGE_RC=$?
printf '%s\n' "$LINEAGE_OUT" | grep '^EVIDENCE\|^CHECK_D FAIL'
[ "$LINEAGE_RC" -eq 0 ] || fail CHECK_D "Contract lineage would NOT reach the worker (see above)"

# =========================== CHECK E =======================================
echo
echo "=== CHECK E: hygiene — no token-shaped string anywhere this gate touched ==="
SCAN_TARGETS=(
  "$0"
  "$FIXTURE/select-skill.py" "$FIXTURE/prompt-shapes.json" "$FIXTURE/assert-arc.js"
  "$FIXTURE/lineage-probe.mjs" "$FIXTURE/bin/aiko"
  "$WORKFLOW" "$SKILL_MD"
  "$TELEGRAM_SRC/reply.js" "$TELEGRAM_SRC/typing.js" "$TELEGRAM_SRC/bridgeHost.js"
  "$BRIDGE_FIXTURE/.smithers/agents.ts" "$BRIDGE_FIXTURE/fixture-host.js"
  "$WS/inspect.json" "$WS/workflow-list.json" "$WS/admit.json" "$WS/admit.err"
  "$WS/plan.json" "$WS/lineage-dump.txt" "$WS/fixture.log" "$WS/smithers.db"
)
for turn in 1 2 3 4 5; do
  SCAN_TARGETS+=("$WS/resume-$turn.json" "$WS/resume-$turn.err" "$WS/req-$turn.json" "$WS/host-$turn.log")
done
LEAKS=$(grep -aEl "$TOKEN_SHAPED" "${SCAN_TARGETS[@]}" 2>/dev/null)
[ -z "$LEAKS" ] || fail CHECK_E "token-shaped string found in: $(echo "$LEAKS" | tr '\n' ' ')"
echo "EVIDENCE[CHECK_E/scan]: 0 matches for /$TOKEN_SHAPED/ across ${#SCAN_TARGETS[@]} artifacts, run outputs, logs and the workspace db"

SELF_READS=$(grep -nE "$TRANSCRIPT_RE" "$0" | grep -vE '^[0-9]+:[[:space:]]*#')
[ -z "$SELF_READS" ] || fail CHECK_E "this gate has a non-comment line naming the compromised transcript: $SELF_READS"
echo "EVIDENCE[CHECK_E/transcript]: this gate names the compromised transcript only in comments — it never opens it"
[ -z "${TELEGRAM_BOT_TOKEN:-}" ] \
  && echo "EVIDENCE[CHECK_E/env]: tier 1 ran with TELEGRAM_BOT_TOKEN unset — everything above is hermetic" \
  || echo "EVIDENCE[CHECK_E/env]: TELEGRAM_BOT_TOKEN is set, but tier 1 used the fixture token under $FIXTURE_TOKEN_ENV only"

# =========================== CHECK F =======================================
echo
echo "=== CHECK F: falsification — two independent red legs ==="

# --- F1: quarantine the skill → CHECK A must go red ------------------------
SKILL_QUARANTINE="$WS/quarantined-self-integrate"
mv "$SKILL_DIR" "$SKILL_QUARANTINE" || fail CHECK_F "could not quarantine $SKILL_DIR"
[ -d "$SKILL_DIR" ] && fail CHECK_F "the quarantine did not apply — a falsifier that changes nothing proves nothing"
( cd "$AIKO_REPO" && timeout 120 aiko inspect --json ) > "$WS/inspect-quarantined.json" 2>/dev/null
F1_OUT=$(timeout 120 python3 "$FIXTURE/select-skill.py" "$WS/inspect-quarantined.json" \
  "$FIXTURE/prompt-shapes.json" "$SKILL_MD" 2>&1)
F1_RC=$?
mv "$SKILL_QUARANTINE" "$SKILL_DIR" || fail CHECK_F "CRITICAL: could not restore $SKILL_DIR from $SKILL_QUARANTINE"
SKILL_QUARANTINE=""
[ -f "$SKILL_MD" ] || fail CHECK_F "CRITICAL: $SKILL_MD did not come back"
[ "$F1_RC" -ne 0 ] || fail CHECK_F "CHECK A PASSED with the skill quarantined — it cannot fail"
printf '%s\n' "$F1_OUT" | grep -q "^CHECK_A FAIL: aiko does not resolve 'self-integrate'" \
  || fail CHECK_F "the quarantine went red for the wrong reason (want the discovery claim): $(printf '%s\n' "$F1_OUT" | tail -2)"
echo "EVIDENCE[CHECK_F/F1]: exit=$F1_RC — $(printf '%s\n' "$F1_OUT" | grep '^CHECK_A FAIL')"

# restored green: the corpus the falsifier removed from is the one that passes
( cd "$AIKO_REPO" && timeout 120 aiko inspect --json ) > "$WS/inspect-restored.json" 2>/dev/null \
  || fail CHECK_F "'aiko inspect --json' failed after restore"
timeout 120 python3 "$FIXTURE/select-skill.py" "$WS/inspect-restored.json" "$FIXTURE/prompt-shapes.json" "$SKILL_MD" \
  > "$WS/restore-a.log" 2>&1 \
  || { cat "$WS/restore-a.log" >&2; fail CHECK_F "CHECK A is not green again after restore"; }
echo "EVIDENCE[CHECK_F/F1 restore]: exit=0 — $(tail -1 "$WS/restore-a.log")"

# --- F2: mutant router copy (video → sendDocument) → CHECK C must go red ---
# The mutation is deliberately invisible to the durable row: `method` is written
# from TELEGRAM_REPLY_VERBS while the bytes leave through the `senders` table
# (reply.js:198-205), so the dispatch row still claims sendVideo. Only the wire
# tells the truth — which is why CHECK C reads the wire.
MUT_WS=$(mktemp -d "$FLOW_ROOT/tmp/telegram-selfwire-mutant.XXXXXX") || fail CHECK_F "mktemp failed"
cp -R "$FLOW_ROOT/packages/integrations/src" "$MUT_WS/mutant-src" || fail CHECK_F "mutant source copy failed"
MUT_REPLY="$MUT_WS/mutant-src/telegram/reply.js"
[ "$(grep -c '^    video: client.sendVideo,$' "$MUT_REPLY")" -eq 1 ] \
  || fail CHECK_F "the mutation target moved in reply.js — update the falsifier"
sed -i 's/^    video: client.sendVideo,$/    video: client.sendDocument,/' "$MUT_REPLY"
grep -q '^    video: client.sendDocument,$' "$MUT_REPLY" \
  || fail CHECK_F "the router mutation did not apply — a falsifier that changes nothing proves nothing"
mkdir -p "$MUT_WS/.smithers/workflows"
cp "$BRIDGE_FIXTURE/.smithers/agents.ts" "$MUT_WS/.smithers/agents.ts"
cp -R "$BRIDGE_FIXTURE/assets" "$MUT_WS/"
sed "s#\"@smthrs/integrations/telegram\"#\"$MUT_WS/mutant-src/telegram.js\"#" "$WORKFLOW" \
  > "$MUT_WS/.smithers/workflows/telegram-aiko-bridge.tsx"
grep -q "$MUT_WS/mutant-src/telegram.js" "$MUT_WS/.smithers/workflows/telegram-aiko-bridge.tsx" \
  || fail CHECK_F "the mutant workflow still imports the real package — the leg would test nothing"

MUT_RUN_ID="selfwire-mutant-$NONCE"
curl -s -m 5 -X POST "$CONTROL_URL/reset" > /dev/null
(
  cd "$MUT_WS" || exit 1
  export "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN"
  timeout 300 bun "$CLI" workflow run telegram-aiko-bridge \
    --run-id "$MUT_RUN_ID" --root "$FLOW_ROOT" \
    --input "{\"chatId\":\"$MUTANT_CHAT_ID\",\"apiBaseUrl\":\"$API_BASE_URL\",\"botTokenEnv\":\"$FIXTURE_TOKEN_ENV\",\"maxTurns\":1,\"waitTimeoutMs\":300000,\"typingIntervalMs\":300,\"typingMaxMs\":1200,\"agentTimeoutMs\":120000}" \
    --no-post-failure --no-monitor --no-report --format json > "$MUT_WS/admit.json" 2> "$MUT_WS/admit.err"
)
MUT_ADMIT=$(run_status "$MUT_WS/admit.json")
[ "$MUT_ADMIT" = "waiting-event" ] || {
  tail -20 "$MUT_WS/admit.err" >&2
  fail CHECK_F "the mutant run did not park (status=$MUT_ADMIT) — the leg must fail on the MUTATION, not on its scaffolding"
}
curl -s -m 5 -X POST "$CONTROL_URL/push" -H 'content-type: application/json' \
  -d "{\"message\":{\"message_id\":7900,\"date\":1770000000,\"chat\":{\"id\":$MUTANT_CHAT_ID,\"type\":\"private\"},\"from\":{\"id\":77,\"first_name\":\"Owner\"},\"text\":\"please send a video of the roster now\"}}" \
  > /dev/null || fail CHECK_F "could not seed the mutant leg's update"
env "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN" timeout 90 bun "$HOST" \
  --db "$MUT_WS/smithers.db" --token-env "$FIXTURE_TOKEN_ENV" \
  --api-base-url "$API_BASE_URL" --poll-timeout-seconds 1 --poll-interval-ms 100 \
  --duration-ms 30000 > "$MUT_WS/host.log" 2>&1 &
HOST_PID=$!
MUT_SEEN=0
for _ in $(seq 1 120); do
  MUT_SEEN=$(signal_count "$MUT_WS/smithers.db" "$MUT_RUN_ID")
  [ "${MUT_SEEN:-0}" -ge 1 ] && break
  sleep 0.5
done
MUT_SEEN=${MUT_SEEN:-0}
stop_host "$MUT_WS/smithers.db"
[ "$MUT_SEEN" -ge 1 ] || { tail -10 "$MUT_WS/host.log" >&2; fail CHECK_F "the mutant leg never received a signal"; }
(
  cd "$MUT_WS" || exit 1
  export "$FIXTURE_TOKEN_ENV=$FIXTURE_TOKEN"
  timeout 300 bun "$CLI" workflow run telegram-aiko-bridge \
    --resume "$MUT_RUN_ID" --root "$FLOW_ROOT" \
    --no-post-failure --no-monitor --no-report --format json > "$MUT_WS/resume.json" 2> "$MUT_WS/resume.err"
)
MUT_STATUS=$(run_status "$MUT_WS/resume.json")
curl -s -m 5 "$CONTROL_URL/requests" > "$MUT_WS/req-1.json"
printf '[{"turn":1,"kind":"video","verb":"sendVideo","filename":"reply.mp4","requests":"%s/req-1.json"}]\n' "$MUT_WS" > "$MUT_WS/plan.json"
F2_OUT=$(timeout 120 bun "$FIXTURE/assert-arc.js" --db "$MUT_WS/smithers.db" --run-id "$MUT_RUN_ID" \
  --chat-id "$MUTANT_CHAT_ID" --plan "$MUT_WS/plan.json" --expect-status "$MUT_STATUS" 2>&1)
F2_RC=$?
[ "$F2_RC" -ne 0 ] || {
  printf '%s\n' "$F2_OUT" >&2
  fail CHECK_F "CHECK C PASSED with video routed to sendDocument — it cannot fail"
}
printf '%s\n' "$F2_OUT" | grep -q '^CHECK_C FAIL' || {
  printf '%s\n' "$F2_OUT" | tail -4 >&2
  fail CHECK_F "the router mutation was caught by the wrong check (expected CHECK_C)"
}
echo "EVIDENCE[CHECK_F/F2]: mutant run status=$MUT_STATUS; the durable dispatch row still reported sendVideo"
echo "EVIDENCE[CHECK_F/F2]: exit=$F2_RC — $(printf '%s\n' "$F2_OUT" | grep '^CHECK_C FAIL')"
rm -rf "$MUT_WS"; MUT_WS=""

# restored green: the unmutated router is still the one on the wire
[ "$(grep -c '^    video: client.sendVideo,$' "$TELEGRAM_SRC/reply.js")" -eq 1 ] \
  || fail CHECK_F "CRITICAL: the real reply.js no longer maps video → client.sendVideo"
echo "EVIDENCE[CHECK_F/F2 restore]: the real router is untouched — reply.js still maps video → client.sendVideo, and CHECK C above ran against it"

kill "$FIXTURE_PID" 2>/dev/null; wait "$FIXTURE_PID" 2>/dev/null; FIXTURE_PID=""

echo
echo "TIER 1 PASS: the handover prompt selects self-integrate out of $(bun -e '
console.log(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).skills.length))' "$WS/inspect.json") skills aiko"
echo "             resolves; the procedure's product — a durable bridge — is discovered by"
echo "             the runner, parks, is woken by the real source host, and holds ALL FIVE"
echo "             reply kinds on the wire with typing sent then refreshed; the worker is an"
echo "             Aiko task that Contract lineage reaches; nothing token-shaped anywhere;"
echo "             and both falsifiers went red naming their own check."

# =========================== TIER 2 ========================================
echo
echo "=== TIER 2: live Bot API (optional) ==="
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "TIER 2 SKIP: TELEGRAM_BOT_TOKEN is unset — no live call was made."
  echo "             (SKIP is not PASS. The only real token this repo has seen is the"
  echo "              compromised one in the aiko-side failure transcript; rotate it at"
  echo "              @BotFather before any live run.)"
else
  TIER2_OUT=$(timeout 60 bun -e '
const { makeTelegramClient } = await import(process.argv[1]);
const { Effect } = await import("effect");
// Token from the environment only — never argv, never printed.
const client = makeTelegramClient({ botToken: process.env.TELEGRAM_BOT_TOKEN });
const me = await Effect.runPromise(client.call("getMe"));
console.log("getMe: id=" + me.id + " username=@" + me.username + " is_bot=" + me.is_bot);
const updates = await Effect.runPromise(client.call("getUpdates", { timeout: 2, limit: 1 }));
console.log("getUpdates: one bounded poll cycle returned " + (Array.isArray(updates) ? updates.length : 0) + " update(s)");
' "$TELEGRAM_SRC/TelegramClient.js" 2>&1)
  if [ $? -eq 0 ]; then
    printf '%s\n' "$TIER2_OUT" | sed 's/^/TIER 2 PASS: /'
  else
    echo "TIER 2 FAIL (does not affect the exit code): $(printf '%s\n' "$TIER2_OUT" | tail -3)" >&2
  fi
fi

STATUS=pass
echo
echo "GATE PASS: telegram-selfwire — discoverable principle → durable wire → whole capability surface → right layer"
exit 0
