# Drop-In Spawn — capability-bounded child Aiko

`inheritEnv=false`, `SpawnAuthorityPolicy` fenced lease, `delegation_capability` opaque handle (subject/tenant/root+parent/fence + audience/purpose + expiry/max_effects + scope). Child shares root, distinct execution/occurrence; no transcript/HOME/API_KEY copy. Cross-journal citations survive compact.

Reply authority: `neuron/limbs/conversation` SMP-33 — child with no `allow_send` can answer `reply_to` on attested correlation; `ForgedSender` blocked.

Lease fence: `contract/libcontract/src/cross_journal_retention.zig` retains evidence+ordinal across `compact`.
