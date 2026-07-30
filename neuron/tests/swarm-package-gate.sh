#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/typed-neuron-swarm.XXXXXX")
pid_a=
pid_b=

cleanup() {
    if [[ -n "$pid_a" ]]; then
        kill "$pid_a" 2>/dev/null || true
        wait "$pid_a" 2>/dev/null || true
    fi
    if [[ -n "$pid_b" ]]; then
        kill "$pid_b" 2>/dev/null || true
        wait "$pid_b" 2>/dev/null || true
    fi
    rm -rf -- "$test_root"
}
trap cleanup EXIT INT TERM

cd "$repo_dir"
zig build test

dist_dir="${test_root}/dist"
archive=$(bash packaging/build-bundle.sh "$dist_dir")
bundle_dir=${archive%.tar.gz}
test -x "${bundle_dir}/install.sh"
test -x "${bundle_dir}/bin/neuron"
tar -tzf "$archive" | rg -q '/manifest.json$'

python3 - "$bundle_dir" <<'PY'
import hashlib
import json
import pathlib
import sys

bundle = pathlib.Path(sys.argv[1])
manifest = json.loads((bundle / "manifest.json").read_text())
assert manifest["schema"] == "neuron.bundle/v1"
assert manifest["wire"] == "neuron.wire/v1"
assert manifest["entrypoint"] == "bin/neuron node serve <node_dir>"
assert hashlib.sha256((bundle / "bin/neuron").read_bytes()).hexdigest() == manifest["binary_sha256"]
PY

ports=$(python3 <<'PY'
import socket

sockets = []
for _ in range(2):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
print(*(sock.getsockname()[1] for sock in sockets))
PY
)
port_a=${ports%% *}
port_b=${ports##* }

prefix="${test_root}/install"
node_a="${test_root}/node-a"
node_b="${test_root}/node-b"
installer="${bundle_dir}/install.sh"
binary="${prefix}/bin/neuron"

"$installer" \
    --prefix "$prefix" \
    --node-dir "$node_a" \
    --listen "127.0.0.1:${port_a}" \
    --write-prefix "artifact/swarm/a/" \
    --transport loopback >/dev/null
id_a=$("$binary" node id "$node_a")

# Reinstallation upgrades package files without rotating identity or state.
"$installer" \
    --prefix "$prefix" \
    --node-dir "$node_a" \
    --listen "127.0.0.1:${port_a}" \
    --write-prefix "artifact/swarm/a/" \
    --transport loopback >/dev/null
test "$id_a" = "$("$binary" node id "$node_a")"
if "$installer" \
    --prefix "$prefix" \
    --node-dir "$node_a" \
    --listen "127.0.0.1:${port_a}" \
    --write-prefix "artifact/swarm/widened/" \
    --transport loopback >"${test_root}/config-mismatch.out" 2>"${test_root}/config-mismatch.err"; then
    echo "reinstall silently changed an existing node configuration" >&2
    exit 1
fi
rg -q 'NodeConfigMismatch' "${test_root}/config-mismatch.err"

"$installer" \
    --prefix "$prefix" \
    --node-dir "$node_b" \
    --listen "127.0.0.1:${port_b}" \
    --write-prefix "artifact/swarm/b/" \
    --transport loopback >/dev/null
id_b=$("$binary" node id "$node_b")
test "$id_a" != "$id_b"

seed_mode() {
    stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}
test "$(seed_mode "${node_a}/device.seed")" = "600"
test "$(seed_mode "${node_b}/device.seed")" = "600"
rg -q "^ExecStart=${prefix}/bin/neuron node serve ${node_a}$" \
    "${node_a}/service/typed-neuron.service"
rg -q "<string>${node_a}</string>" \
    "${node_a}/service/io.typed-neuron.node.plist"

"$binary" node serve "$node_a" >"${test_root}/node-a.log" 2>&1 &
pid_a=$!
"$binary" node serve "$node_b" >"${test_root}/node-b.log" 2>&1 &
pid_b=$!

for _ in $(seq 1 100); do
    if rg -q '"schema":"neuron.node-ready/v1"' "${test_root}/node-a.log" &&
       rg -q '"schema":"neuron.node-ready/v1"' "${test_root}/node-b.log"; then
        break
    fi
    if ! kill -0 "$pid_a" 2>/dev/null || ! kill -0 "$pid_b" 2>/dev/null; then
        echo "an installed node exited before becoming ready" >&2
        sed -n '1,120p' "${test_root}/node-a.log" >&2
        sed -n '1,120p' "${test_root}/node-b.log" >&2
        exit 1
    fi
    sleep 0.05
done
rg -q '"schema":"neuron.node-ready/v1"' "${test_root}/node-a.log"
rg -q '"schema":"neuron.node-ready/v1"' "${test_root}/node-b.log"
rg -q "\"node\":\"${id_a}\"" "${test_root}/node-a.log"
rg -q "\"node\":\"${id_b}\"" "${test_root}/node-b.log"

health_a=$("$binary" node fire "127.0.0.1:${port_a}" \
    --ref mesh/health \
    --schema neuron.health/v1 \
    --payload '{}' \
    --firing health-a \
    --allow-loopback)
health_b=$("$binary" node fire "127.0.0.1:${port_b}" \
    --ref mesh/health \
    --schema neuron.health/v1 \
    --payload '{}' \
    --firing health-b \
    --allow-loopback)

python3 - "$health_a" "$health_b" <<'PY'
import json
import sys

for raw in sys.argv[1:]:
    response = json.loads(raw)
    assert response == {
        "status": "committed",
        "effects_committed": 0,
        "duplicates_skipped": 0,
    }
PY

write_a=$("$binary" node fire "127.0.0.1:${port_a}" \
    --ref mesh/proxy \
    --schema mesh.proxy/v2 \
    --payload '{"schema":"mesh.proxy/v2","artifact_id":"artifact/swarm/a/from-b","bytes":"brain-b"}' \
    --firing cross-a \
    --allow-loopback)
write_b=$("$binary" node fire "127.0.0.1:${port_b}" \
    --ref mesh/proxy \
    --schema mesh.proxy/v2 \
    --payload '{"schema":"mesh.proxy/v2","artifact_id":"artifact/swarm/b/from-a","bytes":"brain-a"}' \
    --firing cross-b \
    --nonce 4242 \
    --allow-loopback)
retry_b=$("$binary" node fire "127.0.0.1:${port_b}" \
    --ref mesh/proxy \
    --schema mesh.proxy/v2 \
    --payload '{"schema":"mesh.proxy/v2","artifact_id":"artifact/swarm/b/from-a","bytes":"brain-a"}' \
    --firing cross-b \
    --nonce 4242 \
    --allow-loopback)

python3 - "$write_a" "$write_b" "$retry_b" <<'PY'
import json
import sys

first_a, first_b, retry_b = map(json.loads, sys.argv[1:])
assert first_a["status"] == first_b["status"] == retry_b["status"] == "committed"
assert first_a["effects_committed"] == first_b["effects_committed"] == 1
assert first_a["duplicates_skipped"] == first_b["duplicates_skipped"] == 0
assert retry_b["effects_committed"] == 0
assert retry_b["duplicates_skipped"] == 1
PY

rg -q 'artifact/swarm/a/from-b' "${node_a}/state/substrate.log"
rg -q 'artifact/swarm/b/from-a' "${node_b}/state/substrate.log"

if "$binary" node fire "127.0.0.1:${port_a}" \
    --ref mesh/health \
    --schema neuron.health/v1 \
    --payload '{}' \
    --firing forbidden-loopback >"${test_root}/denied.out" 2>"${test_root}/denied.err"; then
    echo "node fire admitted loopback without an explicit test override" >&2
    exit 1
fi
rg -q 'EgressDenied' "${test_root}/denied.err"

echo "swarm-package gate: PASS"
