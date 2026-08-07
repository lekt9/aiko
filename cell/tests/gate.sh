#!/bin/bash
set -euo pipefail
CELL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GATES_DIR="$CELL_DIR/tests/gates"
echo "cell gates — 10 witnesses (empty dir, public CLI, durable state)"
echo "================================================================"
fails=0
passes=0
total=0
for g in "$GATES_DIR"/*.sh; do
  name=$(basename "$g" .sh)
  total=$((total+1))
  printf "  [%2d] %-22s " "$total" "$name"
  if bash "$g" > /tmp/gate_"$name".log 2>&1; then
    echo "PASS"
    passes=$((passes+1))
  else
    echo "FAIL"
    cat /tmp/gate_"$name".log | sed 's/^/        /'
    fails=$((fails+1))
  fi
done
echo "------------------------------------------------"
echo "  $passes/$total pass, $fails fail"
if [ $fails -ne 0 ]; then
  echo "GATE FAIL — acceptance criterion not met"
  exit 1
fi
echo "GATE PASS — all 10 witnessed"
