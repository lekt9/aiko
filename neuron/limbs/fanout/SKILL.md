---
name: typed-neuron/fanout
description: Turns one fanout.request/v1 read into N spawn effects whose child identities are deterministic in (partition, key, seq), each carrying a grant narrowed to that item's write prefix. Use when a single firing must split work across independent children and a redelivered coordinator must not double-spawn them.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"probe-fan-1","receptor_schema":"fanout.request/v1","reads":[{"id":"fan-req","schema":"fanout.request/v1","bytes":"{\"partition\":\"tasks\",\"items\":[{\"key\":\"add-task\"},{\"key\":\"notify-user\"}],\"max_fanout\":8,\"seq\":0}","digest":"b8b13b11b15af4a526594f5ed755a737a9422e88a58b4c59c407a403a1b734e7"}],"permitted_reads":["fan-req"],"messages":[]}
expect_contains: fanout/tasks/notify-user/0
---

<!--
Acceptance note. `expect_contains` is the identity of the SECOND spawned child.
It is `fanout/<partition>/<key>/<seq>`, composed from three fields that only
exist inside the digest-pinned read — so the string is false unless the limb
opened the read, walked past the first item, and applied the identity rule. A
handler that emits a fixed decision, stops at items[0], or invents its own child
naming misses it. The whole point of the limb is that this string is a pure
function of the request: that is what makes a redelivered coordinator dedupe
instead of double-spawning.
-->

# typed-neuron/fanout

**Status**: reference generative limb (§30)

Reusable fan-out: one coordinator firing becomes N children with narrowed
delegations, derived entirely from a pinned `fanout.request/v1` read.

## What it does

Reads `{ partition, items: [{key, kind?, write_prefix?}], max_fanout, seq }` and
emits one `spawn` effect per item:

- **identity** — `fanout/<partition>/<key>/<seq>`
- **kind** — the item's `kind`, defaulting to `fanout-worker`
- **grant** — `allow_write` only, scoped to the item's `write_prefix`
  (default `artifact/fanout/<key>/`), with a one-write, depth-1 budget

Control is `terminate` with result `fan:<n>`; evidence cites the request read by
id, so the fan-out is visible to invalidation.

## Key invariants

- **Deterministic identities (§26).** Every child id is a pure function of
  `(partition, key, seq)`. Re-firing the identical stimulus produces the
  identical spawn set, and the runtime dedupes by spawn identity — the
  conformance witness asserts the second delivery commits 0 effects with 3
  `duplicates_skipped`.
- **Narrowing, never widening (§24).** Each child grant is strictly inside the
  limb's own `artifact/fanout/` write prefix and `fanout/` spawn prefix from
  `neuron.json`. The harness — not this neuron — enforces that.
- **Fail closed on over-fan.** `len(items) > max_fanout` is a typed
  `budget_exhausted` rejection carrying no effects. It does not truncate the
  list and proceed.
- **Pure policy (§2).** The neuron declares spawns; it starts nothing. No clock,
  no filesystem, no network.
- **Schema-gated.** A stimulus whose `receptor_schema` is not
  `fanout.request/v1` is a `validation` rejection before anything is read.

## Usage

```sh
# Admit the inert package by digest, then fire through the admitted path
neuron limb admit  . <state_dir>
neuron limb run    <state_dir> --package . --neuron fanout \
                   --stimulus <stimulus.json> --json
```

## Witness

```sh
python3 tests/conformance.py
```

Drives the real CLI from an empty state dir and gates on durable state at every
step: admit (idempotent digest), fan out 3 spawns, redeliver the identical
stimulus (3 skipped / 0 committed), exceed `max_fanout` (non-zero exit),
`revoke` (further runs blocked), `detach` (firings survive GC).
