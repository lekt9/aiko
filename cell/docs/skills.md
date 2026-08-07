# Skills — distilled cells

> Borrowed from Browser Use *Web Agents That Actually Learn*: one agent pays exploration, a second distills the skill, everyone reuses it. Skills are a social network — voting, not authority.

- A skill is a `_skill.cell.yaml` — same shape as any Cell, pinned wiring.
- Shared `skills/` amortizes exploration: first run slow, rest reuse.
- Pipeline: trajectory -> skill cell -> PII gate -> voting (score < -3 retired) -> near-duplicate merge -> HTTP-level skill (skip UI, fire API via `primitives/request`).
- Skills are versioned Cells, validated by `system/builder.cell.yaml`, not prose.

See `skills/README.md` for current skills. See `helpers.py` for the self-heal loop (missing helper -> grep, add one function, rerun).
