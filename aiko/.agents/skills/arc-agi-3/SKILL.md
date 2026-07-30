---
name: arc-agi-3
description: >-
  Solve ARC-AGI-3 (the interactive ARC Prize benchmark) and operate its API for a
  Kaggle submission. Teaches the ARC Prize methodology (RHAE scoring), a falsifiable
  solving playbook (archetype dispatch / "identify offline, win online"), and the
  hard-won gotchas (AWS-ALB sticky-session cookie, the score to levels_completed
  rename, replay-stall trap, transient odd frames). Ships a runnable client that
  toggles offline/online via the ARC_API_MODE env var and DEFAULTS to the Kaggle (offline,
  no-internet, no-key) setup. Use when asked to "solve ARC-AGI-3", "play ARC", "set up
  the ARC-AGI-3 API", "submit to the ARC Prize Kaggle comp", "bench on arc_agi_3", or
  to clear levels of a specific game. Routes sub-steps via lewis-strategy.
metadata:
  node_type: skill
  type: project
  triggers:
    - solve arc-agi-3
    - play arc-agi-3
    - arc agi 3 api
    - arc prize kaggle
    - bench on arc_agi_3
    - clear arc levels
---

## Output mode (load-bearing, never override)

This skill operates the ARC-AGI-3 environment through one runnable client,
`scripts/arc_client.py`, whose mode is set by **`ARC_API_MODE`** and **defaults to
`kaggle` (offline)**. This default is not a preference, it is a constraint: the Kaggle
scoring sandbox has NO internet, so the path that must work without a key or a network
is the default one. `ARC_API_MODE=online` is the opt-in for live development against
`https://three.arcprize.org` and requires `ARC_API_KEY`.

```
ARC_API_MODE=kaggle   (DEFAULT)  offline local arc_agi engine, no key, no internet
ARC_API_MODE=offline             alias for kaggle
ARC_API_MODE=online              live HTTP API (needs ARC_API_KEY)
```

The completion proof is `scripts/arc_gate.sh` exiting 0, never a prose claim. Wins on
the offline engine are real but are NOT a leaderboard placement (see gotcha #9): report
honest scope.

In this Aiko repository, `scripts/run_offline.py` is the native executable surface over
the same `ArcSkill` organs ported from aiko-engine3. `scripts/port_gate.sh` proves skill
discovery structure, offline engine loading, legal action mapping, and a real environment
step. `ARC_AGI3_REPO` and `ARC_AGI3_PYTHON` override local engine discovery.
The default solver is game-agnostic: it uses perception, transition memory, novelty
search, outcome learning, and model proposals without game IDs, replay tables, or known
level rules. `ARC_LEGACY_HEURISTICS=1` exists only for historical reproduction and must
not be used for comparative evaluation.
The general solver loads Contract through `scripts/native_contract.py` and uses the
installed ABI v2+ FECH surfaces (`register_capabilities`, `recommend_plan`, and
`record_capability_observation`); newer additive ABI symbols are probed with
`hasattr` before use. `scripts/native_contract_gate.sh` fails unless the
real dylib registers actions, ranks a plan, and persists a satisfied observation.

## What this skill is

ARC-AGI-3 is the interactive ARC Prize benchmark: an agent is dropped into a novel
turn-based game with no instructions and must explore, infer the goal, and clear levels.
Frontier models score under ~1%; humans ~100%. This skill equips an agent to (1) read a
64x64 frame and act, (2) operate the API in either mode, and (3) package a Kaggle
submission. The domain knowledge is in `references/`; the runnable parts are in
`scripts/` and `assets/`.

## Workflow (numbered)

1. **Plan.** Read `references/01-methodology.md`. Scoring is RHAE: completion first,
   efficiency (squared, capped 1.15x) second; later levels weigh more. Pick targets
   completion-first.
2. **Pick the mode.** `python3 scripts/arc_client.py mode` prints the resolved mode.
   No env -> `offline` (Kaggle). Set `ARC_API_MODE=online` + `ARC_API_KEY` for live.
3. **Perceive -> reason -> act.** Online: `arc_client.py open <game>` then
   `arc_client.py act <N> [x y]` (ACTION6 click: x=col, y=row, 0..63). Offline/Kaggle:
   implement your agent against `arc_agi.Arcade` / the `Agent` base class
   (`assets/kaggle_agent_template/MyAgent.py`). See `references/02-api.md`.
4. **Classify the archetype.** From the first frame + `available_actions`, dispatch:
   paint-to-match, region-control, commit-and-observe, or explore. See
   `references/04-solving-playbook.md`. The wall is the proposer, not perception --
   the eye→predict→propose→verify architecture + the encoder lesson are in
   `references/07-jepa-architecture.md` (the organs' why; `scripts/select_sign.py` IS it live).
5. **Cache wins as replays.** A cleared level's action sequence replays for free at
   minimal action count (max RHAE). Kaggle reuses public-half games.
6. **Witness offline before you trust it.** Run `scripts/arc_gate.sh` (and your own
   replay validator) so gotchas #3/#4 cannot silently regress.
7. **Route the order with lewis-strategy** when the task has many sub-steps. See
   `references/06-lewis-strategy-routing.md`.
8. **Ship + report honest scope.** Kaggle notebook is CC0/MIT-0, no internet. Report
   "N levels cleared / M replays reproduce", never "ranked / SOTA / ASI".

## Hard rules (gates, falsifiable via scripts/arc_gate.sh)

1. `ARC_API_MODE` unset -> resolves to `offline` (Kaggle). The default is the no-internet
   path. (gate check 2)
2. The online path persists cookies across the whole open->reset->act->close flow. A
   stateless client gets spurious "game not found" on RESET behind the AWS-ALB sticky
   session. (gate check 4; gotcha #1)
3. Read `levels_completed` (not `score`) for progress; many games never expose `score`.
   Never bail a winning replay on missing reward. (gotchas #2, #3)
4. The frame renderer tolerates a transient non-64x64 frame without resetting. (gate
   check 6; gotcha #4)
5. Kaggle submissions are self-contained (no network, no hosted models) and open-source
   (CC0/MIT-0). (references/05-kaggle.md)
6. No em dashes anywhere (project ban). (gate check 11)
7. Honest scope: offline wins are not a leaderboard placement. (gotcha #9)

## What this skill does NOT do

- Train or bundle a model. It is a playbook + client, not a solver weight file.
- Run a live Kaggle submission for you, or claim a leaderboard rank / SOTA / ASI.
- Replace `arc-solve`. That skill drives the live API through the aiko engine
  (`aiko arc`); this skill is the broader, self-contained, Kaggle-default ARC-AGI-3
  skill and points at `arc-solve` for the in-engine live path.
- Invent a method. It cites and operationalizes the ARC Prize methodology.

## Scripts

- `scripts/arc_client.py` - the toggleable client. `mode | games | open | reset | act |
  close`. `--mode X` overrides `ARC_API_MODE` for one call.
- `scripts/arc_gate.sh` - the adversarial witness. Exit 0 == every load-bearing claim
  (default mode, online cookie jar, no-key offline, renderer tolerance, references
  coverage, RHAE formula present, gotchas named, no em dashes, template present) holds.
- `scripts/validate_skill_structure.sh` - banger-skill-builder anatomy check.
- `scripts/witness_kernel_mapping.py` - the kernel /contract-mapping witness. Exercises the
  kernel's own `_mk` against `arcengine`; exit 0 == `(a,x,y) -> GameAction` maps correctly
  (id->ACTIONn, ACTION6 x=col/y=row, clamp 0..63, only-ACTION6-carries-coords). Folded into
  `kaggle_seal/gate_aiko_seal.sh` as gate 6, so every seal verifies the mapping before signing.

## References (progressive disclosure, one level deep)

| File | Covers |
|---|---|
| 01-methodology.md | RHAE scoring formula, completion vs efficiency, vs ARC-1/2 |
| 02-api.md | online HTTP API + offline arc_agi engine + Agents SDK contract |
| 03-gotchas.md | sticky session, field rename, replay-stall, odd frames, kaggle rules |
| 04-solving-playbook.md | archetype dispatch, known archetypes, explore loop, TTT |
| 05-kaggle.md | the default path: no-internet, open-source, submit, witness |
| 06-lewis-strategy-routing.md | order the sub-steps along the Genesis spine |
| 07-jepa-architecture.md | the converged design: eye→predict→propose→verify (the organs' why) + the encoder lesson + the honest boundary (the wall is the proposer) |
| 08-kernel-action-mapping.md | the canonical (a,x,y)->GameAction map the kernel marshals against (id space, ACTION6 x=col/y=row, frame fields, harness contract); gated by `witness_kernel_mapping.py` (seal gate 6) |
| upstream/lewis-strategy/ | bundled router (self-contained) |

## Inheritance

- Live in-engine path: `/arc-solve` (drives `aiko arc`).
- Sub-step routing: `/lewis-strategy` (bundled in references/upstream/).
- Built via the `/banger-skill-builder` canon (lean SKILL.md + gates + references +
  assets, load-bearing output mode, adversarial gate as a script).
