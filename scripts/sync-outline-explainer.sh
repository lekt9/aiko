#!/usr/bin/env bash
# Sync the contract-shape explainer to the Outline doc declared in
# references/outline-explainer.target.json.
#
# Reads:
#   ~/.claude/skills/contract/references/contract-shape-explainer.md  (body)
#   ~/.claude/skills/contract/references/outline-explainer.target.json (target)
#   ~/.config/outline/{token,baseurl}                                  (creds)
#
# Writes:
#   ~/.claude/skills/contract/references/.outline-explainer.hash       (last-synced hash)
#
# Behavior:
#   - Computes sha256 of the local body file.
#   - If hash matches the stored sidecar, exits 0 with "no-change".
#   - Otherwise PATCHes the Outline doc via documents.update, updates sidecar.
#   - With --force, always PATCHes regardless of hash.

set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BODY_FILE="$SKILL_ROOT/references/contract-shape-explainer.md"
TARGET_FILE="$SKILL_ROOT/references/outline-explainer.target.json"
HASH_FILE="$SKILL_ROOT/references/.outline-explainer.hash"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

[[ -f "$BODY_FILE" ]] || { echo "missing body: $BODY_FILE" >&2; exit 2; }
[[ -f "$TARGET_FILE" ]] || { echo "missing target: $TARGET_FILE" >&2; exit 2; }
[[ -f ~/.config/outline/token ]] || { echo "missing ~/.config/outline/token" >&2; exit 2; }
[[ -f ~/.config/outline/baseurl ]] || { echo "missing ~/.config/outline/baseurl" >&2; exit 2; }

TOKEN="$(cat ~/.config/outline/token)"
BASE="$(cat ~/.config/outline/baseurl)"
DOC_ID="$(jq -r '.doc_id' "$TARGET_FILE")"
TITLE="$(jq -r '.title' "$TARGET_FILE")"

CUR_HASH="$(shasum -a 256 "$BODY_FILE" | awk '{print $1}')"
PREV_HASH=""
[[ -f "$HASH_FILE" ]] && PREV_HASH="$(cat "$HASH_FILE")"

if [[ "$FORCE" -eq 0 && "$CUR_HASH" == "$PREV_HASH" ]]; then
  echo "{\"status\":\"no-change\",\"hash\":\"$CUR_HASH\",\"doc_id\":\"$DOC_ID\"}"
  exit 0
fi

PAYLOAD="$(jq -Rs --arg id "$DOC_ID" --arg t "$TITLE" \
  '{id:$id, title:$t, text:., append:false, publish:true}' \
  < "$BODY_FILE")"

RESP="$(curl -s -X POST "$BASE/api/documents.update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")"

OK="$(echo "$RESP" | jq -r '.ok // false')"
if [[ "$OK" != "true" ]]; then
  echo "outline update failed:" >&2
  echo "$RESP" | jq . >&2 || echo "$RESP" >&2
  exit 1
fi

echo "$CUR_HASH" > "$HASH_FILE"
URL_PATH="$(echo "$RESP" | jq -r '.data.url')"
echo "{\"status\":\"updated\",\"hash\":\"$CUR_HASH\",\"doc_id\":\"$DOC_ID\",\"url\":\"${BASE}${URL_PATH}\"}"
