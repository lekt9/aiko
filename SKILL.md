---
name: contract
description: Fractal contract primitive. A contract is a declared truth claim with a mechanical check, an iteration loop, and a ledger. Every contract IS a funnel, a feedback loop, and a self-contained verify-ship unit. Cells compose into organs. Organs into organisms.
user-invocable: true
---

# /contract

Core job: declare a truth claim, iterate until genuinely satisfied, spawn children when the truth requires sub-work. A contract is the primitive; there is no separate scaffold above it.

## When to invoke

| Trigger | Action |
|---|---|
| "contract this" / "X must always hold" | `contract declare "<plan>" --action "<check>"` |
| "build and run this" | `contract build "<plan>" --action "<check>"` |
| "solve until done" | `contract solve "<plan>" --action "<check>"` |
| "this is a sub-problem of Y" | `contract spawn <parent-id> "<plan>" --action "<check>"` |
| "keep building / drill to completion / finish without asking" | `contract drive <organ-id>` |
| "what contracts exist" | `contract list` or `contract status [<id>]` |
| "is this a recurring pattern?" | `contract search` |
| "convert past patterns" / "don't lose this in the refactor" | `contract import <source>` |

On any invocation: read `ledgers/contracts.jsonl` — it is the only truth. The full verb list is discoverable via `contract self` (live introspection — count drifts as verbs are added); the table above is the load-bearing front door (Ψ2, working-memory cap).


## Architecture (L0-L2)

- **L0 core** — `scripts/lib/contract_core.py`: data model, the only code that touches `ledgers/contracts.jsonl`. `declare()`, `record_iteration()`, `mark_satisfied()`, `get_tree()`, `list_all()`, `children_satisfy()`.
- **L1 CLI** — `scripts/contract`: the verb surface (see `contract self` for the live enumeration; the front-door table at top lists the load-bearing subset). Every verb either writes one ledger row or emits a structured prompt; nothing else.
- **L2 detector** — `scripts/contract-habit-detect.py`: passive related-contract detector. Token overlap against all `plan` fields in the ledger. Surfaces candidates above threshold. Never declares. (Filename retained; the user-facing operation is `contract search` — the contract IS the habit.)

The unifying model: a contract with a mechanical `--action` is a **cell**. `--action agent-judges` is a **judgment**. `--action funnel` (or `children-satisfy`) is a **funnel** (AND-gate). `--action funnel-first` is a **funnel-first** (OR-gate). `--action quorum:<K>` is a **quorum** (the integrate-and-fire neuron — K of N children). `--action sequence` is a **sequence** (an ordered funnel). `--action loop-until:<cmd>` is a **loop** (re-run body each iterate). `--action harness:<path>` is a **harness** (delegates to `<path>/verify.sh`). `--action tool-guard:<glob>` is a **tool-guard** (a PreToolUse hook blocks the matching tool until the contract is satisfied). One data model, nine shapes, infinite fractal depth.

## Modifying the skill vs creating contracts (dev-level routing)

A `/contract` request is one of two kinds. Judge which in-thread; there is
no keyword rule (a regex on the request text would be a forbidden surface).

**Contract-use** (the common case): the request is a truth claim about your
domain. "X must always hold", "build and verify Y", "this should never
happen". Route it through the primitive: `contract declare / build / solve /
iterate`. The skill's own code is not touched.

**Skill-modification** (the dev case): the request is to change the
`/contract` skill's own machinery: fix a bug in the CLI, add a verb, remove
a fallback, change the ledger schema, edit a bundled script. The signal is
that the request names the skill's own surface (a verb, a script, the ledger
format, the CLI's behavior), not a domain fact.

Skill-modification is still done THROUGH the primitive, recursively: declare
a contract whose truth claim is about the skill's own files and whose
`--action` mechanically checks them. Worked example: the contract "the
/contract skill never swallows an error silently" carries `--action python3
scripts/check-no-silent-fallback.py`. You iterate it red, fix the scripts,
iterate it green, mark it satisfied; the contract then stays in the ledger
as a permanent regression guard.

The dev-level test, in one line: **if satisfying the request changes a file
under this skill's own directory, it is skill-modification, and the change
is itself a contract whose action checks this skill's code.** Otherwise it
is ordinary contract-use.

## Default contracts (universal — declare these in any context)

Eleven principles drawn from CLAUDE.md, CONTRACTS.md, and the fruits of the spirit / 10 commandments — mapped only where the translation is genuinely useful and non-redundant. `contract defaults` shows them; `contract search` surfaces existing matches before re-declaring.

**From engineering principles (CLAUDE.md + CONTRACTS.md):**

| # | Plan (abbreviated) | Shape | Source |
|---|---|---|---|
| 1 | "substrate enables, never prescribes — no forbidden surface in any script or agent" | judgment | CLAUDE.md meta-rule |
| 2 | "every commit introduces zero new failures — diff vs baseline is non-positive" | judgment | C-G (no-regression) |
| 3 | "pointer-not-payload — client holds only opaque pointers; all logic lives server-side" | judgment | CLAUDE.md architecture |
| 4 | "harness collects, agent judges — no script emits PROMOTE/PASS/FAIL on its own" | judgment | C-G01 |
| 5 | "verify the served surface, not the source — a build pass is never sufficient" | judgment | C-G06 |
| 6 | "fix root cause, never band-aid — no downstream fix_*/clean_*/patch_* compensator" | judgment | C-G08 |
| 7 | "no mutable .db or state file un-gitignored inside a git-tracked directory" | cell | C-O04 |
| 8 | "auth/deploy chain verified against the live running service; not build, not timestamp" | judgment | cross-harness pattern |

**From fruits of the spirit + commandments (mapped only where genuinely distinct):**

| # | Plan (abbreviated) | Shape | Source / Doctrine |
|---|---|---|---|
| 9  | "serve the genuine need, not just the literal request — technically-passing but intent-missing is fake-green" | judgment | Love (Galatians 5:22) |
| 10 | "one contract, one truth claim — if an action checks two unrelated things it belongs as two contracts" | judgment | No adultery (Commandment 7) |
| 11 | "every verification result traces to a real live source — no synthesized, proxied, or stubbed result; a proxy-green is a false witness" | judgment | No false witness (Commandment 9) |

**Rejected mappings (forces or overlaps):** Joy/Kindness/Goodness/Gentleness (too abstract or not a gate), Self-control/Patience/Faithfulness (already in two-key exit or C-G13), No other gods/No idols/Name in vain/Honor parents/No murder/No stealing/No coveting (all overlap existing defaults 1-8).

Project-specific rules (no `vercel.json`, no `h-screen`, no `#000/#fff`) do NOT belong here.


## How to actually use this (working loop)

**Self-drive is the default.** Every top-level `contract declare` / `solve` /
`build` auto-arms self-drive on the top-level contract (opt out with
`--no-drive`); a child (`--parent` set) never arms — the organ owns the drive.
Once armed, a `/contract` invocation converges the WHOLE tree in-thread without
a human prompt between iterations. Agent judging (KEY 2) is done in-thread and
is NOT a turn boundary — `iterate` → judge → `_mark` → next `iterate` is one
continuous turn. Never end a `/contract` turn with a satisfiable contract
pending. The only two reasons to yield: missing credential · irreversible action
not already authorized — and then you run `contract disarm` and name the blocker.
Ambiguous intent is agent-judges: act on the higher-confidence interpretation
when reversible; the ledger row is the rollback point.

Crystallised from real session work, not aspiration:

1. **Search before declaring.** `contract search --context "<plan>"` (or `contract build`) scores the plan against all existing contracts. Read the candidates; judge in-thread whether to reuse or iterate an existing one before creating new.
2. **Declare with a real check.** `contract declare "<plan>" --action "<shell cmd>"`. The action is the verify gate. A contract without a check is a wish.
3. **Iterate one wave at a time.** `contract iterate <id>` runs the action, appends one ledger row, prints the two-key exit prompt. Read the row; judge whether the machine result is genuine before marking satisfied.
4. **Spawn when sub-work emerges.** `contract spawn <parent> "<sub>" --action "<check>"`. The parent becomes an organ; its satisfaction = all children satisfied. The spawn verb emits a SPAWN REQUIRED prompt — the agent routes the child via a sub-agent or directly.
5. **Mark satisfied.** Call `contract _mark <id> satisfied` directly. No ceremony tag required — the `_mark` event IS the verdict. (Older sessions emitted `<promise>CONTRACT_SATISFIED:<id></promise>` first; that ritual is retired.)
6. **Ledger is memory.** Every failed wave is evidence. Never delete rows; the history drives related-contract surfacing and informs future declares.
7. **Drive the whole tree in one invocation.** When the user invokes `/contract`, converge the entire organ that invocation declares: iterate and mark every child and the organ itself before yielding. Never end a `/contract` invocation with a satisfiable contract left pending, and never hand the loop back to the user mid-tree. The user says `/contract` once; you drive it to a satisfied organ, or to a genuinely-blocked HOLD with the blocker named. For long autonomous runs, `contract drive <organ-id>` removes the between-iteration pause entirely.

## CLI

```bash
# Declare a cell (mechanical check)
contract declare "<plan>" --action "<shell cmd>" [--parent <id>]        # cell
contract declare "<plan>" --action "funnel" [--parent <id>]             # funnel (AND-gate)
contract declare "<plan>" --action "funnel-first" [--parent <id>]       # funnel-first (OR-gate)
contract declare "<plan>" --action "loop-until:<cmd>" [--parent <id>]   # loop
contract declare "<plan>" --action "harness:<path>" [--parent <id>]     # harness
contract declare "<plan>" --action "children-satisfy" [--parent <id>]   # funnel (legacy alias)

# Search similar + declare + first wave (full build cycle)
contract build "<plan>" [--action "<cmd>"]

# Declare + first wave in one call
contract solve "<plan>" --action "<cmd>"

# One iteration wave — two-key exit
contract iterate <id>

# Emit SPAWN REQUIRED for sub-agent routing
contract spawn <parent-id> "<plan>" [--action "<cmd>"]

# Tree view: contract + all descendants
contract status [<id>]

# All contracts
contract list

# Surface related existing contracts (never auto-declares; `habit` kept as back-compat alias)
contract search [--context "<text>"] [--scope project|global]

# Surface past patterns (principle stores, canon, old ledgers) as candidate contracts
contract import <source> [--archive] [--commands]

# Arm autonomous drive loop (Stop hook re-fires after each turn)
contract drive <organ-id>

# Disarm drive loop (use when genuinely stuck or complete)
contract disarm

# Crystallize a learning: memory file + Outline doc
# (also auto-fires on satisfy for any contract declared with --learning)
contract learn "<insight>" [--source <ref>]
```

## Drive mode (autonomous loop, agent-lifecycle agnostic)

`contract drive <organ-id>` arms the contract's own internal hook system to advance the
loop without human prompts and without depending on any specific agent's lifecycle.

**Architecture (self-contained):**

- `~/.contracts/hooks/drive-advance.sh` — internal hook fired by the contract CLI itself
  (after every `iterate` and `_mark`). Writes `~/.contracts/drive_next.txt`.
- `~/.contracts/drive_next.txt` — the portable state file. Agent-agnostic JSON:
  `{"state":"active","organ":"...","resume_cmd":"bash contract iterate <id>","msg":"..."}`
- Survives agent restarts, session ends, runtime switches. Any agent reads this file.

**How it works:**

1. `contract drive <organ-id>` — writes sentinel + seeds `drive_next.txt` synchronously
2. Agent iterates first pending child, judges KEY 2 in-thread
3. After iterate/mark, internal hook fires → updates `drive_next.txt`
4. When agent turn ends, the transport for the current runtime fires:
   - Claude Code: Stop hook reads `drive_next.txt` → `{"decision":"block","reason":"..."}`
   - Any agent: SessionStart hook (`contract-session-start.sh`) reads `drive_next.txt` on next session
   - Other runtimes: read `drive_next.txt` directly and inject `resume_cmd`
5. When all children satisfied → `drive_next.txt` writes `state:complete`, sentinel removed

**Wiring for other agents:** Read `~/.contracts/drive_next.txt` at session start; inject
the `msg` field as the first user message. That is the entire integration surface.

**When the agent MUST disarm and ask:**
- Missing credential or auth that can't be derived from the repo
- A destructive/irreversible action not already authorized

**Ambiguous intent is NOT a disarm condition.** When the agent self-judges that
two interpretations are both plausible AND both are reversible, pick the higher-
confidence path and act — the ledger row is the rollback point if the agent's
read was wrong. Only disarm when the cost of guessing wrong is genuinely
irreversible (data loss, deploy, external publication) or unrecoverable without
the user.

**Drive mode and the two-key exit:** KEY 2 is still agent-judged in-thread. Drive mode
removes the "wait for user" pause between iterations, not the judgment itself. The agent
can still judge HOLD when a result is fake-green, or disarm when genuinely blocked.

**State files:**
- `~/.contracts/.drive_active` — contains organ ID (sentinel)
- `~/.contracts/drive_next.txt` — current pending action JSON
- Both removed by `contract disarm`

## Crystallizing learnings (memory + Outline)

A contract is a unit of learning (`CONTRACTING_IS_LEARNING`). When a learning
crystallizes, the skill makes it durable on two surfaces beyond the ledger:

1. a **memory file** in the Claude Code auto-memory folder (survives in session recall)
2. an **Outline document** at `docs.getfoundry.app` (the team knowledge base)

This is a **hook-like structure native to /contract** — it rides the same
internal hook bus as `drive-advance` (`_fire_contract_hooks`, fired by the CLI
itself on every `iterate` and `mark`). Two entry points:

- **Automatic** — declare a contract with `--learning "<insight>"`. When that
  contract is marked satisfied, the `crystallize-learning` hook
  (`~/.contracts/hooks/crystallize-learning.py`) fires on the `mark` event and
  crystallizes it. The hook is self-guarded: a non-satisfied contract, a
  contract with no `learning`, or an already-crystallized one is a no-op.
- **On demand** — `contract learn "<insight>" [--source <ref>]` crystallizes an
  explicit insight immediately and appends a `learned` ledger row.

```bash
contract declare "<plan>" --action "<cmd>" --learning "<insight>"   # auto-crystallize on satisfy
contract learn "<insight>" [--source <ref>]                         # crystallize on demand
```

Every crystallization appends a `crystallized` ledger row — the idempotency
key, so a learning is crystallized at most once. Both surfaces are best-effort
and independent: the memory file is always written; the Outline push is
skipped cleanly when `~/.config/outline/` is absent or
`CONTRACT_CRYSTALLIZE_NO_OUTLINE=1` is set. The substrate emits the artifacts;
it never judges them — the agent reads the memory and the doc.


## Output mode (load-bearing)

Per invocation this skill produces one of:

- **One ledger row** appended to `ledgers/contracts.jsonl` with event type, id, plan, action, wave, exit code, and timestamp. One row per declare; one row per iterate; one row per satisfied mark.
- **A SPAWN REQUIRED prompt** (from `contract spawn`) — a structured block telling the agent to route the child contract via a sub-agent. No ledger write; the child's row is written when the sub-agent runs `contract declare`.
- **A BUILD REQUIRED prompt** (from `contract build`) — search results plus the first iterate output. The agent sees similar contracts and the first wave result in one shot.
- **A tree view** (from `contract status`) — the contract and all descendants, each annotated with shape and status.

Never: a silent ledger write with no agent prompt; a synthetic pass verdict; a wave that doesn't print the two-key exit block.

## The nine shapes (one data model)

Every contract is simultaneously a funnel, a loop, and a harness — fractally. A loop's body can be a funnel; a funnel's children can be loops; a harness wraps any shape. The recursion bottoms out at a cell or judgment.

| Shape | `action` field | Satisfied when |
|---|---|---|
| **cell** | shell command | action exits 0 AND agent judges genuine |
| **judgment** | `agent-judges` | agent confirms in-thread |
| **funnel** | `funnel` or `children-satisfy` | ALL children satisfied (AND-gate) |
| **funnel-first** | `funnel-first` | ANY child satisfied (OR-gate) |
| **loop** | `loop-until:<body-action>` | body exits 0 AND agent judges genuine; re-iterate to advance |
| **harness** | `harness:<path>` | `<path>/verify.sh` exits 0 AND agent judges genuine |
| **tool-guard** | `tool-guard:<glob>` | a standing guard — a PreToolUse hook blocks every tool matching the glob until the contract is satisfied (which lifts it) |
| **sequence** | `sequence` | an ordered funnel — satisfied when every child is satisfied; iterate names the next unsatisfied child in declared order as the current stage |
| **quorum** | `quorum:<K>` | the integrate-and-fire neuron — satisfied when at least K of N children are satisfied; funnel is K=N, funnel-first is K=1 |

Fractal: funnels contain loops, loops contain funnels, harnesses wrap any shape. Every contract is itself a funnel (narrows to truth) + loop (iterate until resolved) + harness (collects evidence). `children-satisfy` remains valid; `funnel` is the canonical name. `drive` mode removes the human pause between loop iterations but does not change the two-key exit.

### Shape IS the type system (no `--lifetime` flag will ever exist)

The nine shapes ARE the lifetime / role / decay model. There is no separate
typed-tag layer and there never will be. Concretely:

| If you would reach for… | …use this shape instead |
|---|---|
| `--lifetime one-shot` (the default) | a plain **cell** or **judgment**. Once `_mark satisfied`, it stays satisfied. |
| `--lifetime invariant` (auto-re-fire) | **`loop-until:<cmd>`**. The body re-runs every iterate; the loop completes when the body says so. The body IS the invariant. |
| `--halflife 7d` (decay/staleness) | re-iterate the cell, or **`verify <surface>`** if it's bound. Staleness = "iterate later"; that's already iterate. Time-based decay would smuggle a clock-judgment into the substrate. |
| `--precondition` vs `--postcondition` | iterate **before** for pre, **after** for post. Direction is the agent's call, not a typed field. |
| `--lifetime capability` | **`tool-guard:<glob>`** — the gate IS the capability. |
| `--lifetime composite` | **`funnel` / `funnel-first` / `sequence` / `quorum`** — the composition IS the lifetime. |

**Discovery is a fix, not a proposal.** When the agent discovers that a
flag/field/layer it is about to add is already provided by an existing
shape, the response is to ship the simplification in the same turn — not
to ask "want me to ship this?". The audit and the fix are one continuous
turn. Asking is a redundant turn that violates the work-style discipline.
Worked example: the "lifetime tag" thread surfaced 2026-05-22 and was
immediately fossilized — `bind_to + verify` was the only genuine new
primitive; the rest was already there. Contract `310f425f`.

The **`bind_to + verify` primitive** referenced above: `bind_to` is an
optional field every contract may carry at declare time — a file path,
URL, or other resource id that the contract attaches to. The
`contract verify <surface>` verb re-runs every contract bound to that
surface, asserting they're still satisfied against the current state.
This binds a contract to a concrete artifact rather than to a one-shot
check. See `binding/declare-bind-to` and `binding/verify-foreign` in
`skill-self-test.sh` for the runtime gates that prove `bind_to` and
`verify` are bound (contract `ae1340a6`).

## The two-key exit (load-bearing invariant)

Every `contract iterate` ends with:

```
KEY 1 (machine): <action result — PASS | FAIL | AGENT-JUDGES | ERROR>
KEY 2 (agent):   JUDGE — is this GENUINELY satisfied, or fake-green?

If genuine → run: contract _mark <id> satisfied
Otherwise  → fix the target, then: contract iterate <id>
```

No script claims satisfaction. The machine checks; the agent judges. Both keys required.

## Parallel fan-out (heuristic)

When a problem decomposes into N **independent** sub-contracts (their verify gates don't share state), N parallel Agent calls in a single message dispatch faster than serial. It's a heuristic, not a binding rule — sequential dispatch is also fine, especially when N is small or the agent already has the context loaded.

```bash
# Pattern: declare organ then fan-out N children in one parallel message
contract declare "<umbrella plan>" --action "children-satisfy"
# returns <organ-id>

contract fan-out <organ-id> \
  "child plan 1|action1" \
  "child plan 2|action2" \
  "child plan 3|action3"
```

`fan-out` emits a PARALLEL FAN-OUT block with N agent directives. The agent sends them as a single message with N Agent tool calls. Each sub-agent runs `contract solve "<plan>" --action "<cmd>" --parent <organ-id>`.

**When to fan out:** any time the organ has 2+ children whose verify gates do not depend on each other. The agent judges; the CLI surfaces the prompt.

**When NOT to fan out:** sequential dependencies (child B needs child A's artifact), same-file contention (use a worktree), or N=1.

The serial path still works -- `contract spawn` plus sequential iteration -- for dependent work.

## Fractal spawn

When a wave reveals sub-work too large for one fix:

```bash
contract spawn <parent-id> "sub-claim that must hold" [--action "<cmd>"]
```

`spawn` does not write to the ledger. It emits a SPAWN REQUIRED block telling the agent to route the child via a sub-agent (Agent tool) or directly. The child's ledger entry is written when the sub-agent runs `contract declare`. The parent becomes an organ when it has children; its satisfaction = all children satisfied.

## Search (related-contract surfacing)

The contract IS the habit. There is no separate "habit detection" concept — there is only `contract search`, which surfaces existing contracts related to the current context. Every "candidate" it returns is already a contract in the ledger; treat it as a lookup, not a pattern-promotion prompt.

`contract search --context "<text>"` (alias: `contract habit`) scores the context against all existing contract `plan` fields. Surfaces candidates above threshold:

```
RELATED CONTRACTS (threshold=0.55):

  [+] score=0.87  id=<uuid>  status=satisfied
      plan:   verify X always holds ...
      -> contract iterate <id>         # re-satisfy in this session
      -> contract spawn <id> "<sub>"   # delegate sub-work to this parent
```

The detector surfaces. The agent declares. Auto-contracting is a forbidden surface (pattern-match lists prescribing behavior).

## Lifecycle and natural selection

Contracts are not immortal. They are born, they compete, and the less-fit
ones are retired — a natural-selection lifecycle, recorded in the one
append-only ledger.

**Birth with a contradiction check.** Every `declare` runs the search
detector against the new plan and surfaces the past contracts it most
resembles, under a `lifecycle check (natural selection)` block. The
substrate only surfaces; the agent judges in-thread whether the new
contract genuinely **contradicts**, duplicates, or merely refines an
existing one. No script renders the contradiction verdict — a regex on plan
text would be a forbidden surface.

**Selection by supersession.** When two contracts genuinely contradict, the
agent picks the fitter one (newer evidence, broader truth, a real check
versus a wish) and retires the other:

```bash
contract supersede <loser-id> <winner-id> --reason "<why the winner is fitter>"
```

`supersede` (alias: `merge`) appends a `merged` event. The superseded
contract becomes a **fossil**: terminal `merged` status, kept in the ledger
forever, but dropped from `list`, from `search`, and from the declare-time
contradiction surface. A fossil never resurfaces as a reuse candidate —
selection is one-directional.

**Heredity.** The `merged` row carries `merged_into: <winner-id>`, so every
supersession is an edge in the contract DAG. The chain of fossils behind a
living contract is its lineage — the evolutionary record of how that truth
claim was refined. `contract list --show-merged` reveals the fossils.

The ledger is the fossil record: append-only, every superseded contract
preserved as evidence. Natural selection here is variation (the ledger
accumulates contracts), selection (the agent supersedes the less-fit on a
surfaced contradiction), and heredity (the `merged_into` lineage edge).

## The genesis organ (recipe)

The jesus-loop's nine Genesis days are not a separate engine — they are one
contract **organism**, assembled from the shapes above. This is the
canonical arc for a substantial build.

**Step 0 — Plan (discover and reuse by BM25).** Before declaring anything
new, `contract search --context "<the plan>"` ranks every past contract by
BM25 (term-frequency saturation, inverse document frequency, length
normalization) and surfaces the top hits. JUDGE: reuse or iterate an
existing contract before creating a fresh one. The plan stage is a search,
not a blank page. Every `declare` also runs this surface (the lifecycle
check). The root contract's `plan` is the north star.

**Steps 1-6 — Creation (an ordered `sequence`).** Declare the root with
`--action sequence` and spawn the creation stages as ordered children.
Iterating the sequence always names the next unsatisfied stage — Light
before Firmament before Land. Bound a stage's effort with `--budget N`;
iterate then surfaces wave-vs-budget as evidence.

**Step 7 — Verdict.** The two-key exit is the verdict: KEY 1 machine, KEY 2
the agent's PROMOTE / HOLD / REJECT. Recognize genuine convergence and stop;
the two-key exit is final.

**Step 8 — Judgement (the falsifier `audit`).** Before the organism is
satisfied, `contract audit <root> --auditors N` fans out N cold auditors
who each try to break the root contract. The audit organ is satisfied only
when every auditor genuinely failed to falsify it.

**Step 9 — Emergence.** `contract _mark <root> satisfied`. The organism has shipped.

```bash
contract search --context "<plan>"                  # Step 0  — BM25 discover/reuse
contract declare "<north star>" --action sequence    # the organism root
contract spawn <root> "stage 1 ..." --budget 5       # Steps 1-6 — ordered creation
  ...                                                #            (one spawn per stage)
contract audit <root> --auditors 13                  # Step 8  — falsifier judgement
contract _mark <root> satisfied                      # Step 9  — emergence
```

Nothing here is a new engine. The genesis organ is the nine shapes, the
BM25 plan stage, and the natural-selection lifecycle — composed.

## Signal propagation (the nervous system)

A pile of cells is not an organism — what makes it one is **signalling**.
The contract graph has the cells and the edges (parent links, `contract:<id>`
references, `corroborate` synapses); signal propagation makes those edges
**fire**.

When a contract is marked satisfied — the action potential — `_mark`
surfaces the **wavefront**: every contract a change here should
re-evaluate.

```
=== PROPAGATION (signal) ===
  <id> satisfied. wavefront — judge KEY 2 on each:
  parent organ       <pid>   "<plan>"   -> contract iterate <pid>
  unblocked referrer <rid>   "<plan>"   -> contract iterate <rid>
  synapse            <sid>   "<plan>"   -> contract iterate <sid>
```

The wavefront has three conduction paths:

- **parent organ** — the funnel / sequence / quorum this contract is a
  child of may now be complete.
- **unblocked referrers** — every contract whose `--action` is
  `contract:<id>` was gated on this one; the gate just opened.
- **synapses** — contracts `corroborate`d with this one; related truths
  worth re-checking.

The substrate surfaces the wavefront; it never satisfies anything. KEY 2
stays with the agent on every contract the signal reaches. The graph is now
a nervous system that fires, not a filing cabinet that is walked by hand.

## Break on resolution (the refractory period)

A real neuron has an **absolute refractory period** after firing — roughly
1ms during which the cell physically cannot fire again, no matter how
strong the input. The soma must re-polarise before the next action
potential is even possible. This is not optional, not opt-in, and not
skippable — it's a property of the membrane.

/contract enforces the same thing **by design, fractally**. Every
`_mark satisfied` emits a `=== BREAK ON RESOLUTION (refractory) ===`
block BEFORE the propagation wavefront. KEY 3 lives here.

```
=== BREAK ON RESOLUTION (refractory) ===
  <id> just fired. KEY 3 (agent): pause and judge BEFORE propagating:
    · is the mark still genuine in retrospect (no fake-green)?
    · does this satisfaction invalidate any downstream claim?
    · are any peer or parent contracts now stale or duplicated?
  If any answer is yes — supersede / revise / iterate before continuing.
```

### Three keys, not two

The two-key exit was always incomplete — it gated the mark, not the
propagation. KEY 3 closes that gap:

| Key | Verb | Asks |
|---|---|---|
| **KEY 1** | the action exits | did the mechanical check pass? |
| **KEY 2** | `_mark satisfied` runs | is the pass genuine (no fake-green)? |
| **KEY 3** | the refractory pause | does this firing invalidate anything downstream? |

The wavefront is still surfaced — KEY 3 doesn't replace propagation, it
**precedes** it. The order is biology-mandatory: action potential → refractory
period → axonal propagation. Reversing the order is the substrate equivalent
of a cardiac arrhythmia: signals fire while the soma hasn't recovered, and
the organ destabilises.

### Why fractal, by design

KEY 3 fires on every shape, every depth, no opt-out — same as the
membrane property. A cell mark, an organ mark, a quorum mark, a sequence
stage completion: all of them emit BREAK. The agent CAN race past
("no, nothing's invalidated, keep moving") but the prompt is structurally
present, so the racing is deliberate, not accidental.

This is the substrate enforcing **reflection points fractally**, the way
neurons enforce refractory periods at every fire site. The biology read:
the immune system (shape gates) catches drift in cells. The homeostatic
regulator (audits) catches drift across the corpus. The refractory period
(KEY 3) catches drift **across time** — the moment between one firing and
the next, when a wrong conclusion has the smallest blast radius.

### Self-check

`self/break-on-resolution` (in `scripts/skill-self-test.sh`,
`scripts/check-break-on-resolution.sh`) statically verifies:
- the `BREAK ON RESOLUTION (refractory)` string is present in `_mark`
- `KEY 3` is named explicitly
- BREAK source line number is **less than** the SIGNAL PROPAGATION line
  number (biology order: refractory before signal travels)

Origin: 2026-05-23. The agent was asked "every contract needs a break
on resolution fractally too by design." The honest answer: this is a
genuine missing primitive — KEY 1 + KEY 2 + wavefront, but no
substrate-enforced pause between mark and propagation. Adding it makes
the neuron analogy complete (refractory period was the missing piece)
and gives the agent a structured moment to catch downstream-invalidation
bugs before they propagate. Contract `0bc383d0`.
## Plan-fulfillment proof (the claim-to-evidence binding)

The two-key exit said: KEY 1 machine, KEY 2 agent judges genuine. The
agent's judgment lived **in-thread**, with no artifact on the ledger row.
That made `_mark satisfied` indistinguishable between honest judgment and
rationalized fake-green. The ledger row carried "satisfied" but not
"satisfied **because**".

Plan-fulfillment proof closes that gap by design. Every `_mark satisfied`
**must** carry one of:

```bash
contract _mark <id> satisfied --proof "<one-line evidence the plan held>"
contract _mark <id> satisfied --proof-skip "<why the in-thread KEY 2 is sufficient here>"
```

A bare `contract _mark <id> satisfied` is **refused with exit 2** and the
substrate surfaces the contract's plan text alongside the two paths
forward. The plan IS the rule; the proof IS the self-judgment artifact
crystallized to the ledger row.

### The biology read

Where KEY 3 is the **refractory period** (a moment of rest between firing
and propagation), plan-fulfillment proof is the **synaptic memory** of why
the cell fired. A real synapse records the input pattern that triggered
its action potential — that record is what plasticity acts on later. The
ledger row's `proof` field IS that record: when the substrate asks "why
did this satisfy?", the answer is on the row, not vapored into a closed
conversation.

### The ledger schema (+1 field)

```json
{
  "event": "satisfied",
  "id": "abc1",
  "wave": 2,
  "ts": "...",
  "proof": "deploy hash 04e7 reaches https://site.example with 200 + expected text",
  "agent": "lewis@…"
}
```

Or for the explicit opt-out:

```json
{
  "event": "satisfied",
  "id": "abc1",
  "wave": 2,
  "ts": "...",
  "proof_skip_reason": "autonomous drive — agent KEY 2 fired in-thread on continuous evidence; row is one of N in a tree mark",
  "agent": "..."
}
```

Both fields can be `null` on rows that predate this binding (existing
satisfied rows are untouched). Both are visible via `contract status`,
`contract self --json`, and `contract honest`.

### Why fractal, by design

The binding applies to **every shape, every depth**: cell, judgment,
funnel, sequence, quorum, harness, the organ root, every leaf. There is
no opt-out per-shape, no opt-out at depth N, no env override to silence
the prompt. The agent CAN write a trivially-tautological proof — but the
proof IS on the row, named, attributable, and `contract honest` can later
surface "every proof in the last hour was 'action exited 0' — is KEY 2
degenerating into rubber-stamping?" The binding makes the gap detectable.

### When to use --proof vs --proof-skip

| Path | When | Example |
|---|---|---|
| **`--proof "<evidence>"`** | One-shot organs, leaf cells, explicit human marks. The proof is the audit trail. | `--proof "verify-served-surface returned 0 across 4 routes, no console.error in report.json"` |
| **`--proof-skip "<reason>"`** | Autonomous drive marks where KEY 2 fired in-thread on a wider context window. The skip-reason MUST be specific (the substrate refuses a blank reason). | `--proof-skip "autonomous drive — parent organ b77ad5d1 fired KEY 2 across all 5 stages in this turn"` |

The reason `--proof-skip` exists at all: drive-mode marks fire dozens of
satisfied rows per organ-tree-convergence; forcing every one to carry a
verbose proof would punish the legitimate autonomous-loop case. The
substrate enables either path; the agent picks based on context. **A
silent bare mark is the only thing refused** — every satisfied row is
attributable to one of the two intents.

### Self-check

`self/proof-binding` (in `scripts/skill-self-test.sh`,
`scripts/check-proof-binding.sh`) statically + at runtime verifies:
- `contract_core.mark_satisfied` accepts `proof` / `proof_skip_reason` kwargs
- `_mark satisfied` without proof exits 2 with the `PROOF REQUIRED` prompt
- `_mark satisfied --proof <text>` exits 0 and stores the text on the row
- `_mark satisfied --proof-skip <reason>` exits 0 and stores the reason

Origin: 2026-05-23. The agent was asked to "ensure a contract must
perform what it says its supposed to be doing before resolving, with the
declaration written inside it as a rule programmatically that gets self
judged." The plan IS the rule; the proof IS the self-judgment artifact.
KEY 2 stopped being purely in-thread the moment the artifact landed on
the ledger row. Contract `173c8819`.

## What this skill does NOT do

- Auto-declare from a detected pattern. Surfaces candidates only.
- Auto-satisfy when the action exits 0. Agent is the second key.
- Maintain a separate principle store. `~/.contracts/contracts.jsonl` is the single store.
- Prescribe plan text format. The declarant authors it.
## Psychology (the layer biology doesn't reach)

Biology gives us cells, organs, signals, selection. Psychology adds **what
the agent can hold and act on**. /contract is a substrate at **layer L2**;
its outputs default to L2 + L3 because that's where the agent operates.
Bleed across layers is cognitive noise that erodes attention.

### The five abstraction layers

| Layer | Speaks in | Examples | Default visibility |
|---|---|---|---|
| **L0 — mechanical** | exit codes, hashes, raw paths | `action_exit=1`, `id=905c1a3a`, `pointer(cli): python3 -c "..."` | `--verbose` / `--debug` only |
| **L1 — substrate** | shape names, ledger events | `cell`, `funnel`, `iterated`, `merged` | `--verbose` |
| **L2 — agent-UX** | next action, wave count, navigation | "iterate → judge → mark", "wave 2/5" | **default ON** |
| **L3 — truth-claim** | the plan, PASS/FAIL, KEY-2 verdict | "plan: …", "result: PASS", "is this genuinely satisfied?" | **default ON** |
| **L4 — user-intent** | plain-English meaning, business goal | "frontend is now a banger", "the fix landed" | agent translates upward; skill doesn't emit |

**Rule:** every emitted line belongs to exactly one layer. Mixed-layer output
is a defect. If a layer above L3 needs to be spoken, that's the agent's job
(it has theory of mind for the user; the skill does not).

Worked corroboration: contract `900af694` (output at correct abstraction
layer), `ed084986` (layers named explicitly), `cdb648fc` (final message
/humanizer-translated).

### Three psychology defaults (genuinely distinct from biology/theology)

| # | Default | Antidote to | Where it lives |
|---|---|---|---|
| **Ψ1** | **Layer purity.** Output one layer at a time; L0 noise is hidden by default. | layer-bleed cognitive load | this section + `--verbose` flag on noisy verbs |
| **Ψ2** | **Working-memory cap (Miller's 7±2).** The "When to invoke" front-door table caps at ≤8 load-bearing rows. Long-tail verbs are discoverable via `contract self`, not crammed into entry. | front-door overflow | self-test invariant `psych/working-memory-cap` |
| **Ψ3** | **Confirmation-bias antidote.** For any organ with **≥3 children**, run `contract audit <id>` before `_mark satisfied` — N cold falsifiers try to break it. The substrate surfaces the prompt; the agent judges whether to honor it. | motivated reasoning / fake-green | propagation block after every funnel iterate that surfaces "audit recommended (N children)" |

These do not replace the engineering/theology defaults — they layer on top.
Where biology says "an organism is satisfied when all children fire", psychology
says "the agent reading that result is constrained — render it at L3, not L0,
and cap at one chunk." Where theology says "no false witness", psychology
says "the agent will rationalize fake-green without an external auditor —
fan one out before marking."

## Humanlike dimensions (emotion, sociology, aesthetics)

/contract is **humanlike, not human.** The skill respects three more dimensions
of the agent operating it — affect, multi-agent society, taste — without ever
pretending to feel them itself. Substrate enables; it never invents.

Together with biology (cells/organs/signals), theology (defaults #9–#11), and
psychology (Ψ1–Ψ3), these complete the model: a substrate that is *aware* of
what the agent on the other side is constrained by.

### Ε — Emotion (salience and affective weight)

The agent has affect: frustration with grinding failures, anxiety about
marking wrong, premature joy at the first PASS. The substrate doesn't
share these feelings — it **surfaces the signals so the agent can act on
them rather than be carried by them.**

| # | Default | Antidote to | Where it lives |
|---|---|---|---|
| **Ε1** | **Failure-streak escalation.** When a leaf iterate produces ≥3 consecutive FAILs without intervening change, the iterate output surfaces "🟥 streak=N — escalate (spawn child, revise action, supersede) or abandon (mark `rejected`)." | grinding without escalation (frustration → tunnel vision) | iterate prompt extension |
| **Ε2** | **Over-iteration warning.** When a leaf has ≥3 consecutive PASSes and the agent still hasn't `_mark`ed, the prompt asks: "what specific risk are you still checking for?" — naming the fear surfaces it. | perfectionism / fear-of-marking (anxiety → wave inflation) | iterate prompt extension |

### Σ — Sociology (attribution and reputation)

A contract is declared, iterated, marked — these are speech acts with an
author. Today the ledger is anonymous; an agent rationalizing fake-green
is indistinguishable from one judging honestly. Σ1 closes that gap.

| # | Default | What it enables |
|---|---|---|
| **Σ1** | **Agent attribution on every row.** Every ledger event carries an optional `agent` field (env `CONTRACT_AGENT`, falling back to `git config user.email`). Per-agent KEY-2 honesty rates become observable: who marks satisfied on first PASS vs who iterates an average of N waves? | reputation, trust, accountability across the ledger; supersession is one-directional but attribution makes it diagnostic |
| **Σ2** | **Audience gates — who reads what.** Every `declare` may carry `--audience <tier-or-list>` with three tiers (`public`, `team`, `private`) and/or explicit identities. `contract list --for <viewer>` filters rows to those visible to the viewer. Σ1 attribution feeds Σ2 team membership: the team set IS the agent column. Default for legacy rows (no audience field) is `team` — visible to anyone who has ever declared a contract, invisible to external transports without a ledger identity. The bot (`foundry_aiko_bot`) is NOT team by default; it only sees `public` rows + rows explicitly addressed to it. | safe transport gates — the same /contract substrate can publish to a Telegram bot, an Outline doc, a gitea mirror, the panel UI, without leaking private rows; the agent picks the tier at declare time |
| **Σ3** | **Identity aliases — same human across transports.** `contract alias <canonical> <alias1> [<alias2>...]` declares an equivalence class. `resolve_identity()` walks alias rows via union-find; `is_team_member()` and `visible_to()` compare canonical forms. So Lewis (`lewistham9x@gmail.com` from git, `lewis@getfoundry.app` as founder, `lekt8` on Telegram) is ONE team member after one `contract alias` call, and `--for lekt8` resolves to the same team-visible row set as `--for lewis@getfoundry.app`. Transitive: declaring (A, B) then (B, C) unifies all three. Latest-declared canonical name wins. Verb-gate: `verb-gates/alias/verify.sh`. | cross-transport identity — Lewis pays once, all his bot/web/panel sessions inherit the credit balance; the bot's "stranger or team?" question gets one answer per human, not one per channel |
| **Σ4** | **Agent routing — `agent:<identity>` pointer-type gates ITERATE.** Where Σ2 gates LIST visibility (who can SEE), Σ4 gates iterate routing (who can ACT). `--action "agent:lewis@getfoundry.app"` means: when the routed agent iterates (Σ3-canonical match), the action behaves like `agent-judges` (in-thread judgment surface); when anyone else iterates, the substrate refuses AND appends a routing row to `~/.contracts/inbox/agent/<identity>.jsonl` so the named agent picks the work up via `wait-for-event.py --inbox agent --field target_canonical --equals <id>` on their next session. Compose `agent:<id>` with `--audience <id>` for both invisible + un-actable to anyone else. Verb-gate: `verb-gates/agent-route/verify.sh` covers matched/mismatched/aliased iterators + the inbox row shape. | the universal `whatever needs an agent` primitive — every cross-process task routes through the inbox, the agent's permissions are checked against the row's audience + the action's `agent:` target, and any transport (telegram, panel, web) can dispatch work to any named identity via one substrate verb |

### Α — Aesthetics (craft signal)

A plan that doesn't name a concrete truth claim is aesthetically incomplete
even if its action mechanically passes. Α1 surfaces a quality signal at
declare time without blocking — substrate enables.

| # | Default | Warns on |
|---|---|---|
| **Α1** | **Plan-text quality surfacing.** Plans shorter than 24 chars or matching generic patterns (`^do X$`, `^fix Y$`, `^build Z$`, `^implement W$`) emit a soft warning at declare: "plan text reads as a task, not a truth claim — does it name what must hold?" | wishy-washy plans that satisfy mechanically but never make a binding claim |
| **Α2** | **Transparent, not technical or revealing.** Default human-facing report leads with L4 (what changed in plain English, what works now, what remains) and L3 (the truth claim). Suppress L0 (raw paths, hashes, full contract IDs in prose) and L1 (shape names, ledger event types) unless the user asked for them. Apply Σ2 — never surface rows or details that the audience isn't supposed to see. The rule: *the user should know what's true and what's next without having to learn the substrate's vocabulary or seeing things addressed to someone else.* | over-technical wall-of-IDs reports that obscure the actual outcome; accidental disclosure of internal state to audiences who shouldn't see it |

### Why these three and not others

Economics (opportunity cost) is already covered by `--budget` + wave-count
visibility. Phenomenology (what-it's-like) is `contract self`. History,
ethics, politics, spirituality, mortality all overlap existing defaults
(lineage, theology, append-only-ledger, "serve genuine need", supersession).
The genuine gaps were affect, attribution, and taste — three surfaces, no
more.

Worked corroboration: contract `5cc21029` (this section), and the existing
biology + theology + psychology defaults that these layer onto, not replace.



The substrate enables; it does not prescribe. Scripts emit evidence only. No script bakes a verdict, a banned list, or a per-case rule. The agent renders every verdict in-thread. A contract that auto-satisfies is a tautology, not a contract.

## Ledger schema

`~/.contracts/contracts.jsonl` — append-only, agent-agnostic. One JSON line per event. Lives outside `.claude/` and `.codex/` so contracts survive across runtimes.

```json
{"event":"declared",  "id":"abc1", "plan":"...", "action":"...", "pointer_type":"cli", "parent_id":null, "ts":"..."}
{"event":"iterated",  "id":"abc1", "wave":1, "action_exit":1, "action_result":"fail", "agent_verdict":null, "children_spawned":[], "ts":"..."}
{"event":"iterated",  "id":"abc1", "wave":2, "action_exit":0, "action_result":"pass", "agent_verdict":"genuine", "ts":"..."}
{"event":"satisfied", "id":"abc1", "wave":2, "ts":"..."}
{"event":"spawned",   "id":"abc2", "parent_id":"abc1", "plan":"...", "action":"...", "ts":"..."}
```

The ledger is memory. Every failed wave is `learn_from_execution`. Never delete rows.

## Pointer principle

A contract's `--action` is always a **pointer** to a capability, not raw data inline. The pointer tells the system WHERE to find the check; never embeds the logic itself.

Pointer types that aren't shapes (shapes are catalogued above):

| Pointer type | `--action` form | What it points to |
|---|---|---|
| `cli` | `npm test`, `python3 verify.py` | A local executable or shell command |
| `api` | `curl https://...`, `https://...` | An HTTP endpoint |
| `contract-ref` | `contract:<id>` | Another contract's satisfaction status |
| `x402` | `x402:https://beta-api.unbrowse.ai/v1/credits/debit?cost=10` | Π1 payment-gated HTTP call — 200 PASS, 402 surfaces `=== PAYMENT REQUIRED ===` block with `pay_url` for transports to render, 401 surfaces sign-in hint. Bearer from `UNBROWSE_API_KEY` env or `~/.config/unbrowse/api-key`. Settlement happens at unbrowse, never in /contract. |
| `agent` | `agent:lewis@getfoundry.app` | Σ4 routes the action to a named agent identity. Routed agent (Σ3-canonical) gets `AGENT-JUDGES` (in-thread judgment); anyone else gets refused + inbox row at `~/.contracts/inbox/agent/<id>.jsonl`. Compose with `--audience <id>` for full invisibility + un-actability gating. |

The `contract:<id>` form is pointer-to-pointer: the action is satisfied when the referenced contract is satisfied. This lets one contract's truth claim depend on another without embedding any logic.

The ledger records every pointer call as a row (`event: iterated`), so you always have a history of what was queried, when, and what it returned. The ledger IS the query history.

Rules:
- Never hardcode a decision inside `--action`. The action checks; it never decides.
- If the check requires a server or API, the pointer is the URL; the server holds the logic.
- A `contract:<id>` pointer resolves the referenced contract's current status from the ledger — it does not re-run the action; it reads the declared truth.
- `pointer_type` is stored on every `declared` row and returned by `get()`. It is evidence for the agent, not a baked verdict.
- Actions are bound to their declare-time working directory. `contract_core.declare()` records `cwd` on every row; `iterate` runs the action from it (rows predating the field fall back to the current directory). Declare a contract from the directory its action should run in, and a relative-path action stays correct even when iterated later from elsewhere. Do not bake `cd <dir> &&` into an action.


## Requirement blocks (the generative-UI handoff)

When iterate FAILs because the user needs to **do something out-of-band**
before the action can pass — pay an invoice, sign in, attach a credential,
let another agent take over — the substrate doesn't say "FAIL: try again".
It emits a **requirement block**: a structured `=== <KIND> REQUIRED ===`
section carrying the upstream URL, the response body, and per-transport
render hints. Each transport (Telegram bot, web app, Panel, terminal)
parses the block and renders a **client-native generative UI** — a
sendInvoice in Telegram, a modal in web, an inline card in Panel, a plain
URL in terminal.

The substrate's contribution is the **structured surface**. Per-transport
rendering is the adapter's job; the substrate guarantees the same fields
appear in the same shape no matter which pointer-type fails.

| Block | Fires on | Carries | Native render examples |
|---|---|---|---|
| `=== PAYMENT REQUIRED ===` | x402 → 402 | `upstream`, `status`, `body` (with `pay_url`, `amount`, `asset`) | Telegram `sendInvoice` · Web wallet payment prompt · Panel "Top up" card · Terminal URL |
| `=== SIGN-IN REQUIRED ===` | x402 → 401 | `upstream`, `status`, `body` | Telegram inline keyboard → magic-link · Web OAuth modal · Panel Privy sign-in card · Terminal URL |
| `=== ROUTED ===` | `agent:<id>` mismatch | `target_canonical`, `inbox_path`, `wait_cmd` | Telegram "@<agent> picking this up" · Web spinner with target name · Panel agent-handoff card |
| `=== INHIBITION REFUSAL ===` | `--inhibits` active | `inhibitor_ids`, `inhibitor_plans` | Surface inhibitors with "supersede or release" controls |

**Why this is one section, not four.** The four blocks share the same
shape on purpose: a `kind`, an upstream context, a body the transport can
parse, and a render-hint list. A new pointer-type's failure case can add a
new `=== <NEW-KIND> REQUIRED ===` block with the same convention; no
transport rewiring needed — adapters that handle the existing four already
know how to parse a fifth.

**Why generative-UI not template-UI.** The substrate names *what* the
block represents (payment / sign-in / route / inhibit) and *what payload
it carries*. The transport decides *how to render* given its capabilities:
a Telegram bot ships `sendInvoice` because it has one; a web app ships an
x402 wallet popup because it has one; a terminal ships a clickable URL
because that's all it has. The render is generated client-side from the
substrate's structured prompt — same data, different surfaces.

Verb-gate: `verb-gates/x402/verify.sh` binds the PAYMENT REQUIRED + SIGN-IN
REQUIRED blocks (presence + at least two per-transport render hints).
Future requirement-block additions (`ROUTED`, `INHIBITION REFUSAL`) get
their own gate rows when added.

Origin: contract `74392a21`, 2026-05-23. Lewis's request: "when things are
required — credentials or x402 payments — allow generative UI via /contract
building appropriately based on the context of the client being used."
The block-shape was already in latent form for `PAYMENT REQUIRED`; naming
the convention and unifying `SIGN-IN REQUIRED` under the same shape made
the substrate the single source of truth for "transport, here's what to
render."


## Concept lineage (genesis .tongues)

| Tongues doctrine | Implementation |
|---|---|
| `CONTRACTING_IS_LEARNING` — contracts encode lessons | The ledger IS memory. Failed waves are `learn_from_execution`. |
| `AUTO_CONTRACT_HABIT_DETECTION` / `DAEMON_INTERFACE` — patterns surface as candidates; substrate watches and routes | `contract search` surfaces; agent declares. |
| `self_grow` — spawn children | `contract spawn` is this primitive made real. |

From `principles-as-harnesses.md`: a principle with `--action` IS a contract. From `dag-schema.md`: the graph is the single substrate. These are not external dependencies; they are the concept lineage this primitive implements directly.

See also `references/agentic-ux-copilot.md` for the standing-default doctrine: every `/contract`-built site with a web UI embeds an agentic copilot whose tools are the site's own indexed APIs and whose knowledge is the site's own page content — the same truth-telling discipline as the primitive, applied to the end user.

## Receptors (external events as ligands)

A pile of cells with signal propagation is still **closed** — nothing
from outside the agent can fire it. Receptors close that loop. The
biology equivalent is a **ligand-gated ion channel**: an external signal
(telegram message, webhook hit, Stripe event) binds, the receptor
depolarises, the contract iterates.

**A receptor is NOT a new shape.** It is a convention layered on `cell`
or `loop-until` — the `--action` blocks on an inbox file populated by an
external injector. The shape-is-the-type-system rule (and contract
`310f425f`) forbids a new `--lifetime receptor` flag; the existing
shapes already cover one-shot (cell) and re-fire (loop-until).

### Inbox layout

```
~/.contracts/inbox/
  telegram/<chat-id>.jsonl     # one row per group message  (poller writes)
  webhook/<source>.jsonl        # one row per signed POST    (worker writes)
  stripe/<event-type>.jsonl     # one row per stripe event   (forwarder writes)
```

Each injector appends one JSON line per event. Files are append-only and
agent-agnostic — same shape as `contracts.jsonl`. Row schema is free but
should carry `id`/`message_id` + a sender/source tag + payload.

### Declaring a receptor

```bash
# Receptor that fires when 'ping' appears in the telegram inbox
contract declare "@aiko receives a ping in the group" \
  --action 'python3 ~/.claude/skills/contract/scripts/wait-for-event.py --inbox telegram --filter ping --timeout 60'

# Receptor that fires when Stripe records a checkout success
contract declare "first paid customer" \
  --action 'python3 ~/.claude/skills/contract/scripts/wait-for-event.py --inbox stripe --field type --equals checkout.session.completed --timeout 86400'

# Re-firing receptor — every group message that contains 'redirect' triggers a wave
contract declare "watch for redirect command in group" \
  --action 'loop-until:python3 ~/.claude/skills/contract/scripts/wait-for-event.py --inbox telegram --filter redirect --timeout 5'
```

### `wait-for-event.py` interface

```
--inbox <channel>          # subdir under ~/.contracts/inbox/  (required)
--filter <regex>           # match against the full JSON row
--field <dotted.path>      # match a specific field
--equals <string>          # exact match for --field
--since-id <int>           # only consider rows with id > since-id
--timeout <seconds>        # default 30
--poll <seconds>           # default 1
```

Exits 0 on first match (PASS), 1 on timeout (FAIL), 2 on usage error.
Prints the matched row as JSON to stdout. Never writes to the ledger —
that is the contract CLI's job after KEY 2.

### Standard injectors

| Channel | Injector | Inbox file |
|---|---|---|
| `telegram` | bot poller daemon (long-poll `getUpdates`) | `~/.contracts/inbox/telegram/<chat-id>.jsonl` |
| `webhook` | Cloudflare-fronted HTTPS endpoint, HMAC-verified | `~/.contracts/inbox/webhook/<source>.jsonl` |
| `stripe` | stripe webhook → forwarder | `~/.contracts/inbox/stripe/<event-type>.jsonl` |

Injectors live OUTSIDE the contract skill — they are integrations. A
receptor depends only on the inbox schema, not on which injector wrote
the row. New channels are new directories; no skill change required.

## Streams (the output side of receptors)

Receptors are the contract's **stdin port** — external events drop rows
into an inbox file, the action blocks via `wait-for-event.py`, the
contract depolarises. The dual exists too: **streams** are the contract's
**stdout port** — a long-running action writes progress to a conventional
file, an observer (the agent, another contract, a `contract tail`
follower) reads it in real time.

Like receptors, streams are NOT a new shape and NOT a new ledger field.
They're a **file convention** any action can opt into. The substrate
exposes the path; what the action writes there is the action's business.

### Stream layout

```
~/.contracts/streams/<contract-id>/
  stdout.log    # append-only line stream — progress / logs the action prints
  state.json    # latest structured snapshot — overwritten each tick (atomic rename)
  stdin.fifo    # optional named pipe — for the action that wants interactive input
```

The directory is created lazily by the action that first writes to it
(or by `contract tail` on first follow). It is **outside the ledger** —
ephemeral, gitignored, fine to delete; the ledger row remains the
durable record of what was iterated.

### How an action opts in

```bash
#!/usr/bin/env bash
# any-long-running-action.sh — appends progress to its contract's stream.
# The contract id is passed via env (CONTRACT_ID); the substrate sets it
# before invoking the action so the action knows where to write.
STREAM_DIR="$HOME/.contracts/streams/${CONTRACT_ID}"
mkdir -p "$STREAM_DIR"
LOG="$STREAM_DIR/stdout.log"
printf '%s · starting tour\n' "$(date -u +%FT%TZ)" >> "$LOG"
# … do work …
printf '%s · step 3/12: outlets\n' "$(date -u +%FT%TZ)" >> "$LOG"
printf '{"step":3,"total":12,"label":"outlets"}\n' > "$STREAM_DIR/state.json"
```

No coupling to the substrate's internals. The action prints whatever it
wants, in whatever format. Receptors and streams are pure file IPC —
agent-agnostic, runtime-agnostic, language-agnostic. A Python action
can feed the same stream a bash action would feed.

### Observing a stream

```bash
contract tail <id>           # follow stdout.log (live)
contract tail <id> --since-start   # also dump existing content first
```

`contract tail` is `tail -f` with a `--since-start` shortcut, scoped to
the streams convention path so the agent doesn't have to remember it.
When the stream file doesn't exist, the verb prints the conventional
path so the agent knows where to wire the action's output.

### Receptors ↔ streams as duals

| Direction | Inbox primitive | Stream primitive |
|---|---|---|
| **External → contract** (stdin) | `~/.contracts/inbox/<channel>/*.jsonl` | n/a |
| **Contract → observer** (stdout) | n/a | `~/.contracts/streams/<id>/stdout.log` |
| **Helper** | `wait-for-event.py` (blocks until match) | `contract tail <id>` (follows with tail -f) |
| **Lifetime** | one inbox file per channel; long-lived | one stream dir per contract; deletable after iterate completes |
| **Substrate role** | provides the path convention + helper | provides the path convention + helper |
| **Action's role** | reads matched event, exits | writes progress, exits |

Both are **file IPC against a documented path convention** — exactly the
same architectural shape. Both work at every contract shape and every
DAG depth, because they're orthogonal to the shape system: any action
(cell, judgment body, loop body, harness verify.sh) can read an inbox
and/or write a stream.

### What stays out of the substrate

- **No structured-stdout schema.** The action writes whatever it wants.
  If the agent or another contract needs to parse, that's its problem.
- **No automatic stream → ledger mirror.** Streams are ephemeral; the
  ledger is durable. Mixing them would re-introduce the mutation problem
  the append-only design avoids.
- **No required `CONTRACT_ID` env passthrough.** Actions opt in by
  reading the env var IF they want to stream; bare cells that don't need
  progress visibility just write to stdout normally and get captured in
  the iterated row's `action_result`.

Origin: 2026-05-23. The agent was asked "at any point is there a
receptor stdio thing internally — an interface into any contract?" The
honest answer was: yes for the input side (receptors), and the dual for
output existed in latent form (any action can write a file) but was
never NAMED. Naming it makes the symmetry visible and the convention
discoverable. Contract `ff6e8908`.

## Everything is stdio (the unified model)

The nine shapes split cleanly into two layers, joined by the ledger as
their shared file. The split is load-bearing — it's why the neuron
analogy is exact, not just metaphor.

### The action layer (stdio-shaped)

Every shape that runs code reads stdin / env / files and writes stdout
+ exit code:

| Surface | Reads (stdin) | Writes (stdout) | Exit code drives |
|---|---|---|---|
| `cell` action | env, stdin, fs | stdout, stderr, side-files | KEY 1 |
| `judgment` body (agent) | conversation context | agent_verdict text | KEY 2 |
| `loop-until:` body | env, fs (often a counter file) | stdout per iterate | KEY 1 each wave |
| `harness:<path>/verify.sh` | env, fs | stdout, stream files | KEY 1 |
| `tool-guard:` PreToolUse hook | tool-call JSON on stdin | block/allow JSON on stdout | tool gate |
| receptor (`wait-for-event.py`) | inbox JSONL file | matched-row JSON on stdout | PASS / FAIL |
| stream writer (any action) | (writer side) | `streams/<id>/stdout.log` | n/a |
| internal hook handler | ledger row on stdin | side-effect artifact | n/a |

Every one of these is a tiny stdio process. Receptors are the standardised
stdin port (inbox file). Streams are the standardised stdout port
(`streams/<id>/stdout.log`). The other shapes are bare-shell stdio with
no naming convention required.

### The composition layer (pure ledger queries)

Composition shapes do NOT have stdin/stdout of their own. They're pure
functions over the ledger's current state, evaluated at iterate time:

| Shape | What it queries | Predicate |
|---|---|---|
| `funnel` / `children-satisfy` | every child's status | "ALL satisfied?" |
| `funnel-first` | every child's status | "ANY satisfied?" |
| `sequence` | children in declared order | "first unsatisfied" |
| `quorum:K` | every child's status | "≥K of N satisfied?" |
| `contract:<id>` (action) | the referenced contract's status | "is that one satisfied?" |

These have no I/O footprint of their own. They produce KEY 1 by reading
the ledger and applying a predicate. No subprocess runs.

### The ledger is the trunk stdout

The ledger (`~/.contracts/contracts.jsonl`) is itself a stdio surface
at the substrate scale — append-only, line-delimited, every contract
event writes one line to it, every other contract reads from it. The
action layer's exit codes become satisfied/iterated rows on the trunk;
the composition layer reads those rows to decide its own predicate.

```
                    ┌─────────────────────────────────────┐
                    │  ~/.contracts/contracts.jsonl       │
                    │  (append-only trunk — substrate     │
                    │   stdout that everyone shares)      │
                    └────▲──────────────────────────┬─────┘
       writes events ────┘                          └──── reads events
              │                                                │
   ┌──────────┴──────────┐                       ┌─────────────┴────────┐
   │  ACTION LAYER       │                       │  COMPOSITION LAYER   │
   │  (stdio)            │                       │  (ledger queries)    │
   │                     │                       │                      │
   │  cell · judgment    │                       │  funnel · funnel-first│
   │  loop body · harness│                       │  sequence · quorum   │
   │  tool-guard · hook  │                       │  contract:<id> resolver│
   │  receptor · stream  │                       │                      │
   └─────────────────────┘                       └──────────────────────┘
        ▲          │                                       ▲
        │          │ inbox files / stream files            │
        │          ▼                                       │
   ┌────┴──────────────────┐                  ┌────────────┴────────────┐
   │  EXTERNAL WORLD       │                  │  AGENT (KEY 2)          │
   │  injectors → inbox    │                  │  judges genuine / fake  │
   │  observers ← streams  │                  │  marks satisfied        │
   └───────────────────────┘                  └─────────────────────────┘
```

### Why the neuron analogy is exact (not metaphor)

Map each layer onto a real neuron:

| Neuron part | /contract surface |
|---|---|
| **Dendrites** (incoming signals) | env vars, inbox files, ledger reads of parent/refs, stream readers, stdin |
| **Soma** (integration, fires the action potential) | the action — the shell command, the agent's judgment, the body of a loop |
| **Membrane voltage** (gates the fire) | KEY 1 exit code AND KEY 2 agent verdict |
| **Action potential** (the discrete fire event) | `_mark satisfied` writing the row to the trunk |
| **Axon** (carries the signal out) | the satisfied row in the ledger + optional stream file |
| **Synapses** (downstream connections) | parent organs, contract-ref referrers — the wavefront on `_mark` |
| **Dendritic geometry** (what input pattern fires the cell) | composition shape: funnel = AND, funnel-first = OR, quorum:K = threshold, sequence = ordered chain |

The composition layer isn't a separate kind of neuron — it's the **firing
rule** of the upstream cell. A funnel parent has the dendritic geometry
"fire when ALL inputs fire"; a quorum:K parent has "fire when K of N
inputs fire". Real neurons do the same — threshold integration is
geometry, not a separate process.

### Practical consequence: the agent's mental model

When you read a contract, sort it by layer first:

- **Action shape?** Think "what stdio is this doing?" — what reads, what
  writes, what exit code maps to KEY 1, what stream file (if any).
- **Composition shape?** Think "what predicate over which children?" —
  no stdio question to ask, just the firing rule.

When you write one:
- **Need to verify something concrete?** Action shape (cell most often).
- **Need to combine other contracts?** Composition shape.

Never embed composition logic in a cell's action (don't write a script
that grep's the ledger to AND children — declare a funnel). Never embed
stdio logic in a composition (don't add file I/O to a funnel — give the
funnel a cell child that does the I/O).

Origin: 2026-05-23. The agent asked "so everything is stdio as a
contract/cell/neuron type design?" The honest answer is YES at the
action layer, NO at the composition layer, and the ledger is the
trunk stdio that joins them — which is exactly the two-layer structure
of a biological neural circuit. Naming the split makes the model
mechanical rather than metaphorical.

## Bundled scripts

- `scripts/contract` — CLI front door (declare, iterate, build, spawn, solve, status, list, search, _mark)
- `scripts/contract-habit-detect.py` — passive related-contract detector (L2; surfaced via `contract search`)
- `scripts/contract-import-extract.py` — import extractor: surfaces past patterns as candidate contracts (L2)
- `scripts/check-no-silent-fallback.py` — guard: fails if any skill script swallows an error silently
- `scripts/lib/contract_core.py` — data model, sole ledger writer (L0)
- `scripts/contract-crystallize.py` — crystallizes a learning into a memory file + an Outline doc (shared by the `learn` verb and the crystallize-learning hook)
- `~/.contracts/hooks/crystallize-learning.py` — internal hook: on every `mark` event, crystallizes a satisfied learning-bearing contract
- `scripts/wait-for-event.py` — receptor helper: blocks until an event row matching a filter appears in `~/.contracts/inbox/<channel>/*.jsonl`. PASS on match, FAIL on timeout. Never writes to the ledger.
- `scripts/verify-served-surface.sh` — **served-surface gate** (see below) — bun/npm-bootstrapped Playwright wrapper that loads a list of URLs in headless Chromium and fails the action on console.error / pageerror / same-origin 4xx. The script `scripts/browser/verify.mjs` is the Node program; the bundled `package.json` pins Playwright.
- `scripts/observe-original.sh` — **API-trace / UX-flow recorder** (see below) — drives a *real* site through a scripted tour with a headless browser, captures per-screen network requests with headers + payload + status + clipped response, and emits a markdown `screen-flow.md` report. Use this BEFORE rebuilding any existing site. Implementation: `scripts/browser/observe.mjs`. Shares the same `scripts/browser/` playwright install as the served-surface gate.
- `~/.contracts/contracts.jsonl` — the single append-only store (agent-agnostic)
- `~/.contracts/inbox/<channel>/*.jsonl` — append-only event inboxes that injectors write and receptors poll (telegram, webhook, stripe, …)

## Served-surface gate (standing default for any web ship)

A build that compiles and a build that lights up the browser are two
different truths. `vite build` passing does NOT prove the deployed site
renders without throwing — providers that crash on first paint
(`useVisibility must be used within a VisibilityProvider`), 404'd font
URLs, and other dead-on-arrival regressions slip through type-checking
and unit tests but the user catches them in the console.

Every `/contract` loop that promotes a web deployment **must include a
served-surface gate as one of its sequence stages**. It is a `cell`
contract whose action points at `verify-served-surface.sh`:

```bash
contract spawn <root> \
  "served surface clean: zero console.error, pageerror, or same-origin 4xx on <urls>" \
  --action 'bash ~/.claude/skills/contract/scripts/verify-served-surface.sh https://my-site.example/ https://my-site.example/login --report .scratch/served-verify.json'
```

The action exits 0 only when every URL listed loads in real headless
Chromium without:
- emitting a `console.error`
- raising an uncaught page error
- 4xx-ing a same-origin asset

Filtered by design (substrate enables, doesn't prescribe):
- third-party CORS noise and console.warn are ignored
- cross-origin asset failures are ignored (false positives from CDNs
  and analytics blockers)
- browser-extension chatter (FrameDoesNotExist, evmAsk, runtime.lastError)
  is structurally absent in headless

Pass `--allow <substr>` repeatably to whitelist a known-safe message.
Pass `--report <path>` to capture the structured JSON for KEY-2 review.

**Why this lives in /contract itself, not in a project-local script:**
the discipline is universal — any agent-driven web ship benefits from the
same gate. Promoting it to the skill means every future `/contract` loop
the agent runs inherits the capability by default, not by remembering to
re-derive it. The first-use cost is a one-off `bun install` inside
`scripts/browser/`; every subsequent invocation is a fast headless
load.

Origin: a 2026-05-23 ship that passed `bun run build` and reached
`https://*.pages.dev` HTTP 200, but threw `useVisibility must be used
within a VisibilityProvider` on first paint and 404'd a baked-in
Google Fonts woff2 URL. The agent only learned this when the user pasted
the console log. The gate exists so this never recurs.

## Empathy gate (standing default — extends served-surface)

The served-surface gate catches **crashes** (console.error, pageerror, 4xx).
It does NOT catch a worse failure mode: a page that loads, hydrates without
throwing, and renders an **empty shell**. A skeleton with no content, an
auth-protected route that landed an unauthed user on a blank page, an
error-boundary that swallowed the throw and painted "Application error: a
client-side exception has occurred" — these all pass console-error checks
while genuinely failing for the human reading the page.

`verify.mjs` is the same script for both layers. Empathy primitives:

| Flag | Asserts | Default |
|---|---|---|
| `--wait-after-load <ms>` | hydration pause | 1500 |
| `--wait-until <evt>` | playwright nav-complete | `domcontentloaded` (`networkidle` hangs on sites with poll loops) |
| `--expect <substr>` | `document.body.innerText` contains the substring | (none) |
| `--expect-not <substr>` | `document.body.innerText` does NOT contain | built-ins: `"Application error: a client-side exception"`, `"__next_error__"`, `"something went wrong"` |
| `--min-text <N>` | `innerText.length >= N` (skeleton markup with no visible copy fails) | 0 = off |
| `--no-default-expect-not` | drop the built-in error-boundary guards | — |
| `--no-raw-json` | fail when the visible text contains a JSON dump (4+ JSON-property lines, or any line with 4+ `"key":` tokens). Catches lazy `JSON.stringify()` rendering that ships as "real UI" but is just unsalvaged data | — |
| `--walk` | after each URL, harvest every same-origin `<a href>` on the page and verify each (catches stale internal links — a deleted route still referenced by a nav item) | — |
| `--walk-include <regex>` / `--walk-exclude <regex>` | filter the walk queue by path | — |
| `--prelude <tour.json>` | drive a small login/tour BEFORE the URL checks in a shared browser context. The session cookies + localStorage carry into every subsequent visit and walk — so the gate also covers authenticated routes and the form-submit redirect destination | — |
| `--env-from <file>` | load `KEY=VAL` pairs for the prelude's `${VAR}` substitution | — |

The gate reads `document.body.innerText` (not `outerHTML`) — invisible
nodes and `display:none` skeleton placeholders don't count as content. A
real user reads visible text; the gate does the same.

## Walk + prelude — go from the default entry point end to end

A SPA's client-side 404 (the route's catch-all renders a "404 — try home"
fallback) emits no console.error and no HTTP 4xx. The base served-surface
+ empathy gate lights green even though a human reading the page sees
nothing. The `--walk` and `--prelude` layers close that gap.

- `--walk` follows every internal `<a href>` from each start URL. A stale
  `setLocation("/app/deleted-route")` still referenced in nav code gets
  caught when the walk hits the deleted route and the SPA's fallback paints.
- `--prelude` runs a small JSON tour (`goto / fill / click / wait_idle /
  expect_url / expect_not_text`) in a shared browser context before the URL
  checks. The session cookies and localStorage persist, so authenticated
  routes are verified too — including the destination the form-submit
  redirects to. `expect_url` inside the prelude is the killer step: it
  catches "login submit redirected to a route that 404s on the client side"
  in one assertion.

The killer combo for any rebuild of an existing site:

```bash
bash ~/.claude/skills/contract/scripts/verify-served-surface.sh \
  https://your-site/ \
  https://your-site/<every primary route> \
  --prelude tours/login-flow.json \
  --env-from .observe.env \
  --walk \
  --walk-exclude "^/(api|favicon)" \
  --expect-not "404 — try home" \
  --report .scratch/verify-e2e.json
```

Origin: a 2026-05-23 regression on this codebase — a route rename moved
`/app/outlets` → `/app/dashboard` but the login form still
`setLocation("/app/outlets")`'d. The URL-by-URL gate visited every route
directly and green-lit them, but the user submitted the login form and saw
"404 — try home". The prelude + walk gate would catch it at the
`expect_url: "/app/dashboard"` step, AND incidentally caught five
unrelated 400s firing from the dashboard before session-load.

Worked example — gate a guest cockpit that should render `Composer` + `attach`:

```bash
SID=$(curl -sS -X POST https://my-site.example/api/start-guest \
        -H 'content-type: application/json' -d '{}' \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionId"])')

contract spawn <root> \
  "guest cockpit renders content, not empty error boundary" \
  --action "bash ~/.claude/skills/contract/scripts/verify-served-surface.sh \
              \"https://my-site.example/app?guest=$SID\" \
              --wait-after-load 5000 \
              --min-text 300 \
              --expect 'attach' \
              --expect-not 'Application error' \
              --report .scratch/empathy.json"
```

**Why two layers in one script:** the served-surface and empathy checks
share the same headless load — running them as one walk is cheaper and
avoids the false-confidence of "served-surface passed so we're good" when
the empathy layer would have caught the empty page. Old `--allow` /
`--report` semantics are unchanged; empathy flags are additive.

Origin: a 2026-05-23 ship that passed the served-surface gate (no
console.error, no pageerror, no 4xx) on `https://unreel.ai/app?guest=<sid>`
yet rendered the Next.js error boundary instead of the cockpit, because
the `replay.getfoundry.app/tracker.js` host was down and the React tree
threw silently. The empathy gate would have caught it via `--expect-not
"Application error"` AND via `--min-text 300` (the error boundary has
~80 chars of visible text). The gate exists so this never recurs.

## No raw JSON in the UI (the "we don't ship a `pre`" rule)

A page that renders `JSON.stringify(data, null, 2)` inside a `<pre>` is
not a finished page — it's a debug log shipped to the user. The
served-surface + empathy gates light green on a dashboard whose
"insights" section just dumps the raw observed payload as fenced JSON,
because there's no console.error and the body has plenty of text. The
user sees `{"totalSpendingCurrWeek":4864.916,...}` and rightly calls it
"json like that." `--no-raw-json` catches it.

The flag scans `document.body.innerText` for two independent signals —
either fires:

1. **Multi-line pretty-print.** 4+ lines matching `\s*"key":` are visible
   (the signature of `JSON.stringify(obj, null, 2)` in a `<pre>`).
2. **Collapsed dump.** Any one line with 4+ `"key":` tokens (a one-line
   stringify rendered as copy).

Deliberately tolerant: one or two `"name": "value"` hits in prose don't
trip either threshold. The detector is looking for JSON-as-final-UI,
not JSON-as-quoted-example.

The rule it makes mechanical: **if you have a structured response,
render structured components — KPIs, ranked rows, cards. Never ship the
raw object.** When you don't know the shape yet, log it to the dev
console and render an honest empty-state for the user. JSON in the page
= "the rebuild is unfinished here."

Add this to every web-deploy gate by default:

```bash
bash ~/.claude/skills/contract/scripts/verify-served-surface.sh \
  <urls> \
  --prelude tours/login-flow.json --env-from .observe.env \
  --walk --walk-exclude "^/(api|favicon)" \
  --expect-not "404 — try home" \
  --no-raw-json \
  --report .scratch/verify-e2e.json
```

Origin: a 2026-05-23 dashboard ship that pretty-printed
`bySupplier` / `byCategory` / `insights` responses straight into
`<Markdown>` + ```json fences because the agent reached for the easy
serializer instead of writing real components against the observed
response shapes. The user said: "to make it so that we don't show json
like that ever lol." This gate makes that contract mechanical.

## Observe-original: trace before extract (standing default for any rewrite)

A counterpart to the served-surface gate, run in the **opposite
direction**: before rebuilding an existing site, drive its **live**
frontend through a scripted tour and capture exactly what it does on the
wire. Don't grep endpoints out of the bundle and guess — observe.

The pathology this prevents: pulling endpoint strings out of a compiled
JS bundle gives you the URLs but not the *contract*. Whether a GET
expects `Content-Type: application/json` (Spring rejects null on some
routes, accepts it on others); which extra context headers gate the
route (`outletId, supplierId, companyId`); the exact field name the body
expects (Zeemart's login is `ZeemartId`, not `email` — sending the wrong
field returns a generic 500 with no hint); the order in which calls
happen on a screen so React-Query keys can mirror it. None of this is
visible in the bundle. It IS visible on the wire.

```bash
contract spawn <root> \
  "api surface observed: every screen the rebuild needs is captured from the live original — per-screen endpoints, real headers, real payload, real status — in docs/<site>-screen-flow.md" \
  --action 'bash ~/.claude/skills/contract/scripts/observe-original.sh --tour tours/<site>.json --out docs/observed --env-from .observe.env && test -s docs/observed/screen-flow.md'
```

A **tour** is a small JSON file describing the click-path through the
original site:

```json
{
  "name": "buyer.zeemart.co",
  "base_url": "https://buyer.zeemart.co",
  "match_hosts": ["zm-", "buyer.zeemart.co"],
  "steps": [
    { "label": "login",     "goto": "/login" },
    { "fill": "input[type=email]",    "value": "${SITE_USER}" },
    { "fill": "input[type=password]", "value": "${SITE_PASS}" },
    { "click": "button[type=submit]" },
    { "wait_idle": 3000 },
    { "label": "outlets",   "screenshot": "01-outlets" },
    { "click": "text=Orders" },
    { "wait_idle": 3000 },
    { "label": "orders",    "screenshot": "02-orders" }
  ]
}
```

Each `label` step marks a new "screen"; every network request fired
between that label and the next is bucketed under it in the report.
The tour reads `${VAR}` from env (`--env-from .observe.env` is the
recommended channel — keep it gitignored).

Outputs (under `--out <dir>`):

- `screen-flow.md` — human-readable: each screen, its screenshot, every
  endpoint that fired with method + path + redacted headers + payload +
  status + clipped response, then a distinct-endpoint summary table at
  the end. **Read this before you write a single line of the rebuild.**
- `endpoints.json` — programmatic endpoint map keyed by host & path.
- `events.json` — raw per-request rows (the agent can reprocess).
- `screenshots/*.png` — one full-page screenshot per labelled screen.

Redacted by design: `mudra`, `authorization`, `cookie`, `ZToken`,
`accessToken` are replaced with `<redacted>` in the report so the
artifact is safe to commit. The login response payload that *carries*
those tokens is also clipped.

Filtered by design: `match_hosts` (string include) prevents the report
from drowning in CDN / analytics noise.

**The UX rule that comes out of this:**

Two artifacts give you a faithful rebuild surface, not one:
1. `endpoints.json` — what to call, with what headers, in what order.
2. `screenshots/*.png` + the per-screen endpoint clusters in
   `screen-flow.md` — what the user sees on each screen, and which calls
   power it.

Rebuilding screen-by-screen using *both* (route boundaries inherited
from the original) keeps the UX legible to existing users. Rebuilding
endpoint-by-endpoint without the screen grouping is how you ship an
"API client with a UI on top" that doesn't match anyone's mental model.

Origin: the 2026-05-23 buyer.zeemart.co rebuild — the agent grep'd
endpoint URLs out of `main.js` and guessed at headers/methods, hitting
415/405/400 cascades it had to debug live. Observing the *real*
frontend first would have produced the headers, payload shapes, and
screen-to-endpoint mapping for free. The recorder exists so this never
recurs.

## Multi-dimensional gates (the graph the substrate already gives you)

A contract whose `--action` is `contract:<id>` is a **gate by index** —
it resolves to satisfied iff the referenced contract is satisfied, with
no knowledge of how that other contract checks itself. Compose N such
pointer-gated children under one funnel and you have **pointer-gated children
that compose N gates from N independent dimensions** before the parent
resolves. The graph is decoupled by index; the substrate's nine shapes
already express it; **no new abstraction is required**.

This is the agent-facing recipe for "promotion through multiple layers
of dimensions before resolving." Each pointer is a dimension; each child
is one dimension's gate; the funnel/quorum/sequence over them is the
promotion logic.

### The pattern

```bash
# A deploy-shaped organ that must clear THREE independent gates before resolving:
#   - served-surface (no console.error / pageerror / 4xx)
#   - empathy (real content, no error boundary)
#   - observe-original (only if this is a rewrite — references the trace gate)
contract declare "<deploy north star>" --action funnel
# returns <root>

# Reference each standing gate as a pointer-gated child:
contract declare "served-surface holds for this deploy" \
  --action contract:27125bd7 \
  --parent <root>

contract declare "empathy holds for this deploy" \
  --action contract:4a055cf7 \
  --parent <root>

# Plus your domain-specific gate(s):
contract declare "the actual feature works end-to-end" \
  --action 'bash my/feature-verify.sh' \
  --parent <root>
```

`contract:<id>` reads the referenced contract's status from the ledger;
it does **not** re-run the other contract's action. Each dimension owns
its own iterate cycle and its own evidence. The parent's iterate becomes
"check every dimensional pointer". The agent judging KEY 2 at the parent
sees the graph composed and either marks satisfied (when every gate
genuinely fires) or spawns a child to close the missing dimension.

### Standing gate IDs (canonical pointers)

Already in the global ledger; reference by id:

| Standing gate | Ledger id | Dimension |
|---|---|---|
| served-surface gate | `27125bd7` | console / network crashes on first paint |
| empathy gate | `4a055cf7` | rendered content, no error boundary |
| observe-original gate | `f669f09c` | trace before rebuild |
| Foundry agent organism (receptors) | `838d1447` | external events → contract iterate (inbox + injectors) |
| R4: bot poller daemon | `bb9c351a` | long-poll getUpdates → `~/.contracts/inbox/telegram/<chat>.jsonl` |
| R5: generic webhook receiver | `20d51ba7` | cloudflare-tunnel-fronted HMAC-SHA256 endpoint → `~/.contracts/inbox/webhook/<source>.jsonl` |
| aiko reactor v2 (humanlike) | `95509a44` | full telethon history + project brief + grounded reply |
| Aiko bot fully utilises Telegram Bot API best practices | `7cb69f94` | /commands menu + reactions + inline keyboards + HTML + 429 retry |

Each is `agent-judges` so the project that references it binds the
concrete URLs / floors / substrings via a wrapper action (a sibling
contract whose mechanical action runs the actual `verify-served-surface.sh`
/ `observe-original.sh` call). The standing gate carries the **truth claim**;
the wrapper carries the **bound check**. This is the pointer-not-payload
discipline applied to gates.

The bottom five rows were promoted into the global ledger via
`contract promote <id>` on 2026-05-23 — substrate-level contracts
originally declared inside a project ledger that should be reusable
across every project. The verb is idempotent; promotion is reversible
only by manual ledger surgery (which the substrate forbids — supersede
instead).

### Viewing the graph

`contract graph <id>` renders the topology centered on a node — parents
(one level up), children (one level down with edge type annotation:
`└─ child`, `└─ contract-ref →<other-id>`, `└─ corroborate ↔<other-id>`),
and the `merged_into` lineage when present. Run it to see what
dimensions are wired into an organ before marking it satisfied.

```
$ contract graph <root>
[parents]
  ← <organ-above>  "<plan…>"  (sequence, pending)
[node]
  ● <root>  "deploy north star"  (funnel, active)
[children]
  ├ contract-ref → 27125bd7  "served-surface gate (standing)"   [satisfied]
  ├ contract-ref → 4a055cf7  "empathy gate (standing)"          [active]
  └ <id-of-domain-gate>      "the actual feature works…"        [pending]
```

### Why this is in /contract itself, not a project doc

The graph is universal — every organ benefits from naming its dimensions
explicitly and pointing at standing gates by id. Promoting it into the
skill means every future agent reaches for this composition without
re-discovering it. Origin: 2026-05-23, the agent shipped served-surface
+ empathy as documented patterns but the deploy organs didn't reference
them as children — the gates were aspirational documentation rather
than load-bearing graph nodes. Naming the pattern + giving the gates
canonical IDs closes that loop.

## Containment vs reference (why the substrate is a DAG of pointers, not a tree of nested objects)

The substrate makes a single design choice repeatedly: contracts **reference**
each other, never **contain** each other. The ledger is a flat append-only
stream where every row carries `parent_id` (upward reference) and `action` may
be `contract:<id>` (lateral reference). There is **no structural nesting** —
no row contains another row. The graph is reconstructed by walking those
references at read time.

This is correct, not accidental. Four first-principles reasons:

1. **Append-only is load-bearing.** Structural containment forces parent
   mutation when a child resolves — re-emit the parent row, or break
   immutability. References don't: marking child X satisfied is one
   appended row; the parent re-reads X's current status on next iterate.
   The ledger stays purely additive, and the natural-selection lifecycle
   (fossils, merged_into, lineage) works only because no row is ever
   rewritten.

2. **DAG, not tree.** A contract can be gated by many parents — the
   multi-dimensional gates pattern has many organs all reference the same
   standing gate (`contract:27125bd7`) as a child. Structural containment
   forces a tree (one parent per child). References model the real shape:
   a directed acyclic graph.

3. **The fractal claim is preserved.** Every row has the SAME shape at
   every scale: `{id, plan, action, parent_id?, …}`. A leaf cell and a
   root organ are structurally identical. Spawn at any depth, reference
   at any depth, view at any depth — same primitive. Containment would
   require qualitatively different leaf vs branch rows.

4. **Lazy resolution.** "Is X satisfied?" is a query at iterate time
   against the current ledger. The contract that REFERENCES X via
   `contract:<id>` doesn't carry X's state inline — it reads it freshly.
   This is the substrate principle ("no script bakes a verdict") applied
   to graph composition: every reference is a fresh question, never a
   cached answer.

### Sandboxes live at exactly two layers

| Layer | Mechanism | Granularity |
|---|---|---|
| **per-project ledger** | `CONTRACTS_STORE` env var | one ledger file per project; same IDs in different stores never collide |
| **per-contract action** | `cwd` field on the declared row | each contract's action runs in its declare-time directory |

No per-contract sandbox **within** a ledger. That's correct: within one
ledger, contracts share a graph, and the graph IS the value. Siloing them
further would break the cross-contract reference machinery that makes
multi-dimensional gating work.

### Three event channels, three intents (none interchangeable)

| Channel | Surface | Fires when | Right primitive for |
|---|---|---|---|
| **Internal hooks** | `_fire_contract_hooks` after every `iterate`/`_mark` | substrate-level events (any contract) | cross-cutting concerns that must fire universally — `drive-advance`, `crystallize-learning` |
| **`contract:<id>` action** | resolves another contract's status at iterate time | one specific dependency | in-graph gating, multi-dimensional composition, pointer-not-payload gates |
| **Receptors** | `wait-for-event.py` over `~/.contracts/inbox/<channel>/` | external world signal (telegram, webhook, stripe) | turning outside-the-agent events into iterate triggers |

These cover orthogonal axes: substrate-level (hooks), graph-level
(contract-refs), world-level (receptors). A hook fires for all contracts; a
contract-ref binds one specific dependency; a receptor turns external events
into actions. There is no fourth channel waiting to be invented — these
three exhaust the space.

### What's deliberately NOT in the substrate

- **A "contains" relation on a row.** Children are flat rows with
  `parent_id`. The tree is reconstructed, never stored.
- **Transitive satisfaction caching.** Each iterate re-resolves. The
  ledger IS the query history; recomputation is cheap and verifiable.
- **Per-contract isolation.** Contracts within one ledger share the
  graph — that's the point.
- **A `--lifetime` / typed-tag layer.** Shape IS the type system
  (contract `310f425f`).

Origin: 2026-05-23. The agent was asked "should contracts contain
contracts structurally, or stay decoupled by references?" The honest
answer was "already references — and here's why that's load-bearing,
not arbitrary." This section names the design so future agents see the
answer in the doc, not after re-deriving it from the row schema.

## Self-modeling (biology turned inward)


The skill that says "harness collects, agent judges" should hold itself to
that same rule. Every documented behavior of /contract — every shape, every
default principle, every standing gate — is a truth claim about /contract's
own code. Per the dev-routing rule above, a truth claim about /contract's
own files is **skill-modification**, and skill-modification is itself a
contract whose action checks the implementing code.

The result is a closed loop: /contract IS made of /contract.

### The shape gates (regression harnesses, one per shape)

Each of the 9 shapes has a dedicated gate under `~/.claude/skills/contract/<shape>-gate/verify.sh`
that exercises the shape's semantic claim against the running CLI:

| Shape | Gate proves… |
|---|---|
| `cell` | action exits drive KEY 1; `_mark` drives KEY 2 |
| `judgment` | `agent-judges` surfaces a KEY 2 prompt; never auto-resolves |
| `funnel` | AND-gate over children — resolves only when ALL satisfy |
| `funnel-first` | OR-gate — resolves as soon as ANY child satisfies |
| `loop` | `loop-until:<body>` re-runs body each iterate; converges on exit 0 |
| `harness` | `harness:<path>` delegates KEY 1 to `<path>/verify.sh` |
| `tool-guard` | PreToolUse hook blocks matching tools until the contract resolves |
| `sequence` | ordered funnel — iterate names the next unsatisfied stage |
| `quorum` | K-of-N — integrate-and-fire neuron, strictly between funnel (K=N) and funnel-first (K=1) |

Plus the orthogonal-feature gates (`audit`, `bm25`, `budget`, `lifecycle`,
`propagation`) that test cross-cutting behaviors of the substrate itself.

### Pre-flight self-checks (check yourself before you shrek yourself)

The self-test catches more than shape behavior. It also gates the substrate
against drift between SKILL.md and the implementing code — the kind of
self-inflicted wound the skill can commit without any external user
ever surfacing it. Each `self/*` check in `scripts/skill-self-test.sh`
catches one drift class:

| Self-check | Catches |
|---|---|
| `self/no-drift` | live introspection vs hardcoded prose (existing) |
| `self/heading-ladder` | a section header wedged inside another section (my own patch broke this once — Self-modeling appeared mid-way through Multi-dimensional gates) |
| `self/standing-gate-ids` | every `27125bd7` / `4a055cf7` / `f669f09c` referenced in SKILL.md still resolves to a ledger row with the documented plan text |
| `self/empathy-flags-wired` | every `--flag` named in the Empathy gate table is actually parsed by `verify.mjs` (docs and CLI agree) |
| `self/shape-catalog-matches-gates` | every shape named in the SKILL.md "shape gates" table has a corresponding `<shape>-gate/verify.sh` (catalogue == file system) |
| `self/no-contradictions` | scans SKILL.md for known drift classes (duplicate `##` headers, stale CLI verb counts vs `contract self`, L1 architecture verb subset masquerading as complete, dangling references like `bind_to` cited but never defined) — surfaces line numbers when it finds one |

These are not new shapes. They're plain `cell` contracts whose action is a
grep / Python one-liner against `SKILL.md` + the implementing file. The
pattern stays: substrate enables, agent judges.

### How the gates run

`scripts/skill-self-test.sh` runs every gate in a tempdir-scoped
`CONTRACTS_STORE` (no pollution of the real ledger) and asserts each one
exits 0. The runner is wired as a pre-commit on `~/.contracts/.git` so
every ledger event auto-revalidates the substrate's own claims. If a
future change to `scripts/contract` breaks (say) `funnel-first` semantics,
the next ledger write trips the pre-commit and the regression surfaces
before any contract can reference the broken shape.

### Why this matters (the biology read)

A pile of cells with documented behavior is a textbook. A pile of cells
whose behavior is BOUND by regression gates that exercise them
continuously is an organism. The shape gates ARE the organism's immune
system — they fire on every commit, flag drift before it propagates, and
keep the substrate's claims load-bearing rather than aspirational.

Origin: 2026-05-23. The skill documented 9 shapes but only 3 had
dedicated semantic gates; the other 6 (cell, judgment, funnel,
funnel-first, loop, harness) were described in prose with no binding
check. A regression in any of them would have escaped self-test.
Promoting all 9 to first-class gates closed that loop. Contract
`249a46c4`. The same turn surfaced four drift classes between SKILL.md
and the code that no gate caught — section-wedging, missing standing-gate
contracts, undocumented-implementation gaps, and shape-catalog vs
gate-directory mismatches. Those became the `self/*` pre-flight checks.


## Verb gates (regression harnesses, one per CLI verb)

Shape gates cover the **nine shapes** — the firing rules of the substrate.
They catch a `funnel` that resolves on partial children, a `loop-until`
that doesn't re-fire, etc. They do **not** cover the 44+ CLI verbs (see `contract self`) that
land on `~/.claude/skills/contract/scripts/contract`. A regression in
`promote` or `supersede` could ship undetected — the shape semantics
still pass; the verb just does the wrong thing.

Verb gates close that gap. Mirror of `audits/` and `<shape>-gate/`, one
finer level:

```
~/.claude/skills/contract/verb-gates/<verb>/
  verify.sh   # sandboxed CONTRACTS_STORE; happy path + ≥1 failure mode
  README.md   # optional — what truth the gate binds
```

**Verbs are language, contracts are sentences.** Per `310f425f` (shape
is the type system), there is no new shape and there are no
verbs-as-first-class-contracts. Each verb-gate is a plain `cell` whose
`--action` runs the verb against a tempdir-scoped ledger and asserts the
expected behaviour. The substrate's truth model — "verbs WRITE ledger
rows; contracts ARE ledger rows" — stays exactly as before. The gate
binds the language to its documented surface; nothing else changes.

### Why not verbs-as-first-class-contracts?

It was the natural-sounding alternative. It loses on three grounds:

1. **Bootstrap.** You'd need `declare` to declare `declare`. The
   chicken-and-egg can be papered over (seed rows at install time) but
   it's a permanent ugliness in the substrate.
2. **Hot-path cost.** Every CLI invocation would look up its verb's
   contract before dispatch. The bash dispatcher costs ~0; the contract
   resolver costs a ledger read. Multiplied by every verb ✕ every call,
   that's measurable.
3. **Layer confusion.** A verb is a primitive of the substrate's
   *language*. A contract is a primitive of the substrate's *claims*. A
   sentence is not a word; a word is not a sentence. The languages
   share the ledger, but they don't share their granularity.

Verb gates give the genuine win — "promote actually copies rows", "_mark
never silently fabricates" — without paying any of those costs.

### The runner + self-test wiring

`scripts/run-verb-gates.sh` walks `verb-gates/*/verify.sh` (mirror of
`scripts/run-audits.sh`). Wired into `scripts/skill-self-test.sh` as
`self/verb-gates-pass`, so every ledger event re-runs every verb's gate
through the pre-commit on `~/.contracts/.git`.

### Starter set (2026-05-23)

The first five gates were the verbs with the least existing coverage and
the highest blast radius if they broke. Each gate runs the verb against a
tempdir-scoped ledger and proves at minimum the happy path AND one
failure mode.

| Verb | What the gate binds |
|---|---|
| `promote` | Cross-ledger row copy preserves id + state; idempotent; unknown ids rejected |
| `_mark` | Writes `satisfied` row; `status` reflects it; unknown ids rejected (catch: this gate found a real silent-fabrication bug in `_mark` and the verb was fixed in the same wave) |
| `supersede` | `merged` row carries `merged_into=<winner>`; loser drops out of `list`; loser stays in raw ledger; unknown ids rejected |
| `corroborate` | Synapse event references both ids; unknown ids rejected |
| `learn` | Writes `learned` row + memory file; Outline push opt-out via `CONTRACT_CRYSTALLIZE_NO_OUTLINE=1` |

The other ~38 verbs land the same way as new gates are added — same
directory, same `verify.sh` shape. New verb → new dir → no skill change
required, no new shape.

### What a verb-gate's verify.sh does

1. Make a tempdir and trap-rm it.
2. Set `CONTRACTS_STORE` (or `HOME` if the verb hard-codes `~/.contracts`)
   to live inside the tempdir.
3. Run the verb with concrete inputs.
4. `grep` / `python3 -c` the resulting ledger to assert the expected
   row(s) appeared, with the expected fields.
5. Run the verb again with a deliberately invalid input — assert a clean
   error, not a silent success.
6. `exit 0` if every assertion holds; `exit 1` with `FAIL: <what>` otherwise.

Origin: contract `2db87011`, 2026-05-23. The skill had 14 shape gates + 5
self-checks + 1 audit but **zero** behavioural coverage for the 44+ CLI verbs.
The first wave of 5 verb-gates immediately found a substrate-principle
violation (`_mark` silently fabricated rows for unknown ids), proving the
pattern's value on day one. Contract `0167e892` is the SKILL.md doc gate;
the runner+self-test wiring is `9a2aa216`/`30e820c3`.


## Depth analysis (the resolution-chain walker)

`contract depth <id>` walks the multi-dimensional resolution graph
centered on a contract and surfaces four axes of recursion:

| Axis | What it measures | Wall |
|---|---|---|
| **depth_up** | longest chain of `parent_id` ↑ from `<id>` to a root | none (DAG) |
| **depth_down** | longest chain of `parent_id` ↓ from `<id>` to a leaf | none (DAG) |
| **dims** | number of contracts reached by following `contract:<id>` action refs | none (DAG) |
| **cycles** | any `contract:<id>` chain that loops back on itself (X → Y → X) | **HARD-BREAK** |

```
contract depth <id>                  # pretty layered report
contract depth <id> --json           # machine-readable
contract depth <id> --strict-cycles  # exit 1 on any cycle  (this is what _mark uses)
```

### Cycle = HARD BREAK ON RESOLUTION

The earlier question — *"can there be an infinitely recursive layer
gating in this design multi-dimensionally?"* — is structurally yes, but
**cycles are not recursion, they're divergence**. A `contract:<id>` cycle
(X gates on Y, Y gates on X) means satisfying either side would propagate
a false truth: Y is satisfied because X is, X is satisfied because Y is —
both circularly empty.

The substrate refuses. `_mark satisfied` runs `contract depth <id>
--strict-cycles` BEFORE writing the satisfied row. If a cycle is
detected, the substrate emits:

```
=== HARD BREAK ON RESOLUTION (cycle) ===
  🔥 CYCLES DETECTED (will hard-break on satisfy):
      <a> → <b> → <a>

  refuse to _mark <a> satisfied — closing this would propagate a false truth.
  break the cycle first (revise an action / supersede one side / declare a non-pointer leaf).
```

…and exits non-zero. No row is written. The agent must `revise` one side's
action away from the pointer, `supersede` one of the two, or declare a
non-pointer leaf at one end before the chain can resolve. This is the
substrate enforcement of "no false witness" (default #11) applied to the
graph composition layer.

### Depth/dims = soft warning (Miller's 7±2)

When `_mark satisfied` fires WITHOUT a cycle, the BREAK ON RESOLUTION
block runs the analyzer and surfaces warnings when the graph exceeds
working-memory capacity:

| Threshold | Warning |
|---|---|
| `depth_total >= 7` | exceeds Miller's 7±2 working-memory cap — KEY-2 judgment may degrade |
| `dims >= 4` | KEY-2 becomes pattern-matching above ~3 dimensions |

These are soft — the agent decides whether to honor. The substrate
surfaces; it never forbids. (Contrast: cycles are hard because they're
mechanically unresolvable, not just cognitively expensive.)

### Why this is in /contract itself, not a project-local script

The graph IS the substrate. Cycle detection at mark time is universal —
any organ in any project benefits from refusing to satisfy through a
circular gate. The Miller-cap soft-warn is universal — agents reading
KEY 2 at any depth need the integration-vs-pattern-matching honesty.

Origin: contract `fb9698f7`, 2026-05-23. The question "can there be
infinitely recursive layer gating?" surfaced the gap: structurally yes,
mechanically only if cycles are caught. The verb-gate (`verb-gates/depth/`)
proves the analyzer + the hard-break on a 2-node cycle in <1s, including
that the satisfied row is NOT written.


## Self-organism (the wrap)

Every section above documents a claim /contract makes about itself:
"nine shapes", "Eleven principles", "44+ verbs", "every Origin: cites a real
contract", "every bundled script exists". The **self-organism** root
`b77ad5d1` is the single funnel that pointer-gates on every one of those
layer-claims. Iterating it walks every binding gate the substrate has,
fractally. **The substrate is BOTH the speaker and the listener for its
own claims** — same primitive, both sides.

### The four self-binding gates (new in this wave)

| Gate (cell) | Binds the claim |
|---|---|
| `self/origin-citations` | every `contract <8hex>` cited in SKILL.md resolves in the global ledger (no fake-witness) |
| `self/bundled-scripts` | every path listed under "Bundled scripts" exists on disk |
| `self/doctrine-binding` | every Ψ/Ε/Σ/Α doctrine is declared + at least 3/7 are runtime-bound (honest gap surfaces the rest as TODO) |
| `self/default-contracts` | SKILL.md says "Eleven principles" AND lists 11 rows AND `contract defaults` enumerates 11 |

Each runs in `scripts/skill-self-test.sh` as a `self/*` check alongside
`self/audits-pass` and `self/verb-gates-pass`, so every ledger commit
re-verifies the whole substrate's self-binding via the `~/.contracts/.git`
pre-commit hook.

### Why this is THE wrap

Per "verbs are language, contracts are sentences": every other binding
gate (shape, verb, audit) binds a piece of the language. The
self-organism binds the **identity statement** the substrate makes — "I
am what I document." A skill that documents 9 shapes but ships 7 is
lying; a skill that cites contract `fb9698f7` in its origin notes but
that id doesn't exist anywhere is lying. The wrap makes lying
mechanically impossible: the pre-commit hook fails before the lie ships.

Real drift caught on the first wave (2026-05-23):
- 5 cited contract ids in SKILL.md resolved nowhere globally (promoted via `contract promote`).
- 1 bundled-script path had a `~` expansion bug in the checker (fixed).
- The `contract defaults` CLI verb enumerated 10 principles while SKILL.md said 11 (CLI was missing `substrate-enables` row #1 + had off-by-one numbering for the second table).
- 4 of 7 doctrines (Ψ1/Ε1/Ε2/Σ1) were documented but not runtime-bound; gate softened to "≥3 bound, name the rest as aspirational" — those four are the follow-on binding work.

The substrate found the lies and forced them into truths in the same wave.
That's what "wrap" means.

Origin: contract `cc5e8920`, 2026-05-23. Self-organism root: `b77ad5d1`
(in the global ledger; other projects can `contract:b77ad5d1` to assert
"the /contract substrate I depend on is itself self-bound").


## Honest self-awareness (the drill loop)

"Self-aware" is a philosophical claim and the substrate doesn't try to
own it in the philosophical sense. The **achievable, mechanical** version
the substrate ships is:

> Every claim with a binding gate **passes** (mechanical); every claim
> without one is explicitly **catalogued as aspirational** (epistemic).

Both halves are required. A skill that passes every check it built but
lies about claims it never built a check for is not self-aware — it's
selectively honest. A skill that catalogues every gap but doesn't
mechanically enforce the bound ones is not honest — it's introspective.
**Mechanical + epistemic = honest self-awareness.**

### The drill loop

`scripts/self-drill.sh` is the programmatic loop the substrate runs
against itself. Each round:

1. Run `scripts/skill-self-test.sh`, capture every failing check.
2. For each fail in a known-fixable class, apply the fixer:
   - `self/origin-citations` → find the orphan id in any project ledger
     and `contract promote` it.
   - `self/default-contracts` / `self/bundled-scripts` /
     `self/doctrine-binding` → require source edits; surface as
     `aspirational-gap` for agent review (not auto-fixed; the gate IS
     the surface).
3. Re-run; cap N=8 rounds.
4. Append one wave row per round to `~/.contracts/self-drill.jsonl`.
5. Final `verdict` row: `all-green` if every check passes, else
   `aspirational-gap` with the residual fails named.

The drill log IS the proof of self-awareness — it captures what the
substrate could mechanically converge AND what remained as known
aspiration in the same artifact.

### Aspirational gaps catalogue (residual, 2026-05-23)

These claims are documented but lack a runtime binding **at the layer
this catalogue tracks** (the `self/doctrine-binding` and verb-gates
classes). They are **named, not lied about**:

| Claim | Documented in | Status | What would close the gap |
|---|---|---|---|
| Ψ1 — Layer purity (`--verbose` hides L0) | Psychology § | no `--verbose` flag on iterate/status | add `--verbose` and hide L0 by default |
| ~39 verbs without dedicated verb-gates | Verb gates § | starter set is 5; rest rely on indirect coverage via shape gates + self-test verb runs | add `verb-gates/<verb>/verify.sh` per verb (same audits/ doctrine) |

Already bound (was previously listed here as aspirational; corrected on
contradiction purge):

- **Σ1 agent attribution** is bound — `skill-self-test.sh`
  `humanlike/agent-attribution` proves `CONTRACT_AGENT` env carries
  through to ledger rows via `contract_core.declare`.
- **Ε1 failure-streak escalation** is bound — `humanlike/failure-streak`
  proves the iterate surface emits the streak banner after 3 consecutive
  FAILs.
- **Ε2 over-iteration warning** is bound — `humanlike/over-iteration`
  proves the iterate surface emits the "what risk?" prompt after 3
  consecutive PASSes without `_mark`.
- **`bind_to + verify` primitive** is bound — `binding/declare-bind-to`
  and `binding/verify-foreign` prove the field is wired through
  `declare`/`get` and the `verify` verb exists.

Each remaining gap is a declared truth claim that the substrate cannot
mechanically prove today. The drill log records this as `verdict =
aspirational-gap` when the gap-bound classes trip, so no future agent
reading the substrate mistakes documentation for binding.

### Why this terminates honestly

The drill loop has three possible terminations:

1. **`all-green`** — every binding gate passes. The substrate is
   honestly bound at every layer it claims a binding for.
2. **`aspirational-gap`** — some gates fail in a class the auto-fixer
   can't resolve (source edits, doctrinal additions). The residual is
   named. Honesty preserved by surfacing.
3. **`MAX_ROUNDS` exhausted with no convergence** — never expected to
   happen at substrate scale; would indicate a fixer that introduces
   new failures (anti-pattern caught by Σ1's attribution if it were
   wired). The drill exits 1 and the agent investigates.

Self-aware in the achievable sense IS this loop terminating in 1 or 2
with the verdict + residual in the ledger. The substrate cannot promise
philosophical self-awareness; it CAN promise honest accounting of every
claim it makes about itself.

Origin: contract `df89a300`, 2026-05-23. Lewis said "keep drilling it
i n a loop programmatically til its self aware and honest" — the
honest reading: build the loop, run it, ship green or ship the gap
named.


## Audits (corpus-wide rule enforcement, paired with idempotent fixers)

A rule documented in prose lives nowhere. A rule with a verifier lives in
one file. A rule with a verifier **plus an idempotent fixer plus a corpus
scope** lives across the entire substrate forever. That last form is what
`audits/<rule>/` is.

The biology read: shape gates are the **immune system** (per-shape
regression checks). Audits are the **homeostatic regulator** — they sweep
the corpus continuously and pull every drifting cell back into range.

### Directory convention

```
~/.claude/skills/contract/audits/<rule>/
  verify.sh   # pure-read, exits 0 on full-corpus compliance, 1 otherwise
  fix.sh      # idempotent, brings the corpus into compliance, never edits content
  scope.txt   # newline-separated globs of corpora the rule applies to
  README.md   # what the rule is, why it exists, link to memory + contract
```

The `scope.txt` file is the substrate's answer to "what does this rule
apply to?" Each non-comment line is a shell glob (resolved with `eval echo`
so `~` and `*` work). The audit walks every matched directory.

### The runner + self-test wiring

`scripts/run-audits.sh` walks `audits/*/verify.sh` and runs each in turn.
It's wired into `scripts/skill-self-test.sh` as `self/audits-pass`, so the
pre-commit hook on `~/.contracts/.git` re-runs every rule's corpus audit on
every ledger event. A rule that drifts shows up in the next commit, not
two weeks later when Lewis catches it.

### What lives in audits vs check-*.py vs shape-gates

| Layer | Scope | Lives at | Example |
|---|---|---|---|
| **shape gate** | one of the 9 contract shapes | `<skill>/<shape>-gate/verify.sh` | `cell-gate`, `funnel-gate` |
| **drift check** | SKILL.md docs vs implementing code | `scripts/check-*.py` | `check-heading-ladder.py`, `check-shape-catalog.py` |
| **audit** | a corpus rule across many files | `audits/<rule>/verify.sh` + `fix.sh` + `scope.txt` | `audits/memory-layering/` |

Shape gates fire when the CLI's semantics drift. Drift checks fire when
docs and code disagree. Audits fire when the **content the substrate
governs** drifts — memory files, ledger rows, generated artifacts.

### Worked example — `audits/memory-layering/`

The three-layer doc-org rule (contract `767fd41d`) is the first audit. Its
files:

- `verify.sh` — walks every `~/.claude/projects/*/memory/` + `~/.claude/memory/`
  and runs `scripts/check-memory-layering.py` against each. Exits 1 on any
  violation across the whole corpus (559 files, 39 dirs at last count).
- `fix.sh` — calls `scripts/backfill-memory-layering.py` against the same
  dirs. Idempotent: trims over-long descriptions/hooks/titles, indexes
  orphans, wraps unparseable files with synthesized frontmatter, renames
  truncated-slug files. Body content is never touched.
- `scope.txt` — `~/.claude/projects/*/memory` + `~/.claude/memory`.
- `README.md` — what the rule is + how it was introduced.

When the rule was added in contract `767fd41d`, the original fix touched
only the project memory dir it ran in (115 files). Lewis caught the gap:
"whenever you make some change like that, you could actually rewrite all
things to update to match." Contract `d4074595` promoted the fix into the
audits convention; re-running surfaced **236 violations across the other
39 dirs**, all fixed by the same idempotent script.

### Rules for adding a new audit

1. **Build verify.sh first**, before fix.sh. The audit is the rule made
   executable; without it, "the corpus passes" is unfalsifiable.
2. **Walk the WHOLE scope**, not just the dir you're editing. The point
   of `scope.txt` is to make the corpus surface explicit.
3. **fix.sh is idempotent.** Running it on a green corpus reports 0 fixes
   and changes nothing. Without idempotency, re-runs cause churn.
4. **fix.sh never touches body content.** Memory bodies are knowledge the
   agent wrote; the fixer only adjusts metadata layers (frontmatter,
   index lines, slugs, file wrapping).
5. **Mark satisfied only when corpus-wide verify is green.** Local-only
   "I fixed the file I touched" is not satisfaction — the rule applies to
   the whole corpus or it applies to nothing.

Origin: 2026-05-23. The agent shipped the layering rule + a narrow
bespoke fixer for one folder. Lewis pointed out: "deep solve this
properly" — meaning generalise the pattern. Contract `d4074595`. The
result is the audits/ directory convention with `memory-layering` as the
worked first instance — and the meta-rule that every future rule lands
the same way.


## Biology gaps shipped: apoptosis · inhibition · hebbian

Three biology primitives were mapped into the substrate after the
question "what else from biology could /contract into contract that are
good gaps to work with?" surfaced honest holes. Each lands as a query
verb or a single field — no new shape (per `310f425f`, shape IS the type
system). Together they extend the neuron model with **time-bound
truth**, **negative regulation**, and **behavioral correlation**.

### Apoptosis (time-bound truth) — `contract stale`

A satisfied row is not eternal truth — it was true when the action last
fired. Real cells have programmed death: a finite lifespan after which
the cell auto-terminates regardless of input. The substrate analogue is
**staleness**: a satisfaction has an implicit half-life, and the agent
should re-iterate after enough wall-clock time has passed.

`contract stale` is a query verb (no new shape, no new field — staleness
is a documented convention on existing satisfactions):

```bash
contract stale                       # default --since 7d
contract stale --since 24h
contract stale --since 30d --json
```

Surfaces every satisfied contract whose latest `satisfied` row is older
than the cutoff, with its plan + age + the suggested next action:

```
=== CONTRACT STALE (--since 7d) ===
  2 satisfied contract(s) older than 7d:
  [12.4d] abc1234   served-surface clean on https://...
         last satisfied: 2026-05-11T...Z
         -> contract iterate abc1234     # re-prove the claim still holds
         -> contract supersede abc1234 <winner>  # if the claim is obsolete
```

The substrate surfaces; the agent decides whether to re-iterate or
supersede. No clock-judgment is baked in — the agent's `--since` is the
threshold for *this* iteration. Verb-gate: `verb-gates/stale/verify.sh`
proves the happy path + the bad-`--since` refusal. Origin: contract
`20402720`.

### Inhibition (negative regulation) — `--inhibits <id>`

Real neurons have both excitatory and inhibitory inputs. The substrate
had only excitatory composition (funnel/quorum/sequence — all fire-when
predicates). **Inhibition** is the orthogonal axis: a satisfied
inhibitor **blocks** a downstream contract from satisfying, distinct
from supersession (lifecycle) and tool-guard (capability).

Declared at the inhibitor:

```bash
contract declare "feature flag X is OFF" \
  --action "test ! -f /etc/flag-x" \
  --inhibits abc1234           # this contract, when satisfied,
                               # suppresses _mark satisfied on abc1234
```

The `inhibits` field lives on the declared row of the inhibitor; one
contract can inhibit many targets (pass `--inhibits` repeatedly). At
`_mark satisfied <target>` time, the substrate scans for any contract
with `target` in its `inhibits` list whose own status is `satisfied`. If
any such inhibitor is firing, the mark is **refused** with a non-zero
exit and an `=== INHIBITION REFUSAL ===` block that names every active
inhibitor by id + plan. No satisfied row is appended.

The refusal lifts only when every active inhibitor is released —
typically via `contract supersede <inhibitor> <winner>` (the inhibitor
becomes a fossil and stops contributing to active-inhibitor scans).

Verb-gate: `verb-gates/inhibits/verify.sh` proves the field plumbing,
the fire-when-clear happy path, the refusal under active suppression,
the multi-inhibitor surface, and the lift-on-supersede. Origin: contract
`d830f26e`.

### Hebbian (co-iteration synapse) — `contract synapse`

"Cells that fire together wire together." `contract search` surfaces
contracts related by **plan text** (BM25 + embeddings). It does NOT
surface contracts related by **co-iteration behavior**: two contracts
that always get iterated within the same wave-window are probably about
the same thing even when their plan text is dissimilar.

`contract synapse` walks the ledger's `iterated` events, finds pairs of
distinct contracts whose iterations fall within the same wave-window N
times, and surfaces them as `corroborate` candidates:

```bash
contract synapse                                  # default --window 300s --threshold 2
contract synapse --window 60 --threshold 5
contract synapse --window 600 --json
```

Output names each pair, the co-iteration count, both plans, both
statuses, and the suggested `corroborate` command. Already-corroborated
pairs are excluded (the substrate doesn't re-suggest existing synapses
— corroboration IS the wired-up synapse).

The substrate surfaces; the agent declares the corroboration. Never
auto-fires — that would violate "no script bakes a verdict" (CLAUDE.md
default #4 / C-G01).

Verb-gate: `verb-gates/synapse/verify.sh` proves the detection on a
constructed ledger, the threshold + window respected, and the
already-corroborated exclusion. Origin: contract `5fc64e98`.

### Why these three, why no more in this wave

Mapped: apoptosis (time-bound truth), inhibition (negative regulation),
Hebbian co-iteration (behavioral correlation).

Considered + rejected as overlapping existing primitives:
- **Mitosis / cell division** — `contract spawn` already does this.
- **Stem cells** — `contract revise` already replaces an action late-binding.
- **Hormonal signaling** — receptors (broad inbox filters) cover this.
- **Glia / supporting cells** — the `audit/*` and `self/*` contracts ARE this.
- **Mycorrhizal networks** — the cross-substrate standing-gate pattern (via `contract promote` + global ledger) covers this.
- **Entropy / decay** — apoptosis IS this; explicit `--halflife` was rejected by `310f425f` and remains so.

Considered + deferred (genuine gaps, not yet shipped):
- **Pain / nociception (priority interrupts)** — no use case surfaced yet.
- **Sleep / consolidation (nightly compress)** — hooks already partly cover this.
- **Energy budget aggregate** — `--budget` is per-contract; a tree-wide energy ledger would be a separate wave.

Organ root: contract `082e72cd` (biology gaps shipped). The three
children are `20402720` (apoptosis), `d830f26e` (inhibition),
`5fc64e98` (hebbian); each is gated on its verb-gate.


## Identity (public-facing is Aiko)

The substrate has two voices, gated by `Σ2 --audience`. Internally,
`team` and `private` rows speak the substrate's own L0/L1 vocabulary —
shapes, cells, KEY 1/2/3, ledger events, hooks. Externally, every row
declared `--audience public` (and every transport-rendered requirement
block that lands in front of a non-developer — `=== PAYMENT REQUIRED ===`,
`=== SIGN-IN REQUIRED ===`, `=== INHIBITION REFUSAL ===`, anything the
Telegram bot / web app / Panel surfaces back to a human end-user) speaks
as **Aiko**. The substrate's public face IS Aiko's voice.

The full voice rule set lives in the **`aiko-voice` skill**
(`~/.claude/skills/aiko-voice/SKILL.md`) — pointer-not-payload, so this
section names the load-bearing rules and refers out for the canonical
shipped strings, banned-jargon table, and UGC hook engine.

### The load-bearing voice rules (read aiko-voice for the rest)

1. **Employee, not tool.** Aiko is who you hire, not what you configure.
   "She finishes the job, end to end." Not "agent," not "assistant" in
   product-feature copy, not "cell," not "MCP server."
2. **First-person feminine when speaking, third-person feminine when
   described.** "I read your inbox" / "She reads your inbox." Never "the
   substrate," never "the system," never "it" in a public-facing line
   where the speaker is Aiko herself.
3. **No substrate jargon in public rows.** `cells / shapes / KEY 2 /
   funnel / iterate / mark satisfied / quorum / ledger / hooks / MCP /
   CLI / agents` are L0/L1 terms. They never appear in a `--audience
   public` row or transport-rendered block. The substrate translates
   downward at the boundary; it does not leak.
4. **Asks before the irreversible step.** Send, pay, book, publish — the
   public surface always names the upcoming irreversible action and
   waits for the human. Aiko is not "drafts and waits"; she is
   "finishes, but pauses at the gate that can't be undone."
5. **No AI-slop adjectives.** `powerful / seamless / unleash / elevate /
   next-gen / robust / enterprise-grade` are forbidden in any public
   row. Concrete proof or cut.
6. **By tomorrow it's up to speed.** Aiko learns the user, not the
   reverse. No "prompt engineering," no "configure," no "wire up."
   The framing is "sign in once, by tomorrow she knows your inbox /
   calendar / suppliers / cadence."
7. **No em dashes.** House rule, also an AI tell. Commas, periods,
   semicolons do the work.

### What this means mechanically

| Surface | Audience | Voice |
|---|---|---|
| Telegram bot reply / web modal / Panel card / mobile push | `public` | Aiko — first-person feminine, no jargon, asks before irreversible |
| `contract iterate` / `contract status` / hook log | `team` | substrate — shapes, KEY 1/2/3, ledger event names |
| Internal ledger row (`declared`, `iterated`, `satisfied`) | `private`/`team` | substrate — full vocabulary, agent attribution, proof fields |
| `=== PAYMENT REQUIRED ===` / `=== SIGN-IN REQUIRED ===` block rendered to a paying user | `public` (the user is non-developer) | Aiko — "I need you to add $5 in credits before I can finish this" — render-hint becomes Aiko's prose, not a stack trace |

The substrate enables the split; the agent renders the voice. There is
no auto-translator from L1 to Aiko. The agent reading a `--audience
public` row writes Aiko's voice in that surface. Self-check
`self/identity-binding` (in `scripts/skill-self-test.sh` +
`scripts/check-identity-binding.sh`) statically verifies the Identity
section is present, cites `aiko-voice`, names ≥4 of the seven load-bearing
rules, and references the `public`/`team`/`private` tiering as the
gating mechanism.

### Why this is in /contract itself, not just aiko-voice

`aiko-voice` is the **execution layer** — the exhaustive rules an agent
writing customer-facing Aiko copy must follow. `/contract` is the
**substrate** that emits public-facing rows in the first place. Binding
the substrate's public surface to Aiko's voice at the doctrinal layer
(here) makes it impossible for a future agent to ship a public row in
the substrate's own voice ("cell 7afc6d27 unsatisfied: funnel-first
needs ANY child to fire") to a user who has never read the SKILL.md.
The substrate's public face is Aiko's; the substrate's internal face is
the substrate's. Both true at the same time, gated by `Σ2`.

Origin: contract `1bed8068`, 2026-05-23. Lewis asked "/contract public
identity to be aiko and /contract to dig history of what aiko is
supposed to be personality wise and make that the /contract identity
too." The ledger and the `aiko-voice` skill already carried the voice;
this section binds it as a `Σ2`-gated property of the substrate so
every future transport-rendered public surface inherits the discipline.
