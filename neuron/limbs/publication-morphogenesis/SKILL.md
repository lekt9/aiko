---
name: typed-neuron/publication-morphogenesis
description: Inbound interface morphogenesis — searches the node's live ports for reuse, drafts an inert published-interface document bound to an already-admitted handler, and judges a real over-the-listener probe into retain-or-retire. Use when callers need this node to serve a contract it does not serve yet, or when a freshly published port must be proven to actually serve its gap before anything is kept.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"f-judge-001","receptor_schema":"neuron.publication-probe/v1","reads":[{"id":"publication-morphogenesis/gaps/f326eb2fa2463be07f0fbf8dbf2ccfa1","schema":"neuron.publication-gap/v1","digest":"16636dc632cf984a98a57ad4d2575500cca1f151e6c546548b264319d6ff7446","bytes":"{\"id\":\"example/greet\",\"need\":\"callers hand this node a name and receive a typed greeting\",\"route\":\"/greet\",\"method\":\"POST\",\"emits\":[\"example.greeting/v1\"],\"expect_contains\":\"hello ada\"}"},{"id":"publication-morphogenesis/probes/f326eb2fa2463be07f0fbf8dbf2ccfa1","schema":"neuron.publication-probe/v1","digest":"a350b06d58c26b94b29dee3cd174dfdc2135119d725a9eae0b6c4003ca7b1dcb","bytes":"{\"schema\":\"neuron.publication-probe/v1\",\"gap\":\"example/greet\",\"published\":\"c0dd2d78f82ed73ec7591fd92ad3e8105a58670551f45f5d373196221160112c\",\"agent\":\"porter\",\"transport\":\"http-listener\",\"listener\":\"127.0.0.1:8791\",\"url\":\"http://127.0.0.1:8791/agents/porter/greet\",\"method\":\"POST\",\"status\":200,\"product_schema\":\"example.greeting/v1\",\"neuron_status\":\"served\",\"response_body\":\"{\\\"answer\\\":\\\"hello ada\\\",\\\"schema\\\":\\\"example.greeting/v1\\\"}\"}"},{"id":"publication-morphogenesis/patterns/f326eb2fa2463be07f0fbf8dbf2ccfa1","schema":"neuron.publication-pattern/v1","digest":"8d61d72520e9eb0d883e4efc94a579a3a911ad8063a575c07f7728514f02c668","bytes":"{\"schema\":\"neuron.publication-pattern/v1\",\"gap\":\"example/greet\",\"interface\":\"c0dd2d78f82ed73ec7591fd92ad3e8105a58670551f45f5d373196221160112c\",\"route\":\"/agents/porter/greet\",\"verified_successes\":2}"}]}
expect_contains: retained/3
---

# publication-morphogenesis — a published interface that a listener actually serves

`src/morphogenesis.zig` closes an **outbound** capability gap: the agent needs
something it cannot reach, so a boundary is discovered, derived, tested,
admitted, attached, retried on the real path, and judged — or nothing is kept.

This limb is the **inbound** counterpart. A publication gap says callers need
this node to *serve* something it does not serve, and the same loop runs in the
other direction:

```text
PublicationGap
  → search the node's own live ports by typed surface
  → derive an explicit published-interface document as an inert artifact
  → `neuron port publish` admits it, `neuron port attach` binds the route
  → a REAL HTTP client calls it over a REAL `neuron port http` listener
  → judge the outcome
  → retain and rerank, or detach + revoke
```

## Why this is a limb, not kernel

`IMPLEMENTATION.md`'s change procedure defaults an interpreter feature to an
admitted limb; kernel placement demands a concrete trust-boundary, atomicity,
isolation, or liveness reason. This loop has none, because **every authority
step it needs is already a kernel verb** — `neuron port publish|attach|detach
|revoke`, all wired through `src/serve.zig`, all funnelling into
`Runtime.execute`. What remains is drafting a document out of substrate state
and judging an observation against a declared acceptance. That is generation,
and `limbs/introspection/neurons/limb_designer.py` is the direct precedent: it
already generates a whole limb package as inert data, admitted only by a later,
independent step.

As a limb this loop is digest-pinned, admitted, and revocable. As kernel code it
would hold ambient authority it does not need, and could not be revoked without
a rebuild. It adds no CLI verb and does not touch `src/main.zig`: it drives the
public CLI an operator already has.

## The three refusals, carried inbound

**1. Reuse is searched before generation.** `reuse-searcher` compares the gap
against the node's own port census on *typed surface*, not on path — a gap asks
for a capability, not a URL. If a live admitted port already serves the
contract, the plan says `reuse`, and `port-drafter` takes that plan as a
*required read* and refuses to draft. There is no branch that reaches a draft
without a search that failed, so a second live route over one capability is
structurally unreachable rather than merely discouraged.

**2. Nothing is retained on compilation alone.** A port that publishes,
attaches, and answers `200` under the promised schema has still proven nothing.
`publication-judge` judges the body against the gap's own `expect_contains`,
and an unverified port is judged `retire` — the verdict carries the exact
`port detach` and `port revoke` calls that withdraw it. Admission is not
success.

**3. Rankings are learned only from verified results.** A
`neuron.publication-pattern/v1` record is written on the verified branch and
nowhere else, and `reuse-searcher` ranks candidates by it. A port that never
served anything cannot become the one reuse prefers. A pattern belongs to one
(gap, interface) pair: a different port starts its own record rather than
inheriting a ranking it never earned.

## And one refusal this direction needs that the outbound one does not

Outbound, "the real path" is `membrane.invokeRead` — the same call the agent
would make, so an in-process probe *is* the real path. Inbound it is not. The
real path is a TCP socket, an HTTP request line, a route table, a caller check,
a body decode, and a firing, and **none of that runs when a probe fires the
handler limb directly**. An in-process probe proves the limb works. It says
nothing about whether the port works, which is the whole claim being judged.

So `publication-judge` refuses any probe that does not attest an off-process
listener — `transport` must be `http-listener`, the url authority must equal the
attested listener socket, and the path must be this gap's `/agents/<agent>`
mount point. A refused probe writes **no artifact at all**: a verdict grounded
in the wrong observation is worse than no verdict, because it would be retained.

## Neurons

### reuse-searcher
Reads a `neuron.publication-gap/v1` and a `neuron.port-census/v1` (the node's
published records plus its live route table), optionally with prior
`neuron.publication-pattern/v1` records. Writes one
`neuron.publication-plan/v1`: `reuse` (naming the port and its verified-success
count) or `generate`.

### port-drafter
Reads the gap, the plan, and a `neuron.limb-census/v1` built from the node's own
`neuron.limb-admission/v1` records. Resolves the handler *out of that census* —
the gap may not name a handler digest, so a port can never be drafted for an
implementation this node has not already admitted by digest. Writes an inert
`neuron.published-interface/v1` document plus a
`neuron.publication-draft-record/v1` provenance record.

`requested_caps` is derived from the invocation mode alone and carries no
prefixes: the kernel computes the write and send namespaces from `(agent,
published digest)` at attach time, and a document that named them would be
claiming a namespace it is not entitled to choose. A read may not send; a
command must.

### publication-judge
Reads the gap and a `neuron.publication-probe/v1`. Writes a
`neuron.publication-verdict/v1`, and — only when verified — a
`neuron.publication-pattern/v1`.

## What these neurons refuse

- A probe that is not an attested off-process HTTP observation —
  `insufficient_evidence`, and nothing is written.
- A gap carrying any outbound manifest field (`implementation_digest`,
  `url_template`, …) — refused rather than dropped, so an operator never
  believes a pin exists that nothing checks. The list is kept byte-identical to
  `serve.zig` `FORBIDDEN_FIELDS`.
- A gap naming its own `requested_caps` or `handler_digest` —
  `capability_denied`.
- A route with a `{param}` segment, a query, a traversal, or the `/agents/`
  prefix — an un-schema'd input channel, or a shadow of the harness mount point.
- A receptor schema outside `accepts` — that port would be an execute-anything
  capability wearing a contract.
- A command bound to a safe method, or a command with no reconcile route.
- A gap with no `expect_contains` — unfalsifiable; anything returning bytes
  would "serve" it.
- A plan belonging to a different gap.
- Overwriting a record that was not staged as a read (`cas_write`): replacing
  something you have not read is the lost update the interpreter's
  compare-and-swap exists to prevent.

## Authority

None. These neurons write ordinary artifacts under `publication-morphogenesis/`
and nothing else — `allow_send` and `allow_spawn` are false for all three. A
drafted document serves nothing until `neuron port publish` admits it and
`neuron port attach` binds it, and a retire verdict withdraws nothing until an
operator runs the calls it names.

## Witness

```sh
zig build
PYTHONDONTWRITEBYTECODE=1 python3 limbs/publication-morphogenesis/tests/conformance.py
```

It drives `neuron agent init`, `neuron limb admit|run|revoke|detach`, and
`neuron port publish|attach|detach|revoke|list|http` from an empty directory,
starts a real listener in a separate process, calls it with a real HTTP client,
and asserts against durable substrate state, real HTTP status lines, and the
harness's own typed refusals — never stdout resemblance.

Each of the four refusals above has been removed individually and the witness
caught every one:

| Refusal removed | Witness failure |
|---|---|
| over-the-listener probe check | `an in-process probe was accepted as evidence about a port` |
| reuse before generation | `a second port was drafted over a contract already served` |
| retire on unverified | `a port that does not serve its gap was retained` |
| verified-only ranking | `a retired port trained the ranking` |

Run with `PYTHONDONTWRITEBYTECODE=1` and ship no `__pycache__`: a `.pyc` inside
a digest-pinned package changes its admission digest with the Python version.
The witness asserts the package digest has not moved by the end of the run.

## Why the acceptance above is not free

The probe drives `publication-judge`, the neuron that carries refusals 2 and 3.
It is fed the `example/greet` gap, an attested `http-listener` observation, and
one prior `neuron.publication-pattern/v1` record standing at
`verified_successes: 2`.

The literal `3` appears nowhere in the input. Reaching `retained/3` requires all
of the following to have actually happened:

1. `require_listener` accepted the observation — `transport` is `http-listener`,
   the url authority equals the attested `127.0.0.1:8791`, the path is exactly
   `/agents/porter/greet`, the method matches the route's declared `POST`, and
   the published digest is 64 hex characters.
2. All four `judge` conditions held — HTTP `200`, a `served` firing status, a
   `product_schema` inside the contract's `emits`, and a response body
   containing the gap's own `expect_contains` (`hello ada`).
3. `prior_successes` found the existing pattern for exactly this
   (gap, interface) pair and incremented it.

Any single failure changes the answer: a wrong-schema answer or a `200` with the
wrong body yields `retired` and writes no pattern at all; a bad probe is a typed
`insufficient_evidence` rejection with no artifact; and a handler that ignores
the prior record yields `retained/1`.
