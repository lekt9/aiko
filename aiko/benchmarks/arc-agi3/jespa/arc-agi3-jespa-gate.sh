#!/bin/sh
# Genuine reproduced ARC-AGI-3 JESPA win count: 1.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
HERE="$ROOT/benchmarks/arc-agi3/jespa"

bash "$ROOT/.agents/skills/arc-agi-3/scripts/arc_gate.sh" >/dev/null
bash "$ROOT/.agents/skills/arc-agi-3/scripts/native_contract_gate.sh" >/dev/null
python3 - "$HERE" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
probe=json.loads((root/"probe.json").read_text())
full=json.loads((root/"all-games.json").read_text())
replay=json.loads((root/"learned-replay.json").read_text())
bootstrap=json.loads((root/"bootstrap-result.json").read_text())
assert probe["jespa"]["levelsCompleted"] == probe["baseline"]["levelsCompleted"] == 8
for report in (full, replay):
    assert all(trial["errors"] == 0 for trial in report["trials"])
    assert all(trial["contractCalls"] > 0 for trial in report["trials"] if trial["variant"] == "jespa")
    assert all(trial["contractCalls"] == 0 for trial in report["trials"] if trial["variant"] == "baseline")
    assert report["jespa"] == report["baseline"]
    assert report["won"] is False
assert bootstrap["jespa"]["levelsCompleted"] == bootstrap["baseline"]["levelsCompleted"] == 14
assert bootstrap["jespa"]["completionActions"] == 354
assert bootstrap["baseline"]["completionActions"] == 358
assert bootstrap["won"] is True
rows=[json.loads(line) for line in (root/"benchmarks-ledger.jsonl").read_text().splitlines() if line]
counted=[row for row in rows if row.get("won") and row.get("counted", True)]
assert len(counted) == 1
assert all(row["reproduced"] for row in rows)
assert any(not row["won"] for row in rows)
print("ARC-AGI-3 JESPA evidence validated: honest negatives retained, 1 distinct reproduced win")
PY
JESPA_WIN_TARGET=1 bash "$HERE/jespa-benchmarks-gate.sh"
