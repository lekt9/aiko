#!/bin/sh
set -eu

bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix="${HOME}/.local"
state_base="${XDG_STATE_HOME:-${HOME}/.local/state}"
node_dir="${state_base}/typed-neuron"
listen="0.0.0.0:7331"
write_prefix="artifact/swarm/"
transport="tailnet"
init_node=1

usage() {
    echo "usage: install.sh [--prefix DIR] [--node-dir DIR] [--listen IP:PORT]"
    echo "                  [--write-prefix PREFIX] [--transport tailnet|loopback]"
    echo "                  [--no-init]"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix|--node-dir|--listen|--write-prefix|--transport)
            if [ "$#" -lt 2 ]; then
                echo "installer option needs a value: $1" >&2
                exit 2
            fi
            option=$1
            value=$2
            shift 2
            case "$option" in
                --prefix) prefix=$value ;;
                --node-dir) node_dir=$value ;;
                --listen) listen=$value ;;
                --write-prefix) write_prefix=$value ;;
                --transport) transport=$value ;;
            esac
            ;;
        --no-init) init_node=0; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "unknown installer option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$transport" in
    tailnet|loopback) ;;
    *) echo "transport must be tailnet or loopback" >&2; exit 2 ;;
esac

test -x "${bundle_dir}/bin/neuron"
if [ -f "${bundle_dir}/manifest.json" ]; then
    expected_sha=$(sed -n 's/.*"binary_sha256":"\([^"]*\)".*/\1/p' "${bundle_dir}/manifest.json")
    if [ "${#expected_sha}" -ne 64 ]; then
        echo "bundle manifest has no valid binary checksum" >&2
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        actual_sha=$(sha256sum "${bundle_dir}/bin/neuron" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual_sha=$(shasum -a 256 "${bundle_dir}/bin/neuron" | awk '{print $1}')
    else
        echo "sha256sum or shasum is required to verify the bundle" >&2
        exit 1
    fi
    if [ "$actual_sha" != "$expected_sha" ]; then
        echo "bundle binary checksum mismatch" >&2
        exit 1
    fi
fi
install -d "${prefix}/bin" "${prefix}/share/typed-neuron"
install -m 755 "${bundle_dir}/bin/neuron" "${prefix}/bin/neuron"
for name in README.md SWARM_NODE.md manifest.json ceilings.example.json; do
    if [ -f "${bundle_dir}/${name}" ]; then
        install -m 644 "${bundle_dir}/${name}" "${prefix}/share/typed-neuron/${name}"
    fi
done

if [ "$init_node" -eq 1 ]; then
    "${prefix}/bin/neuron" node init "$node_dir" \
        --listen "$listen" \
        --write-prefix "$write_prefix" \
        --transport "$transport" >/dev/null

    install -d "${node_dir}/service"
    cat >"${node_dir}/service/typed-neuron.service" <<EOF
[Unit]
Description=Typed Neuron swarm node
After=network-online.target tailscaled.service

[Service]
Type=simple
ExecStart=${prefix}/bin/neuron node serve ${node_dir}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    cat >"${node_dir}/service/io.typed-neuron.node.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.typed-neuron.node</string>
  <key>ProgramArguments</key><array>
    <string>${prefix}/bin/neuron</string><string>node</string><string>serve</string><string>${node_dir}</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${node_dir}/node.log</string>
  <key>StandardErrorPath</key><string>${node_dir}/node.err</string>
</dict></plist>
EOF
fi

echo "Typed Neuron installed: ${prefix}/bin/neuron"
if [ "$init_node" -eq 1 ]; then
    echo "Node directory: ${node_dir}"
    echo "Node identity: $("${prefix}/bin/neuron" node id "$node_dir")"
    echo "Start: ${prefix}/bin/neuron node serve ${node_dir}"
fi
