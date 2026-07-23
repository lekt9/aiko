---
name: contract-interface
description: Generate a provider-neutral Contract-native interface pack from any CLI, API, app, device, watcher, or messaging surface. Use whenever an agent needs to connect a new input/output surface, run it as a durable process or loop, or make an existing integration Contract-native. Treat named providers such as Telegram and iOS as examples, never permanent branches in the core.
---

# Contract Interface

An interface is a temporary phenotype grown from one declarative receptor
specification. Do not add provider branches to Aiko or Contract.

## Morphogenesis

1. Discover the real interface and its available adapter command/API.
2. Write one receptor JSON using `references/receptor.schema.json`.
3. Declare inbound events before filtering and outbound effects with authority,
   idempotency, evidence, privacy, TTL, and supported response variants.
4. Run `scripts/grow.py SPEC --out DIR`. This emits a Contract-native skill
   graph, capability catalog, normalized receptor, and an optional generic
   runtime descriptor.
5. Validate with `scripts/conform.py DIR`.
6. Install only when requested: `scripts/grow.py SPEC --install`. Installation
   copies the generated pack to the user skill layer. A declared runtime can
   additionally be rooted as a user process with `--start`; this is an explicit
   effect and never happens during generation.
7. Test the same invariant with a second, unlike interface. If the compiler or
   Contract core needs the provider's name, the abstraction has failed.

The fixed cell is:

`observe → normalize → authorize → prepare → execute → sense → evaluate → settle`

Read-only cells may branch. Effects depend on authorization and preparation.
Provider acknowledgement is evidence for execution, not proof of human
consumption. Unsupported response kinds HOLD; they never silently become text.

Use Telegram, iOS, email, a filesystem watcher, or a future device only as
fixtures proving the same germ layer. Adapter implementation remains real
platform code; this skill generates the Contract-native root around it.
