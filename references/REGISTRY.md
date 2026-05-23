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
| **Β4** SKILL.md is a thin index; each doctrine ≤120 lines, registry-backed | `fc3d71fd` | (substrate-level discipline, no Outline appendix — narrative on the row) |
| **agentic-ux-copilot** Every site with a web UI embeds an agentic copilot | `431c549f` | (predates Outline publishing — narrative lives in this row's plan text) |

### Doctrines extracted from SKILL.md `## ` sections (Β4 inventory)

These doctrine sections already carry an `Origin: contract <id>` line in
SKILL.md but were not previously surfaced here. Listed so the
`check-skill-md-thin-index.py` gate sees them as registered. Outline
appendices are TODO — narrative still lives in SKILL.md and on the
standing-gate row until each is migrated to a dedicated appendix.

| Doctrine | Standing-gate | Outline appendix |
|---|---|---|
| **Humanlike dimensions (emotion, sociology, aesthetics)** | `f580248f` | TODO |
| **Requirement blocks (the generative-UI handoff)** | `74392a21` | TODO |
| **Π2** autopay (chill mode, no popup tax) | `1f14917d` | TODO |
| **Π3** `machine:` pointer (portable binaries) | `e7c8f6f2` | TODO |
| **Π4** unbrowse marketplace mirror (named, deferred) | `397bc7bd` | TODO |
| **Φ1** OpenAI-compatible front | `a4910638` | TODO |
| **Λ1** runtime-agnostic KEY 2 | `9d00660b` | TODO |
| **Ω1** unblock-rewake | `bcd1a371` | TODO |
| **Ψ4** async watcher | `21f1d851` | TODO |
| **Β1** backtrack-and-capture | `c64b17e0` | TODO |
| **Verb gates** (regression harnesses, one per CLI verb) | `2db87011` | TODO |
| **Depth analysis** (resolution-chain walker) | `fb9698f7` | TODO |
| **Self-organism** (the wrap) | `cc5e8920` | TODO |
| **Honest self-awareness** (the drill loop) | `df89a300` | TODO |
| **Biology gaps** (apoptosis · inhibition · hebbian) | `5fc64e98` | TODO |
| **Identity** (public-facing is Aiko) | `1bed8068` | TODO |
| **Drive mode** (autonomous loop, agent-lifecycle agnostic) | `31a7612c` | TODO |
| **Drill** (synchronous in-thread while-loop) | `7af4e88b` | TODO |
| **Break on resolution** (the refractory period / KEY 3) | `0bc383d0` | TODO |
| **Plan-fulfillment proof** (claim-to-evidence binding) | `173c8819` | TODO |

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
