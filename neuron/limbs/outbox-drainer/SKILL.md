---
name: typed-neuron/outbox-drainer
description: Drains queued outbox messages to adapters with bounded retry, dead-letter and reconciliation; the drainer fires on an outbox.drain-request/v1 stimulus and re-declares each still-eligible message as an adapter-bound send paired with a numbered delivery-attempt record, while the reconciler settles one delivery from provider evidence.
probe_input: {"firing_id":"probe-drain","messages":[],"now_ms":0,"permitted_reads":["drain-req","queued","rec-a","rec-b"],"reads":[{"bytes":"{\"max_attempts\":5,\"max_batch\":4,\"partition\":\"mock:\"}","digest":"84182e2018bc0bdfa64e73521ab8fe81b5f802acd021e3189cafb0a27903aee1","id":"drain-req","schema":"outbox.drain-request/v1"},{"bytes":"{\"messages\":[{\"firing_id\":\"f-done\",\"key\":\"403a7b83947f1858ec8b3babc91608f815cf5a047278990fc534018d05b0a65b\",\"payload\":\"{\\\"text\\\":\\\"done\\\"}\",\"schema\":\"t/v1\",\"to\":\"mock:chan\"},{\"firing_id\":\"f-retry\",\"key\":\"3bfd47fc61c52cbe45226ab09b27c45e883e3ad19edbf64bb0c47243f1cbd8fb\",\"payload\":\"{\\\"text\\\":\\\"retry\\\"}\",\"schema\":\"t/v1\",\"to\":\"mock:chan\"}],\"partition\":\"mock:\"}","digest":"727302955beb1291a3f4631912ff4ba7eea41e3d4e048664aecc4f36a9d08fcd","id":"queued","schema":"outbox.queued-messages/v1"},{"bytes":"{\"attempts\":1,\"key\":\"403a7b83947f1858ec8b3babc91608f815cf5a047278990fc534018d05b0a65b\",\"schema\":\"outbox.delivery-record/v1\",\"status\":\"acknowledged\"}","digest":"90c5fbf4dac1b8877f88727ad73a597f5d556cc9cfbc2a44e0d17abd44518831","id":"rec-a","schema":"outbox.delivery-record/v1"},{"bytes":"{\"attempts\":2,\"key\":\"3bfd47fc61c52cbe45226ab09b27c45e883e3ad19edbf64bb0c47243f1cbd8fb\",\"schema\":\"outbox.delivery-record/v1\",\"status\":\"retryable\"}","digest":"f3ca1fe14338be445c42522925726d4e5aeb87588026f714330cdcea02ae6644","id":"rec-b","schema":"outbox.delivery-record/v1"}],"receptor_schema":"outbox.drain-request/v1","schema":"neuron.stimulus/v1"}
expect_contains: artifact/outbox/attempts/3bfd47fc61c52cbe45226ab09b27c45e883e3ad19edbf64bb0c47243f1cbd8fb/3
---

# typed-neuron/outbox-drainer

**Status**: reference generative limb (§30) — policy core delivered, see
`README.md` for what is explicitly *not* claimed.

Policy Neurons for draining queued messages through named adapters **without
moving retry policy into the kernel**. Adapters own credentials; the neurons
own eligibility, attempt counting, and settlement.

## The two neurons

- `neurons/drainer.py` — folds the record history (`outbox.delivery-attempt/v1`
  plus `outbox.delivery-record/v1`, all digest-pinned reads) into per-key state,
  selects the still-eligible messages in the requested partition, and declares
  two effects per message:

  ```
  write  artifact/outbox/attempts/<key>/<n>   (outbox.delivery-attempt/v1)
  send   <original channel>                   (envelope carrying <key> as the
                                               idempotency key)
  ```

  Terminal keys (`acknowledged`, `dead_letter`) and in-flight keys are skipped,
  so a duplicate drain declares nothing. An empty eligible set settles as
  `terminate drained`.

- `neurons/reconciler.py` — settles exactly one delivery per firing. `settle`
  mode folds an attempt record plus the adapter's ack into
  `acknowledged` / `retryable` / `dead_letter` / `reconciliation_required`;
  `reconcile` mode releases a parked delivery **only** on fresh provider
  evidence staged as a new read. No fresh evidence is a typed
  `insufficient_evidence` rejection — delivery is never assumed.

## Why the acceptance is what it is

The probe stimulus stages two queued messages in partition `mock:`. One already
carries an `acknowledged` delivery record (terminal — must be skipped). The
other carries a `retryable` record at **2** attempts, under a `max_attempts` of
5, so it is eligible again and its next attempt is **3**.

The declared acceptance is the attempt artifact id

```
artifact/outbox/attempts/3bfd47fc…d8fb/3
```

Three separate things have to be right before that string exists: the message
key must survive the content-identity check (`sha256(firing_id|to|schema|
payload)`, so the id is not a token the probe can hand over), the terminal key
must have been excluded by the fold, and the attempt ordinal must be derived as
`prior + 1` from the record history. A drainer that ignored history writes
`…/1`; one that re-drained the acknowledged message writes a second artifact
under the other key. Neither can print this string. The evidence claim on the
same decision reads `declared 1 adapter-bound sends for partition mock:`.

Reproduce it directly:

```sh
printf '%s' "<probe_input>" | python3 neurons/drainer.py
```

## Key invariants

- **Pure policy (§2).** No adapter, no secret, no clock beyond the stimulus's
  `now_ms`. A `send` effect is a declaration; the harness commit boundary is
  the only linearization point.
- **The idempotency key is the message identity**, not a counter — the same
  message re-ingested is the same key and drains once.
- **Uncertainty parks, it does not settle.** An unknown adapter exit is
  `uncertain`, which becomes `reconciliation_required`, which only fresh
  provider evidence can clear.
- **Attempt ceilings are in the request** (`max_batch`, `max_attempts`), not in
  the interpreter; crossing the ceiling on a retryable outcome is what turns it
  into `dead_letter`.

## Conformance

```sh
python3 tests/conformance.py
```

Creates its own fixtures, drives the real `driver.py` against
`tests/mock_adapter.py` for the ack / permanent / retryable / uncertain
markers, then fires the reconciler on fresh evidence to release the parked
delivery.
