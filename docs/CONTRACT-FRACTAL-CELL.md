# Contract is the fractal cell

> STEER law: do not fork a plasma-fractal clone. Map its shape onto the
> contract substrate that already exists. There is **no second primitive**.

## Plasma-fractal shape (external reference)

[plasma-ai/fractal](https://github.com/plasma-ai/fractal) is hierarchical agent
loops with recursive self-organization:

| Fractal concept | Meaning |
|---|---|
| Node | Autonomous loop toward a goal in an isolated worktree |
| Spawn children | Subtasks grow a tree to fit the problem |
| Hard caps | max-iters, max-depth, max-children, max-descendants, cost, time |
| SQLite runs DB | Local durable run/iter/step metadata |
| Feedback | Iterate until completion or stop signal |

## Contract isomorphism (same shape, one primitive)

| Fractal | Contract cell |
|---|---|
| Node | One **contract row** (`declare` / `parent_id`) |
| Agent loop | **Aiko worker** pointed by `agent:aiko` + env (`AIKO_CONTRACT_ID`, `PARENT`, `ROOT`, `DEPTH`) |
| Spawn children | `contract_expand_json` / `expand_turn_root` → child rows |
| Worktree isolation | Optional subagent worktrees; identity is still the contract id |
| max-depth / children / descendants | `AIKO_CONTRACT_MAX_*` + `muscle.MAX_PARALLEL` |
| SQLite | Append-only **ledger** (`contracts.jsonl`) — pointer fold, not process memory |
| Feedback iterate | `posthook:feedback` + residual `posthook:iterate:<parent>` + turn-feedback.jsonl |
| Waves of parallel children | `muscle.schedule` dependency-safe waves |

## Cellular spine (every Aiko turn)

Every grounded turn expands the **same four-edge spine** (then skill DAG nodes):

```text
observe  →  agent:aiko  →  verify  →  posthook:feedback
   │              ↑________________________|
   │         residual: posthook:iterate:<id>
   └─ skill:* nodes (bounded fan-out)
```

| Key | Action | Role |
|---|---|---|
| `observe` | `contract:observe_state` | Sensor / reality intake |
| `agent` | `agent:aiko` | Aiko-powered cell (the work) |
| `verify` | `contract:verify` | Independent check / evaluator |
| `feedback` | `posthook:feedback` | Close loop; residual re-opens as contracts |

Production path:

- `crates/codegen/xai-grok-shell/src/contract_native.rs`
  - `cell_spine_children` / `cell_expand_children` / `expand_turn_root`
  - `close_feedback_loop` on failed satisfy
- `libcontract` `pointer.zig` (`agent:`, `posthook:`, `contract:`)
- `libcontract` `muscle.zig` (bounded parallel waves)
- `libcontract` `c_abi.zig` (`contract_expand_json`)

## Infinite feedback without a second brain

Feedback is **not** a separate orchestrator. It is:

1. Child contracts under the same parent (`parent_id`)
2. Cross edges as `contract:<id>` / `posthook:*` / `agent:*` pointers
3. Append-only ledger re-read on the next turn (stateless worker)
4. Depth / children / concurrency caps as the refractory period

Pointer → pointer → value: the process holds env ids; the ledger holds truth.

## Witness

```bash
bash scripts/witness-contract-fractal-cell.sh
```

Gates A (expand + bounds), B (`agent:aiko`), C (posthook loop), D (caps + tests).

## Forbidden

- New fractal/brain/orchestrator crates that re-implement expand/schedule/ledger
- Process-local shared agent memory as the source of truth
- Auto-satisfying `agent` / `verify` / `feedback` leaves without real evidence
