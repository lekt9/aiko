#!/usr/bin/env bash
# mcp-leak-gate.sh — node `gate.no_leak`
#
# Settles: "the per-session MCP child-process leak in `aiko agent leader` is
# gone, measured end-to-end against a real leader, and the measurement is
# capable of showing the leak when the leak is there."
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY CONTRACT — read this before changing anything
#
#   * This gate NEVER restarts, stops, reloads or kills `aiko-leader.service`.
#     It touches that unit exactly once, read-only, to prove its own leader is
#     a DIFFERENT process (`systemctl --user show -p MainPID`), and re-reads it
#     at the end to prove the unit's MainPID never moved.
#   * It NEVER pkills `unbrowse`, `node`, or any pattern it did not create.
#     Every process it reaps is one of its own: two hermetic leaders it
#     started, the ACP clients it forked, and the fixture MCP servers those
#     leaders spawned — all of which carry a per-run tag (`--tag <RUN_TAG>`)
#     that exists nowhere else on the machine.
#   * It runs its own leaders on their own HOME, AIKO_HOME and socket, and
#     REFUSES to start if any of those resolve inside the real `$HOME`.
#   * It aborts if MemAvailable drops below --min-avail-mb (default 4096).
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT IS ASSERTED
#
#   CHECK A  the leader under test really is the FIXED binary, and really is
#            not the user's unit: `/proc/<pid>/exe`, socket path, MainPID, and
#            a byte-level discriminator (two strings that exist only in the
#            fixed source) present in the new binary and absent in the old.
#   CHECK B  N session cycles leak nothing: per cycle the fixture tree must
#            APPEAR (proving the instrument sees a spawn) and then be GONE
#            after teardown. Attributable delta must be 0 — the contract in
#            `mcp-leak-baseline.txt`. Then, on the same leader, R in-session
#            client replacements must strand nothing either.
#   CHECK C  total RSS of the leader's MCP descendants does not grow across
#            the N cycles.
#   CHECK D  the shared-client safety property (`drain owned_clients ONLY`)
#            still holds. Asserted at UNIT level, not e2e — stated as such.
#   CHECK E  falsification: the identical procedure against the INSTALLED
#            PRE-FIX binary must show growth > 0. Same gate, same fixture,
#            same drive — old binary leaks, new binary does not.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THERE ARE TWO DRIVES, AND WHICH ONE IS THE FALSIFIER
#
# Measured here, not assumed: session TEARDOWN reaps the MCP child on BOTH
# binaries. Each session actor runs on its own thread with its own
# current-thread runtime (`spawn.rs:1793` → `Builder::new_current_thread`), so
# when `run_session` returns, that runtime is dropped, every task on it dies
# with it — including rmcp's serve task, which owns `SafeTokioChildProcess` —
# and `Drop` runs `kill_process_group()`. The `Arc` cycle cannot save a client
# whose entire runtime just went away. A session-churn drive is therefore the
# right measurement for "N sessions leave nothing behind" (CHECK B) but it is
# NOT a falsifier: the pre-fix binary passes it too.
#
# The cycle is observable exactly where a client is dropped WHILE its session's
# runtime keeps running — `McpState::update_configs_diff` (`servers.rs:629`,
# `self.owned_clients.remove(name)`), reached by an MCP config hot-reload. On
# the pre-fix binary the removed client's `Arc` is still held by its own
# liveness task, so its stdio child is stranded and one tree accumulates per
# reload; on the fixed binary the removed client drops immediately and the
# child is reaped. That is CHECK E's drive, and it is run on BOTH binaries so
# the contrast is measured rather than argued.
#
# ─────────────────────────────────────────────────────────────────────────────
# HOW A SESSION IS DRIVEN, AND WHY IT IS NOT "session/new + disconnect"
#
# `witness-mcp-leak-repro.sh` drove `initialize + session/new + disconnect` and
# measured +0.93 trees per session on the live leader. That is a real leak
# measurement, but it is NOT a teardown measurement: a client disconnect does
# not end a session on this build. The leader emits
# `x.ai/internal/evict_sessions` for the detached sessions
# (`leader/server.rs:1581`), but that notification goes out WITHOUT the leading
# underscore that `agent-client-protocol` requires of an extension method
# (`rpc.rs:223` — `method.strip_prefix('_')`), so the agent answers
# "Method not found" and `handle_evict_sessions` never runs. Sessions stay
# resident. Their MCP servers stay with them — correctly, on either binary.
# (Reported as FINDING 1; it is out of this node's write set.)
#
# So this gate drives the path that DOES end a session and that a real client
# already uses: `_x.ai/session/close` (`handlers/session.rs:38`), which runs
# `request_session_shutdown` → the actor's terminal arm →
# `shutdown_owned_mcp_clients`. Per cycle:
#
#     initialize → session/new → [sample: tree MUST appear]
#                → _x.ai/session/close → [sample: tree MUST be gone]
#                → disconnect (EOF)
#
# The "tree MUST appear" half is what stops this gate passing while blind: a
# counter that always returns 0 fails the spawn assertion on every cycle.
#
# ─────────────────────────────────────────────────────────────────────────────
# USAGE
#   bash e2e/mcp-leak-gate.sh [--sessions N] [--min-avail-mb M]
#                             [--fixed-bin PATH] [--leaky-bin PATH]
#                             [--skip-unit]        # CHECK D off; gate then FAILS
#   Env: AIKO_FIXED_BIN, AIKO_LEAKY_BIN, T_UNIT
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

export PATH="$HOME/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export CODEDB_NO_HOOKS=1

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$GATE_DIR/fixtures/mcp-leak"
FIXTURE_SERVER="$FIXTURE_DIR/mcp_leak_server.py"
FIXTURE_CHILD="$FIXTURE_DIR/mcp_leak_child.py"
REPO_ROOT="${REPO_ROOT:-/home/deck/work/aiko/aiko}"
BASELINE_FILE="${BASELINE_FILE:-/home/deck/work/aiko/aiko-flow/tmp/mcp-leak-baseline.txt}"

FIXED_BIN="${AIKO_FIXED_BIN:-$REPO_ROOT/target/release/aiko}"
LEAKY_BIN="${AIKO_LEAKY_BIN:-$HOME/bin/aiko}"
USER_UNIT="aiko-leader.service"

SESSIONS=5
RELOADS=3               # in-session client replacements per arm (CHECK E's drive)
MIN_AVAIL_MB=4096
RUN_BUDGET_S=900
LEADER_START_TIMEOUT=60
SESSION_TIMEOUT=60
INIT_TIMEOUT=40
CLOSE_TIMEOUT=30
REAP_WAIT_S=15          # how long a reap is allowed to take before it is a leak
POST_SPAWN_SETTLE=2     # the leader spawns the MCP tree asynchronously
POST_CLOSE_SETTLE=2
SETTLE_S=5
CONTROL_S=10
RUN_UNIT=1

# Pre-fix numbers from mcp-leak-baseline.txt, quoted so the contrast is visible
# in this gate's own output rather than in another file.
BASE_ATTR_TREES=4.67
BASE_ATTR_PER_SESSION=0.93
BASE_BG_PER_MIN=4.000
BASE_D_TREES=6
BASE_D_PROCS=24
BASE_D_RSS=2365.1
BASE_RSS_PER_SESSION=473.0
BASE_SESSIONS=5

while [ $# -gt 0 ]; do
  case "$1" in
    --sessions)      SESSIONS="$2"; shift ;;
    --reloads)       RELOADS="$2"; shift ;;
    --min-avail-mb)  MIN_AVAIL_MB="$2"; shift ;;
    --fixed-bin)     FIXED_BIN="$2"; shift ;;
    --leaky-bin)     LEAKY_BIN="$2"; shift ;;
    --skip-unit)     RUN_UNIT=0 ;;
    -h|--help)       sed -n '1,80p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
  shift
done

RUN_T0="$(date +%s)"
RUN_TAG="MCPLEAKGATE-$$-$(date +%s)"
FAIL=0
ARM_LABEL=""

hr()   { printf '────────────────────────────────────────────────────────────────\n'; }
step() { printf '\n'; hr; printf '## %s\n\n' "$*"; }
ok()   { printf '  PASS  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAIL=1; }
ev()   { printf 'EVIDENCE %s\n' "$*"; }
elapsed() { echo $(( $(date +%s) - RUN_T0 )); }

# ─────────────────────────────────────────────────────────────────────────────
# reaping — ONLY ever our own forks, and only ever by our own run tag
# ─────────────────────────────────────────────────────────────────────────────
OWN_PIDS=()          # clients we fork
LEADER_PIDS=()       # hermetic leaders we start
WORKDIRS=()

# Fixture processes are `setsid`'d by aiko (xai-tty-utils detach_command), so
# they do NOT die with the leader — reaping them is this gate's job, and the
# `--tag` makes them unmistakably ours.
#
# The `[m]` is not decoration: in a pipeline `ps` and `grep` start together, so
# a plain pattern captures the grep process itself (its argv contains the
# pattern) and the gate would then "find" an orphan that is its own matcher.
# `[m]cp_leak_` cannot match the argv that carries it.
tagged_pids() {
  ps -eo pid=,args= 2>/dev/null \
    | grep -E "[m]cp_leak_(server|child)\.py --tag $RUN_TAG" \
    | awk -v me="$$" -v pa="$PPID" '{ if ($1+0 != me && $1+0 != pa) print $1+0 }'
}

cleanup() {
  local p
  for p in "${OWN_PIDS[@]:-}";    do [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; done
  for p in "${LEADER_PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; done
  sleep 1
  for p in $(tagged_pids); do kill -TERM "$p" 2>/dev/null; done
  sleep 1
  for p in "${OWN_PIDS[@]:-}";    do [ -n "$p" ] && { kill -KILL "$p" 2>/dev/null; wait "$p" >/dev/null 2>&1; }; done
  for p in "${LEADER_PIDS[@]:-}"; do [ -n "$p" ] && { kill -KILL "$p" 2>/dev/null; wait "$p" >/dev/null 2>&1; }; done
  for p in $(tagged_pids); do kill -KILL "$p" 2>/dev/null; done
  local d
  for d in "${WORKDIRS[@]:-}"; do [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"; done
  return 0
}
trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────────────────────────────────────
# measurement primitives — lifted from witness-mcp-leak-repro.sh on purpose:
# same counting technique, so this gate's numbers and the baseline's numbers
# are the same kind of number. One ps snapshot, BFS in awk, scoped by ANCESTRY.
# Bare `pgrep -f` is never used to count: this script's own command line
# contains the tag, and that is exactly the artefact that produced bug.md's
# bogus "189 → 753".
# ─────────────────────────────────────────────────────────────────────────────
descendants_of() {
  local root="$1"
  ps -eo pid=,ppid= 2>/dev/null | awk -v root="$root" '
    { pid=$1+0; ppid=$2+0; child[ppid]=child[ppid] " " pid }
    END {
      n=0; queue[n++]=root; i=0
      while (i<n) {
        cur=queue[i++]
        if (cur in child) {
          split(child[cur], kids, " ")
          for (k in kids) { if (kids[k]!="") { queue[n++]=kids[k]+0; print kids[k]+0 } }
        }
      }
    }'
}

# "pid rss_kb argv" for the fixture MCP processes under <pid>
mcp_rows_under() {
  local root="$1" desc
  desc="$(descendants_of "$root")"
  [ -n "$desc" ] || return 0
  ps -o pid=,rss=,args= -p "$(echo "$desc" | tr '\n' ',' | sed 's/,$//')" 2>/dev/null \
    | grep -E "[m]cp_leak_(server|child)\.py --tag $RUN_TAG"
}

trees_under() {  # stage A only == one per MCP client == the leak cardinality
  local n; n="$(mcp_rows_under "$1" | grep -cE '[m]cp_leak_server\.py --tag')"
  echo "${n:-0}"
}
procs_under() { local n; n="$(mcp_rows_under "$1" | grep -c .)"; echo "${n:-0}"; }
rss_mb_under() {
  local v; v="$(mcp_rows_under "$1" | awk '{s+=$2} END {printf "%.1f", s/1024}')"
  [ -n "$v" ] && echo "$v" || echo "0.0"
}

mem_avail_mb() { awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo; }
mem_guard() {
  local a; a="$(mem_avail_mb)"
  if [ "$a" -lt "$MIN_AVAIL_MB" ]; then
    bad "ABORT low_memory mem_avail_mb=$a min_avail_mb=$MIN_AVAIL_MB"
    return 1
  fi
  return 0
}
budget_guard() {
  if [ "$(elapsed)" -ge "$RUN_BUDGET_S" ]; then
    bad "ABORT run_budget_exceeded budget_s=$RUN_BUDGET_S elapsed_s=$(elapsed)"
    return 1
  fi
  return 0
}

wait_for_line() {  # <file> <ere> <timeout-s>
  local f="$1" re="$2" to="$3" i=0
  while [ "$i" -lt $(( to * 10 )) ]; do
    grep -qE "$re" "$f" 2>/dev/null && return 0
    sleep 0.1; i=$(( i + 1 ))
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# hermetic leader
# ─────────────────────────────────────────────────────────────────────────────
# A unix socket path must fit in sun_path (~108 bytes), which a long $TMPDIR
# blows out ("path must be shorter than SUN_LEN"). Pick the shortest root that
# is still a temp dir, and refuse anything that would land inside the real HOME.
sock_root() {
  local c
  for c in "${TMPDIR:-}" /tmp; do
    [ -n "$c" ] && [ -d "$c" ] && [ ${#c} -le 40 ] && { echo "$c"; return 0; }
  done
  echo /tmp
}

LEADER_PID=""; LEADER_SOCK=""; WORK=""; LEADER_LOG=""

# The hermetic config, parameterised by SLOT. Rewriting it with a new slot
# changes the server's argv, which `update_configs_diff` sees as the same NAME
# with different bytes — i.e. removed AND added — so the live client is
# replaced while its session's runtime keeps running. That replacement is the
# only place the `Arc` cycle is observable end-to-end (see the header).
write_config() {  # <slot>
  cat > "$WORK/home/.aiko/config.toml" <<EOF
# hermetic config for mcp-leak-gate; nothing here is read from the real HOME
[cli]
installer = "internal"

[ui]
permission_mode = "always-approve"
yolo = false

[mcp_servers.mcpleak]
command = "/usr/bin/python3"
args = ["$FIXTURE_SERVER", "--tag", "$RUN_TAG", "--slot", "$1"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 30
EOF
}

start_leader() {  # <label> <binary>
  local label="$1" bin="$2"
  WORK="$(mktemp -d "$(sock_root)/mcpleak-$label.XXXXXX")" || return 1
  WORKDIRS+=("$WORK")
  mkdir -p "$WORK/home/.aiko" "$WORK/cwd"
  LEADER_SOCK="$WORK/leader.sock"
  LEADER_LOG="$WORK/leader.err"

  # The danger is not "inside $HOME" — $TMPDIR is often under $HOME — it is
  # landing in the user's real aiko state, where this gate would be talking to
  # (or evicting) the live leader instead of its own.
  case "$LEADER_SOCK" in
    "$HOME"/.aiko/*|"$HOME"/.grok/*)
      bad "refusing to run: hermetic socket $LEADER_SOCK is inside the user's real aiko state"; return 1 ;;
  esac
  case "$WORK" in
    "$HOME"/.aiko*|"$HOME"/.grok*)
      bad "refusing to run: hermetic workdir $WORK is inside the user's real aiko state"; return 1 ;;
  esac
  if [ ${#LEADER_SOCK} -ge 100 ]; then
    bad "refusing to run: socket path too long for sun_path (${#LEADER_SOCK} bytes): $LEADER_SOCK"; return 1
  fi

  write_config 0

  ( cd "$WORK/cwd" && exec env -i \
      PATH="$PATH" HOME="$WORK/home" AIKO_HOME="$WORK/home/.aiko" \
      GROK_LEADER_SOCKET="$LEADER_SOCK" \
      XAI_API_KEY="mcp-leak-gate-not-a-real-key" \
      GROK_XAI_API_BASE_URL="http://127.0.0.1:9" \
      GROK_CLI_CHAT_PROXY_BASE_URL="http://127.0.0.1:9" \
      GROK_TELEMETRY_ENABLED=false GROK_FEEDBACK_ENABLED=false \
      GROK_TRACE_UPLOAD=false GROK_INSTRUMENTATION=disabled \
      RUST_LOG=xai_grok_shell=debug \
      "$bin" agent --always-approve --leader-socket "$LEADER_SOCK" \
        leader --no-exit-on-disconnect --no-auto-update \
      >"$WORK/leader.out" 2>"$LEADER_LOG" ) &
  LEADER_PID=$!
  LEADER_PIDS+=("$LEADER_PID")

  local i=0
  while [ "$i" -lt $(( LEADER_START_TIMEOUT * 5 )) ]; do
    [ -S "$LEADER_SOCK" ] && kill -0 "$LEADER_PID" 2>/dev/null && return 0
    kill -0 "$LEADER_PID" 2>/dev/null || { bad "$label leader died during startup; log tail:"; tail -5 "$LEADER_LOG" | sed 's/^/      /'; return 1; }
    sleep 0.2; i=$(( i + 1 ))
  done
  bad "$label leader did not bind $LEADER_SOCK within ${LEADER_START_TIMEOUT}s"
  return 1
}

stop_leader() {
  [ -n "$LEADER_PID" ] || return 0
  kill -TERM "$LEADER_PID" 2>/dev/null
  local i=0
  while kill -0 "$LEADER_PID" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$(( i + 1 )); done
  kill -KILL "$LEADER_PID" 2>/dev/null
  wait "$LEADER_PID" 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
# one session cycle against the running hermetic leader
#   returns 0 ok / 1 drive failure; sets SPAWN_DELTA / TEARDOWN_DELTA
# ─────────────────────────────────────────────────────────────────────────────
INIT_JSON='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"_meta":{"startupHints":{"nonInteractive":true,"skipGitStatus":true,"skipProjectLayout":true},"clientType":"mcp-leak-gate","clientVersion":"1"}}}'

SPAWN_DELTA=0; TEARDOWN_DELTA=0
drive_session() {  # <n> <binary>
  local n="$1" bin="$2"
  local fifo="$WORK/in.$n" out="$WORK/out.$n" cerr="$WORK/cerr.$n"
  local pid sid pre mid post fd rc=0 t0
  t0="$(date +%s)"
  pre="$(trees_under "$LEADER_PID")"
  mkfifo "$fifo" 2>/dev/null || { bad "session $n: mkfifo failed"; return 1; }
  : > "$out"; : > "$cerr"

  ( cd "$WORK/cwd" && exec env -i \
      PATH="$PATH" HOME="$WORK/home" AIKO_HOME="$WORK/home/.aiko" \
      GROK_LEADER_SOCKET="$LEADER_SOCK" XAI_API_KEY="mcp-leak-gate-not-a-real-key" \
      GROK_XAI_API_BASE_URL="http://127.0.0.1:9" \
      GROK_CLI_CHAT_PROXY_BASE_URL="http://127.0.0.1:9" \
      timeout "$SESSION_TIMEOUT" "$bin" agent --leader --leader-socket "$LEADER_SOCK" stdio \
      <"$fifo" >"$out" 2>"$cerr" ) &
  pid=$!
  OWN_PIDS+=("$pid")
  exec {fd}> "$fifo"

  printf '%s\n' "$INIT_JSON" >&$fd
  if ! wait_for_line "$out" '"id":1,"result"' "$INIT_TIMEOUT"; then
    bad "session $n: initialize timed out after ${INIT_TIMEOUT}s"
    exec {fd}>&-; kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1
  fi

  printf '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"%s","mcpServers":[]}}\n' "$WORK/cwd" >&$fd
  if ! wait_for_line "$out" '"id":2,"result"' "$SESSION_TIMEOUT"; then
    bad "session $n: session/new timed out after ${SESSION_TIMEOUT}s"
    exec {fd}>&-; kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1
  fi
  sid="$(grep -o '"sessionId":"[^"]*"' "$out" | head -1 | cut -d'"' -f4)"
  sleep "$POST_SPAWN_SETTLE"
  mid="$(trees_under "$LEADER_PID")"

  # `_x.ai/session/close`: the underscore is the ACP extension prefix, stripped
  # by the transport before dispatch (rpc.rs:223). Without it the agent answers
  # -32601 and nothing is torn down — see FINDING 1.
  printf '{"jsonrpc":"2.0","id":3,"method":"_x.ai/session/close","params":{"sessionId":"%s"}}\n' "$sid" >&$fd
  if ! wait_for_line "$out" '"id":3' "$CLOSE_TIMEOUT"; then
    bad "session $n: _x.ai/session/close got no reply in ${CLOSE_TIMEOUT}s"
    rc=1
  elif ! grep -q '"id":3,"result"' "$out"; then
    bad "session $n: _x.ai/session/close returned an error: $(grep -o '"id":3.\{0,90\}' "$out" | head -1)"
    rc=1
  fi

  # Give the reap a bounded window. A green arm exits this loop immediately;
  # a leaking arm burns the whole window and is then counted as a leak.
  local i=0
  while [ "$i" -lt $(( REAP_WAIT_S * 5 )) ]; do
    [ "$(trees_under "$LEADER_PID")" -le "$pre" ] && break
    sleep 0.2; i=$(( i + 1 ))
  done
  sleep "$POST_CLOSE_SETTLE"
  post="$(trees_under "$LEADER_PID")"

  exec {fd}>&-                       # EOF == the way a real headless client leaves
  local w=0
  while kill -0 "$pid" 2>/dev/null && [ "$w" -lt 100 ]; do sleep 0.1; w=$(( w + 1 )); done
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null

  SPAWN_DELTA=$(( mid - pre ))
  TEARDOWN_DELTA=$(( post - pre ))
  ev "$ARM_LABEL session n=$n sid=${sid:-none} trees_pre=$pre trees_after_session_new=$mid trees_after_close=$post spawn_delta=+$SPAWN_DELTA teardown_delta=$TEARDOWN_DELTA elapsed_s=$(( $(date +%s) - t0 ))"
  return $rc
}

# ─────────────────────────────────────────────────────────────────────────────
# in-session client replacement: ONE session, R MCP config hot-reloads.
# This is the drive that separates the two binaries (see the header).
#   sets RELOAD_GROWTH (trees left over above the one live server) and
#        RELOAD_CYCLES_LEAKED
# ─────────────────────────────────────────────────────────────────────────────
RELOAD_GROWTH=0; RELOAD_CYCLES_LEAKED=0
rows_have_slot() { mcp_rows_under "$LEADER_PID" | grep -q -- "--slot $1"; }

drive_reload_churn() {  # <binary>
  local bin="$1" r base tot fd pid sid rc=0
  RELOAD_GROWTH=0; RELOAD_CYCLES_LEAKED=0
  local fifo="$WORK/in.reload" out="$WORK/out.reload"
  mkfifo "$fifo" 2>/dev/null || { bad "$ARM_LABEL reload: mkfifo failed"; return 1; }
  : > "$out"

  ( cd "$WORK/cwd" && exec env -i \
      PATH="$PATH" HOME="$WORK/home" AIKO_HOME="$WORK/home/.aiko" \
      GROK_LEADER_SOCKET="$LEADER_SOCK" XAI_API_KEY="mcp-leak-gate-not-a-real-key" \
      GROK_XAI_API_BASE_URL="http://127.0.0.1:9" \
      GROK_CLI_CHAT_PROXY_BASE_URL="http://127.0.0.1:9" \
      timeout $(( SESSION_TIMEOUT * (RELOADS + 2) )) \
      "$bin" agent --leader --leader-socket "$LEADER_SOCK" stdio \
      <"$fifo" >"$out" 2>/dev/null ) &
  pid=$!
  OWN_PIDS+=("$pid")
  exec {fd}> "$fifo"

  printf '%s\n' "$INIT_JSON" >&$fd
  if ! wait_for_line "$out" '"id":1,"result"' "$INIT_TIMEOUT"; then
    bad "$ARM_LABEL reload: initialize timed out"
    exec {fd}>&-; kill -TERM "$pid" 2>/dev/null; wait "$pid" >/dev/null 2>&1; return 1
  fi
  printf '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"%s","mcpServers":[]}}\n' "$WORK/cwd" >&$fd
  if ! wait_for_line "$out" '"id":2,"result"' "$SESSION_TIMEOUT"; then
    bad "$ARM_LABEL reload: session/new timed out"
    exec {fd}>&-; kill -TERM "$pid" 2>/dev/null; wait "$pid" >/dev/null 2>&1; return 1
  fi
  sid="$(grep -o '"sessionId":"[^"]*"' "$out" | head -1 | cut -d'"' -f4)"
  sleep "$POST_SPAWN_SETTLE"
  base="$(trees_under "$LEADER_PID")"
  ev "$ARM_LABEL reload base sid=$sid live_trees=$base (one live MCP server for one live session)"
  if [ "$base" -lt 1 ]; then
    bad "$ARM_LABEL reload: no MCP server for the live session — nothing to replace"
    exec {fd}>&-; kill -TERM "$pid" 2>/dev/null; wait "$pid" >/dev/null 2>&1; return 1
  fi

  for (( r=1; r<=RELOADS; r++ )); do
    write_config "$r"
    printf '{"jsonrpc":"2.0","id":%s,"method":"_x.ai/internal/reload_all_mcp_servers","params":{}}\n' $(( 100 + r )) >&$fd
    if ! wait_for_line "$out" "\"id\":$(( 100 + r )),\"result\"" "$CLOSE_TIMEOUT"; then
      bad "$ARM_LABEL reload r=$r: reload_all_mcp_servers got no result"
      rc=1; continue
    fi
    # the replacement must actually start, or there is nothing to replace
    local i=0 appeared=0
    while [ "$i" -lt 200 ]; do
      rows_have_slot "$r" && { appeared=1; break; }
      sleep 0.1; i=$(( i + 1 ))
    done
    [ "$appeared" -eq 1 ] || bad "$ARM_LABEL reload r=$r: the replacement server (--slot $r) never started"
    # bounded window for the REPLACED client's child to be reaped
    i=0
    while [ "$i" -lt $(( REAP_WAIT_S * 5 )) ]; do
      [ "$(trees_under "$LEADER_PID")" -le "$base" ] && break
      sleep 0.2; i=$(( i + 1 ))
    done
    sleep "$POST_CLOSE_SETTLE"
    tot="$(trees_under "$LEADER_PID")"
    ev "$ARM_LABEL reload r=$r replacement_started=$appeared live_trees=$tot expected=$base stranded=$(( tot - base ))"
    [ "$tot" -gt "$base" ] && RELOAD_CYCLES_LEAKED=$(( RELOAD_CYCLES_LEAKED + 1 ))
  done

  tot="$(trees_under "$LEADER_PID")"
  RELOAD_GROWTH=$(( tot - base ))

  printf '{"jsonrpc":"2.0","id":9,"method":"_x.ai/session/close","params":{"sessionId":"%s"}}\n' "$sid" >&$fd
  wait_for_line "$out" '"id":9' "$CLOSE_TIMEOUT"
  exec {fd}>&-
  local w=0
  while kill -0 "$pid" 2>/dev/null && [ "$w" -lt 100 ]; do sleep 0.1; w=$(( w + 1 )); done
  kill -TERM "$pid" 2>/dev/null; wait "$pid" >/dev/null 2>&1
  ev "$ARM_LABEL reload RESULT reloads=$RELOADS cycles_with_stranded_trees=$RELOAD_CYCLES_LEAKED stranded_trees_at_end=$RELOAD_GROWTH"
  return $rc
}

# ─────────────────────────────────────────────────────────────────────────────
# one arm: start a hermetic leader on <binary>, drive N cycles, measure
#   sets ARM_* globals
# ─────────────────────────────────────────────────────────────────────────────
ARM_TREES_D=0; ARM_PROCS_D=0; ARM_RSS_D=0.0; ARM_PER_SESSION=0.00
ARM_SPAWNS_SEEN=0; ARM_TEARDOWN_LEAKS=0; ARM_DRIVEN=0; ARM_BG_PER_MIN=0.000
ARM_RELOAD_GROWTH=-1; ARM_RELOAD_LEAKS=-1

# CHECK A's process-level half, asserted the moment the leader is up and BEFORE
# anything is driven through it: a gate that checked identity after the fact
# could be measuring a leader that something else replaced.
assert_fixed_identity() {
  local exe want
  exe="$(readlink -f "/proc/$LEADER_PID/exe" 2>/dev/null)"
  want="$(readlink -f "$FIXED_BIN")"
  ev "A serving_leader pid=$LEADER_PID /proc/pid/exe=$exe"
  ev "A expected_exe=$want"
  if [ -n "$exe" ] && [ "$exe" = "$want" ]; then
    ok "A /proc/$LEADER_PID/exe is the fixed binary"
  else
    bad "A /proc/$LEADER_PID/exe ($exe) is not the fixed binary ($want)"
  fi
  if [ "$exe" != "$(readlink -f "$LEAKY_BIN")" ]; then
    ok "A the serving leader is NOT the installed $LEAKY_BIN"
  else
    bad "A the serving leader IS the installed binary"
  fi
  if [ "$LEADER_PID" != "$USER_UNIT_PID_BEFORE" ]; then
    ok "A hermetic leader pid=$LEADER_PID differs from $USER_UNIT MainPID=$USER_UNIT_PID_BEFORE"
  else
    bad "A hermetic leader pid collides with the user's unit MainPID"
  fi
  if [ "$LEADER_SOCK" != "$HOME/.aiko/leader.sock" ] && [ "$LEADER_SOCK" != "$HOME/.grok/leader.sock" ]; then
    ok "A hermetic socket $LEADER_SOCK is neither $HOME/.aiko/leader.sock nor $HOME/.grok/leader.sock"
  else
    bad "A hermetic socket collides with the user's leader socket"
  fi
}

run_arm() {  # <label> <binary>
  local label="$1" bin="$2" n
  ARM_LABEL="$label"
  ARM_TREES_D=0; ARM_PROCS_D=0; ARM_RSS_D=0.0; ARM_PER_SESSION=0.00
  ARM_SPAWNS_SEEN=0; ARM_TEARDOWN_LEAKS=0; ARM_DRIVEN=0; ARM_BG_PER_MIN=0.000

  mem_guard || return 1
  start_leader "$label" "$bin" || return 1
  ev "$label leader started pid=$LEADER_PID exe=$(readlink -f "/proc/$LEADER_PID/exe" 2>/dev/null) sock=$LEADER_SOCK home=$WORK/home aiko_home=$WORK/home/.aiko"
  [ "$label" = fixed ] && assert_fixed_identity

  # Idle control. A hermetic leader has no other client, so the background rate
  # must be exactly zero; the live leader's was 4.000 trees/min. Without this,
  # a delta of zero could just mean "we happened to look at a quiet moment".
  local c0 c1
  c0="$(trees_under "$LEADER_PID")"
  sleep "$CONTROL_S"
  c1="$(trees_under "$LEADER_PID")"
  ARM_BG_PER_MIN="$(awk -v d="$(( c1 - c0 ))" -v s="$CONTROL_S" 'BEGIN{printf "%.3f", d*60.0/s}')"
  ev "$label control idle_s=$CONTROL_S idle_d_trees=$(( c1 - c0 )) background_trees_per_min=$ARM_BG_PER_MIN"

  local before_trees before_procs before_rss
  before_trees="$(trees_under "$LEADER_PID")"
  before_procs="$(procs_under "$LEADER_PID")"
  before_rss="$(rss_mb_under "$LEADER_PID")"
  ev "$label before trees=$before_trees procs=$before_procs rss_mb=$before_rss"

  for (( n=1; n<=SESSIONS; n++ )); do
    budget_guard || return 1
    mem_guard    || return 1
    if drive_session "$n" "$bin"; then ARM_DRIVEN=$(( ARM_DRIVEN + 1 )); fi
    [ "$SPAWN_DELTA" -ge 1 ] && ARM_SPAWNS_SEEN=$(( ARM_SPAWNS_SEEN + 1 ))
    [ "$TEARDOWN_DELTA" -gt 0 ] && ARM_TEARDOWN_LEAKS=$(( ARM_TEARDOWN_LEAKS + 1 ))
  done

  sleep "$SETTLE_S"
  local after_trees after_procs after_rss
  after_trees="$(trees_under "$LEADER_PID")"
  after_procs="$(procs_under "$LEADER_PID")"
  after_rss="$(rss_mb_under "$LEADER_PID")"
  ARM_TREES_D=$(( after_trees - before_trees ))
  ARM_PROCS_D=$(( after_procs - before_procs ))
  ARM_RSS_D="$(awk -v a="$after_rss" -v b="$before_rss" 'BEGIN{printf "%.1f", a-b}')"
  ARM_PER_SESSION="$(awk -v d="$ARM_TREES_D" -v s="$ARM_DRIVEN" 'BEGIN{ if(s>0) printf "%.2f", d/s; else print "0.00" }')"
  ev "$label after  trees=$after_trees procs=$after_procs rss_mb=$after_rss settle_s=$SETTLE_S"
  ev "$label RESULT sessions_driven=$ARM_DRIVEN spawns_observed=$ARM_SPAWNS_SEEN teardown_leaks=$ARM_TEARDOWN_LEAKS d_trees=$ARM_TREES_D d_procs=$ARM_PROCS_D d_rss_mb=$ARM_RSS_D attributable_trees_per_session=$ARM_PER_SESSION"

  # PHASE 2 — in-session client replacement, on the same leader.
  budget_guard || return 1
  mem_guard    || return 1
  drive_reload_churn "$bin"
  ARM_RELOAD_GROWTH="$RELOAD_GROWTH"; ARM_RELOAD_LEAKS="$RELOAD_CYCLES_LEAKED"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════════
printf 'mcp-leak-gate.sh — node gate.no_leak\n'
ev "run_tag=$RUN_TAG sessions=$SESSIONS host=$(uname -n) started=$(date -Iseconds)"
ev "fixed_bin=$FIXED_BIN"
ev "leaky_bin=$LEAKY_BIN"
ev "baseline=$BASELINE_FILE"
ev "fixture=$FIXTURE_SERVER (+ $FIXTURE_CHILD)"
ev "mcp_server_choice=own_fixture — the hermetic HOME registers this gate's own stdio MCP server, NOT a copy of the real ~/.grok [mcp_servers.unbrowse]. Why: the defect is in McpClient's lifecycle and is indifferent to which stdio server was spawned, while a cold unbrowse under a fresh HOME risks a 45s startup, network, and ~473 MB of leaked RSS per session on the falsification arm — and a FAILED unbrowse handshake would be reaped by the already-correct handshake-failure path, leaving the gate green while proving nothing. The fixture's standing as an instrument is demonstrated, not assumed: CHECK E leaks it on the pre-fix binary."
ev "drive_1_session_churn=initialize -> session/new -> _x.ai/session/close -> disconnect, x$SESSIONS. A bare disconnect does NOT end a session on this build (see FINDING 1 in the header), so 'session/new + disconnect' would measure resident sessions, not teardown, and would be red on a correct binary."
ev "drive_2_in_session_replacement=one live session, then x$RELOADS: rewrite the hermetic config's server argv -> _x.ai/internal/reload_all_mcp_servers -> the client is REPLACED while its session runtime keeps running. This is the drive that separates the binaries; session teardown alone does not, because the session's own tokio runtime is dropped with the actor and takes rmcp's serve task (and the child) with it."
ev "tree_shape=2 procs (stage A mcp_leak_server.py -> stage B mcp_leak_child.py), vs unbrowse's 4; 1 tree == 1 MCP client == the baseline's leak cardinality (one per SessionActor)"

for f in "$FIXTURE_SERVER" "$FIXTURE_CHILD" "$FIXED_BIN"; do
  [ -e "$f" ] || { bad "missing required file: $f"; }
done
command -v /usr/bin/python3 >/dev/null || bad "missing /usr/bin/python3 (the fixture interpreter)"
[ "$FAIL" -eq 0 ] || { printf '\nRESULT=FAIL (preconditions)\n'; exit 1; }

USER_UNIT_PID_BEFORE="$(systemctl --user show -p MainPID --value "$USER_UNIT" 2>/dev/null)"
[[ "$USER_UNIT_PID_BEFORE" =~ ^[0-9]+$ ]] || USER_UNIT_PID_BEFORE=0
ev "user_unit=$USER_UNIT main_pid_before=$USER_UNIT_PID_BEFORE active_state=$(systemctl --user show -p ActiveState --value "$USER_UNIT" 2>/dev/null) — READ ONLY; this gate never signals that unit"
ev "mem_avail_mb=$(mem_avail_mb) min_avail_mb_guard=$MIN_AVAIL_MB"

# ═════════════════════════════════════════════════════════════════════════════
step "CHECK A — the leader under test is the FIXED binary, and is not the user's unit"

# Byte-level discriminator: two strings that exist only in the fixed sources
# (liveness.rs's Weak-upgrade exit, run_loop.rs's owned-only drain). A path
# check alone would pass on a stale rebuild of the same path.
FIXSTR1='transport liveness watcher: client dropped, exiting'
FIXSTR2='shutting down owned MCP clients'
n1="$(grep -c -a -F "$FIXSTR1" "$FIXED_BIN" 2>/dev/null || true)"
n2="$(grep -c -a -F "$FIXSTR2" "$FIXED_BIN" 2>/dev/null || true)"
o1="$(grep -c -a -F "$FIXSTR1" "$LEAKY_BIN" 2>/dev/null || true)"
o2="$(grep -c -a -F "$FIXSTR2" "$LEAKY_BIN" 2>/dev/null || true)"
ev "A fix_marker_1='$FIXSTR1' fixed_bin=$n1 leaky_bin=$o1"
ev "A fix_marker_2='$FIXSTR2' fixed_bin=$n2 leaky_bin=$o2"
if [ "${n1:-0}" -ge 1 ] && [ "${n2:-0}" -ge 1 ]; then
  ok "A the binary under test carries both fix markers (Weak-upgrade exit + owned-only drain)"
else
  bad "A the binary under test is missing a fix marker — it is not the fixed build"
fi
if [ "${o1:-0}" -eq 0 ] && [ "${o2:-0}" -eq 0 ]; then
  ok "A the installed binary carries neither marker — it is a genuine pre-fix build (CHECK E has something to falsify with)"
else
  bad "A the installed binary already carries the fix markers — CHECK E would not be a falsifier"
fi
ev "A fixed_bin_realpath=$(readlink -f "$FIXED_BIN") mtime=$(date -r "$FIXED_BIN" -Iseconds 2>/dev/null)"
ev "A leaky_bin_realpath=$(readlink -f "$LEAKY_BIN") mtime=$(date -r "$LEAKY_BIN" -Iseconds 2>/dev/null)"

# ═════════════════════════════════════════════════════════════════════════════
step "CHECK B/C — drive $SESSIONS session cycles on a hermetic leader built from the FIXED binary"

if run_arm fixed "$FIXED_BIN"; then
  FIXED_LEADER_PID="$LEADER_PID"; FIXED_SOCK="$LEADER_SOCK"; FIXED_LOG="$LEADER_LOG"; FIXED_WORK="$WORK"

  # ---- CHECK B ------------------------------------------------------------
  ev "B per-session deltas above; spawn_delta>=1 proves the counter SEES a spawn, teardown_delta==0 proves the reap"
  ev "B THIS RUN     sessions=$ARM_DRIVEN attributable_d_trees=$ARM_TREES_D attributable_trees_per_session=$ARM_PER_SESSION background_trees_per_min=$ARM_BG_PER_MIN d_procs=$ARM_PROCS_D"
  ev "B PRE-FIX BASE sessions=$BASE_SESSIONS attributable_d_trees=$BASE_ATTR_TREES attributable_trees_per_session=$BASE_ATTR_PER_SESSION background_trees_per_min=$BASE_BG_PER_MIN d_procs=$BASE_D_PROCS   (mcp-leak-baseline.txt, live leader, unbrowse trees)"
  ev "B CONTRACT     gate_requires_attributable_d_trees_max=0 gate_requires_attributable_trees_per_session_max=0.00 gate_requires_background_trees_per_min_max=0.000"

  if [ "$ARM_DRIVEN" -ge "$SESSIONS" ]; then
    ok "B all $SESSIONS sessions were driven (a gate that drove nothing may claim nothing)"
  else
    bad "B only $ARM_DRIVEN/$SESSIONS sessions were driven"
  fi
  if [ "$ARM_SPAWNS_SEEN" -eq "$SESSIONS" ]; then
    ok "B every session spawned a fixture MCP tree the counter could see ($ARM_SPAWNS_SEEN/$SESSIONS)"
  else
    bad "B only $ARM_SPAWNS_SEEN/$SESSIONS sessions produced a visible MCP spawn — the measurement is blind, not clean"
  fi
  if [ "$ARM_TEARDOWN_LEAKS" -eq 0 ]; then
    ok "B no session left its MCP tree behind after teardown"
  else
    bad "B $ARM_TEARDOWN_LEAKS/$SESSIONS sessions left their MCP tree alive after teardown"
  fi
  if [ "$ARM_TREES_D" -le 0 ]; then
    ok "B attributable_d_trees=$ARM_TREES_D <= 0 (baseline pre-fix: $BASE_ATTR_TREES over $BASE_SESSIONS sessions)"
  else
    bad "B attributable_d_trees=$ARM_TREES_D > 0"
  fi
  # Stage B is the half that proves the reap was a process-GROUP kill. Stage A
  # holds the MCP transport and would exit on stdin EOF alone; stage B holds no
  # pipe to anything, so it can only be ended by a signal. A d_procs of 0 with a
  # d_trees of 0 therefore means `kill_process_group()` really ran — a partial
  # reap that only closed the pipe would leave stage B behind and show up here.
  if [ "$ARM_PROCS_D" -le 0 ]; then
    ok "B d_procs=$ARM_PROCS_D <= 0 — the pipe-less stage-B process died too, so the whole process group was reaped, not just the transport (baseline pre-fix: +$BASE_D_PROCS)"
  else
    bad "B d_procs=$ARM_PROCS_D > 0 — something in the MCP process group survived"
  fi
  if awk -v v="$ARM_BG_PER_MIN" 'BEGIN{exit !(v <= 0.0)}'; then
    ok "B background_trees_per_min=$ARM_BG_PER_MIN <= 0.000 (baseline pre-fix: $BASE_BG_PER_MIN)"
  else
    bad "B background_trees_per_min=$ARM_BG_PER_MIN > 0.000"
  fi

  # ---- CHECK C ------------------------------------------------------------
  RSS_TOL_MB=15
  ev "C THIS RUN     d_rss_mb=$ARM_RSS_D over $ARM_DRIVEN sessions (tolerance <= ${RSS_TOL_MB} MB, which is less than ONE fixture tree)"
  ev "C PRE-FIX BASE d_rss_mb=$BASE_D_RSS over $BASE_SESSIONS sessions = $BASE_RSS_PER_SESSION MB per session (unbrowse trees)"
  if awk -v v="$ARM_RSS_D" -v t="$RSS_TOL_MB" 'BEGIN{exit !(v <= t)}'; then
    ok "C RSS of the leader's MCP descendants did not grow across $ARM_DRIVEN sessions"
  else
    bad "C RSS of the leader's MCP descendants grew by $ARM_RSS_D MB"
  fi

  ev "B in-session replacement (config hot-reload x$RELOADS on one live session) stranded_trees=$ARM_RELOAD_GROWTH cycles_with_stranded_trees=$ARM_RELOAD_LEAKS"
  if [ "$ARM_RELOAD_GROWTH" -eq 0 ] && [ "$ARM_RELOAD_LEAKS" -eq 0 ]; then
    ok "B every replaced MCP client's child was reaped while its session kept running — the Arc cycle is gone on the real path, not just in a unit test"
  else
    bad "B in-session client replacement stranded $ARM_RELOAD_GROWTH tree(s) across $ARM_RELOAD_LEAKS cycle(s)"
  fi
  FIXED_RELOAD_GROWTH="$ARM_RELOAD_GROWTH"

  if grep -qa "shutting down owned MCP clients" "$FIXED_LOG" 2>/dev/null; then
    ok "B the leader's own log shows the owned-only teardown running: $(grep -a -o 'session teardown: shutting down owned MCP clients.*' "$FIXED_LOG" | tail -1 | cut -c1-110)"
  else
    bad "B the leader never logged the owned-clients teardown — the reap, if any, came from somewhere else"
  fi
  stop_leader
  sleep 1
  leftover="$(tagged_pids | wc -l | tr -d ' ')"
  ev "B after stopping the fixed leader, tagged fixture processes still alive: $leftover"
  if [ "$leftover" -eq 0 ]; then
    ok "B the fixed arm left no MCP orphans at all"
  else
    bad "B the fixed arm left $leftover tagged MCP processes behind"
  fi
  FIXED_ARM_TREES_D="$ARM_TREES_D"; FIXED_ARM_LEAKS="$ARM_TEARDOWN_LEAKS"
else
  bad "B the fixed arm could not be driven"
  FIXED_ARM_TREES_D=-1; FIXED_ARM_LEAKS=-1; FIXED_RELOAD_GROWTH=-1
  stop_leader
fi

# ═════════════════════════════════════════════════════════════════════════════
step "CHECK E — falsification: the SAME procedure against the INSTALLED PRE-FIX binary"
ev "E method=same gate, same fixture, same drive, same counting; only the binary changes. If this arm does not leak, this gate cannot detect the defect it claims to defend."

if [ ! -x "$LEAKY_BIN" ]; then
  bad "E no pre-fix binary at $LEAKY_BIN — the gate cannot demonstrate it is capable of failing"
elif [ "$(readlink -f "$LEAKY_BIN")" = "$(readlink -f "$FIXED_BIN")" ]; then
  bad "E $LEAKY_BIN and $FIXED_BIN are the same file — no falsifier"
elif ! budget_guard || ! mem_guard; then
  bad "E budget or memory exhausted before the falsification arm could run"
else
  if run_arm leaky "$LEAKY_BIN"; then
    ev "E LEAKY ARM  session_churn: sessions=$ARM_DRIVEN spawns=$ARM_SPAWNS_SEEN teardown_leaks=$ARM_TEARDOWN_LEAKS d_trees=$ARM_TREES_D d_rss_mb=$ARM_RSS_D"
    ev "E LEAKY ARM  in_session_replacement: stranded_trees=$ARM_RELOAD_GROWTH cycles_with_stranded_trees=$ARM_RELOAD_LEAKS of $RELOADS"
    ev "E FIXED ARM  session_churn d_trees=$FIXED_ARM_TREES_D | in_session_replacement stranded_trees=$FIXED_RELOAD_GROWTH"
    if [ "$ARM_DRIVEN" -ge "$SESSIONS" ] && [ "$ARM_SPAWNS_SEEN" -eq "$SESSIONS" ]; then
      ok "E the pre-fix arm was driven identically ($ARM_DRIVEN sessions, $ARM_SPAWNS_SEEN visible spawns, $RELOADS reloads)"
    else
      bad "E the pre-fix arm was not driven identically — the comparison is not like-for-like"
    fi
    ev "E measured, not assumed: the pre-fix binary's SESSION-CHURN delta is $ARM_TREES_D. Session teardown reaps on both binaries because the session's own current-thread runtime is dropped with the actor (spawn.rs:1793), which kills rmcp's serve task and runs SafeTokioChildProcess::Drop. That is why the falsifier is the in-session replacement below and not the session churn above."
    if [ "$ARM_RELOAD_GROWTH" -gt 0 ] && [ "$ARM_RELOAD_LEAKS" -gt 0 ]; then
      ok "E the pre-fix binary LEAKS under this gate: $ARM_RELOAD_GROWTH stranded tree(s) over $RELOADS in-session client replacements ($ARM_RELOAD_LEAKS/$RELOADS cycles) → this gate reports RED for that arm"
    else
      bad "E the pre-fix binary did NOT leak under this gate (stranded=$ARM_RELOAD_GROWTH) — the gate is not capable of failing, so its green means nothing"
    fi
    if [ "$FIXED_RELOAD_GROWTH" -eq 0 ] && [ "$ARM_RELOAD_GROWTH" -gt 0 ]; then
      ok "E CONTRAST old=+$ARM_RELOAD_GROWTH stranded trees vs new=$FIXED_RELOAD_GROWTH — same gate, same fixture, same drive, opposite verdicts"
    else
      bad "E CONTRAST failed: old=$ARM_RELOAD_GROWTH new=$FIXED_RELOAD_GROWTH"
    fi
    stop_leader
    sleep 1
    lo="$(tagged_pids | wc -l | tr -d ' ')"
    ev "E after stopping the pre-fix leader, its stranded fixture processes still alive: $lo. Note the stranded servers outlive only their OWNER, not the leader process itself: killing the leader closes their stdin, and this fixture exits on EOF (a server that ignores EOF — as a leaked 'unbrowse mcp' tree does — would persist and need the cgroup kill a 'systemctl restart' performs). Either way this gate reaps its own tagged processes in its EXIT trap."
  else
    bad "E the pre-fix arm could not be driven"
    stop_leader
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
step "CHECK D — subagent safety: the drain touches owned_clients ONLY (UNIT-level assertion)"
ev "D scope: this is a UNIT-level assertion, not an e2e one. Driving a real subagent that inherits a parent's shared client and then tearing it down is a multi-session scenario this gate does not stage; the property is instead pinned by the two tests that encode it."
if [ "$RUN_UNIT" -eq 0 ]; then
  bad "D skipped by --skip-unit; the shared-client property is then unasserted"
else
  T_UNIT_DEFAULT=$(( RUN_BUDGET_S - $(elapsed) - 30 ))
  T_UNIT="${T_UNIT:-$T_UNIT_DEFAULT}"
  if [ "$T_UNIT" -lt 60 ]; then
    bad "D no budget left for the unit assertion (${T_UNIT}s of ${RUN_BUDGET_S}s remained)"
  else
    ev "D note: these two invocations need a warm cargo target dir. Cold, the test-profile build of xai-grok-shell alone can exceed the ${RUN_BUDGET_S}s run budget, and this phase then fails on budget rather than lying about the property."
    ev "D running: cargo test -p xai-grok-shell --lib drain_owned_clients   (timeout ${T_UNIT}s)"
    unit_log1="$(sock_root)/mcpleak-unit1.$$.log"; d0="$(date +%s)"
    ( cd "$REPO_ROOT" && CARGO_TERM_COLOR=never timeout "$T_UNIT" \
        cargo test --offline -p xai-grok-shell --lib drain_owned_clients ) >"$unit_log1" 2>&1
    ev "D xai-grok-shell unit phase took $(( $(date +%s) - d0 ))s"
    tail -6 "$unit_log1" | sed 's/^/      /'
    if grep -qE "test result: ok\. [1-9][0-9]* passed" "$unit_log1"; then
      ok "D drain_owned_clients_never_touches_shared_clients passes (shared_clients survive a subagent's own teardown)"
    else
      bad "D the xai-grok-shell drain tests did not pass (log: $unit_log1)"
    fi
    T_UNIT2=$(( RUN_BUDGET_S - $(elapsed) - 15 ))
    if [ "$T_UNIT2" -lt 60 ]; then
      bad "D no budget left for the second unit assertion"
    else
      ev "D running: cargo test -p xai-grok-mcp --lib client_shutdown_reaps   (timeout ${T_UNIT2}s)"
      unit_log2="$(sock_root)/mcpleak-unit2.$$.log"; d1="$(date +%s)"
      ( cd "$REPO_ROOT" && CARGO_TERM_COLOR=never timeout "$T_UNIT2" \
          cargo test --offline -p xai-grok-mcp --lib client_shutdown_reaps ) >"$unit_log2" 2>&1
      ev "D xai-grok-mcp unit phase took $(( $(date +%s) - d1 ))s"
      tail -6 "$unit_log2" | sed 's/^/      /'
      if grep -qE "test result: ok\. [1-9][0-9]* passed" "$unit_log2"; then
        ok "D client_shutdown_reaps_child_while_another_arc_is_held passes (an explicit shutdown reaps even while a second Arc is held — a subagent's inherited handle cannot keep a dead server's child alive)"
      else
        bad "D the xai-grok-mcp shutdown-reap test did not pass (log: $unit_log2)"
      fi
      rm -f "$unit_log2"
    fi
    rm -f "$unit_log1"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
step "SAFETY — the user's live leader was never touched, and this run reaps only its own"
USER_UNIT_PID_AFTER="$(systemctl --user show -p MainPID --value "$USER_UNIT" 2>/dev/null)"
[[ "$USER_UNIT_PID_AFTER" =~ ^[0-9]+$ ]] || USER_UNIT_PID_AFTER=0
ev "user_unit main_pid_before=$USER_UNIT_PID_BEFORE main_pid_after=$USER_UNIT_PID_AFTER active_state=$(systemctl --user show -p ActiveState --value "$USER_UNIT" 2>/dev/null)"
if [ "$USER_UNIT_PID_BEFORE" != "$USER_UNIT_PID_AFTER" ]; then
  bad "SAFETY $USER_UNIT MainPID moved ($USER_UNIT_PID_BEFORE → $USER_UNIT_PID_AFTER)"
elif [ "$USER_UNIT_PID_AFTER" = "0" ]; then
  ok "SAFETY $USER_UNIT is not running on this host (MainPID 0 before and after) — nothing of the user's was touched"
else
  ok "SAFETY $USER_UNIT MainPID unchanged ($USER_UNIT_PID_AFTER) — it was not restarted by this gate"
fi

cleanup_leftover="$(tagged_pids | wc -l | tr -d ' ')"
if [ "$cleanup_leftover" -gt 0 ]; then
  ev "reaping $cleanup_leftover leftover tagged fixture processes (all of them ours, by run tag)"
  for p in $(tagged_pids); do kill -TERM "$p" 2>/dev/null; done
  sleep 1
  for p in $(tagged_pids); do kill -KILL "$p" 2>/dev/null; done
  sleep 1
fi
orphans="$(tagged_pids | wc -l | tr -d ' ')"
ev "orphans_after_reap=$orphans (processes tagged $RUN_TAG still alive)"
if [ "$orphans" -eq 0 ]; then
  ok "SAFETY no orphans left behind by this run"
else
  bad "SAFETY $orphans tagged processes survived cleanup"
fi
ev "mem_avail_mb_end=$(mem_avail_mb) elapsed_s=$(elapsed) run_budget_s=$RUN_BUDGET_S"

hr
if [ "$FAIL" -eq 0 ]; then
  printf 'RESULT=PASS  node=gate.no_leak  sessions=%s  elapsed_s=%s\n' "$SESSIONS" "$(elapsed)"
  exit 0
fi
printf 'RESULT=FAIL  node=gate.no_leak  sessions=%s  elapsed_s=%s\n' "$SESSIONS" "$(elapsed)"
exit 1
