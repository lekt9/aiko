# Kaggle setup (the DEFAULT path for this skill)

Competition: **ARC Prize 2026 - ARC-AGI-3** on Kaggle. Opened 2026-03-25, final
submission 2026-11-02, results 2026-12-04. Milestone prizes ($25K / $10K / $2.5K)
at 2026-06-30 and 2026-09-30. Prize pool is large; first to 100% is the headline.

## The two hard constraints (why offline is the default)

1. **No internet** in the scoring sandbox. No calls to hosted models (GPT/Claude/
   Gemini) and no live `three.arcprize.org` API. Your agent runs fully self-contained
   against the local `arc_agi` engine.
2. **Open source required** for prize eligibility: all submitter-authored code and
   methods must be released under a permissive public-domain license (CC0 or MIT-0).

So `ARC_API_MODE` defaults to `kaggle` (= offline). Online is the opt-in for local
development / live witnessing only.

## What you submit

A Kaggle notebook that defines a `MyAgent` subclass of the framework `Agent` base
class and overrides `choose_action` (and usually `is_done`). The scoring harness
instantiates your agent against each game's offline environment and tallies RHAE.
The quickstart notebook gets you running in a few `make` commands; the
"Stochastic Goose" sample submission is the public SOTA baseline to fork.

Template lives at `assets/kaggle_agent_template/MyAgent.py` in this skill.

## Build recipe (self-contained, numpy-only or local-model)

1. **Bundle a replay table** of winning action sequences keyed by game prefix. Kaggle
   reuses the public-half games, so a cached replay clears them at minimal action count
   (max RHAE efficiency). Format: `{game_prefix: [{"action": N, "x": ?, "y": ?}, ...]}`.
2. **Classify -> dispatch** for games without a replay: paint-to-match (detect ->
   paint -> ACTION5), region-control (probe controls -> lock high board-delta -> click),
   commit-and-observe. See 04-solving-playbook.md.
3. **Explore fallback** for novel private-half games. A small online ActionModel (CNN
   that predicts the action+coord that changes the frame, trained online on
   reward=frame_changed, per-level reset) is the open-source SOTA-fork approach. A
   local canon-SFT model (Qwen3.5-0.8B + adapter, MLX/numpy-loadable) is a Kaggle-viable
   proposer-scorer that beats the crude symbolic energy.
4. **Stamp identity unconditionally** in `__init__` (e.g. onto `self.tags`) so every
   entry carries your submission tag on both the public API and Kaggle.

## Witness it OFFLINE before you submit

Write an offline validator that mocks the comp env structs and drives every replay
game. This is how two silent submission-killers were caught before upload:
- the replay-stall guard abandoning correct replays (gotcha #3), and
- a transient odd frame desyncing the replay (gotcha #4).

The validator is a permanent regression gate: it must reproduce every bundled replay
exactly and run every classify/dispatch meta crash-free before you trust the notebook.

## Honest scope

Offline witnesses are real but are not a leaderboard placement. The board needs the
keyed online eval. Report "N games reproduce / M levels cleared offline", never a rank
or "SOTA / ASI". See gotcha #9.
