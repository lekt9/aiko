# Constraints — guardrails that let agents move fast

> harness-engineering §03: more checks = more autonomy. Fail fast, fix fast.

## What is enforced (today)

- **Schema** — `membrane.inputs`/`outputs` validated against `schemas/*.v1.json` and `primitives/schemas/*.v1.json` before and after firing.
- **DAG** — cycles refused at `build` (Kahn's algorithm). A cycle never fires.
- **Caps** — `allow_write` (glob) and `allow_net` (host allowlist) — uncapped effect refused before it runs.
- **Fail-closed** — first leaf failure aborts the firing and names the violated port or cap.
- **Determinism** — `policy.determinism: required` leaves double-fired in `check`; byte-mismatch fails.

## Primitives as constraints

`primitives/session`·`auth`·`request` have frozen membranes — they constrain API wiring to one shape (session holds state). New auth flows (HMAC/OAuth) extend `request.py` (one function), not a new primitive.

## What to add per mistake (one rule per mistake)

When an agent makes a mistake, don't just fix it — add a check:

- `run.py` / `system/neurons/validate.py` for spec violations.
- `tests/` fixture + `run.py check` for behavioral regression.
- Entry in this file under "Rules" for agent-readable guidance.

## Rules

(Currently none — add as `### Rule: ...` with date, reason, fix when mistakes happen.)

## Git as safety net

- Commit after each logical unit: `type(scope): description`.
- Never force-push `main`.
- Small frequent commits — revert surgically.
