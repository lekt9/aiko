#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="${1:-${repo_dir}/dist}"
os_name=$(uname -s | tr '[:upper:]' '[:lower:]')
arch_name=$(uname -m)
case "$arch_name" in
    x86_64|amd64) arch_name="x86_64" ;;
    arm64|aarch64) arch_name="aarch64" ;;
esac
bundle_name="typed-neuron-${os_name}-${arch_name}"
bundle="${output_dir}/${bundle_name}"
archive="${output_dir}/${bundle_name}.tar.gz"

if [ -e "$bundle" ] || [ -e "$archive" ]; then
    echo "bundle target already exists: ${bundle_name}" >&2
    exit 1
fi

cd "$repo_dir"
zig build -Doptimize=ReleaseSafe
install -d "${bundle}/bin"
install -m 755 zig-out/bin/neuron "${bundle}/bin/neuron"
install -m 755 packaging/install.sh "${bundle}/install.sh"
install -m 644 README.md "${bundle}/README.md"
install -m 644 reference/SWARM_NODE.md "${bundle}/SWARM_NODE.md"
install -m 644 packaging/ceilings.example.json "${bundle}/ceilings.example.json"

if command -v sha256sum >/dev/null 2>&1; then
    binary_sha=$(sha256sum "${bundle}/bin/neuron" | awk '{print $1}')
else
    binary_sha=$(shasum -a 256 "${bundle}/bin/neuron" | awk '{print $1}')
fi
version=$("${bundle}/bin/neuron" --version | awk '{print $2}')
cat >"${bundle}/manifest.json" <<EOF
{"schema":"neuron.bundle/v1","name":"typed-neuron","version":"${version}","os":"${os_name}","arch":"${arch_name}","binary_sha256":"${binary_sha}","entrypoint":"bin/neuron node serve <node_dir>","wire":"neuron.wire/v1"}
EOF

tar -C "$output_dir" -czf "$archive" "$bundle_name"
echo "$archive"
