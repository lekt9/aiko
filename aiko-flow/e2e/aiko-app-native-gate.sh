#!/usr/bin/env bash
# aiko-app-native-gate.sh — node gate.app_native
#
# The composed end-to-end gate: a headless BROWSER drives the real SPA against
# the BUILT aiko binary's own hermetic `native serve`. Composes the two settled
# witnesses (tmp/witness-app-native-client.sh, tmp/witness-app-aiko-login.sh):
#
#   1. hermetic `aiko native serve --addr` from target/release/aiko with the
#      machine's real session copied into a throwaway HOME (0600, deleted on
#      exit) — the resident :19420 daemon runs an OLD binary lacking /v1/auth
#      and is never touched. A hermetic LEADER (`aiko agent leader
#      --relay-on-demand`) runs alongside it: the native agent-mail endpoint
#      is a bridge onto the leader socket (native_api.rs bridge_agent_mail),
#      so without one the initialize handshake (d) has nothing to answer it;
#   2. the SPA's vite dev server started with HOME pointed at that hermetic
#      home, so its /native guard+proxy reads the hermetic discovery doc and
#      pins the hermetic baseUrl (ORDER MATTERS: serve first, vite second);
#   3. Playwright Chromium (fixtures/aiko-app/browser-gate.mjs) asserts, from
#      page context: app renders (a), signed-in identity in the DOM with no
#      grok login UI (b), /native/v1/{manifest,auth} round-trip (c), the
#      aiko.acp.v1 agent-mail initialize handshake (d);
#   4. bundle hygiene (e): zero grok issuer/OAuth hosts (auth.x.ai,
#      accounts.x.ai — pinned from crates/.../auth/config.rs) in the served
#      modules and the SPA source;
#   5. FALSIFICATION, inline after green: kill the hermetic serve, reload —
#      the app must visibly fail closed ("Not queried"/"Not available", 503
#      native_unavailable taxonomy from page context).
#
# GATE_FALSIFY=1 arm: the hermetic serve is killed right after the curl
# pre-checks, so the browser green assertions MUST fail and the gate MUST exit
# nonzero — proof the browser arm cannot pass without a live native path.
#
# Exit 0 only when every arm holds. Every wait is bounded; all child process
# groups die on EXIT.
set -u
export PATH="$HOME/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export CODEDB_NO_HOOKS=1

REPO=/home/deck/work/aiko
BIN="$REPO/aiko/target/release/aiko"
FRONTEND="$REPO/aiko/apps/frontend/frontend"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/aiko-app"
REAL_AIKO="$HOME/.aiko"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/aiko-app-native-gate.XXXXXX")"
chmod 700 "$SCRATCH"
PGIDS=()

cleanup() {
  status=$?
  for pid in "${PGIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PGIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$SCRATCH" # includes the hermetic copy of auth.json
  exit "$status"
}
trap cleanup EXIT INT TERM

evidence() { echo "EVIDENCE: $*"; }
fail() {
  echo "EVIDENCE: FAIL: $*"
  for log in leader.log serve.log vite.log stub.log; do
    [ -s "$SCRATCH/$log" ] && { echo "--- tail $log ---"; tail -5 "$SCRATCH/$log"; }
  done
  exit 1
}

command -v node >/dev/null || fail "node not on PATH"
command -v curl >/dev/null || fail "curl not on PATH"
command -v python3 >/dev/null || fail "python3 not on PATH"
[ -x "$BIN" ] || fail "built binary missing: $BIN (cargo build --release -p xai-grok-pager-bin)"
[ -s "$REAL_AIKO/auth.json" ] || fail "no real session on this machine: $REAL_AIKO/auth.json missing"
[ -d "$FRONTEND/node_modules" ] || fail "$FRONTEND/node_modules missing — run npm install first"
[ -f "$FIXTURES/browser-gate.mjs" ] || fail "fixture missing: $FIXTURES/browser-gate.mjs"
node -e "const p=require('$REPO/aiko-flow/e2e/node_modules/playwright');if(!require('fs').existsSync(p.chromium.executablePath()))process.exit(1)" \
  || fail "Playwright Chromium not installed for aiko-flow/e2e (pnpm exec playwright install chromium)"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

wait_for_file() { # path timeout_s
  local path=$1 deadline=$((SECONDS + $2))
  while [ ! -s "$path" ]; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.2
  done
  return 0
}

wait_http_up() { # url seconds — any HTTP answer counts as "up"
  local url=$1 tries=$2 code
  for _ in $(seq "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$url" || true)
    [ "$code" != "000" ] && return 0
    sleep 1
  done
  return 1
}

wait_port_down() { # url seconds
  local url=$1 tries=$2 code
  for _ in $(seq "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$url" || true)
    [ "$code" = "000" ] && return 0
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------------------
# 1. Hermetic HOME + the BUILT binary's own leader and `native serve` (each
#    bounded 60s). Serve before vite: vite pins its /native target from the
#    discovery doc at boot. The leader binds $HERMETIC/.aiko/leader.sock —
#    the resident leader at ~/.aiko/leader.sock is never touched.
# ---------------------------------------------------------------------------
HERMETIC="$SCRATCH/home"
mkdir -p "$HERMETIC/.aiko"
chmod 700 "$HERMETIC"
install -m 600 "$REAL_AIKO/auth.json" "$HERMETIC/.aiko/auth.json"
[ -f "$REAL_AIKO/config.toml" ] && install -m 600 "$REAL_AIKO/config.toml" "$HERMETIC/.aiko/config.toml"

(
  # --relay-on-demand: never touch the grok.com relay for a local handshake.
  exec env -u GROK_HOME HOME="$HERMETIC" AIKO_HOME="$HERMETIC/.aiko" \
    setsid "$BIN" agent leader --relay-on-demand --no-exit-on-disconnect --no-auto-update
) >"$SCRATCH/leader.log" 2>&1 &
LEADER_PID=$!
PGIDS+=("$LEADER_PID")
LEADER_DEADLINE=$((SECONDS + 60))
while [ ! -S "$HERMETIC/.aiko/leader.sock" ]; do
  [ "$SECONDS" -ge "$LEADER_DEADLINE" ] && fail "hermetic leader never bound its socket within 60s"
  sleep 0.2
done
evidence "hermetic leader bound $HERMETIC/.aiko/leader.sock"

NPORT=$(free_port)
(
  exec env -u GROK_HOME HOME="$HERMETIC" AIKO_HOME="$HERMETIC/.aiko" \
    setsid "$BIN" native serve --addr "127.0.0.1:$NPORT"
) >"$SCRATCH/serve.log" 2>&1 &
SERVE_PID=$!
PGIDS+=("$SERVE_PID")
wait_for_file "$HERMETIC/.aiko/native/api.json" 60 \
  || fail "hermetic native serve on :$NPORT never wrote its discovery doc within 60s"

NTOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['authorization']['token'])" "$HERMETIC/.aiko/native/api.json") \
  || fail "hermetic discovery doc carries no bearer token"

# Pin that the hermetic port is served by the BUILT binary, not any resident daemon.
HEALTH=$(curl -sS -m 10 -H "Authorization: Bearer $NTOKEN" "http://127.0.0.1:$NPORT/v1/health") || fail "hermetic /v1/health unreachable"
SERVER_PID_REPORTED=$(printf '%s' "$HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin)['pid'])") || fail "/v1/health names no pid: $HEALTH"
SERVER_EXE=$(readlink -f "/proc/$SERVER_PID_REPORTED/exe" 2>/dev/null || echo unreadable)
[ "$SERVER_EXE" = "$(readlink -f "$BIN")" ] || fail "hermetic port served by $SERVER_EXE, not the built binary"
evidence "hermetic native serve on :$NPORT is the BUILT binary (pid $SERVER_PID_REPORTED, $(printf '%s' "$HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"))"

# ---------------------------------------------------------------------------
# 2. Stub workspace API + vite dev server with the hermetic HOME (bounded 120s).
# ---------------------------------------------------------------------------
SPORT=$(free_port)
( exec setsid node "$FIXTURES/stub-backend.mjs" "$SPORT" ) >"$SCRATCH/stub.log" 2>&1 &
STUB_PID=$!
PGIDS+=("$STUB_PID")
wait_http_up "http://127.0.0.1:$SPORT/api/v1/config/frontend" 30 || fail "stub workspace API never came up on :$SPORT"

VPORT=$(free_port)
(
  cd "$FRONTEND" || exit 1
  HOME="$HERMETIC" BACKEND_URL="http://127.0.0.1:$SPORT" \
    exec setsid node node_modules/vite/bin/vite.js --port "$VPORT" --strictPort --host 127.0.0.1
) >"$SCRATCH/vite.log" 2>&1 &
VITE_PID=$!
PGIDS+=("$VITE_PID")
wait_http_up "http://127.0.0.1:$VPORT/" 120 || fail "vite dev server never came up on :$VPORT"
ORIGIN="http://127.0.0.1:$VPORT"
evidence "SPA dev server at $ORIGIN (HOME=$HERMETIC, /native -> :$NPORT, /api+/cli -> stub :$SPORT)"

# Curl pre-checks: the proxy serves the hermetic binary before the browser runs.
M_CODE=$(curl -s -o "$SCRATCH/manifest.json" -w '%{http_code}' -m 10 "$ORIGIN/native/v1/manifest" || true)
[ "$M_CODE" = "200" ] || fail "pre-check GET /native/v1/manifest -> HTTP $M_CODE: $(head -c 300 "$SCRATCH/manifest.json")"
grep -q '"schema":"aiko.native.v1"' "$SCRATCH/manifest.json" || fail "pre-check manifest is not aiko.native.v1"
A_CODE=$(curl -s -o "$SCRATCH/auth.json" -w '%{http_code}' -m 10 "$ORIGIN/native/v1/auth" || true)
[ "$A_CODE" = "200" ] || fail "pre-check GET /native/v1/auth -> HTTP $A_CODE: $(head -c 300 "$SCRATCH/auth.json")"
EXPECT_IDENT=$(python3 - "$SCRATCH/auth.json" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
assert body.get("signed_in") is True, f"signed_in is not true: {body}"
account = (body.get("accounts") or [{}])[0]
print(account.get("email") or account.get("label") or "")
PY
) || fail "pre-check /native/v1/auth does not report a signed-in session: $(head -c 300 "$SCRATCH/auth.json")"
[ -n "$EXPECT_IDENT" ] || fail "pre-check /native/v1/auth names no email/label to assert in the DOM"
evidence "pre-check: proxy serves the hermetic binary — manifest 200 aiko.native.v1, auth 200 signed_in:true ident=$EXPECT_IDENT"

# ---------------------------------------------------------------------------
# GATE_FALSIFY=1 — kill the serve NOW; the browser green arm must go red.
# ---------------------------------------------------------------------------
if [ "${GATE_FALSIFY:-0}" = "1" ]; then
  evidence "FALSIFY arm: killing the hermetic native serve BEFORE the browser assertions — this run must exit nonzero"
  kill -TERM -- "-$SERVE_PID" 2>/dev/null || kill -TERM "$SERVE_PID" 2>/dev/null || true
  wait_port_down "http://127.0.0.1:$NPORT/v1/health" 30 || fail "hermetic serve did not die"
fi

# ---------------------------------------------------------------------------
# 3. GREEN: headless Chromium drives the real SPA (bounded: 240s wrapper,
#    per-assert 60s inside, ws 30s).
# ---------------------------------------------------------------------------
timeout 240 node "$FIXTURES/browser-gate.mjs" green "$ORIGIN" "$EXPECT_IDENT" "$SCRATCH/modules.txt" 2>&1 \
  | tee "$SCRATCH/browser-green.log"
BROWSER_RC=${PIPESTATUS[0]}
[ "$BROWSER_RC" = "0" ] || fail "browser green arm exited $BROWSER_RC"

# ---------------------------------------------------------------------------
# 4. (e) Bundle hygiene: zero grok issuer/OAuth hosts in the served modules
#    and the SPA source. Hosts pinned from crates/codegen/xai-grok-shell/src/
#    auth/config.rs: GROK_OAUTH2_ISSUER=https://auth.x.ai and
#    PROD_ACCOUNTS_APP_ORIGINS=https://accounts.x.ai.
# ---------------------------------------------------------------------------
BANNED='auth\.x\.ai|accounts\.x\.ai'
SRC_HITS=$(grep -RIn -E "$BANNED" "$FRONTEND/src" 2>/dev/null | head -5 || true)
[ -z "$SRC_HITS" ] || fail "grok issuer host in SPA source: $SRC_HITS"
[ -s "$SCRATCH/modules.txt" ] || fail "browser recorded no served module URLs to scan"
grep -q "src/api/native.ts" "$SCRATCH/modules.txt" || fail "served-module list does not include src/api/native.ts — the scan would miss the app's own modules"
# The app's own /src/ modules are scanned in full; dependency chunks fill the
# remainder of the 400-URL budget.
{ grep "/src/" "$SCRATCH/modules.txt"; grep -v "/src/" "$SCRATCH/modules.txt"; } | head -400 >"$SCRATCH/scan.txt"
SCANNED=0 HITS=""
while IFS= read -r url; do
  [ -n "$url" ] || continue
  SCANNED=$((SCANNED + 1))
  if curl -s -m 10 "$url" | grep -qE "$BANNED"; then HITS="$HITS $url"; fi
done <"$SCRATCH/scan.txt"
[ "$SCANNED" -ge 5 ] || fail "only $SCANNED served modules scanned — too few to mean anything"
[ -z "$HITS" ] || fail "grok issuer/OAuth host in served modules:$HITS"
evidence "(e) bundle hygiene: 0 grok issuer/OAuth hosts (auth.x.ai, accounts.x.ai) in $SCANNED served modules (all /src/ modules + dependency sample of $(wc -l <"$SCRATCH/modules.txt") recorded) + SPA source tree"

# ---------------------------------------------------------------------------
# 5. FALSIFICATION, inline: kill the hermetic serve, reload — the app must
#    visibly fail closed and the 503 taxonomy must reach page context.
# ---------------------------------------------------------------------------
kill -TERM -- "-$SERVE_PID" 2>/dev/null || kill -TERM "$SERVE_PID" 2>/dev/null || true
wait_port_down "http://127.0.0.1:$NPORT/v1/health" 30 || fail "hermetic serve did not die for the red arm"

RED_CODE=$(curl -s -o "$SCRATCH/red-manifest.json" -w '%{http_code}' -m 10 "$ORIGIN/native/v1/manifest" || true)
[ "$RED_CODE" -ge 500 ] 2>/dev/null || fail "red arm: /native/v1/manifest -> HTTP $RED_CODE with the serve dead — not fail-closed"
grep -q '"native_unavailable"' "$SCRATCH/red-manifest.json" || fail "red arm: 5xx without the native_unavailable taxonomy: $(head -c 300 "$SCRATCH/red-manifest.json")"
evidence "RED (curl): /native/v1/manifest -> HTTP $RED_CODE native_unavailable with the serve dead"

timeout 240 node "$FIXTURES/browser-gate.mjs" red "$ORIGIN" "$EXPECT_IDENT" 2>&1 \
  | tee "$SCRATCH/browser-red.log"
RED_RC=${PIPESTATUS[0]}
[ "$RED_RC" = "0" ] || fail "browser red arm exited $RED_RC — the app did not visibly fail closed"

evidence "ALL GREEN: browser-driven SPA against the built binary's hermetic native serve — render, signed-in identity, page-context round-trip, aiko.acp.v1 handshake, bundle hygiene, and fail-closed falsification"
exit 0
