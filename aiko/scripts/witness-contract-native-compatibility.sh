#!/bin/sh
set -eu

SOURCE=${1:-}
if [ -z "$SOURCE" ] || [ ! -x "$SOURCE" ]; then
    echo "usage: witness-contract-native-compatibility.sh <contract-binary>" >&2
    exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "witness-contract-native-compatibility: jq is required" >&2
    exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/home" "$TMP/work"
cp "$SOURCE" "$TMP/contract"
chmod 755 "$TMP/contract"

HOME="$TMP/home" "$TMP/contract" sign-binary "$TMP/contract" >/dev/null
HOME="$TMP/home" "$TMP/contract" verify-self | grep -q 'verify-self: OK'

cd "$TMP/work"
begin=$(HOME="$TMP/home" "$TMP/contract" task begin \
    "native checked-task compatibility" --check "test -f proof.txt")
task_id=$(printf '%s\n' "$begin" | sed -n -E 's/^([0-9a-f]{8})$/\1/p' | head -1)
test -n "$task_id"
if HOME="$TMP/home" "$TMP/contract" task verify "$task_id" >/dev/null 2>&1; then
    echo "witness-contract-native-compatibility: an unsatisfied check passed" >&2
    exit 1
fi
touch proof.txt
HOME="$TMP/home" "$TMP/contract" task verify "$task_id" | grep -q satisfied

initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"native-compatibility-witness","version":"1"}}}'
initialized='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
declare='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"declare","arguments":{"plan":"native MCP compatibility","action":"true","fast":true}}}'
response=$(printf '%s\n%s\n%s\n' "$initialize" "$initialized" "$declare" | \
    HOME="$TMP/home" "$TMP/contract" mcp 2>/dev/null | tail -1)
printf '%s\n' "$response" | jq -e '
    .result.isError == false and
    .result.content[0].type == "text" and
    (.result.structuredContent.id | test("^[0-9a-f]{8}$")) and
    .result.structuredContent.status == "pending"
' >/dev/null

echo "contract native compatibility: PASS"
