# Constraints — guardrails that let agents move fast

> harness-engineering §03: more checks = more autonomy. Fail fast, fix fast.

## What is enforced (today)

- **Schema** — `membrane.inputs`/`outputs` validated against `schemas/*.v1.json` and `primitives/schemas/*.v1.json` before and after firing.
- **DAG** — cycles refused at `build` (Kahn's algorithm). A cycle never fires.
- **HTTP network caps** — `kind: http` checks the target host against `allow_net` before calling the HTTP helper.
- **Frontier serialization** — Kahn frontiers express topological readiness, not concurrency authority. All same-frontier leaves fire serially in lexical order. Only a mechanically confined and witnessed kind may ever parallelize; no Python leaf is classified as mechanically safe.
- **Fail-closed observations** — the first graph, port, leaf, HTTP host, output, or provenance failure observed by the runtime aborts the firing.
- **Determinism** — `policy.determinism: required` leaves double-fired in `check`; byte-mismatch fails.

## What is declaration/audit only

`allow_write`, `allow_spawn`, and Python/exec network declarations are not executor confinement. Python executes in-process and exec commands inherit host authority, so either can use filesystem, process, or network APIs outside its declaration. Caps communicate intended authority to admission and review; they must not be called a sandbox or mechanical proof of effect freedom. Until a portable executor boundary enforces them, Cell serializes every frontier rather than inferring safety from an empty declaration.

## Primitives as constraints

`primitives/session`·`auth`·`request` have frozen membranes — they constrain API wiring to one shape (session holds state). New auth flows (HMAC/OAuth) extend `request.py` (one function), not a new primitive.

## What to add per mistake (one rule per mistake)

When an agent makes a mistake, don't just fix it — add a check:

- `run.py` / `system/neurons/validate.py` for spec violations.
- `tests/` fixture + `run.py check` for behavioral regression.
- Entry in this file under "Rules" for agent-readable guidance.

## Rules

### Rule: reuse existing cells — fork is unwitnessed (2026-08-08)

Before authoring a new `*.cell.yaml` or `neurons/*.py`, run
`python3 cell/scripts/cell_reuse_radar.py --repo cell --name <newfile> --intent "<what it does>"`.
Exit 0 = STEER fired → the capability already lives in a cell/neuron; **wire it as an organelle**
(`cell: ./existing.cell.yaml`) or **fix it where it lives** (its tests/callers come free). Exit 3 = clear.
A new file that re-implements an existing capability is unwitnessed — no tests, no callers, diverges
from production wiring (same failure mode as `simulate_soonest_copy` vs `predictionMap`). Hook
`cell/hooks/pre_write_cell_steer.py` (PreToolUse Write, armed via `.claude/cell-steer.local` or
`CELL_STEER_ON=1`) blocks the fork mechanically — same shape as jesus-pattern `steer` and
`jesus-ralph` arm markers. See `cell/SKILL.md` §Reuse and `cell/hooks/hooks.json`.

## Git as safety net

- Commit after each logical unit: `type(scope): description`.
- Never force-push `main`.
- Small frequent commits — revert surgically.
