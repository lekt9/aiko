#!/usr/bin/env bash
# Falsifier: Aiko must not invert Cell / Smithers / Worker / Contract.
# Removing the skill refusals or adding POST /api/smithers/run as an
# implementation makes this gate red.
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL layer-lock: $*" >&2; exit 1; }

FLOW="aiko/.agents/skills/aiko-flow/SKILL.md"
DROP=".agents/skills/aiko-drop-in/SKILL.md"
[ -f "$FLOW" ] || fail "missing $FLOW"
[ -f "$DROP" ] || fail "missing $DROP"

# Skills must name the inversion so agents cannot "forget" it.
grep -q 'Layer lock' "$FLOW" || fail "aiko-flow SKILL lost the layer lock"
grep -q 'Smithers does not compute' "$FLOW" || grep -q 'Must not' "$FLOW" || fail "aiko-flow SKILL lost the Smithers refusal"
grep -q 'POST /api/smithers/run' "$FLOW" || fail "aiko-flow SKILL no longer forbids /api/smithers/run"
grep -q 'aiko-flow-local' "$FLOW" || fail "aiko-flow SKILL no longer forbids aiko-flow-local"
grep -q 'do not fork' "$DROP" || fail "drop-in SKILL lost hoysan-draft fork refusal"
grep -q 'POST /api/smithers/run' "$DROP" || fail "drop-in SKILL no longer forbids /api/smithers/run"

# Implementations of the inversion — not mentions in the lock itself.
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
skip_parts = {
    "node_modules", "zig-out", "target", ".git", ".zig-cache",
    "dist", "coverage",
}
# The lock files may *name* the forbidden strings.
allow_suffix = {
    "tests/layer-lock-gate.sh",
    "aiko/.agents/skills/aiko-flow/SKILL.md",
    ".agents/skills/aiko-drop-in/SKILL.md",
    "CLAUDE.md",
    "docs/SOURCE-OF-TRUTH.md",
}
impl = (
    'app.post("/api/smithers/run"',
    "app.post('/api/smithers/run'",
    'engine: "aiko-flow-local"',
    "engine: 'aiko-flow-local'",
    "Smithers stub",
)
hits = []
roots = [
    root / "aiko" / ".agents",
    root / ".agents",
    root / "cell",
    root / "neuron",
    root / "docs",
    root / "src",
    root / "tests",
    root / "aiko-flow" / "packages",
    root / "aiko-flow" / "skills",
    root / "aiko-flow" / ".agents",
]
for base in roots:
    if not base.exists():
        continue
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        if any(p in skip_parts for p in path.parts):
            continue
        rel = path.relative_to(root).as_posix()
        if rel in allow_suffix:
            continue
        if path.suffix not in {".ts", ".tsx", ".js", ".mjs", ".md", ".zig", ".py"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for marker in impl:
            if marker in text:
                hits.append(f"{rel}: {marker}")
if hits:
    raise SystemExit("inverted layers:\n  " + "\n  ".join(hits))
PY

echo "PASS layer-lock-gate"
