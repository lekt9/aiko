# Graph engineering in Aiko

Aiko answers one expensive question before work fans out:

> Is the runnable work **a chain, or a graph**?

The answer comes from declared dependencies, not from the order of a checklist. Contract analyzes the open walk, Cell runs its own typed cell DAG, Neuron exposes committed derivation edges, and Aiko composes those surfaces. There is no new root scheduler and no second ledger.

## Normal Aiko use is already graph-native

A normal Aiko prompt does not require `graph-plan`, an opt-in flag, or a separate workflow command. Before the reasoning worker starts, the Rust host now:

1. declares the turn in the native Contract ledger;
2. derives the admitted Meta-Agent skill nodes;
3. asks Contract to materialize their typed execution graph;
4. validates the loaded ABI, root identity, digest, unique child identities, hold state, and complete non-empty waves;
5. resolves the Contract continuation and only then starts the worker.

Any missing native library, rejected declaration, unavailable graph expansion, held node, malformed/mismatched graph, or invalid continuation refuses the turn before model/tool dispatch. Contract terminalizes children created by an aborted expansion; the ABI 13 graph-abandon operation rescans durable child rows, terminalizes them and then the root, and reports incomplete cleanup instead of claiming success. ACP tracing and configured upload bookkeeping are host setup outside this task-execution boundary. `AIKO_MACHINE_CONTEXT=off` disables only the optional local context projection; it does not bypass graph admission. `aiko-doctor graph-plan` remains a diagnostic/design surface for inspecting arbitrary walk JSON, not a prerequisite for using Aiko.

## The gate: chain, not a graph

Look only at the **current ready frontier**.

- Zero or one ready node: **chain, not a graph**. Run the one node; do not add workers yet.
- Two or more ready nodes: a graph is available. Fan out only after checking write/effect collisions and worker isolation.
- A later wave with several nodes does not make the current one-node frontier parallel. Re-run the plan after settlement advances the walk.

An edge exists only when data or settlement really crosses it. “Then” is not an edge. Conversely, two nodes with no dependency can still be unsafe to co-locate when their declared write scopes overlap.

```text
one ready                         two ready

  discover                           left     right
     |                                 \       /
  implement       chain                reduce          graph
```

## Try the planner

From the repository root:

```sh
zig build
cat >/tmp/aiko-walk.json <<'JSON'
{"nodes":[
  {"id":"research","plan":"collect evidence","depends_on":[],"status":"pending",
   "writes":["out/research.json"],"invoke_skills":["websearch"],"witness":"test -s out/research.json"},
  {"id":"audit","plan":"audit the repository","depends_on":[],"status":"pending",
   "writes":["out/audit.json"],"invoke_skills":["code-review-and-quality"],"witness":"test -s out/audit.json"},
  {"id":"synthesize","plan":"join both results","depends_on":["research","audit"],"status":"pending",
   "writes":["out/report.md"],"invoke_skills":["copywriting"],"witness":"test -s out/report.md"}
]}
JSON
./zig-out/bin/aiko-doctor graph-plan /tmp/aiko-walk.json | python3 -m json.tool
```

The first `ready` frontier is `audit, research` in lexical order, so `kind` is `graph`. `waves` shows the deterministic Kahn plan; it does not execute the nodes.

## Read the verdict precisely

| Field | Meaning |
|---|---|
| `kind` | `graph` only when the current valid `ready` frontier has more than one node; otherwise `chain`. |
| `ready` | First executable Kahn frontier among nodes whose status is `pending`, `in_progress`, or `blocked`. |
| `waves` / `independent_groups` | Deterministic lexical frontiers for all active nodes. |
| `write_collisions` | Pairwise, component-aware overlap among declared write scopes. A named risk, not automatic workspace isolation. |
| `cycle_list` / `cycles` | Active nodes left by Kahn analysis. Any cycle empties all executable frontiers. |
| `unknown_dependencies` | References to node IDs absent from the walk. They also empty all frontiers. |
| `ungrounded` / `grounding_gaps` | Active nodes with no non-empty `invoke_skills`, `inspire_from`, or `capability_gaps`. |
| `ungated` / `gating_gaps` | Active nodes with no non-empty `witness`. |
| `model_tiers` | `judgement` for fan-in/fan-out of at least three or `how: eval`; otherwise `mechanical`. This is a routing hint. |

Malformed walks, unknown dependencies, and cycles are refusals. Collisions, grounding gaps, and gating gaps are reported by this ABI but **do not themselves remove `ready`**. The caller must close or explicitly govern those gaps before launch. The analyzer currently consumes node ID, status, dependencies, plan, writes, skill-grounding fields, witness, and optional `how`; a declared `reads` field is useful contract documentation but is not validated by this analyzer.

## Which layer does what?

| Layer | Owns | Does not own |
|---|---|---|
| **Contract** | Pure fail-closed walk analysis; durable ledger, obligations, leases, evidence and settlement elsewhere in Contract. | Cell execution or UI scheduling. `contract_graph_plan` itself is an observer and does not append a ledger row. |
| **Cell** | Typed YAML cell DAGs, strict ports, deterministic Kahn frontiers, serial same-frontier execution, manifests. | Contract durability or general task-walk scheduling. |
| **Neuron** | Standalone firing identity, committed citations/production, invalidation and three-case redrive. | Contract planning; observer-side effect-safety guesses. |
| **Aiko** | CLI/ABI/host composition and cross-layer acceptance. | A fifth scheduler or ledger. |

The representations are related but not interchangeable: a Contract walk is not automatically executed as a Cell, and Neuron’s `/graph` is committed provenance, not a task plan.

## Effects change the rule

Only a kind whose authority is mechanically confined by a portable, witnessed executor may ever parallelize. Frontiers are topological: dependency independence says what is ready, not what is safe to run concurrently. Cell fires every same-frontier Python, exec, HTTP, and composite sibling serially in lexical order. Python/exec caps are audit metadata, not confinement; an empty declaration does not establish effect freedom. Across task workers, overlapping writes need isolated workspaces plus an explicit reconciliation step.

When a cited source moves, deterministic computation may be re-derived under a new firing ID. An action already read back as sent must **never** be replayed. It becomes a compensation obligation over the old and new products (case 3).

## Acceptance

```sh
bash tests/graph-engineering-gate.sh
```

This gate runs the real Contract dylib witness, the complete Cell gate, the standalone/live Neuron observer gate, and a focused compiled Rust-host test for strict admitted-graph response validation. It also checks the prompt-entry ordering anchor and forbidden dependency directions. The Rust test does not drive a live ACP client, so “root gate green” proves the producer ABI, compiled response membrane, lower-layer seams, and dispatch ordering claim—not every desktop runtime behavior.

## Read next

- [ARCHITECTURE.md](ARCHITECTURE.md) — ownership, mappings, invariants, and diagrams.
- [MIGRATION.md](MIGRATION.md) — move serial or implicit flows onto declared graph contracts.
- [EXAMPLES.md](EXAMPLES.md) — runnable chain, fan-out, refusal, gap, invalidation, and compensation examples.
- [video-analysis.md](video-analysis.md) and [video-transcript.md](video-transcript.md) — source-grounded lecture material and its provenance boundary.
- [repository-audit.md](repository-audit.md) — the pre-implementation audit; its “gaps” section is a dated snapshot, not the current feature list.

## Source vs. synthesis

The supplied video is a Stanford career lecture by Andrew Ng and Laurence Moroney about AI work, product discovery, delivery, risk, technical debt, hype, and an intent → plan → tools → reflect loop. It does **not** teach DAG scheduling, Aiko, Cell, Neuron, Contract, typed graph edges, witnesses, or compensation. Translating its themes into the graph mechanics documented here is project synthesis. Reported percentages, forecasts, demonstrations, and anecdotes remain speaker claims unless independently verified.
