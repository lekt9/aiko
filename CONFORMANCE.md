# Aiko vs. the architecture document — what actually holds

Every verdict below was produced by running the command beside it against the
system in this repository. `tests/conformance-gate.sh` re-runs all of them and
goes red if any stops reproducing, so this file cannot quietly drift from the
code it describes.

**What this report is not.** It is not a claim that Aiko implements the
document. Three of the document's proposals are *deliberately rejected* here,
and the rejections are the interesting part — each one would have broken a
property the system depends on. Those rows are marked `REJECTED`, not `ABSENT`.

**Coverage.** Twenty-six claims across §1.3, §2, §3, §4, §5, §6, §7 and §8, each run before it was written down. The
document has nineteen sections; §9-§19 (validator taxonomy, claim-state lattice,
feedback-explosion controls, Hermes/UI, benchmarking, security) are not covered
here and should not be read as passing.

---

## Verdicts

| | meaning |
|---|---|
| `PRESENT` | the system does this |
| `PARTIAL` | some of it holds; the row says which part |
| `ABSENT` | it does not exist — shown on two search axes |
| `REJECTED` | the system deliberately does the opposite, for a stated reason |

```conformance
# verdict	section	expect_exit	claim	command
PRESENT	§1.3	0	neuron builds with the contract layer absent	cd neuron && zig build
PRESENT	§1.3	0	neuron's own suite passes standalone with contract absent	cd neuron && zig build test
PRESENT	§2.2	0	stale projection plus selective re-derivation, end to end	bash neuron/tests/redrive-gate.sh
PRESENT	§2.2	0	redrive has a THIRD case (compensation) the document's model lacks	grep -q 'compensate' neuron/src/redrive.zig
REJECTED	§2.4	0	confidence is a bounded integer inside the firing identity, not a Float[0,1] — floats do not hash stably	grep -q 'confidence_milli' neuron/src/generated_wire.zig
ABSENT	§2.4	nonzero	a stored five-state cache_status — staleness is DERIVED, storing it would be a second source of truth	grep -rq 'cache_status' neuron/src
ABSENT	§2.4	nonzero	SemVer node versions — a content digest is the version and cannot drift from it	grep -rqi 'semver' neuron/src
PRESENT	§4	0	a package declaring no falsifiable acceptance is refused admission	bash neuron/tests/skill-doc-gate.sh
PRESENT	§5	0	Level 1 bounded nodes execute deterministically with no model call	bash neuron/tests/escalation-ladder-gate.sh
ABSENT	§5	nonzero	Level 3 temporary executive agent	grep -rqi 'executive_agent' neuron/src src
PRESENT	§6	0	self-building: discover a boundary, derive inert, test, admit by digest, attach, judge	bash neuron/tests/interface-morphogenesis-gate.sh
PRESENT	§6	0	missing-capability generation, bounded by a catalogue that never reads the gap	bash neuron/tests/authored-gap-gate.sh
PARTIAL	§6	0	human approval exists as a capability-grant flag and an attach-time concern, NOT as lifecycle step 9	grep -rq 'human_approval' neuron/src
ABSENT	§7	nonzero	shadow-run: a proposed version replayed in parallel on real inputs without side effects	grep -rqiE 'shadow[_-]?run' neuron/src src
ABSENT	§7	nonzero	the ImprovementSignal record	grep -rq 'ImprovementSignal' neuron/src src
PRESENT	§8	0	claim.register is a live MCP verb, not a design	grep -q 'aiko.claim.register' src/mcp.zig
PRESENT	§8	0	deadline passes unmet -> contradiction -> dependent fires, and an already-crossed dependent is compensated rather than re-fired	bash neuron/tests/claim-deadline-gate.sh
PARTIAL	§1.3	0	the standalone evidence proves independence from CONTRACT, not from AIKO — the shipped aiko binary IS neuron's	grep -q 'neuron.artifact("neuron")' build.zig
REJECTED	§1.3	0	"degrades gracefully" — the house doctrine is the opposite: prefer failing closed over degrading	grep -rqi 'failing closed' CLAUDE.md neuron/CLAUDE.md
PRESENT	§3.3	nonzero	no model endpoint exists anywhere in the running binary — stronger than "LLM at priority 4 only"	strings zig-out/bin/aiko | grep -qiE 'anthropic|openai|/v1/messages'
ABSENT	§3.3	nonzero	the named five-priority routing hierarchy	grep -rqiE 'priority ?[1-5]' neuron/src src
REJECTED	§3.3	0	"Priority 4: generate new code (LLM invoked)" — generation is a bounded catalogue of pre-written transforms, never a model	grep -q 'CATALOGUE' neuron/src/morphogenesis.zig
PARTIAL	§5	0	agent retirement exists as an OPERATOR verb; automatic disengagement once a routine is established does not	grep -q 'agent_ops.retire(' neuron/src/main.zig
ABSENT	§6	nonzero	step 2: decompose an objective into sub-capabilities	grep -rqi 'decompos' neuron/src
ABSENT	§6	nonzero	step 3: the EXACT_MATCH | CONFIGURABLE | COMPOSABLE | MISSING classification	grep -rq 'EXACT_MATCH\|CONFIGURABLE\|COMPOSABLE' neuron/src
REJECTED	§8	0	ISO-8601 `expected_by` deadlines — a wall clock inside a firing identity breaks idempotent replay, so the deadline is a commit ordinal	grep -q 'ordinal' src/mcp.zig
```

---

## What the tally means

**The reactive core is real, and stronger than the document.** §2.2's selective
invalidation runs. `redrive` classifies a stale row into three cases and the
third has no counterpart in the proposal: the document's `on_contradiction:
INVALIDATE_AND_PROPAGATE` would re-derive "notify 35 workers" and **re-message
the 31 who did not change**. Adopting §8 as written would undo a solved problem.

**No model is invoked anywhere — which is stronger than §3.3 claims.** The
document reserves the LLM for "Priority 4". There is no Priority 4: no model
endpoint exists in the running binary at any tier, and the named five-priority
hierarchy does not exist. The real ladder is three routes — reused, generated,
authored — and "generation" is a bounded catalogue of pre-written transforms,
never a model. §3.3's *conclusion* holds; its *mechanism* is not what runs.

**Five rejections, each load-bearing.** A `Float` confidence cannot sit inside a
deterministic firing identity, so the loop would never settle. A stored
`cache_status` is a second source of truth — this repository shipped that bug
once, when the observer and `redrive` classified the same row differently. A
SemVer is a promise where a digest is a fact. An ISO-8601 deadline puts a wall
clock inside the firing identity and breaks idempotent replay. And "degrades
gracefully" is the opposite of the house doctrine, which is to fail closed.

**§1.3's evidence proves less than the sentence claims, and this report said so
too before it was corrected.** neuron building and passing standalone proves
independence from **contract** — not from **Aiko** — because the shipped `aiko`
binary IS neuron under another name. The requirement may well be satisfied; this
evidence is not what settles it.

**§7 is the honest hole.** Self-improvement — collect, propose, replay against
history, shadow-run, promote or roll back — exists in no form, and neither does
the `ImprovementSignal` record. The search was written to preserve one
distinction: the system *does* replay firings to verify determinism, which is a
different mechanism from replaying a proposed version against historical cases.
Conflating them would have manufactured a pass.

**§5 is one-and-a-half of three levels.** Level 1 is solid and deterministic.
Level 3 does not exist; there is no executive tier. Retirement exists, but as an
operator-invoked `agent retire` verb, not the document's automatic disengagement
"once a routine is established". Level 2 is not in the verified rows above and
is not claimed here either way.

**§6 is a 7-step lifecycle, not an 11-step one.** Discovery, derivation,
testing, admission by digest, attachment and judgement all run. Absent: the
decompose step, and the EXACT_MATCH | CONFIGURABLE | COMPOSABLE | MISSING
classification. Human approval exists as a capability grant rather than the
document's "present what will be sent, to whom, when, under what rules" review.

---

## How to distrust this file

Run `bash tests/conformance-gate.sh`. It parses the block above, re-runs every
command, and fails if any verdict stops reproducing — naming the claim, the
expected exit and the actual one. A verdict here that no gate covers is a
verdict to distrust, including these.
