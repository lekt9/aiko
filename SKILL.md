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

On any invocation: read `ledgers/contracts.jsonl` — it is the only truth. The full verb list (38+) is discoverable via `contract self`; the table above is the load-bearing front door (Ψ2, working-memory cap).


## Architecture (L0-L2)

- **L0 core** — `scripts/lib/contract_core.py`: data model, the only code that touches `ledgers/contracts.jsonl`. `declare()`, `record_iteration()`, `mark_satisfied()`, `get_tree()`, `list_all()`, `children_satisfy()`.
- **L1 CLI** — `scripts/contract`: the verb surface. `declare`, `iterate`, `build`, `spawn`, `solve`, `status`, `list`, `search`, `_mark`. Every verb either writes one ledger row or emits a structured prompt; nothing else.
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

### Α — Aesthetics (craft signal)

A plan that doesn't name a concrete truth claim is aesthetically incomplete
even if its action mechanically passes. Α1 surfaces a quality signal at
declare time without blocking — substrate enables.

| # | Default | Warns on |
|---|---|---|
| **Α1** | **Plan-text quality surfacing.** Plans shorter than 24 chars or matching generic patterns (`^do X$`, `^fix Y$`, `^build Z$`, `^implement W$`) emit a soft warning at declare: "plan text reads as a task, not a truth claim — does it name what must hold?" | wishy-washy plans that satisfy mechanically but never make a binding claim |

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

The `contract:<id>` form is pointer-to-pointer: the action is satisfied when the referenced contract is satisfied. This lets one contract's truth claim depend on another without embedding any logic.

The ledger records every pointer call as a row (`event: iterated`), so you always have a history of what was queried, when, and what it returned. The ledger IS the query history.

Rules:
- Never hardcode a decision inside `--action`. The action checks; it never decides.
- If the check requires a server or API, the pointer is the URL; the server holds the logic.
- A `contract:<id>` pointer resolves the referenced contract's current status from the ledger — it does not re-run the action; it reads the declared truth.
- `pointer_type` is stored on every `declared` row and returned by `get()`. It is evidence for the agent, not a baked verdict.
- Actions are bound to their declare-time working directory. `contract_core.declare()` records `cwd` on every row; `iterate` runs the action from it (rows predating the field fall back to the current directory). Declare a contract from the directory its action should run in, and a relative-path action stays correct even when iterated later from elsewhere. Do not bake `cd <dir> &&` into an action.


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

Each is `agent-judges` so the project that references it binds the
concrete URLs / floors / substrings via a wrapper action (a sibling
contract whose mechanical action runs the actual `verify-served-surface.sh`
/ `observe-original.sh` call). The standing gate carries the **truth claim**;
the wrapper carries the **bound check**. This is the pointer-not-payload
discipline applied to gates.

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
