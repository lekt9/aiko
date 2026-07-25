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

## Memoized primitives (reuse, don't rebuild)

These are settled levers absorbed into the corpus. Each is a primitive a
generated pack or hand-written receptor may compose instead of reinventing;
re-running its witness re-verifies the memoized result.

### `scripts/proposer_receptor.py` — generic native-substrate LLM-proposer receptor

A provider-neutral, task-neutral proposer over the Contract substrate. ARC and
any task consume it; the LLM backend and prompt shape stay out of the core.
- **Fixed cell** as a thin Python orchestrator: `authorize (Zig gate) →
  transport (Python LLM I/O) → settle (Zig sense+validate+settle)`. The
  tamper-resistant policy lives in the substrate primitive `contract_propose_settle`
  (libcontract); Python owns only the external LLM I/O.
- **Transports** are pluggable behind `TransportRegistry` (RM3 shape):
  `AikoCliTransport`, `EchoTransport`, cloud/GGUF as sibling adapters. Swapping a
  backend touches nothing in the receptor or consumers.
- **Authority-gated** (fail-closed): the paid LLM effect HOLDs at the Zig gate
  unless the caller passes `authority=True`. Fail-open to a Python settle mirror
  only when libcontract is absent; the envelope records `settled_by`.
- **Witness**: `scripts/witness_proposer_receptor.py` (3 claims: provider-neutral
  Echo, substrate-native generic `aiko-proposer` provider + Zig authority gate,
  live `aiko-cli`+glm-5.2 call settled in Zig). `PROPOSER_LIVE=1 AIKO_MODEL=<id>`.

### Contract-substrate rebuild gotcha (macOS arm64)

A rebuilt `libcontract.dylib` comes out `linker-signed` (`flags=0x20002 adhoc,
linker-signed`) and macOS **SIGKILLs it on load** (rc=137) — indistinguishable
from OOM until you compare codesign flags. The aiko installer normally re-signs
adhoc on install (the shipped dylib carries a `.sync.` identifier). After a
manual rebuild: `codesign --force --sign - ~/.aiko/lib/libcontract.dylib`, then
re-run the FECH verifier before trusting the rebuild.
