# /contract doctrine registry

> **The substrate is mechanical; this file is a map, not a manuscript.**
> Each doctrine lives in three load-bearing places: a **standing-gate
> contract** (the plan + audit trail in the global ledger, pointer-bindable
> via `--action contract:<id>`), an **Outline appendix** (the human-readable
> narrative), and **SKILL.md** (the substrate's self-documenting front
> door where the doctrine is summarized in-band). This file replaces 1638
> lines of `references/*.md` prose that duplicated those three surfaces
> with no binding gate keeping them in sync. Per Β3 (2026-05-24).

## Doctrine → standing-gate id → Outline anchor

Reference a doctrine from any project: `contract declare "..." --action contract:<id>`.
Read the narrative: open the Outline router doc and jump to the appendix.

| Doctrine | Standing-gate | Outline appendix |
|---|---|---|
| **Π5** Facilitator binding (4-way payment routing) | `5e1c4b14` | Pi5 facilitator-binding |
| **Π6** Unbrowse router + auth annotation | `a88ee00e` | Pi6 unbrowse-router |
| **Π7** Invisible x402 (Stripe front, agent-browser back) | `fdfacf59` | Pi7 invisible-x402 |
| **locality-split** Dev-local /contract vs user-remote unbrowse CLI | `ed4a2700` | locality-split |
| **Ξ1** Fractal layer wrapping (programmatic L0..L4 enforcement) | `c9de1eb9` | Xi1 fractal-layer-wrapping |
| **Λ2** Periodic distillate retraining on RunPod | `1c090ac9` | Lambda2 distillate-retraining |
| **Β2** Drill-binding (loop until the statement is real) | `10572c91` | Beta2 drill-binding |
| **agentic-ux-copilot** Every site with a web UI embeds an agentic copilot | `431c549f` | (predates Outline publishing — narrative lives in this row's plan text) |

Router doc: `docs.getfoundry.app` →
*/contract IS the unbrowse router (Π5 facilitators, Π6 auth annotation, …)*

## Why this folder no longer holds prose

Three reasons (each shipped as its own doctrine the prose files used to
violate):

1. **Self-organism wrap.** SKILL.md § *Self-organism* binds every claim
   the substrate makes about itself to a runtime gate. A `.md` file in
   `references/` was a claim no gate watched — `self/no-contradictions`
   could not catch drift between the prose, the standing-gate's plan
   text, and the Outline doc.
2. **Audits doctrine.** SKILL.md § *Audits* requires every corpus rule
   to ship as `audits/<rule>/{verify.sh, fix.sh, scope.txt, README.md}`.
   The prose files were corpus content with no audit. `audits/references-purge/`
   closes that gap.
3. **Containment vs reference.** SKILL.md § *Containment vs reference*
   says the substrate composes by index, never by structural duplication.
   Two copies of the same doctrine (file + standing-gate) are the
   prose-equivalent of containment — fork-prone, ambiguous on conflict.
   One canonical row, multiple read surfaces, is the substrate's pattern.

## What's allowed in this folder

Per `audits/references-purge/verify.sh`:

- `REGISTRY.md` — this file (the only doctrine-mapping surface).
- `README.md` for any future binding-gate folder under references/ — but
  the binding gate must itself live as a standing-gate contract id in
  the table above, not as a doctrine essay.

A new `.md` doctrine file added without a matching standing-gate row in
this table trips the audit on next ledger commit (substrate pre-commit
on `~/.contracts/.git`). The folder cannot regrow back into the
prose-duplication anti-pattern.

Origin: contract `9d3f399f` (Β3 organ), 2026-05-24. Lewis: "references
that make the program aspirational should be purged and converted into
/contract mechanically."
