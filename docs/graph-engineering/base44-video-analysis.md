# Video analysis: Base44 — *Your ideas, your apps*

> **Historical.** Dated review or transcript. Not current product documentation. What the tree is today: [../SOURCE-OF-TRUTH.md](../SOURCE-OF-TRUTH.md).

## Identification and evidence boundary

The supplied URL is a 56-second Base44 product advertisement, not an explanation of graph engineering. Its direct message is that one person can describe an application, refine it in layers, connect tools, increase its sophistication, style it, and continue iterating whenever another idea occurs. The visuals show a natural-language prompt, a travel-planning example, an integration prompt for Google Drive, dashboard and learning-app examples, style controls, and a mindfulness-app prompt. Those are observed marketing images; they do not establish the implementation, security, reliability, determinism, or deployment properties of the product.

> **Provenance boundary:** “Source claims” below summarizes the advertisement. “Graph-engineering interpretation” is an Aiko design synthesis. The advertisement does not mention Aiko, Cell, Neuron, Contract, DAGs, typed edges, admission, digests, witnesses, redrive, or compensation. It must not be cited as endorsing those mechanisms.

The normalized source transcript is [base44-video-transcript.md](base44-video-transcript.md). The downloaded media is `/home/deck/Downloads/oIcP3BOvyeY.mp4`.

## What the advertisement actually claims

| Source phrase | Marketing proposition | What remains unproven by the clip |
|---|---|---|
| “Describe it and it’s real” | Natural-language intent can produce an application quickly. | Correctness, completeness, durable state, deployability, and whether the result satisfies the user’s real acceptance criteria. |
| “One thought leads to more thoughts, layer by layer” | Building is incremental and conversational. | How revisions track dependencies, invalidate derived work, or preserve earlier invariants. |
| “When you need your tools, bring them in” | External integrations can be added during construction. | Authentication, least privilege, effect isolation, retries, idempotence, and independently observed completion. |
| “Create something smarter… powerful” | The platform can add more capable behavior. | Model boundaries, determinism, resource bounds, and failure modes. |
| “Style counts” | The generated product can be visually customized. | Accessibility, responsive behavior, consistency, or regression coverage. |
| “Keep building” | Iteration is continuously available. | A convergence rule, rollback, version identity, or a settlement condition. |

## Graph-engineering interpretation

The advertisement is useful to Aiko chiefly as a compact statement of the desired **experience**: intent should become a working system without forcing the user to manually operate orchestration machinery. Graph engineering supplies the missing mechanical conditions under that experience.

```text
user intent
    │
    ▼
Aiko admission membrane ──refuse──► no worker dispatch
    │ admitted root + digest
    ▼
Contract obligation graph
    │ deterministic waves / holds / terminal state
    ▼
Cell typed execution graph
    │ declared ports, resources, effects, witnesses
    ▼
Neuron committed provenance
    │ cites / produces / stale derivations
    ▼
observed result ──new evidence──► invalidate, redrive, or compensate
```

### 1. “Describe it” becomes a typed problem, not an unchecked prompt

A prompt is only the first input. Before reasoning-worker dispatch, normal Aiko use declares a Contract root, expands the admitted graph, validates ABI, root identity, digest, children, holds, and complete non-empty waves, then obtains a valid continuation. A malformed or incomplete graph refuses. This preserves the low-friction experience while preventing “a model started” from being confused with “the requested work was admitted.”

### 2. “Layer by layer” becomes explicit data and settlement edges

A sequence of conversational turns is not automatically a graph. An edge exists only when a downstream node reads an upstream product or requires its settlement. Contract’s Kahn analysis identifies the current ready frontier; it does not infer independence from prose order. Declared reads, writes, produces, and dependencies make later revision impact visible instead of burying it in chat history.

### 3. “Bring tools in” becomes admitted capability plus effect policy

Tool availability is not launch authority. A graph-native harness declares the capability, input/output schema, resource needs, acceptance witness, and effect class. Content-addressed admission binds the package to the bytes reviewed. Cell may fan out deterministic, isolated work; Python and exec siblings remain serialized where declared caps are only audit metadata rather than OS confinement.

### 4. “Smarter” stays at the edges of deterministic recomputation

A model can help interpret intent, draft content, or summarize exceptions, but a non-deterministic model on the recompute path destroys the termination proof. Producers whose outputs drive invalidation must be deterministic over pinned inputs. Model suggestions never become durable launch authority merely because they are plausible.

### 5. “Keep building” requires invalidation and a stopping rule

Iteration is safe only when the system knows what changed and what was derived from it. Neuron reconstructs provenance from committed `cites` and `produces` edges. Contract invalidation makes superseded obligations stale. Redrive then separates three cases: deterministic recomputation, opening an agent goal where nothing crossed a boundary, and compensation where an external effect already crossed. Re-sending the old effect is refused.

Every cycle also owes a convergence rule. Per-node witnesses and terminal states establish local settlement; the end-to-end gate establishes system settlement. Unbounded progress may continue, but repeated unchanged failure must not masquerade as work.

### 6. “I built this” becomes attributable provenance

Graph-native authorship is not a claim about who typed every byte. It is a durable account of who requested the work, what package and inputs were admitted, which nodes produced which outputs, what evidence they cited, which effects crossed boundaries, and which witnesses settled them. That makes the surprising result inspectable rather than magical.

## The design lesson for Aiko, Cell, Neuron, and Contract

| Layer | Native responsibility | Refusal it owns |
|---|---|---|
| **Aiko** | Turn ordinary prompts into mandatory native admission before worker dispatch; expose diagnostics and package surfaces. | No native library, rejected/mismatched/incomplete graph, invalid continuation, or failed cleanup means no worker. |
| **Contract** | Own durable declarations, graph planning, admission identity, holds, invalidation, and terminal truth. | Cycles, unknown dependencies, invalid statuses, malformed identity, and false terminalization are rejected. |
| **Cell** | Execute a declared typed cell graph and emit canonical provenance manifests. | Invalid ports/edges, unsafe concurrency, missing witnesses, and unsupported effect claims fail closed. |
| **Neuron** | Fire primitives independently of Contract and project committed citation/production edges. | An uncited dependency is not invented; observation does not make topology claims it cannot see. |

This split preserves the central architecture rule: **no fifth scheduler and no second ledger**. “Graph-native” does not mean forcing every component into one graph runtime. It means each layer speaks an explicit graph contract at its boundary and refuses claims beyond its authority.

## Requirements carried into the GraphHarness compiler

The ad’s desired flow suggests a reusable package boundary, but the package must be stronger than a prompt template. A GraphHarness package therefore needs:

1. a canonical schema version and deterministic package identity;
2. typed node dependencies and data contracts;
3. skill grounding or an explicit capability gap per executable atom;
4. runnable per-node and end-to-end witnesses;
5. resource and effect declarations, including isolation assumptions;
6. bounded recursion and a convergence policy;
7. transitive content digests for all executable or interpretive inputs;
8. compatibility rules that never silently weaken admission;
9. provenance sufficient for invalidation, redrive, compensation, and audit;
10. a clear ownership statement that reuses Contract planning/admission, Cell execution, Neuron observation, and Aiko composition rather than copying them.

The package compiler described in [HARNESS-SPEC.md](HARNESS-SPEC.md) and [HARNESS-COMPILER.md](HARNESS-COMPILER.md) is the mechanical continuation of those requirements. A missing document link indicates that the corresponding graph node has not yet settled; documentation must not imply otherwise.

## Bottom line

Base44’s advertisement offers a compelling interaction target: describe, connect, refine, and ship without orchestration ceremony. It does not show the evidence needed to trust that path. Aiko’s graph-engineering design aims to preserve the surface simplicity while making admission, dependency, execution, observation, invalidation, effects, and settlement explicit and mechanically checkable underneath.
