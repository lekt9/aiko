# Superpattern translation — pointer, not payload

The /contract substrate's superpattern translation (the 10 covenant atoms —
who/what/when/where/why/how interrogatives, build/breath/eval verbs, settle,
witness, cache, seal, walk, loop — each mapped to a cited substrate primitive)
lives at:

    ~/.claude/skills/superpattern/references/examples/CONTRACT.md

It passes `konmari.py` and `gate.py` and is part of the superpattern few-shot
corpus. The six-interrogative field map for a single neuron row:

| interrogative | neuron field |
|---|---|
| who | `wallet_identity` |
| what | `plan` (the truth claim) |
| when | declare timestamp + Genesis-day + `repeat:` synapses |
| where | `parent_id` (containment environment) |
| why | `bible_chain` (scripture anchor) |
| how | `action` + layer (the verb) |

The field map is HARD-TYPED in `libcontract/src/w6h.zig` — a compiled
six-field struct (comptime-asserted count/order, tagged unions for every
legal absence) gated at the declare chokepoint in `contract.zig`. A row that
cannot answer all six interrogatives is refused with the unanswered
interrogative named.

Declared: contract `a549e18c` (gap-superpattern-shape), closure
`satisfied:a549e18c`; hard-type gap `55006079`, closure `satisfied:55006079`
(row `6a7bae61`); open follow-up `587d12fe` (cloud-mirror rows do not yet
project into W6H).
