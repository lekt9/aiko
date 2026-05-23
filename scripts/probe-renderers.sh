#!/usr/bin/env bash
# probe-renderers.sh — child C of d26df94c. Asserts 5 renderers exist + each
# produces sane output for a representative substrate stdio input.
set -e

R="$HOME/.claude/skills/contract/scripts/renderers"
for n in stdout aiko-notch merjs video-message tg-video; do
  if [ ! -e "$R/$n.sh" ] && [ ! -e "$R/$n.py" ]; then
    echo "FAIL: renderer missing: $n"; exit 1
  fi
done
echo "PASS: 5 renderers present"

SAMPLE='=== TWO-KEY EXIT ===
  plan: probe sample
  result: PASS
  body: I just shipped a thing.
  Run: contract iterate deadbeef'

# stdout pass-through
OUT=$(printf '%s\n' "$SAMPLE" | bash "$R/stdout.sh")
[ -n "$OUT" ] || { echo "FAIL: stdout renderer no output"; exit 1; }
echo "PASS: stdout passthrough"

# aiko-notch JSON card
OUT=$(printf '%s\n' "$SAMPLE" | python3 "$R/aiko-notch.py")
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
for k in ("kind","title","body","actions","raw"):
    assert k in d, "missing " + k
assert isinstance(d["actions"], list), "actions not a list"
' || { echo "FAIL: aiko-notch envelope shape wrong"; echo "$OUT"; exit 1; }
echo "PASS: aiko-notch emits JSON card with required fields"

# merjs markdown
OUT=$(printf '%s\n' "$SAMPLE" | python3 "$R/merjs.py")
echo "$OUT" | grep -q '^## ' || { echo "FAIL: merjs missing title header"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q '^### Raw' || { echo "FAIL: merjs missing Raw section"; echo "$OUT"; exit 1; }
echo "PASS: merjs emits markdown with ## title + ### Raw section"

# video-message HINT envelope
OUT=$(printf '%s\n' "$SAMPLE" | python3 "$R/video-message.py")
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["kind"] == "video-message-hint"
assert d["tts"]["provider"] == "chatterbox"
assert d["video"]["provider"] == "seedance-r2v"
assert isinstance(d["rendering_chain"], list) and len(d["rendering_chain"]) >= 3
' || { echo "FAIL: video-message envelope wrong"; echo "$OUT"; exit 1; }
echo "PASS: video-message emits chatterbox + seedance-r2v HINT envelope"

# tg-video composes video-message + sendVideo
OUT=$(printf '%s\n' "$SAMPLE" | python3 "$R/tg-video.py")
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["kind"] == "tg-video-hint"
assert d["video"]["kind"] == "video-message-hint"
assert d["telegram_dispatch"]["method"] == "sendVideo"
assert "thread_id_env" in d["telegram_dispatch"]
assert "discipline" in d["telegram_dispatch"]
' || { echo "FAIL: tg-video envelope wrong"; echo "$OUT"; exit 1; }
echo "PASS: tg-video composes video-message + sendVideo with thread + discipline note"

echo
echo "probe-renderers: PASS"
exit 0
