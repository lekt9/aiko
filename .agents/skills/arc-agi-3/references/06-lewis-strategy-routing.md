# Routing ARC-AGI-3 sub-tasks with lewis-strategy

`lewis-strategy` is a dynamic skill router: given a problem it emits an ordered,
phase-labelled sequence of which skills to call, walked along the biblical
Plan -> Build -> Test -> Judge spine (the nine Genesis phases: light, firmament,
land, luminaries, creatures, dominion, sabbath, judgement, emergence) as a
lowest-cost-first priority queue. It routes; it does not execute.

A bundled copy of its SKILL.md is in `references/upstream/lewis-strategy/` so this
skill is self-contained. The live router (with its semantic Bible index) lives at
`~/.claude/skills/lewis-strategy/`.

## How to use it for an ARC task

```bash
python3 ~/.claude/skills/lewis-strategy/scripts/bible_route.py "solve ARC-AGI-3 sb26 L2 and package for Kaggle"
```

It returns the relevant skills in scripture order. For ARC work the spine maps onto
this skill's own phases:

| Genesis phase | ARC-AGI-3 sub-step | Where |
|---|---|---|
| light (plan) | read the methodology + RHAE scoring; pick completion-first targets | 01-methodology.md |
| firmament (boundary) | choose mode: kaggle/offline default vs online | scripts/arc_client.py |
| land (skeleton) | classify the game archetype from the first frame | 04-solving-playbook.md |
| luminaries (signals) | wire the gate / offline witness so wins are falsifiable | scripts/arc_gate.sh |
| creatures (fill) | implement choose_action: replay -> classify -> explore | assets/kaggle_agent_template |
| dominion (integrate) | run end-to-end; clear a level; cache the winning replay | 05-kaggle.md |
| sabbath (verdict) | score RHAE; PROMOTE/HOLD against the human baseline | 01-methodology.md |
| judgement (audit) | offline-witness every replay; check gotchas #3/#4 didn't regress | 03-gotchas.md |
| emergence (ship) | package the notebook (CC0/MIT-0), submit, report honest scope | 05-kaggle.md |

## Why route at all

ARC work has many sub-capabilities (perceive, classify, replay, explore, witness,
package). lewis-strategy keeps you from doing them out of order, e.g. building a
solver before a falsifiable witness exists (luminaries before creatures), or
claiming a result before the judgement audit. Plan before light; witness before
fill; audit before ship.
