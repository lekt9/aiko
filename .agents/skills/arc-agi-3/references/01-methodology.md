# ARC-AGI-3 methodology (source: docs.arcprize.org/methodology, June 2026)

## What ARC-AGI-3 measures

ARC-AGI-3 is an **interactive** reasoning benchmark. Unlike ARC-AGI-1/2 (static
input-grid to output-grid puzzles solved in one shot), ARC-AGI-3 drops an agent
into a novel turn-based game with **no natural-language instructions**. The agent
must explore the environment, infer the goal on the fly, build an adaptable world
model, and learn continuously. It measures intelligence **across time**, not a
single final answer.

- ARC-AGI-1: static, broad-program induction. Frontier systems do well.
- ARC-AGI-2: static, harder compositional/contextual reasoning.
- ARC-AGI-3: interactive games. Frontier models score under ~1% (Gemini 3.1
  ~0.37%); the best public agent (Stochastic Goose) ~12.58% on 2 games with
  ~255k actions; humans ~100%. The gap is enormous and the point.

## Scoring: Relative Human Action Efficiency (RHAE)

Two dimensions: **completion** (levels finished) and **efficiency** (actions vs a
human). An "action" is a discrete interaction that affects game state. Internal
reasoning, tool calls, and thinking tokens do NOT count as actions.

**Per-level score:**

    level_score = (human_baseline_actions / ai_actions) ^ 2     capped at 1.15

- Matching the human baseline -> 1.0.
- Taking twice as many actions -> 0.25 (it is squared, so inefficiency is punished).
- Beating the human is capped at 1.15x (you cannot farm score by being slightly
  faster on an easy level).

**Game score:** weighted average of per-level scores, weighted by the 1-indexed
level number (level 3 counts 3x level 1). Later, harder levels dominate. A game
where you clear 4 of 5 levels is capped proportionally (~66.7% max for that game).

**Final score:** the average of all game scores, 0..100%.

**Human baseline:** derived from first-time players, using the upper-median human
(by fewest actions) per level, so a single speed-runner does not set the bar.

## What this implies for strategy

1. Completion first, efficiency second. A cleared level at 2x human (0.25) beats an
   uncleared level (0.0), and the level-number weighting means clearing a later
   level is worth far more than shaving actions off level 1.
2. Efficiency is squared and capped: do not over-optimize action count below the
   human baseline; spend the saved effort clearing MORE levels.
3. No instructions: the agent must discover the rule by acting. The benchmark
   rewards a discover-then-exploit loop, not a pretrained answer.
4. The real wall is the **proposer** (authoring an action the agent has never seen
   work), not perception or memory. See 04-solving-playbook.md.
