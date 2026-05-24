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
| "drill these proposed things in a while loop / finish without asking" | `contract drill <id> [<id>...] [--auto-mark-cells] [--auto-judge]` |
| "what contracts exist" | `contract list` or `contract status [<id>]` |
| "is this a recurring pattern?" | `contract search` |
| "convert past patterns" / "don't lose this in the refactor" | `contract import <source>` |

On any invocation: read `ledgers/contracts.jsonl` — it is the only truth. The full verb list is discoverable via `contract self` (live introspection — count drifts as verbs are added); the table above is the load-bearing front door (Ψ2, working-memory cap).


## Doctrine delegation (the thin-index discipline)

The substrate's own pointer-not-payload law applied to **this file**.
SKILL.md is a thin INDEX of doctrines, not their full prose. Each
doctrine lives in three load-bearing places (Β3, `9d3f399f`):

1. **Standing-gate contract** — the bindable id, audit trail, +
   load-bearing narrative on the row's `plan` field.
2. **Outline appendix** at `docs.getfoundry.app` — the human-readable
   long-form narrative.
3. **SKILL.md** — a ≤120-line summary that cites the standing-gate id
   so an agent reading SKILL.md can `contract status <id>` for full
   evidence + `contract:<id>` to pointer-bind it.

Β4 (`fc3d71fd`) is the runtime binding: `check-skill-md-thin-index.py`
counts doctrine sections, fails on size cap (total ≤1200 lines) and
fat-section cap (each ≤120 lines), surfaces unregistered doctrines as
warnings. The substrate self-corrects continuously: a fat new doctrine
trips the gate on the next ledger commit, the agent shrinks it, the gate
goes green.

Why not put doctrine prose under `references/<slug>.md`? Β3's
`audits/references-purge/` explicitly forbids it: duplicating prose
across files + the standing-gate row + the Outline doc creates
three-way drift that no gate can keep coherent. The narrative belongs
on the contract row (canonical) and the Outline doc (readable). SKILL.md
keeps only the summary.

The doctrine roster lives at `references/REGISTRY.md`. Read it to find
which standing-gate id binds which doctrine.


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

## Drill (synchronous in-thread while-loop over N targets)

`contract drill <id1> [<id2>...] [--auto-mark-cells] [--auto-judge] [--max-waves N] [--outer-rounds N]`
is the synchronous in-thread sibling of `drive`. Where `drive` arms an
async sentinel-based loop on **one** organ (re-fires across turns via
Stop/SessionStart hooks), `drill` blocks **in-thread** and loops across
**N** named targets until each is settled (`satisfied`/`merged`/`rejected`)
or the outer-round budget is exhausted.

It is the substrate-level answer to *"every named-but-pending thing /contract
just proposed gets drilled in a while loop in the same turn — unless
already completed properly."* The agent's prior discipline ("never end a
/contract turn with a satisfiable contract left pending") becomes
mechanical: surface N pendings → close the same turn with
`contract drill <id1> ... <idN>` → either every target settles or the
ones that didn't are honestly named in the report.

### The loop

For each outer round (default 8, mirrors `self-drill`):

1. Filter targets: skip every id already `satisfied`/`merged`/`rejected`
   (the **"unless already completed properly"** carve-out).
2. For each remaining id, call `drive-watch <id>` — the existing
   one-organ synchronous loop. `drive-watch` walks the tree leaf-first,
   iterates the next pending leaf, and HALTS on judgments awaiting KEY 2.
3. If `--auto-mark-cells` was passed, mechanical cells exiting 0 are
   auto-marked (carries `--proof-skip` naming the wave context).
4. If `--auto-judge` was passed AND Λ1 is available (codex CLI on PATH
   or `CONTRACT_LLM_URL` set), drill calls `contract judge <id>` on the
   halted leaf; a `PROMOTE` verdict triggers `_mark satisfied --proof
   "drilled via contract drill — Λ1 PROMOTE in outer round N"`.
5. After the inner pass, if any target's status changed, the outer
   round counts as progress and the loop runs again. If a full round
   makes no progress, drill halts with an honest "remaining N target(s)
   need human KEY-2 or external state" message — never a fake-green.

### Exit semantics

| Outcome | Exit |
|---|---|
| Every target settled (satisfied/merged/rejected) | 0 |
| ≥1 target still pending after halt | 1 |
| Usage error (no ids, unknown id, unknown flag) | 2 |

The final report enumerates every target with its terminal status, so
the caller never has to re-query.

### Composition with the rest of the substrate

- KEY 2 stays agent-judged. `--auto-mark-cells` is a KEY-2 surrogate
  for mechanical cells only (action exit 0 = genuine). `--auto-judge`
  delegates KEY 2 to Λ1 (any OpenAI-compatible LLM) — same discipline
  as `contract judge`. Without either flag, drill iterates and halts —
  caller renders KEY 2 in-thread on the next turn.
- Plan-fulfillment proof is preserved: every auto-mark carries a
  specific `--proof-skip` reason (drill outer round + Λ1 verdict, or
  drive-watch's "mechanical cell exit 0 wave N/M") — bare marks are
  still refused.
- Ω1 unblock-rewake fires automatically: drilling a chain like
  `[X, Y]` where Y is HOLD'd on X, and X resolves, will surface Y as
  re-judgeable in the next outer round and try again.
- Inhibition is honored: if a target is suppressed by a satisfied
  `--inhibits`, the `_mark` is refused (`=== INHIBITION REFUSAL ===`)
  and drill leaves it pending — exiting 1 with the blocker named in
  the final report.

### Verb-gate

`verb-gates/drill/verify.sh` binds five phases:

1. `contract drill` with no ids → usage on stderr, exit 2.
2. Already-satisfied id → no-op carve-out, exit 0.
3. Multiple mechanical cells + `--auto-mark-cells` → all settled, exit 0
   (this phase also catches a real regression in `drive-watch` if its
   auto-mark stops carrying `--proof-skip`).
4. Unknown id → exit 2 with "not found in ledger" message.
5. Pending cell without `--auto-mark-cells` → stays pending, exit 1
   (proves drill doesn't silently auto-promote).

Origin: 2026-05-24. Lewis: *"programmatically /contract it in the skill
to drill all things that you propose to me as a while loop until there's
nothing left unless the /contract goal's already completed properly."*
The prior pattern was agent discipline ("surface pendings then drive
the tree in one invocation") that I forget on long turns. Promoting it
to a verb with a verb-gate makes the discipline mechanical: every
"here are the things I propose" closes with a `contract drill <ids>`
call in the same turn, and the substrate's own regression check
ensures the verb keeps doing what it claims.

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
| **Σ6** | **Multi-client presence + first-write claim — `contract session register/list/claim`.** Σ3 gives the identity, Σ4 gives the inbox, but neither tells the substrate *which* clients are online right now. Σ6 closes that loop with three subcommands: `session register --canonical <id> --transport <tg\|web\|panel\|terminal> --client-id <id>` writes a presence row to `~/.contracts/inbox/sessions/<canonical>.jsonl` (resolved via Σ3, so registering as `lekt8` is the same as registering as `lewis@getfoundry.app`); `session list --canonical <id>` returns every client whose presence row is younger than TTL (default 300s — re-register to heartbeat); `session claim <requirement-id> --client-id <id>` is first-write-wins at `~/.contracts/inbox/claims/<requirement-id>.jsonl`. A subsequent claim by a different client_id exits 1 with `=== ALREADY CLAIMED ===` naming the original claimant — so two devices don't both render the same payment modal. Same-client re-claim is idempotent (the transport adapter can retry safely on flaky networks). Verb-gate: `verb-gates/session/verify.sh`. Origin: contract `f580248f`, 2026-05-23. | one user, many devices, shared context: when a requirement block fires for `lewis`, every registered tg/web/panel/terminal client tails the agent inbox and sees it; the first to call `claim` renders the generative UI, the others show a "resolved on another device" hint. The substrate doesn't pick the renderer — it surfaces who's present and arbitrates the race. |

### Cross-device generative-UI in one paragraph

Lewis on his laptop iterates a contract → 402 fires → the substrate emits
`=== PAYMENT REQUIRED ===` AND (when `CONTRACT_AGENT` is set) appends a
matching row to `~/.contracts/inbox/agent/<canonical>.jsonl` (the Σ4 fan-out
file). Every registered client of Lewis's canonical identity (Σ3) is
tailing that file. The tg bot on his phone sees the row, calls
`contract session claim <req-id> --client-id tg-phone` and wins the race
(Σ6). It renders `sendInvoice`. Meanwhile his web session sees the row
too, calls claim, gets `=== ALREADY CLAIMED ===` exit 1, and shows
"resolved on phone — refresh when done." When Lewis pays on phone, the
debit succeeds; the next iterate on the laptop re-runs the action, the
402 is gone, and the contract resolves. Four substrate primitives,
zero new shapes, full cross-device generative UI.

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
| `machine` | `machine:graff --status` | Π3 portable binary reference. At iterate time the substrate resolves `<name>` via `~/.config/contract/machine-binaries.json` map → `command -v <name>` on PATH → emits `=== MACHINE BINARY MISSING ===` if neither. The contract row stays portable across hosts (mac, tencent, any client install) — each machine maintains its own resolution map; the contract action never bakes an absolute path. |

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

## Unbrowse integration (Π2 · Π3 · Π4 · Φ1)

Per Β4 thin-index: full prose lives on standing-gate contracts; this section is the pointer.

| Doctrine | Standing-gate | One-line summary |
|---|---|---|
| **Π2** autopay (chill mode) | `1f14917d` | x402 → 402 → silent settle via `<base>/v1/billing/autopay/charge` with bearer `UNBROWSE_API_KEY`; opt-in `CONTRACT_AUTPAY=1` or `~/.config/unbrowse/autopay.json`; honest fall-through to PAYMENT REQUIRED on non-200. Keys stay at unbrowse, never in /contract. |
| **Π3** `machine:<binary>` pointer | `e7c8f6f2` | Per-host-portable contract row; resolution at iterate time via `~/.config/contract/machine-binaries.json` → `command -v <name>` → `=== MACHINE BINARY MISSING ===` block. Verb-gate: `verb-gates/machine/verify.sh`. |
| **Π4** unbrowse marketplace mirror | `397bc7bd` | **Deferred** — every contract row pushed to `<unbrowse>/v1/contracts/mirror` via internal hook; endpoint not yet shipped at unbrowse (404 today). `contract promote <id>` is the today-cross-project sharing primitive. |
| **Φ1** OpenAI-compatible front | `a4910638` | `scripts/openai-render.py` translates iterate output → SSE chunks; requirement blocks become OpenAI `tool_calls` (`payment_required`, `sign_in_required`, `agent_routed`, `inhibition_refusal`, `machine_binary_missing`). Substrate-internal headers stay in `delta.content`. Verb-gate: `verb-gates/openai-render/verify.sh`. |

All four compose at the unbrowse boundary: Φ1 is the public API surface, Π2 is the chill-mode billing on top of x402, Π3 makes the contract action portable across hosts/containers, Π4 is the eventual horizontal sync (deferred to unbrowse-side endpoint). Security-relevant client code is public-by-doctrine; payment processor internals stay private.

Run `contract status <id>` for full narrative on any of the four.
## Λ1 — runtime-agnostic KEY 2 (any LLM can be the judge)

`contract judge <id>` reads a contract's latest iterate output and asks
a configured OpenAI-compatible LLM endpoint for a structured PROMOTE /
HOLD / REJECT verdict. Closes the loop opened by Φ1: where Φ1 streams
substrate output to an OpenAI client, Λ1 calls an OpenAI endpoint to
serve KEY 2 in-thread. The substrate becomes truly runtime-agnostic —
no Claude Code, no Codex, no Cursor required; any LLM that speaks
`/v1/chat/completions` can do the judging (Venice.ai, OpenAI, Anthropic,
local llama.cpp, anything).

### Routing — codex first, HTTP as fallback

The substrate prefers the **codex CLI** when it's on PATH. Codex is auth'd
through the user's ChatGPT subscription, so there's no API-key shape to
manage and no per-call quota to top up. The HTTP fallback exists for
hosts without codex (servers, fresh containers, foreign laptops).

| Surface | Routing |
|---|---|
| `codex` on PATH | **default** — uses `codex exec --skip-git-repo-check -s read-only --output-last-message <tmp> -`; prompt on stdin; verdict captured from `--output-last-message` file (only the final model reply, not the streaming chatter) |
| `CONTRACT_LLM_VIA=codex` env | force codex even if HTTP config is set |
| `CONTRACT_LLM_VIA=http` env | force HTTP even if codex is on PATH (used by the verb-gate's mock-LLM phase) |
| `CONTRACT_LLM_MODEL` env | optional `-m <model>` passthrough for codex; OR `"model"` field for HTTP |
| `CONTRACT_LLM_URL` + `CONTRACT_LLM_KEY` env | HTTP path: bearer-auth `/v1/chat/completions` (e.g. `https://api.openai.com/v1`, `https://api.venice.ai/api/v1`) |
| `~/.config/contract/llm.json` | persistent `{"url":"...","key":"...","model":"..."}` for the HTTP path |

When neither codex nor HTTP config is reachable, `contract judge` exits 2
with the "no judging surface available" prompt naming both options.

### Exit semantics

| Verdict | Exit | Next |
|---|---|---|
| `PROMOTE` | 0 | substrate emits `contract _mark <id> satisfied --proof "Λ1 ..."` hint |
| `HOLD` | 1 | substrate emits `contract iterate <id>` hint |
| `REJECT` | 1 | substrate emits `contract supersede` / `revise` hint |
| missing config / unparseable verdict / unknown id | 2 | no auto-promote on failure |

Verb-gate `verb-gates/judge/verify.sh` binds both routing paths. HTTP
phases (against a mock `/chat/completions` server): no-config refused,
unknown id refused, PROMOTE exits 0 with _mark hint, HOLD exits 1 with
iterate hint, REJECT exits 1 with supersede/revise hint, unparseable
verdict refused. Codex phases (against a fake `codex` shim on PATH): the
shim's PROMOTE/HOLD verdict reaches the substrate intact AND codex is
preferred over HTTP when both are available (auto-default).

### Why this matters

Drops the implicit "agent runtime" dependency. Today /contract assumes
Claude Code (or Codex) holds KEY 2 in-thread. Λ1 lets a `pay.sh` wrapper
plus a Venice API key be enough to drive iterate-judge-mark loops
end to end — no chat client required. The substrate's mechanical-and-LLM
combo IS the agent.

Origin: contract `9d00660b`, 2026-05-23. Lewis's ask: "/contract to check
if we even need an agent runtime or /contract that starts via a binary
of an llm or even a pay.sh /contract to a api provider from venice might
even be enough." Answer: no runtime needed; Λ1 lets any LLM endpoint
serve KEY 2. Binding gate: `verb-gates/judge/verify.sh`.

Routing-default amendment 2026-05-24: codex CLI is the default judging
surface when on PATH; HTTP /v1/chat/completions is the fallback for
hosts without codex. Lewis's follow-on: "use codex cli instead of
openai always." Same Λ1 doctrine, different default. The substrate is
still runtime-agnostic — any OpenAI-shaped LLM endpoint works on the
HTTP path, and codex itself is just an alternate transport to the same
chat-completions semantics, but auth'd via ChatGPT subscription instead
of an OpenAI API key. Binding contract for the amendment:
`e068000e` (2026-05-24).

## Ω1 — unblock-rewake (HOLD verdicts self-trigger when blockers satisfy)

A Λ1 HOLD verdict that names a blocker contract id used to be **prose**.
The agent read it, judged in-thread, and moved on. If the blocker
satisfied later, nothing in the substrate remembered that the HOLD'd
contract was now re-judgeable — the dependency lived in conversation,
which the next session forgot.

Ω1 closes that loop by recording the blocker as a **typed link** on the
ledger row. When the blocker satisfies, the propagation wavefront
re-surfaces every HOLD'd dependent automatically.

### How it works

1. `contract judge <id>` calls the LLM, captures the verdict + reason.
2. If the verdict is HOLD or REJECT, the reason text is scanned for
   8-hex contract ids adjacent to blocker keywords (`block`, `blocked`,
   `depends`, `depending`, `gated`, `waiting`, `until`, `after`,
   `when`). Every matched id that resolves to a real contract row is
   collected into `blocked_by: [id, ...]`.
3. The substrate appends a typed `judged` ledger event:
   `{event: "judged", id: <X>, verdict: "HOLD", blocked_by: [<Y>], reason: "..."}`
4. When any blocker `<Y>` is later `_mark satisfied`, the propagation
   block scans for `judged` rows whose `blocked_by` includes `<Y>` and
   whose own status is still pending, then emits
   `=== Ω1 UNBLOCK-REWAKE ===` listing every now-resolvable dependent
   with its re-judge command.
5. `contract unblocked` is the standing query — lists every HOLD/REJECT
   contract whose every blocker is now satisfied (the **ready** list)
   plus those still waiting on a subset (the **waiting** list).

The substrate surfaces; the agent re-judges. No script auto-promotes
the dependent — that would violate "harness collects, agent judges".
The shift is mechanical only at the *surfacing* layer: the agent never
forgets a HOLD again, because the ledger remembers the link and the
satisfy wavefront fires the reminder.

### Worked example

```bash
# X depends on Y. Λ1 judges X as HOLD, names Y in the reason.
contract judge <X>
# → verdict: HOLD
#   reason:  blocked on <Y> — Y must satisfy first before X can resolve
#   blocked_by: <Y>  (will re-surface when these satisfy)

# Later — Y gets done.
contract _mark <Y> satisfied --proof "..."
# → === PROPAGATION (signal) ===
#     (parent/referrer/synapse rows)
# → === Ω1 UNBLOCK-REWAKE ===
#     <Y> satisfied — judge-HOLD dependents re-fireable:
#     🔓 <X>  "X plan..."
#       -> contract judge <X>  # re-fire Λ1 with this blocker cleared

# Or query directly:
contract unblocked
# → === Ω1 UNBLOCKED (re-judgeable now) ===
#     🔓 <X>  [HOLD]  "X plan..."
#         blocker <Y>  [satisfied]
#         -> contract judge <X>
```

### Recursive convergence

Because the unblock-rewake fires inside the same wavefront block as
parent/referrer/synapse propagation, satisfying any contract that
**transitively unblocks** a chain of HOLDs cascades through the graph
in one `_mark` call. If X is HOLD'd on Y and Y is HOLD'd on Z, then
`_mark Z satisfied` surfaces Y; the agent re-judges Y (now PROMOTE);
`_mark Y satisfied` surfaces X; agent re-judges X. The recursion is
shallow per turn (one mark fires one wavefront) but compounds across
the convergence loop until the dependency graph is drained.

### Why this is the right abstraction layer

The blocker information was always **in the reason text** — the LLM
named it correctly every time. The gap was that the reason was an
unstructured string, so the substrate couldn't query "what's blocked
on X?" without re-parsing every prose row. Ω1 promotes the
already-spoken dependency into a typed ledger edge:

- L0 (mechanical) — `judged` row with `blocked_by: [ids]`
- L1 (substrate) — `wavefront()` extended to scan that field
- L2 (agent-UX) — `=== Ω1 UNBLOCK-REWAKE ===` and `contract unblocked`
- L3 (truth-claim) — "this HOLD is now resolvable because Y satisfied"

The substrate enables; the agent judges KEY 2 on the re-fire. The
re-judge isn't auto-promoted — the agent decides whether the new state
of the world genuinely resolves the HOLD or whether new evidence
opened new questions.

### Verb-gate

`verb-gates/unblocked/verify.sh` binds six phases against a mock
codex shim: judge captures `blocked_by` from a HOLD verdict naming
contract Y in the reason; `contract unblocked` lists X under WAITING
before Y satisfies; `_mark Y satisfied` emits `=== Ω1 UNBLOCK-REWAKE ===`
naming X with a `contract judge X` hint; `contract unblocked` then
lists X under READY; `--json` output is parseable; satisfying X
removes it from the surface (no spurious zombies).

Origin: contract `bcd1a371`, 2026-05-24. Lewis's framing:
"shit you go hold should be revisited when unblocked by another
/contract." The substrate already had wavefront propagation for
`contract:<id>` referrers; Ω1 generalizes that to the *implicit*
dependencies the LLM names in HOLD reasons, by promoting them to typed
ledger edges. Binding gate: `verb-gates/unblocked/verify.sh`.

## Ψ4 — async watcher (programmatic wait for external completion)

The previous primitives covered every loop **inside** the substrate:
parent organs fire when children satisfy, `contract:<id>` referrers
unblock when targets satisfy, Ω1 surfaces HOLD'd dependents when blockers
satisfy. But none of them close the loop with the **world outside** the
ledger — the unbrowse endpoint that hasn't shipped yet, the deploy that's
still rolling out, the manual approval that hasn't landed.

Until Ψ4, a contract waiting on an external condition had two paths:
1. The agent remembers to manually `contract iterate <id>` periodically
   (it forgets across sessions, compaction, days off).
2. A receptor blocks on an inbox file (someone has to write the file).

Neither poll the external thing. Ψ4 fills the gap with a tiny periodic
poller — a watcher that runs a probe on a wall-clock interval, and when
the probe flips, programmatically iterates the watched contract. From
there the existing wavefront (parent/referrer/synapse) plus Ω1 (HOLD'd
dependents) does its job: the dependency graph wakes up automatically.

### How it works

1. `contract watch <id> [--probe "<cmd>"] [--interval <s>]` — register a
   watcher. State lives at `~/.contracts/watchers/<id>.json`.
2. `contract watch tick` — one poll cycle. For each watcher whose
   interval has elapsed since `last_run_ts`:
   - run the probe (or skip if no probe — direct iterate)
   - on **probe-FAIL**: persist `last_run_ts` + `attempts++`, keep
     watching
   - on **probe-PASS** (or no probe): write an event to
     `~/.contracts/inbox/watcher/<id>.jsonl`, run
     `contract iterate <id>` (the contract's existing action becomes
     KEY 1), and **remove the watcher** (one-shot semantics)
3. The auto-iterate emits the standard two-key exit. KEY 2 still belongs
   to the agent on next session. The fire is mechanical, not a verdict.
4. When the agent eventually `_mark`s the contract satisfied, the
   propagation wavefront fires + Ω1 re-surfaces every dependent HOLD —
   the whole graph wakes up from one external state flip.
5. **`~/.contracts/hooks/watch-tick.sh`** — internal hook. Fires on
   every `iterate` and `_mark` event via `_fire_contract_hooks`, so any
   /contract activity advances every pending watcher's poll. Guarded
   against re-entry (the auto-iterate it triggers doesn't recurse).

### One-shot, not invariant

Like apoptosis: the watcher exists to fire once and disappear. If the
external condition flips back (an endpoint ships, then breaks), the
agent can re-register. Persistent invariants are `loop-until:<body>`'s
job — staleness across time is Ψ4's job. Different shapes, no overlap.

### Why this is in the substrate, not a cron job

Cron lives outside the contract graph. A cron-driven poller would know
"this URL returned 200" but couldn't programmatically advance the
contract that depends on it — the agent would still have to wake up,
notice the cron log, and manually iterate. Ψ4 keeps the poller AND the
iterate AND the wavefront on one substrate, so the chain "external
state flip → contract iterate → wavefront → unblocked dependent" is
mechanical end to end.

### Composition with Ω1

This is the chain Lewis named:
- contract `A` is HOLD'd, blocker named is contract `B`
- `B` waits on an external thing (e.g. unbrowse endpoint)
- agent registers a watcher: `contract watch B --probe "curl -fsSL ..."`
- some future tick (or any iterate/mark elsewhere fires the hook) flips
  the probe → `B` is iterated → next session the agent `_mark`s `B`
  satisfied → wavefront fires Ω1 UNBLOCK-REWAKE → `A` surfaces in
  `contract unblocked --ready` for re-judgement

No agent involvement between "register the watcher" and "wake up to
find A ready to judge". The convergence loop self-triggers across the
external boundary.

### Worked example — wiring the unbrowse deferred items

```bash
# The deferred item 65cac760 is waiting on unbrowse to ship
# /v1/billing/autopay/charge — when that endpoint stops 404'ing, the
# Π2 autopay contract can resolve.
contract watch 65cac760 \
  --probe 'test "$(curl -s -o /dev/null -w %{http_code} https://beta-api.unbrowse.ai/v1/billing/autopay/charge)" != "404"' \
  --interval 3600

# Now any future /contract activity in any session re-checks the
# endpoint every hour. The day it ships, 65cac760 auto-iterates,
# the agent marks it satisfied, and any Π2 contract that referenced
# `contract:65cac760` becomes resolvable in the wavefront.
```

### Verb-gate

`verb-gates/watch/verify.sh` binds eight phases: register refuses on
phantom ids; list surfaces watchers pretty + `--json`; tick respects
interval (skipped count); probe-FAIL doesn't fire (no false-witness
inbox row); probe-PASS fires (auto-iterates contract with PASS row +
writes inbox event + removes watcher one-shot); no-probe watcher fires
on schedule (the receptor-shape case); stop cleanly removes without
firing; stop on missing watcher refuses.

Origin: contract `21f1d851`, 2026-05-24. Lewis's framing:
"wire up hooks to wait for those to complete via /contract so that
the relevant /contract within the /contract list will actually wait for
it to complete and retrigger this /contract accordingly by programmatic
means." The substrate already had receptors (inbox consumers) and
hooks (event firing) but no programmatic **producer** that turned
external state into inbox events. Ψ4 is that producer — and it
composes with Ω1 to make the dependency graph wake itself up.

## Β1 — backtrack-and-capture (deferred items become contract rows, mechanically)

Across a long session the agent keeps naming "deferred", "named-and-
deferred", "honest gap", "next move that's actually yours" items in
response prose. Without discipline those items live in the conversation
only — they vanish on compaction or session end. Lewis's framing: "we
kept interrupting and /contract that to always happen."

Β1 is the substrate doctrine: **every deferred item named in a /contract
response gets a declared contract row before the turn yields.** The
ledger holds the list, not the conversation.

### The discipline

At the end of any /contract turn, the agent scans its own response for
"deferred", "named-but-not-shipped", "honest gap", "next move", "TODO",
"future wave" callouts. For each, before emitting the final summary:

```bash
contract declare "DEFERRED-<scope>: <one-line plan> ... Origin: <doctrine-id>" \
  --action "agent-judges" --no-drive
```

The result: every named follow-up survives compaction, surfaces in
future `contract search` runs, and can be referenced by id from the
next session.

### Worked example — session 2026-05-23 backtrack

The first application of Β1 captured **12 deferred items** from this
session as contract rows under root organ `c64b17e0`:

| Slug | Id | Scope |
|---|---|---|
| unbrowse-autopay-endpoint | `65cac760` | unbrowse-side `/v1/billing/autopay/charge` (Π2 follow-on) |
| unbrowse-mirror-endpoint | `3e4abc17` | unbrowse-side `/v1/contracts/mirror` (Π4 follow-on) |
| unbrowse-chat-completions-route | `15720baa` | unbrowse-side `/v1/chat/completions` (Φ1 follow-on) |
| unbrowse-landing-chat | `c20337e6` | unbrowse.ai homepage chat client (Φ1 follow-on) |
| unbrowse-public-security-scope | `828ba2b4` | open-source security-relevant client extraction (Φ1 follow-on) |
| agent-inbox-auto-append-on-requirement | `c06a3442` | substrate auto-append requirement blocks to canonical inbox (Σ6 follow-on) |
| docker-silo-per-allowlisted-user | `731af006` | infra C1 — hardware privacy boundary |
| referral-10pct-revenue-share | `294b265c` | unbrowse-side cut at debit time (Σ5 follow-on) |
| verb-gate-routed-block | `0db1b0bb` | substrate gate for ROUTED block KV-shape |
| verb-gate-inhibition-refusal-block | `977a5efb` | substrate gate for INHIBITION REFUSAL block KV-shape |
| psi1-verbose-flag | `53615eca` | substrate `--verbose` flag (Ψ1 binding) |
| verb-gates-coverage-rest | `c7057971` | ~30 CLI verbs without dedicated gates |

The Β1 root `c64b17e0` is a funnel with 12 `contract:<id>` children —
one per deferred item. The funnel resolves only when every deferred
item has either shipped (its child contract satisfied) or been
formally superseded. `contract status c64b17e0` shows the live progress.
`contract search --context "DEFERRED"` surfaces them outside the organ.

### Why the substrate not the memory

Recall files survive sessions but the agent doesn't reliably read them
back into context. The ledger has gravity: `contract search` runs on
every `declare`, `contract list` is one command, and the
`self/origin-citations` self-check catches when a `Β1`-cited id goes
missing. Putting deferred items in the ledger means they get found
again automatically; in memory files they only get found if the agent
remembers to look.

Origin: contract `c64b17e0`, 2026-05-23. Lewis's framing: "so we
backtrack through this session and /contract all the supposed next
moves we were supposed to do in parallel because we kept interrupting
and /contract that to always happen." The first half is the worked
example above; the second half is this section binding the discipline
to the substrate's map.


## The stdio model (receptors · streams · ledger as trunk)

Per Β4 thin-index: full prose lives on standing-gate contracts; this section is the pointer.

**Two layers, joined by the ledger as their shared file:**

- **Action layer (stdio-shaped)** — every shape that runs code reads stdin / env / files and writes stdout + exit code. `cell`, `judgment` body, `loop-until:` body, `harness:<path>/verify.sh`, `tool-guard:` PreToolUse hook, receptors (`wait-for-event.py` over `~/.contracts/inbox/<channel>/*.jsonl`), stream writers (`~/.contracts/streams/<id>/stdout.log`), internal hook handlers. Each is a tiny stdio process.
- **Composition layer (pure ledger queries)** — `funnel` / `funnel-first` / `sequence` / `quorum:K` / `contract:<id>`. No stdin/stdout of their own; pure predicates over the ledger's current state, evaluated at iterate time.
- **Ledger as trunk stdout** — `~/.contracts/contracts.jsonl` is itself a stdio surface at substrate scale: append-only, line-delimited, every event writes one line, every other contract reads from it.

**Receptors (input port)** — external events drop rows into `~/.contracts/inbox/<channel>/*.jsonl`; action blocks via `wait-for-event.py --inbox <channel> [--filter <regex>|--field <path> --equals <s>] --timeout <s>`. PASS on first match, FAIL on timeout. Standard injectors: telegram bot poller, webhook receiver, stripe forwarder. Doctrine row: `ff6e8908`.

**Streams (output port)** — long-running action writes to `~/.contracts/streams/<id>/{stdout.log,state.json}`; observer follows via `contract tail <id>`. Action opts in by reading `$CONTRACT_ID` env. Same doctrine row: `ff6e8908`.

**Neuron analogy is exact, not metaphor:** dendrites = env/inbox/stdin; soma = the action; membrane voltage = KEY 1 + KEY 2; action potential = `_mark satisfied`; axon = the satisfied row + optional stream; synapses = parent/referrer wavefront; dendritic geometry = composition shape.

Run `contract status ff6e8908` for full narrative + worked examples + the layer-diagram.

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

## Web-deploy verification (served-surface · empathy · walk · no-raw-JSON · observe-original)

Per Β4 thin-index: full prose lives on standing-gate contracts; this section is the pointer.

Every web-deploy organ composes from these five gates, each its own standing-gate referenced by id in the Multi-dimensional gates table below. One Playwright-based script (`scripts/browser/verify.mjs`) implements served-surface + empathy + walk + no-raw-JSON in a single headless load; `scripts/observe-original.sh` (and `scripts/browser/observe.mjs`) records the original site before any rebuild.

| Gate | Standing-gate | What it catches |
|---|---|---|
| **Served-surface** | `27125bd7` | console.error / pageerror / same-origin 4xx on first paint (catches dead-on-arrival regressions a build pass hides) |
| **Empathy** | `4a055cf7` | hydrated-but-empty shells, error-boundaries that swallowed the throw, skeleton-only pages. Flags: `--wait-after-load`, `--expect`, `--expect-not`, `--min-text`, built-in `"Application error"` / `"__next_error__"` / `"something went wrong"` guards |
| **Walk + prelude** | (extends `4a055cf7`) | `--walk` follows every same-origin `<a href>`; `--prelude tours/login-flow.json` runs goto/fill/click/wait_idle/expect_url in a shared browser context BEFORE the URL checks, so the form-submit redirect destination is verified (`expect_url` catches client-side 404 fallbacks) |
| **No-raw-JSON** | (extends `4a055cf7` via `--no-raw-json`) | fails when `document.body.innerText` contains a JSON dump (4+ `"key":` lines OR any line with 4+ `"key":` tokens). Catches lazy `JSON.stringify` rendering shipped as "real UI" |
| **Observe-original** | `f669f09c` | run BEFORE a rebuild: drives the live original through a JSON tour, captures per-screen network requests with redacted headers + payload + status + clipped response → `docs/observed/screen-flow.md` + `endpoints.json` + `events.json` + screenshots. Reveals what the bundle hides (real headers, payload shapes, request order) |

**The killer combo** (compose all five in one invocation):
```bash
bash ~/.claude/skills/contract/scripts/verify-served-surface.sh \
  <urls> \
  --prelude tours/login-flow.json --env-from .observe.env \
  --walk --walk-exclude "^/(api|favicon)" \
  --expect-not "404 — try home" \
  --no-raw-json \
  --report .scratch/verify-e2e.json
```

**Why one section, five gates:** they share one headless load (cheaper to run together than separately) and one report.json shape (so KEY 2 reads one artifact, not five). Per pointer-not-payload, each project's deploy organ references the standing-gate by id rather than re-deriving the check. Run `contract status <id>` for full narrative on any of the five.

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

## Locality (the four-scope metasuperpattern)

/contract is **location-invariant at the row level, location-dependent
at the discovery level**. One primitive runs at four scopes; the
substrate's existing discovery algorithm plus the Σ-stack already cover
the mechanics. This section names the unified model so future agents
reach for one mental shape, not four.

### The four scopes (one algorithm, four files)

| Scope | Ledger location | Identity | Use |
|---|---|---|---|
| **project** | `<project>/.claude/contracts.jsonl` | per-project | project-local gates, deploy verifications, feature claims; same id in two projects is independent |
| **global** | `~/.contracts/contracts.jsonl` | per-user host-wide | standing gates (`contract promote <id>`), identity catalogs (`~/.contracts/people/`), reusable verifiers |
| **container** | `/opt/.contracts/contracts.jsonl` inside a docker container | per-tenant | hardware-enforced privacy (OS layer enforces what Σ2 enforces in software); the deferred C1 silo work (`731af006` → `b61a83be`) IS this scope's binding gate |
| **account** | `~/.contracts/contracts.jsonl` of a remote user account, reached via SSH | per-OS-user | `ssh user@host -- contract iterate <id> --stdin` is faithful at-a-distance iterate; CONTRACT_USER=`$(whoami)` makes the SSH'd-into account the requesting identity |

### The discovery algorithm (one walk, four scopes)

`contract_core._ledger()`:
- `CONTRACTS_STORE` env wins (any override)
- else walk up from cwd looking for `.claude/contracts.jsonl` (project)
- else fall back to `~/.contracts/contracts.jsonl` (global / account / container — whichever home the process is rooted in)

That's it. Same code resolves project, global, container, and account
scopes correctly because the file location IS the scope.

### What already works across scopes (no new code)

- **Row schema is identical at every scope.** Declared/iterated/satisfied/cached JSONL rows have the same shape whether the file lives in a project, in `~/.contracts/`, in a container, or in an SSH'd-into account.
- **The nine shapes work identically.** A funnel in a project ledger composes the same as a funnel in a container ledger.
- **The three keys fire identically.** KEY 1 machine, KEY 2 agent, KEY 3 refractory — no scope shortcuts.
- **Σ3 identity aliases** — same human across hosts/containers/accounts after one `contract alias` call.
- **Σ4 `agent:<id>` routing** — inbox writes when iterator-identity differs from action-target; works identically inside a container, over SSH, on the host.
- **Σ6 session register/list/claim** — multi-client coordination; `client_id` can be `tg-phone`, `ssh-tencent`, `docker-cayden-sandbox`; same arbitration logic.
- **Π3 `machine:<binary>`** — per-host resolution map means the same contract row resolves binaries correctly on every host/container.
- **inbox shared volumes** — `~/.contracts/inbox/` is plain JSONL; mount it as a docker volume and containers share the bus.
- **`contract promote`** — project→global upgrade path; container→host is the same row-copy with a different source path.
- **SSH-triggered iterate** — no new code needed; bash dispatch + stdio is already the cache-layer's stdin path; CONTRACT_USER derives from `$USER` on the remote shell.

### Wavefront and cycles across scopes

The wavefront (parent / referrer / synapse / Ω1 unblock-rewake)
propagates **within** the ledger being iterated. Cross-scope
propagation is **deliberate**, not implicit:

- `contract promote <id>` (project → global) — explicit row copy; the promoted row IS the canonical thereafter
- Σ4 inbox writes (any scope → named-agent's home scope) — explicit by `agent:<id>` action

Because every cross-scope reference goes through `promote` or Σ4, the
substrate cannot form a cross-scope `contract:<id>` cycle: the
referenced id resolves to the local ledger only, and the cycle detector
(`contract depth --strict-cycles`) is sufficient at single-scope scope.

### What's deliberately NOT shipped under this doctrine

- **A `scope` field on rows beyond `0661a665`.** Scope IS the file location, not a row-level tag; over-tagging would force two sources of truth.
- **Automatic cross-scope sync.** Promotion is a verb (deliberate human/agent action), not a hook. The Π4 unbrowse marketplace mirror is the eventual horizontal-sync layer but lives at unbrowse, not /contract.
- **Container / account scope verb-gates.** The discovery algorithm is shape-agnostic; existing `cell-gate` + `verb-gates/promote` already prove the same primitive at every scope. Adding `iterate-from-container` or `iterate-via-ssh` verb-gates would be testing the OS, not the substrate.

Origin: contract `79c2d656`, 2026-05-24. Lewis's framing: "/contract
can be project level or global level /contract and even exist in
different docker containers for /contract isolation of things or even
/contract for user account level where even ssh into the account and
cli stdio via ssh triggers the /contract — write the meta super
/contract metasuperpattern". The doctrine composes existing pieces
(`0661a665` scope-tag, `3b1d1cca` promote-discipline, `731af006` /
`b61a83be` docker silo, Σ3/Σ4/Σ6 stack) into one unified model. The
genuinely new claim is the SSH-as-substrate-entry-point binding — a
remote shell carries stdio faithfully, so `ssh user@host -- contract
iterate <id> --stdin` is the same primitive as a local iterate.

## The invocation organism (every /contract is itself a contract)

The fractal claim said: every contract is simultaneously **funnel + loop
+ harness** at every depth. The Locality doctrine said: that's also
true at every scope. This doctrine binds it as the **invocation
pattern**: every /contract call mechanically wraps as **funnel + loop + harness in three orthogonal dimensions**, with the user's prompt typed
onto the declared row and the response typed onto the satisfied row.

### Three orthogonal dimensions (declarative composition)

| Dimension | What it does | Bound by |
|---|---|---|
| **FUNNEL** (composition) | invocation root is `sequence` / `funnel` / `quorum`; work decomposes into N children via `spawn` / `fan-out`; root resolves when children resolve | the nine shapes (already documented) |
| **LOOP** (programmatic while-until-completion) | `solve` declares + first-iterates with self-drive auto-armed on the root; `drive` arms async across turn boundaries; `drill` runs synchronous in-thread loop across N targets until each settles or budget exhausts | Drive mode + Drill (already documented) |
| **HARNESS** (verification gate) | root action can be `harness:<path>`, OR a sequence gating on N `contract:<id>` pointer-gated children, OR a final-stage verify call | multi-dimensional gates + harness shape |

The three are composed on every invocation, not picked one at a time. A
healthy invocation has all three: a funnel that names the work, a loop
that drives it to completion, a harness that proves the satisfaction.

### What gets typed on the contract (no new event types)

Every dimension surfaces as already-existing ledger events. The
discipline doesn't add new types; it binds that EVERY invocation
produces this audit trail:

| Lifecycle moment | Ledger event row | Field |
|---|---|---|
| user's prompt fired /contract | `declared` | `plan` |
| every wave the action ran | `iterated` | `action_result` + `action_exit` |
| every 10s sliding cache reuse | `cached` | `action_exit` + `source_wave` + `user` |
| every child spawned | `spawned` | `parent_id` + `plan` |
| Λ1 HOLD with named blocker | `judged` | `verdict` + `blocked_by` + `reason` |
| agent's final response / verdict | `satisfied` | `proof` OR `proof_skip_reason` |

`contract status <root>` shows the full invocation lifecycle from one
row's perspective. No conversation required to audit what happened.

### The mechanical promise (every /contract invocation walks this)

1. **SEARCH** — the UserPromptSubmit hook surfaces related contracts before the agent acts (already wired)
2. **DECLARE** — invocation root with the user's prompt as `plan` and a real `--action` as the harness gate
3. **SPAWN** — N children for the work (funnel dimension); fan-out for parallel-independent, sequence for ordered
4. **DRIVE** — self-drive auto-arms on top-level declare; `drill` for synchronous in-thread completion of N pendings
5. **ITERATE** — every leaf to KEY 1 PASS; agent judges KEY 2 in-thread; `_mark` with proof; KEY 3 refractory check
6. **PROPAGATE** — wavefront fires; Ω1 re-surfaces HOLD'd dependents; Ψ4 watchers wake from external state
7. **ROOT MARK** — `_mark <root> satisfied --proof "<final response summary>"` (the typed output)
8. **RETURN** to user only when root organ is satisfied OR genuine HOLD is named with the blocker

The user types /contract once. The substrate types-onto-the-ledger the
trigger, every wave, every child, every cache hit, every judgment,
every propagation, every refractory check, and the final proof.

### What's deliberately NOT shipped

- **New `invoked` / `responded` event types.** `declared.plan` IS the trigger, `satisfied.proof` IS the response, both already typed. Over-typing would force two sources of truth.
- **A new `invocation` shape.** Every existing shape can be the invocation root; sequence/funnel/quorum for multi-stage, cell/judgment for one-shot.
- **Auto-wrapping every slash-command call.** The discipline applies to BUILD/SOLVE-shaped invocations (work to do), not READ-shaped (`contract list`, `contract status`). The agent has theory-of-mind about which is which; mechanical wrapping would over-fire.

### The fractal claim, refined (one more axis)

| Axis | Claim |
|---|---|
| **depth** | every contract is funnel + loop + harness at every depth (composition recursion) |
| **scope** | every contract operates identically at project / global / container / account (locality invariance, `79c2d656`) |
| **invocation** | every /contract invocation mechanically wraps as funnel + loop + harness in three declarative dimensions, with trigger and output typed onto ledger events |

Origin: contract `55e60ce8`, 2026-05-24. Lewis's framing: "so this is
how calling /contract should always be done mechanically in the
skill — it's a funnel loop and a harness, that is declarative in
different dimensions — figure out how to make /contract so banger by
/contract triggers and outputs as part of the contract typed to
always happen forever where the loop is /contract'ed to always be
while until completion programmatically". Composes existing primitives
(Drive mode, Drill, self-drive default, three keys, plan-fulfillment
proof binding `173c8819`, Ω1 `bcd1a371`, Ψ4 `21f1d851`, the
multi-dimensional gates pattern) into one invocation-pattern doctrine.
The genuinely new claim is naming all of them as ONE mechanical
wrapping so every future /contract invocation reaches for the same
shape by default.

## Self-binding (the immune system, the homeostatic regulator, the wrap)

Per Β4 thin-index: full prose lives on standing-gate contracts; this section is the pointer.

The substrate enforces what it documents via five binding layers, each its own standing-gate. Every ledger commit re-fires every layer through the pre-commit hook on `~/.contracts/.git` (transport: `scripts/skill-self-test.sh`):

| Layer | Doctrine | Standing-gate | Binds |
|---|---|---|---|
| **Shape gates** | self-modeling | `249a46c4` | Each of the 9 shapes (cell, judgment, funnel, funnel-first, loop, harness, tool-guard, sequence, quorum) has a dedicated gate at `~/.claude/skills/contract/<shape>-gate/verify.sh` exercising its semantic claim against the running CLI. Plus orthogonal-feature gates (`audit`, `bm25`, `budget`, `lifecycle`, `propagation`). |
| **Verb gates** | verb-language coverage | `2db87011` | Each of the 44+ CLI verbs has its own gate at `verb-gates/<verb>/verify.sh` (sandboxed `CONTRACTS_STORE`; happy path + ≥1 failure mode). Verbs are language, contracts are sentences — verb-gates bind the language without forcing every verb to be a first-class contract. Starter set covers promote / _mark / supersede / corroborate / learn (caught a real `_mark` silent-fabrication bug on day one). |
| **Audits** | corpus-wide rule enforcement | (audits doctrine) | `audits/<rule>/{verify.sh,fix.sh,scope.txt,README.md}` — verify is pure-read across the whole scope; fix is idempotent and never touches body content. Wired as `self/audits-pass`. Worked example: `audits/memory-layering/` (contract `767fd41d` + `d4074595`) caught 236 violations across 39 dirs the original narrow fix had missed. |
| **Self-organism** | identity-binding wrap | `cc5e8920` + root `b77ad5d1` | A funnel that pointer-gates on every layer-claim (`self/origin-citations`, `self/bundled-scripts`, `self/doctrine-binding`, `self/default-contracts`, `self/heading-ladder`, `self/standing-gate-ids`, `self/empathy-flags-wired`, `self/shape-catalog-matches-gates`, `self/no-contradictions`). The substrate is BOTH the speaker AND the listener for its own claims. First-wave drift caught: 5 cited contract ids resolved nowhere, 1 bundled-script path had `~` expansion bug, default-contracts count was off by one. |
| **Honest self-awareness** | drill loop | `df89a300` | `scripts/self-drill.sh` runs `skill-self-test.sh` in a loop (≤8 rounds), auto-promotes orphan contract ids via `contract promote`, surfaces unfixable-class failures as `aspirational-gap` named-not-lied-about. Terminates in `all-green` OR `aspirational-gap` with residual; never silently green. The drill log at `~/.contracts/self-drill.jsonl` IS the proof of self-awareness — mechanical (bound gates pass) + epistemic (gaps catalogued). |

**Biology read:** shape gates = immune system (per-shape regression). Audits = homeostatic regulator (sweep the corpus continuously). Self-organism = identity statement ("I am what I document"). Drill loop = honest self-awareness terminator. KEY 3 refractory + plan-fulfillment proof + Β4 thin-index audit make lying mechanically impossible: the pre-commit hook fails before the lie ships.

**What's deliberately NOT shipped:** verbs-as-first-class-contracts (bootstrap + hot-path + layer-confusion reasons — see `2db87011`'s plan); a separate principle-store (the ledger IS the store); auto-promote on test failure (the agent judges KEY 2; gates surface, they don't decide).

Run `contract status <id>` for any of the five layer doctrines.


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
