# /contract JSON shape

The substrate (Zig binary + sibling SDKs) is a **pure validator and
row-writer**. It does no LLM calls, no inference, no translation.
What it accepts is JSON in the /contract shape; what it writes is a
signed ledger row. Nothing else.

The LLM lives **outside** the substrate, as a translator. Its job is
to convert a human-shaped sentence (plus domain context) into JSON
matching this schema, intentionally translating the sentence into
the **terminology of the layer below**.

```
   layer 6  ─ operator sentence ────┐
                                    │  LLM translates ↓ one layer
   layer 5  ─ value JSON  ──────────┘  (terminology of value: wallet/x402)
                ↓ substrate validates + signs + appends row
   layer 4  ─ transport JSON  ──────  (terminology of transport: webhook/tunnel/...)
                ↓ ...
   layer 0  ─ word JSON  ───────────
```

Every step down the trio of layers, the LLM (outside the substrate)
re-expresses the truth claim in vocabulary one level more concrete.
The substrate refuses to land any JSON that doesn't validate — there
is no escape hatch.

## Canonical schema

The substrate validates each incoming row JSON against this shape.
Required fields are marked `R`; optional `?`.

```jsonc
{
  // R — event kind. Determines which other fields are required.
  "event": "declared" | "iterated" | "satisfied" | "died",

  // R — 8-hex contract id (the canonical pointer). On `declared`
  // rows the substrate generates this if absent; on subsequent
  // event rows it must match an existing id.
  "id": "deadbeef",

  // R for declared / iterated — the truth claim or output text.
  "plan": "the user wants to know X",

  // R for declared — the action shape (a typed pointer prefix).
  // Inferred layer via libcontract/src/pointer.zig:inferLayer.
  // Must be one of the prefixes pointer.zig knows; unknown shapes
  // collapse to `cli:` (layer 2) and fail spirit-attest later.
  "action": "neuron:user" | "cli:..." | "validate:..." | ...,

  // R for declared — the pointer-inferred layer (0..8).
  // The substrate refuses any layer outside this range
  // (libcontract/src/pattern.zig comptime invariant).
  "layer": 3,

  // ? — parent contract id; null/absent means root.
  "parent_id": "c0ffee99" | null,

  // ? — typed edges to other contracts (DAG synapses).
  // Each entry is { to: "<id>", kind: "pointer"|"inhibits"|... }.
  // libcontract/src/contract.zig defines the SynapseKind enum.
  "synapses": [],

  // ? — wallet-derived ed25519 chain. Populated by the substrate
  // at write time; callers must not supply these themselves.
  "env_pubkey": "<64 hex>",
  "parent_signature": "<128 hex>",

  // ? — content-addressed digest folding cwd + plan + parent.
  // Populated by the substrate. Same plan+context always returns
  // the same id (idempotent).
  "inputs_hash": "<64 hex>",
  "inputs_hash_version": 2,

  // R for satisfied — iteration wave the satisfy refers to.
  "wave": 1,

  // ? for satisfied / died — proof / cause text.
  "proof": "...",

  // R always — actor identity.
  "agent": "<email or agent id>",

  // R always — RFC3339 timestamp.
  "ts": "2026-05-26T22:45:00Z"
}
```

## Validation rules (the substrate refuses non-conforming JSON)

These mirror the comptime + runtime invariants already in
`libcontract/src/pattern.zig` + `libcontract/src/pointer.zig`:

1. **Event is one of the four enums.** No custom event types — the
   ledger walker would silently skip unknown events, creating a
   blind spot.
2. **id is 8 lowercase hex chars.** Validates the canonical pointer
   format.
3. **layer is in 0..8.** Out-of-range fails the substrate's pattern
   gate. Adding a layer = editing pointer.zig + re-attesting; not
   negotiable at row-write time.
4. **action's prefix is one of the known typed pointers.** Unknown
   actions degrade to layer 2 (cli/api) and trigger spirit-attest
   failure on the next build. Callers should match an existing
   prefix or extend the substrate's source first.
5. **parent_id, if present, is 8-hex or null.** Same as id format.
6. **synapses, if present, is an array of {to:8hex, kind:string}.**
   kind must be one of the SynapseKind enum values.
7. **No future-only fields.** Fields the substrate doesn't yet
   understand are passed through verbatim but trigger a one-line
   "unknown_field" diagnostic — append-only ledger means the row
   stays even if a downgraded substrate can't fully interpret it.

## How an outside LLM produces this JSON

The substrate doesn't dictate the LLM's prompt. But the canonical
recipe (used by `contract-openai-api` when it's wired) is:

```
INPUT  to LLM:
  - the sentence (human-shaped truth claim)
  - the layer the sentence currently lives at (1..8)
  - a digest of the published /contracts in scope (domain context)
  - the JSON schema above (verbatim, in the prompt)
  - instruction: "Re-express this sentence as /contract JSON,
    targeting layer N-1. Use the terminology and typed pointer
    prefixes appropriate to layer N-1. Output strict JSON only."

OUTPUT from LLM:
  /contract JSON matching the schema above.

The substrate then:
  - validates the JSON
  - rejects if any rule above is violated
  - signs (env_pubkey + parent_signature) and appends the row
  - fires the L7→L8 cascade if applicable
```

The LLM has freedom in HOW to translate (which action shape, which
synapses, which evidence) — the substrate has authority over WHAT
shape is acceptable. Authority + freedom are separate concerns.

## Layer-down translation examples

| Input layer | Input sentence | Output layer | Output action |
|---|---|---|---|
| 6 (operator) | "decide whether to retry the failed call" | 5 (value) | `wallet:retry-budget` |
| 5 (value) | "spend $0.02 of retry budget on a re-attempt" | 4 (transport) | `webhook:https://api.x/retry` |
| 4 (transport) | "POST the retry payload to the webhook" | 3 (graph) | `neuron:webhook-call` |
| 3 (graph) | "the retry neuron fires and records its result" | 2 (cell) | `cli:curl -X POST ...` |
| 2 (cell) | "execute the curl command" | 1 (system) | `machine:darwin-arm64` |

Each step is a fresh /contract row (child of the prior, signed by
the prior's keypair). Walking the chain reconstructs the full
intent → execution → result trace.

## The trio at each layer

`build / run / eval` (the canonical user verbs Lewis named) apply
to every layer identically:

- **build** = validate + append a `declared` row at THIS layer
- **run** = validate + append an `iterated` row referencing the
  declared one (an iteration child is itself a fresh /contract at
  the same layer, action `iterate:<parent>`)
- **eval** = append a `satisfied` row; if the row's action is L7
  (`validate:`), the substrate auto-spawns the L8 `signed:` child

The translation step (sentence → JSON) is what moves between
layers; the trio operates within a layer. To traverse layers,
chain trio calls: build at L6, eval at L6 → produces L5 trigger
→ build at L5, etc.
