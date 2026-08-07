#!/bin/bash
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.agents/skills/cell"
mkdir -p "$DEST/references"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
cp "$SRC/SPEC.md" "$DEST/references/SPEC.md"
cp "$SRC/docs/architecture.md" "$DEST/references/architecture.md"
cp "$SRC/docs/harness.md" "$DEST/references/harness.md"
cp "$SRC/docs/context.md" "$DEST/references/context.md"
cp "$SRC/docs/constraints.md" "$DEST/references/constraints.md"
cp "$SRC/docs/skills.md" "$DEST/references/skills.md"
cp "$SRC/primitives/README.md" "$DEST/references/primitives.md"
cp "$SRC/helpers.py" "$DEST/references/helpers.py"
echo "$SRC" > "$DEST/.installed_from"
git -C "$SRC/.." rev-parse --short HEAD 2>/dev/null > "$DEST/VERSION" || echo "cell/v0" > "$DEST/VERSION"
echo "installed cell skill -> $DEST"
ls -R "$DEST" | head -40
