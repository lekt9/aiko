# skill/ — harness-engineering bundled inside cell

This directory ships the **harness-engineering** skill verbatim inside `cell` so the whole harness is self-contained in one checkout.

- `harness-engineering/SKILL.md` + `references/01–09` — upstream harness-engineering (AGENTS.md, context, constraints, loops, etc.)
- `harness-engineering/references/10-cell-fractal-harness.md` — the cell addition (what/when/how for `Cell = membrane + (run|organelles+wiring)`)
- `../SKILL.md` + `../SPEC.md` — the cell standard itself

Two entry points:

```sh
/skill:harness-engineering   # AGENTS/docs/loops/... + now also cell via 10-cell
/skill:cell                  # the fractal harness directly (via ~/.agents/skills/cell, install with ../install-skill.sh)
```

The `10-cell` reference inside `harness-engineering` points at `../../SPEC.md` etc via relative paths so `cell` remains the SSOT.
