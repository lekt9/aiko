---
name: typed-neuron/preemptor
description: Proposes an exact, replay-safe cache candidate for a stimulus by fingerprinting its identity against recorded firings. Use when a firing is about to be dispatched and a prior decision may be reusable — the limb nominates a candidate for the canonical runtime to revalidate, and never replays an effect itself.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"f-probe-001","receptor_schema":"example.greet-request/v1","caps_fingerprint":"caps-greet-read-only-v2","reads":[{"id":"input/ada","schema":"example.greet-request/v1","digest":"749a62808254a4acbcaf5262beaecfbd42a9c88877ec1f53de3d2fe58fa8449b","bytes":"{\"name\":\"ada\"}"}],"messages":[{"schema":"neuron.preempt-cache/v1","payload":"[{\"firing_id\":\"f-9f2c04\",\"receptor_schema\":\"example.greet-request/v1\",\"stimulus_fingerprint\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"decision\":{\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"greetings/kai\"}}]}},{\"firing_id\":\"f-3a91e7\",\"receptor_schema\":\"example.greet-request/v1\",\"stimulus_fingerprint\":\"f1135bc749eb4c8cf624ead7557c403457f3ee91619e5a31f7d97f9cf332eb0c\",\"decision\":{\"effects\":[{\"kind\":\"send\",\"message\":{\"to\":\"outbox/ops\"}}]}},{\"firing_id\":\"f-58d3e1\",\"receptor_schema\":\"example.other-request/v1\",\"stimulus_fingerprint\":\"f1135bc749eb4c8cf624ead7557c403457f3ee91619e5a31f7d97f9cf332eb0c\",\"decision\":{\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"greetings/zoe\"}}]}},{\"firing_id\":\"f-c72b90\",\"receptor_schema\":\"example.greet-request/v1\",\"stimulus_fingerprint\":\"f1135bc749eb4c8cf624ead7557c403457f3ee91619e5a31f7d97f9cf332eb0c\",\"decision\":{\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"events/greet-settled\"}}]}},{\"firing_id\":\"f-6e15af\",\"receptor_schema\":\"example.greet-request/v1\",\"stimulus_fingerprint\":\"f1135bc749eb4c8cf624ead7557c403457f3ee91619e5a31f7d97f9cf332eb0c\",\"decision\":{\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"greetings/ada\"}}]}},{\"firing_id\":\"f-b04c2d\",\"receptor_schema\":\"example.greet-request/v1\",\"stimulus_fingerprint\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"decision\":{\"effects\":[{\"kind\":\"write\",\"artifact\":{\"id\":\"greetings/bob\"}}]}}]"}],"budget":{"max_effects":2,"max_writes":1,"max_messages":0,"max_spawns":0,"max_bytes":65536,"max_depth":1}}
expect_contains: proposed exact cache candidate f-6e15af; zero effects replayed
---

# typed-neuron/preemptor

**Status**: reference generative limb (§30)

Safe preemption proposal: finds exact replay-safe cache candidates.

## What it is

A pure Neuron that receives a stimulus and cached firing records. It proposes an
exact identity match only when the recorded decision is replay-safe. It never
replays effects. The canonical Zig cache independently recomputes the complete
identity and revalidates policy, reachability, and idempotency before reuse.

## Key invariants

- §25: The limb emits an inert candidate record and replays zero effects.
- §30: Learned prediction may rank candidates but cannot become a second cache authority.
- §2: Pure and stateless.

## Conformance

```sh
python3 tests/conformance.py
```

## Why the acceptance above is not free

The probe carries three cache entries, and the answer is the third one.

- `f-sent-9c1` is first in the list and carries the **identical** stimulus
  fingerprint, so anything that matched on fingerprint alone — or simply took
  the first entry — would name it. Its cached decision `send`s, and §25 refuses
  to preempt an external boundary crossing, so it is disqualified.
- `f-other-4e8` is replay-safe but is a different stimulus identity, so exact
  matching drops it.
- `f-replay-safe-2b7` is the only entry that is both an exact identity match and
  replay-safe.

Naming it requires actually computing `stimulus_fingerprint` over
`receptor_schema` + the digest-pinned reads + the caps fingerprint, and then
running the replay-safety filter over the candidates. The fingerprint appears in
the probe only as an opaque hex string on the entries; a handler that does not
recompute it from the stimulus cannot tell the decoy from the answer.
