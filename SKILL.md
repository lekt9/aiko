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
| "is this a recurring pattern?" | `contract habit` |
| "convert past patterns" / "don't lose this in the refactor" | `contract import <source>` |
| any invocation | read `ledgers/contracts.jsonl` — it is the only truth |


## Architecture (L0-L2)

- **L0 core** — `scripts/lib/contract_core.py`: data model, the only code that touches `ledgers/contracts.jsonl`. `declare()`, `record_iteration()`, `mark_satisfied()`, `get_tree()`, `list_all()`, `children_satisfy()`.
- **L1 CLI** — `scripts/contract`: the verb surface. `declare`, `iterate`, `build`, `spawn`, `solve`, `status`, `list`, `habit`, `_mark`. Every verb either writes one ledger row or emits a structured prompt; nothing else.
- **L2 detector** — `scripts/contract-habit-detect.py`: passive pattern detector. Token overlap against all `plan` fields in the ledger. Surfaces candidates above threshold. Never declares.

The unifying model: a contract with a mechanical `--action` is a **cell**. `--action agent-judges` is a **judgment**. `--action funnel` (or `children-satisfy`) is a **funnel** (AND-gate). `--action funnel-first` is a **funnel-first** (OR-gate). `--action loop-until:<cmd>` is a **loop** (re-run body each iterate). `--action harness:<path>` is a **harness** (delegates to `<path>/verify.sh`). One data model, five shapes, infinite fractal depth.

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

Thirteen principles drawn from CLAUDE.md, CONTRACTS.md, and the fruits of the spirit / 10 commandments — mapped only where the translation is genuinely useful and non-redundant. `contract defaults` shows them; `contract habit` surfaces existing matches before re-declaring.

**From engineering principles (CLAUDE.md + CONTRACTS.md):**

| # | Plan (abbreviated) | Shape | Source |
|---|---|---|---|
| 1 | "substrate enables, never prescribes — no forbidden surface in any script or agent" | judgment | CLAUDE.md meta-rule |
| 2 | "every commit introduces zero new failures — diff vs baseline is non-positive" | judgment | C-G (no-regression) |
| 3 | "pointer-not-payload — client holds only opaque pointers; all logic lives server-side" | judgment | CLAUDE.md architecture |
| 4 | "harness collects, agent judges — no script emits PROMOTE/PASS/FAIL on its own" | judgment | C-G01 |
| 5 | "verify the served surface, not the source — a build pass is never sufficient" | judgment | C-G06 |
| 6 | "fix root cause, never band-aid — no downstream fix_*/clean_*/patch_* compensator" | judgment | C-G08 |
| 7 | "explicit verdict — PROMOTE/HOLD/REJECT with every caveat named; never bare 'done'" | judgment | C-G11 |
| 8 | "no mutable .db or state file un-gitignored inside a git-tracked directory" | cell | C-O04 |
| 9 | "auth/deploy chain verified against the live running service; not build, not timestamp" | judgment | cross-harness pattern |

**From fruits of the spirit + commandments (mapped only where genuinely distinct):**

| # | Plan (abbreviated) | Shape | Source / Doctrine |
|---|---|---|---|
| 10 | "serve the genuine need, not just the literal request — technically-passing but intent-missing is fake-green" | judgment | Love (Galatians 5:22) |
| 11 | "recognize genuine convergence and stop — do not re-iterate an already truly satisfied contract; the two-key exit is final" | judgment | Sabbath (Commandment 4) |
| 12 | "one contract, one truth claim — if an action checks two unrelated things it belongs as two contracts" | judgment | No adultery (Commandment 7) |
| 13 | "every verification result traces to a real live source — no synthesized, proxied, or stubbed result; a proxy-green is a false witness" | judgment | No false witness (Commandment 9) |

**Rejected mappings (forces or overlaps):** Joy/Kindness/Goodness/Gentleness (too abstract or not a gate), Self-control/Patience/Faithfulness (already in two-key exit or C-G13), No other gods/No idols/Name in vain/Honor parents/No murder/No stealing/No coveting (all overlap existing defaults 1-9).

Project-specific rules (no `vercel.json`, no `h-screen`, no `#000/#fff`) do NOT belong here.


## How to actually use this (working loop)


Crystallised from real session work, not aspiration:

1. **Search before declaring.** `contract habit --context "<plan>"` (or `contract build`) scores the plan against all existing contracts. Read the candidates; judge in-thread whether to reuse or iterate an existing one before creating new.
2. **Declare with a real check.** `contract declare "<plan>" --action "<shell cmd>"`. The action is the verify gate. A contract without a check is a wish.
3. **Iterate one wave at a time.** `contract iterate <id>` runs the action, appends one ledger row, prints the two-key exit prompt. Read the row; judge whether the machine result is genuine before marking satisfied.
4. **Spawn when sub-work emerges.** `contract spawn <parent> "<sub>" --action "<check>"`. The parent becomes an organ; its satisfaction = all children satisfied. The spawn verb emits a SPAWN REQUIRED prompt — the agent routes the child via a sub-agent or directly.
5. **Mark explicitly.** Emit `<promise>CONTRACT_SATISFIED:<id></promise>` then `contract _mark <id> satisfied`. No script claims satisfaction unilaterally.
6. **Ledger is memory.** Every failed wave is evidence. Never delete rows; the history drives habit detection and informs future declares.
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

# Surface recurring pattern candidates (never auto-declares)
contract habit [--context "<text>"] [--scope project|global]

# Surface past patterns (principle stores, canon, old ledgers) as candidate contracts
contract import <source> [--archive] [--commands]

# Arm autonomous drive loop (Stop hook re-fires after each turn)
contract drive <organ-id>

# Disarm drive loop (use when genuinely stuck or complete)
contract disarm
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
- Genuinely ambiguous intent (two valid interpretations with different outcomes)
- A destructive/irreversible action not already authorized

**Drive mode and the two-key exit:** KEY 2 is still agent-judged in-thread. Drive mode
removes the "wait for user" pause between iterations, not the judgment itself. The agent
can still judge HOLD when a result is fake-green, or disarm when genuinely blocked.

**State files:**
- `~/.contracts/.drive_active` — contains organ ID (sentinel)
- `~/.contracts/drive_next.txt` — current pending action JSON
- Both removed by `contract disarm`


## Output mode (load-bearing)

Per invocation this skill produces one of:

- **One ledger row** appended to `ledgers/contracts.jsonl` with event type, id, plan, action, wave, exit code, and timestamp. One row per declare; one row per iterate; one row per satisfied mark.
- **A SPAWN REQUIRED prompt** (from `contract spawn`) — a structured block telling the agent to route the child contract via a sub-agent. No ledger write; the child's row is written when the sub-agent runs `contract declare`.
- **A BUILD REQUIRED prompt** (from `contract build`) — search results plus the first iterate output. The agent sees similar contracts and the first wave result in one shot.
- **A tree view** (from `contract status`) — the contract and all descendants, each annotated with shape and status.

Never: a silent ledger write with no agent prompt; a synthetic pass verdict; a wave that doesn't print the two-key exit block.

## The five shapes (one data model)

Every contract is simultaneously a funnel, a loop, and a harness — fractally. A loop's body can be a funnel; a funnel's children can be loops; a harness wraps any shape. The recursion bottoms out at a cell or judgment.

| Shape | `action` field | Satisfied when |
|---|---|---|
| **cell** | shell command | action exits 0 AND agent judges genuine |
| **judgment** | `agent-judges` | agent confirms in-thread |
| **funnel** | `funnel` or `children-satisfy` | ALL children satisfied (AND-gate) |
| **funnel-first** | `funnel-first` | ANY child satisfied (OR-gate) |
| **loop** | `loop-until:<body-action>` | body exits 0 AND agent judges genuine; re-iterate to advance |
| **harness** | `harness:<path>` | `<path>/verify.sh` exits 0 AND agent judges genuine |

Fractal: funnels contain loops, loops contain funnels, harnesses wrap any shape. Every contract is itself a funnel (narrows to truth) + loop (iterate until resolved) + harness (collects evidence). `children-satisfy` remains valid; `funnel` is the canonical name. `drive` mode removes the human pause between loop iterations but does not change the two-key exit.

## The two-key exit (load-bearing invariant)

Every `contract iterate` ends with:

```
KEY 1 (machine): <action result — PASS | FAIL | AGENT-JUDGES | ERROR>
KEY 2 (agent):   JUDGE — is this GENUINELY satisfied, or fake-green?

If genuine → emit: <promise>CONTRACT_SATISFIED:<id></promise>
             then: contract _mark <id> satisfied
Otherwise  → fix the target, then: contract iterate <id>
```

No script claims satisfaction. The machine checks; the agent judges. Both keys required.

## Parallel fan-out (binding rule)

When a problem decomposes into N **independent** sub-contracts (they do not need each other's output to start), the agent MUST launch them as N parallel Agent tool calls in a **single message** -- not sequentially.

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

## Habit detection

`contract habit --context "<text>"` scores the context against all existing contract `plan` fields. Surfaces candidates above threshold:

```
HABIT CANDIDATE (score=0.87): "verify X always holds"
  id: <uuid>   status: satisfied
  → contract iterate <id>         # re-satisfy in this session
  → contract spawn <id> "<sub>"   # delegate sub-work to this parent
```

The detector surfaces. The agent declares. Auto-contracting is a forbidden surface (pattern-match lists prescribing behavior).

## What this skill does NOT do

- Auto-declare from a detected pattern. Surfaces candidates only.
- Auto-satisfy when the action exits 0. Agent is the second key.
- Maintain a separate principle store. `~/.contracts/contracts.jsonl` is the single store.
- Prescribe plan text format. The declarant authors it.

## Substrate principle (inherited, invariant)

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

| Pointer type | `--action` form | What it points to |
|---|---|---|
| `cli` | `npm test`, `python3 verify.py` | A local executable or shell command |
| `api` | `curl https://...`, `https://...` | An HTTP endpoint |
| `agent-judges` | `agent-judges` | The in-thread agent judgment (no machine action) |
| `funnel` | `funnel` or `children-satisfy` | All child contracts (AND-gate) |
| `funnel-first` | `funnel-first` | Any child contract (OR-gate) |
| `loop` | `loop-until:<cmd>` or bare `loop` | Body command re-run each iterate; loop converges when body exits 0 |
| `harness` | `harness:<path>` | External harness at `<path>/verify.sh` |
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
| `AUTO_CONTRACT_HABIT_DETECTION` — patterns surface as candidates | `contract habit` surfaces; agent declares. |
| `DAEMON_INTERFACE` — substrate watches and routes | `contract habit` is the conscious surface of passive observation. |
| `self_grow` — spawn children | `contract spawn` is this primitive made real. |

From `principles-as-harnesses.md`: a principle with `--action` IS a contract. From `dag-schema.md`: the graph is the single substrate. These are not external dependencies; they are the concept lineage this primitive implements directly.

## Bundled scripts

- `scripts/contract` — CLI front door (declare, iterate, build, spawn, solve, status, list, habit, _mark)
- `scripts/contract-habit-detect.py` — passive pattern detector (L2)
- `scripts/contract-import-extract.py` — import extractor: surfaces past patterns as candidate contracts (L2)
- `scripts/check-no-silent-fallback.py` — guard: fails if any skill script swallows an error silently
- `scripts/lib/contract_core.py` — data model, sole ledger writer (L0)
- `~/.contracts/contracts.jsonl` — the single append-only store (agent-agnostic)
