#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
DPID=""
cleanup() { [ -n "$DPID" ] && kill "$DPID" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

# hermetic stdio agent — honors the same --prompt-file contract as the aiko CLI
cat > "$tmp/fake-aiko" <<'EOF'
#!/bin/bash
pf=""
while [ $# -gt 0 ]; do case "$1" in --prompt-file) pf="$2"; shift 2;; *) shift;; esac; done
[ -n "$pf" ] && [ -f "$pf" ] || { echo "no prompt file" >&2; exit 1; }
echo "stub-agent-reply: $(wc -c < "$pf" | tr -d ' ') bytes"
EOF
chmod +x "$tmp/fake-aiko"

sock="$tmp/d.sock"
CELL_DAEMON_SOCK="$sock" AIKO_BIN="$tmp/fake-aiko" python3 "$CELL/run.py" daemon > "$tmp/daemon.log" 2>&1 &
DPID=$!

python3 - "$sock" <<'PY' || { echo "FAIL daemon: socket never came up"; exit 1; }
import socket, sys, time
for _ in range(50):
    s = socket.socket(socket.AF_UNIX)
    try:
        s.connect(sys.argv[1]); s.close(); sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit(1)
PY

req() { python3 - "$sock" "$1" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect(sys.argv[1])
s.sendall(sys.argv[2].encode() + b"\n")
buf = b""
while b"\n" not in buf: buf += s.recv(65536)
print(buf.decode().strip())
PY
}

# 1) ping
req '{"op":"ping"}' | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['ok'] else 1)" || { echo "FAIL daemon: ping"; exit 1; }

# 2) one daemon only — a second start against the same socket is refused
CELL_DAEMON_SOCK="$sock" python3 "$CELL/run.py" daemon > /dev/null 2>&1 && { echo "FAIL daemon: second daemon accepted"; exit 1; }

# 3) agent turns go through the stdio agent binary (prompt by file, reply by stdout)
out=$(req '{"op":"agent","prompt":"hello"}')
echo "$out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['ok'], d
assert 'stub-agent-reply: 5 bytes' in d['output'], d
" || { echo "FAIL daemon: agent turn ($out)"; exit 1; }

# 4) empty prompt refused
req '{"op":"agent","prompt":""}' | python3 -c "import json,sys; sys.exit(1 if json.load(sys.stdin)['ok'] else 0)" || { echo "FAIL daemon: empty prompt accepted"; exit 1; }

# 5) a firing anywhere (public CLI) is broadcast to subscribers
python3 - "$sock" "$CELL" <<'PY' || { echo "FAIL daemon: subscriber never saw the firing"; exit 1; }
import json, socket, subprocess, sys, tempfile
sock_path, cell = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect(sock_path)
s.sendall(b'{"op":"subscribe"}\n')
f = s.makefile("r")
assert json.loads(f.readline())["subscribed"]
with tempfile.TemporaryDirectory() as out:
    subprocess.run(["python3", f"{cell}/run.py", "run", f"{cell}/example/pipeline.cell.yaml",
                    "--inputs", f"{cell}/example/inputs.json", "--out", out],
                   check=True, capture_output=True)
    fid = json.load(open(f"{out}/manifest.json"))["produced_by"]
while True:
    ev = json.loads(f.readline())
    if ev.get("event") == "heartbeat":
        continue
    assert ev.get("event") == "firing", ev
    if ev.get("id") == fid:
        sys.exit(0)
PY

echo "PASS daemon: one listener — ping, single-instance, stdio agent turns, journal broadcast"
