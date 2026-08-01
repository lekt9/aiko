#!/usr/bin/env bash
# Adversarial gate for the arc-agi-3 skill. Exit 0 only when every load-bearing
# claim of the skill is falsifiably true. Prose degrades; exit codes survive.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(dirname "$HERE")"
fail=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

echo "== arc-agi-3 gate =="

# 1. client imports and resolves a mode
python3 "$HERE/arc_client.py" mode >/tmp/arc_mode.json 2>/tmp/arc_mode.err \
  && ok "client runs, prints mode" || { bad "client failed: $(cat /tmp/arc_mode.err)"; }

# 2. DEFAULT (no env) must resolve to offline/kaggle
unset ARC_API_MODE
def_mode=$(python3 "$HERE/arc_client.py" mode 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"])' 2>/dev/null)
[ "$def_mode" = "offline" ] && ok "default mode = offline (Kaggle)" \
  || bad "default mode is '$def_mode', expected offline"

# 3. ARC_API_MODE=online flips to the live API path
on_mode=$(ARC_API_MODE=online python3 "$HERE/arc_client.py" mode 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["resolved"])' 2>/dev/null)
[ "$on_mode" = "online" ] && ok "ARC_API_MODE=online -> online" \
  || bad "online toggle broken (got '$on_mode')"

# 4. online path MUST wire a persistent cookie jar into the HTTP opener (sticky-session fix).
# Behavioral, not grep: a refactor that drops HTTPCookieProcessor would pass a grep but break online.
python3 - "$HERE/arc_client.py" <<'PY' && ok "cookie jar wired into HTTP opener (sticky-session fix)" || bad "cookie jar NOT connected to the opener (sticky-session bug unguarded)"
import sys, importlib.util, urllib.request
spec = importlib.util.spec_from_file_location("ac", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
opener, jar = m._opener()
procs = [h for h in opener.handlers if isinstance(h, urllib.request.HTTPCookieProcessor)]
assert len(procs) == 1, f"expected 1 HTTPCookieProcessor, got {len(procs)}"
assert procs[0].cookiejar is jar, "cookie jar not connected to the processor"
assert hasattr(jar, "save") and hasattr(jar, "load"), "jar is not persistent"
PY

# 5. offline path must NOT require a key (no ARC_API_KEY reference on the kaggle branch)
ARC_API_MODE=kaggle python3 "$HERE/arc_client.py" mode 2>/dev/null \
  | grep -q '"needs_key": false' \
  && ok "kaggle/offline mode needs no API key" || bad "offline mode wrongly needs a key"

# 6. frame renderer tolerates a transient non-grid frame (no crash on the (0,) frame gotcha)
python3 - "$HERE" <<'PY' && ok "renderer tolerates transient non-grid frame" || bad "renderer crashes on odd frame"
import sys, importlib.util
spec = importlib.util.spec_from_file_location("ac", sys.argv[1] + "/arc_client.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = m.render({"frame": [], "state": "NOT_FINISHED"})
assert "non-grid" in out, out
PY

# 7. SKILL.md names the load-bearing defaults and is lean
S="$SKILL/SKILL.md"
grep -qi "default" "$S" && grep -qi "kaggle" "$S" && grep -qi "offline" "$S" \
  && ok "SKILL.md names the Kaggle/offline default" || bad "SKILL.md missing default-mode statement"
lines=$(wc -l < "$S"); [ "$lines" -lt 500 ] && ok "SKILL.md lean ($lines lines)" \
  || bad "SKILL.md too long ($lines lines)"

# 8. references cover the five required topics, each its own file
for f in 01-methodology 02-api 03-gotchas 04-solving-playbook 05-kaggle 06-lewis-strategy-routing; do
  [ -s "$SKILL/references/$f.md" ] && ok "reference $f present" || bad "missing reference $f.md"
done

# 9. methodology reference states the real RHAE scoring formula (not a stub)
grep -q "human_baseline" "$SKILL/references/01-methodology.md" \
  && grep -qi "1.15" "$SKILL/references/01-methodology.md" \
  && ok "methodology has the real RHAE formula + 1.15x cap" || bad "methodology RHAE formula missing/stubbed"

# 10. gotchas reference names the sticky-session cookie AND the score->levels_completed rename
grep -qi "sticky" "$SKILL/references/03-gotchas.md" \
  && grep -q "levels_completed" "$SKILL/references/03-gotchas.md" \
  && ok "gotchas name sticky-session + levels_completed rename" || bad "gotchas missing key entries"

# 11. no em dashes in shipped source/docs (project ban). Build the needle so this file stays clean.
EMDASH=$(printf '\xe2\x80\x94')
if grep -RIl --include='*.md' --include='*.py' --include='*.sh' "$EMDASH" "$SKILL" >/dev/null 2>&1; then bad "em dash found: $(grep -RIl --include='*.md' --include='*.py' --include='*.sh' "$EMDASH" "$SKILL" | tr '\n' ' ')"; else ok "no em dashes"; fi

# 11b. every shipped Python file compiles (catch syntax breakage before a live run)
pyok=1
for py in "$HERE/arc_client.py" "$SKILL/assets/kaggle_agent_template/MyAgent.py"; do
  python3 -m py_compile "$py" 2>/tmp/arc_pyc.err || { pyok=0; echo "    $(cat /tmp/arc_pyc.err)"; }
done
[ "$pyok" -eq 1 ] && ok "all shipped Python compiles" || bad "a shipped .py fails py_compile"

# 11c. the API reference documents BOTH the online endpoints and the offline engine
grep -qi "three.arcprize.org" "$SKILL/references/02-api.md" \
  && grep -qi "arc_agi" "$SKILL/references/02-api.md" \
  && grep -qi "choose_action" "$SKILL/references/02-api.md" \
  && ok "API ref covers online + offline + Agent contract" || bad "API ref missing a mode"

# 11d. act/close with no open game exit cleanly (no raw traceback). The lost sheep.
rm -f "$HOME/.arc-agi-3-session/state.json"
out=$(env -u ARC_API_KEY ARC_API_MODE=online python3 "$HERE/arc_client.py" act 5 2>&1)
echo "$out" | grep -qi "no open game" && ! echo "$out" | grep -q "Traceback" \
  && ok "act with no session -> clean message, no traceback" \
  || bad "act with no session leaks a traceback: $(echo "$out" | tail -1)"

# 12. kaggle agent template exists and subclasses the Agent base class
T="$SKILL/assets/kaggle_agent_template/MyAgent.py"
[ -s "$T" ] && grep -q "class MyAgent" "$T" && grep -qi "choose_action" "$T" \
  && ok "kaggle MyAgent template present (choose_action)" || bad "kaggle agent template missing/incomplete"

# 13. the API interface retries transient failures with backoff (all online ops go
# through _request); witnessed offline (no network/key), see witness_retry_backoff.py
python3 "$HERE/witness_retry_backoff.py" >/dev/null 2>&1 \
  && ok "API retry-with-backoff: transient retried, 4xx fast-fail, capped" \
  || bad "retry-backoff witness failed (run witness_retry_backoff.py)"

echo "== $( [ $fail -eq 0 ] && echo "GATE GREEN" || echo "GATE RED" ) =="
exit $fail
