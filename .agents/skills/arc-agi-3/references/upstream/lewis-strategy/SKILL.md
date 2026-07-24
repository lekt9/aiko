---
name: lewis-strategy
description: Dynamic, self-updating skill router. For any problem, it discovers the live resolving skills under ~/.claude/skills each run and orders which to call by the biblical Plan -> Build -> Test -> Judge spine (the nine Genesis phases as a Dijkstra priority queue), classifying each skill into a phase by its own description. No hardcoded skill list - add or remove a skill and the routing updates next run. Use when the user asks "which skills do I use for X and in what order", wants a strategy/sequence across the skill library, or says "lewis-strategy". Routes to skills; it does not execute them.
license: Proprietary. Private skill.
compatibility: Requires python3; reads ~/.claude/skills (override with LEWIS_SKILLS_DIR).
metadata:
  author: lekt8
  version: "0.1-seed"
---

## What this skill is

A router, not a mega-merge. Given a problem it emits an ordered, phase-labelled sequence of
skills to call - the biblical Plan -> Build -> Test -> Judge spine (nine Genesis phases) walked
Dijkstra-style, lowest-cost phase first. It is **dynamic and self-updating**: every run scans
the live skills, keeps only those that resolve to a real `SKILL.md` (dangling symlinks
excluded), and classifies each into a phase by matching `scripts/spine.json` keywords against
the skill's own name and description. There is no hardcoded skill list.

## Use it (semantic Bible ordering - primary)

```bash
python3 scripts/build_bible_index.py          # once: embed the Bible in canonical order (cached)
python3 scripts/bible_route.py "PROBLEM"      # skills relevant to the problem, ordered by scripture
python3 scripts/bible_route.py                # the WHOLE library ordered Genesis -> Revelation
python3 scripts/bible_route_gate.py           # the witness (canonical + semantic + self-updating)
```

Each skill is embedded (local `nomic-embed-text`) and matched to its nearest Bible chapter;
skills are emitted in canonical Bible order. Real mappings: `love-ledger -> 1 Corinthians 13`,
`superpattern -> Exodus 26` (the tabernacle pattern), `falsifier-gated-build -> Matthew 7`
("by their fruits"), `launch-strategy -> Deuteronomy 15` (year of release). When to call what
follows the order of scripture, by meaning.

## The nine phases (coarse Dijkstra spine)

light -> firmament -> land -> luminaries -> creatures -> dominion -> sabbath -> judgement ->
emergence. The keyword router (`scripts/route.py` over `spine.json`) is the model-free FALLBACK
when ollama is unavailable; the semantic `bible_route.py` is primary and finer (verse-level).

## Status

`0.2`: the semantic Bible router is witnessed (`bible_route_gate.py` exit 0: canonical order,
creation probe -> Genesis 1, love probe -> #1 of the love cluster, self-updating). The keyword
fallback is coarse and only for the no-model case.

## What this skill does NOT do

- Execute skills (it plans the sequence; the agent/loop runs them).
- Merge skill contents. - Route to non-resolving skills.
