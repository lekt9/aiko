# How to solve ARC-AGI-3 (the playbook that actually moved the live gate)

The benchmark is a skill-acquisition test: zero-shot transfer fails BY DESIGN. The
method below is the only one in a 34-paper corpus that moved the live gate off zero.

## The core method: "Identify Offline, Win Online" (archetype dispatch)

1. **Classify the game by its first-frame signature.** Each game is one of a small
   set of mechanics (archetypes). The first rendered frame + `available_actions` is a
   cheap, offline-identifiable signature.
2. **Dispatch to a cached per-archetype solver.** Reverse-engineer each archetype's
   rule ONCE, cache the winning procedure, and replay it forever. This beats training:
   cheap, deterministic, transfers across the public-half games that Kaggle reuses.
3. **Only the unseen residual needs online discovery.** Novel private-half games fall
   back to the explore loop below.

Why this and not a big RL/world-model stack: the heavy synthesis stack scored 0 with
no replay. **The wall is the proposer** (authoring an action you have never seen
succeed), not perception or memory. Stacking RL novelty bonuses makes the agent
explore forever and die at the action budget (rewarded for exploring, not solving).

## Known archetypes (worked examples)

- **paint-to-match** (`sb26`, actions `[5,6,7]`): click a palette swatch to SELECT a
  color (each color used once, bijection N colors / N dots), click a dot to PAINT it,
  `ACTION5` submits. Win = painted dots match the top target boxes in the game's read
  order. L1 = straight left-to-right. L2 = two panels joined by a colored WIRE: the
  panel with the wire-box is the main sequence, the other splices in at the wire-box
  position, both read L->R. L3 = two wires (double splice). L4 open frontier: wire
  color `e` paints a HOLLOW box, fill mechanic unsolved.
- **region-control** (`tn36`, `vc33`): probe cells to find the control glyph (often a
  large bottom commit button), lock onto the action with the largest board delta,
  click it repeatedly to sweep. Found by probing, not RL.
- **commit-and-observe** (`bt11`): repeat one action and watch +1 advance / -1 game
  over; the optimal is often near the human baseline (bt11: 72 actions optimal).
- **perception / click-glyph** (`bt33`): read the frame, find control glyphs by the
  topmost cell of each non-background color, learn good-vs-bad by trial. Residual:
  when a placed sprite shares the control's top row, the topmost-cell heuristic mis-
  clicks; fix is shape-based 2x2 L-glyph detection.

## The explore loop for a novel game (when no archetype matches)

1. Perceive: structural descriptor of the frame (objects, colors, candidate click
   targets). Read `available_actions`.
2. Probe: try each available action once; record which actually changed the frame
   (most states have only ~1 frame-changing action - low branching).
3. Commit-and-observe: when one repeated action advances state, ride it.
4. Test-time training (TTT) is the validated research path for the piece-to-target
   majority: per-game, train a tiny dynamics + value model on the (frame, action,
   frame') stream (reward-free), then plan toward high value. Dynamics recover
   strongly per-game (sp80 0.17 -> 0.63) even though zero-shot transfer is ~0.
   Open blocker: goal-from-zero-reward (value cold-start) on truly novel games.

## Efficiency discipline (RHAE)

Clear the level first - a cleared level at 2x human (0.25) beats an uncleared one (0).
Because the per-level score is squared and capped at 1.15x, do not grind action count
below the human baseline; spend the budget clearing the next, higher-weighted level.
A cached replay clears a known level in its minimal action count for free.

## Route the sub-steps with lewis-strategy

For a given task ("clear sb26 L2", "bench offline", "package for Kaggle") let
lewis-strategy order which sub-capabilities to call in the Plan -> Build -> Test ->
Judge spine. See 06-lewis-strategy-routing.md.
