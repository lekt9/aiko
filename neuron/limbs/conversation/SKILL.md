---
name: typed-neuron/conversation
description: Bidirectional correlated exchange between neurons — an asker opens a conversation and parks on the answer, a responder answers any peer using only the return address stamped into its own stimulus. Fires when one neuron must ask another something and wait for the reply, and when a neuron holding no send capability must still be able to answer the peer that asked it.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"probe-1","receptor_schema":"conv.ask/v1","messages":[{"to":"neuron/responder","schema":"conv.ask/v1","payload":"{\"question\":\"how long is this?\"}","from":"neuron/asker","correlation":"conv-probe-1","reply_to":"neuron/asker-inbox","turn":1}]}
expect_contains: {"correlation":"conv-probe-1","payload":"{\"answer\":17,\"question\":\"how long is this?\"}","schema":"conv.answer/v1","to":"neuron/asker-inbox"}
grounding: neuron/AGENTS.md#2, neuron/AGENTS.md#10.1, neuron/src/runtime.zig
---

# typed-neuron/conversation

**Status**: reference generative limb (§30)

Bidirectional neuron communication: a correlated request, a park on the answer,
and a reply whose authority comes from possessing the request rather than from
anything the replier was granted.

## What it does

Three neurons, all pure and stateless (§2). The conversation's state lives in the
durable message envelope and the park predicate, never in a process.

### asker — `conv.start/v1`, `conv.answer/v1` → `conv.ask/v1`, `conv.settled/v1`

One neuron covering both halves of an exchange, distinguished only by what
arrives in its stimulus:

- no answer present → emit a correlated request and `continue`, parking on
  `reply/<correlation>`. The pump holds unrelated traffic while parked, so
  another conversation cannot consume the park.
- the answer present → `terminate`, writing what was heard to
  `artifact/conversation/<correlation>/settled`.

### responder — `conv.ask/v1` → `conv.answer/v1`

The point of this neuron is what it does **not** have: no send capability
(`allow_send: false` in its manifest), no configured peer list, no knowledge of
who might call it. It can still answer, because the request carries its own
attested return address (`reply_to`) and conversation identity (`correlation`),
both stamped by the interpreter at the asker's commit boundary. Reply authority
is conferred by possession of the request.

The "work" it performs is deliberately trivial — it answers with the length of
the question — because the exchange, not the computation, is the claim.

### forger — adversarial fixture

Bypasses the shared `_neuron` helpers entirely and writes a raw decision
asserting provenance it does not own (`from`, `reply_to`, or `turn`). It is
granted a **full** send capability, so its rejection is about forged provenance
and never about missing authority. If this neuron ever commits an effect, the
trust boundary is broken.

## Key invariants

- **The interpreter stamps `from`, `reply_to` and `turn`, not the neuron.** A
  decision that self-asserts any of the three is rejected as `ForgedSender`.
  The guard is in the interpreter, not in the Python SDK — that is what the
  forger exists to prove.
- **A reply follows the attested return path exactly** and cannot be re-aimed at
  a third party (runtime.zig `answeredRequest`). It needs no send prefix.
- **A one-way message confers no reply authority.** A request carrying no
  `reply_to`/`correlation` is a typed `capability_denied`, not a silent
  unauthorized send.
- **A conversation cannot outrun its turn ceiling** (`max_turns: 4` here). Either
  the neuron's own conversation check or the interpreter valve catches it; both
  fail closed and neither commits.
- Rejected firings commit nothing. The conformance witness asserts the journal
  grows by exactly the one valid reply across five adversarial firings.

## Conformance

```sh
python3 tests/conformance.py
```

Every assertion drives a real `neuron limb ...` command against a real durable
substrate and reads the committed envelopes back out of `substrate.log`. Source
presence is not the claim; those commands are.

## Probe

The frontmatter probe fires the **responder** with a request it was never
configured to expect. The acceptance is the computed reply body — `answer` is
`len("how long is this?")`, so the string only appears if the request was
parsed, the transform ran, and the reply was aimed at the attested `reply_to`
on the attested correlation:

```sh
echo '<probe_input>' | python3 neurons/responder.py
```
