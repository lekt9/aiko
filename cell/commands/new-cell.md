---
description: cell:new — scaffold a new fractal harness (new cell)
argument-hint: "<name> [--kind prompt|pipeline|video|api]"
---

Scaffold a new `*.cell.yaml` using the skill's template and validate it.

1. Read `cell/SKILL.md` and `cell/SPEC.md §2` for the normative shape.
2. Ask for missing `membrane` ports if not implied by the prompt.
3. Write the file (leaf `exec`/`python`/`http` or composite `organelles+wiring`).
4. Run `python cell/run.py build <new file>` — fail-closed, first port/cap violation is the signal.

Primitives to compose: `cell/primitives/session`, `auth`, `request`, `cas`, `author` (+ `fal-generate`/`fal-status` for video). Patterns as copy-paste starters: `cell/patterns/<prompt|context|loop|graph|api-reveng|video>/`.
