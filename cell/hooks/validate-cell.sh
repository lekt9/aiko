#!/bin/bash
# PostToolUse hook — if a *.cell.yaml was written, validate it
TOOL_INPUT="$1"
FILE=$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path','') or d.get('file_path',''))" 2>/dev/null)
if [[ "$FILE" == *".cell.yaml" ]]; then
  ROOT=$(echo "$FILE" | sed 's|cell/.*||;s|/$||')
  CELL_PATH=$(echo "$FILE" | python3 -c "import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())" "$FILE" 2>/dev/null || echo "$FILE")
  echo "[cell] validating $CELL_PATH ..." >&2
  python3 "$(dirname "$0")/../run.py" build "$CELL_PATH" 2>&1 | head -20 >&2 || true
fi
exit 0
