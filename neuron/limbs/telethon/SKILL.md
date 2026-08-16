---
name: typed-neuron/telethon-effect
description: Provider-neutral admitted messaging effect policy with exact tuple ACLs, durable digest-only outbox, independent per-recipient read-back, linked requeue and compensation without replay.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"telethon-probe","receptor_schema":"neuron.telethon-effect-request/v1","reads":[{"id":"telethon/probe","schema":"neuron.telethon-effect-request/v1","digest":"54296802830d00d295311e371770020de159a8569509dcf9ca45a56f62cebaa4","bytes":"{\"conversation_id\":\"chat-A\",\"credential_handle\":\"cred:synthetic\",\"effect_id\":\"effect-0000000001\",\"execution\":\"exec-1\",\"expires_at\":100,\"payload_digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"recipient_id\":\"worker-1\"}"}],"permitted_reads":["telethon/probe"],"messages":[]}
expect_contains: artifact/telethon/outbox/effect-0000000001
---

# Telethon effect policy

`effect` is a pure planner. `boundary.py` is an injected-provider membrane. It
normalizes inbound updates, requires exact `(conversation, recipient, action)`
ACL entries, journals an intent before crossing, and settles accepted or
uncertain sends only after independent read-back for that same recipient.

The append-only record excludes bodies, credentials, provider errors and raw
updates. Its dead-letter rows retain Contract execution/effect IDs, opaque
recipient, attempt, bounded classification and evidence digests. Expired pending
work is dead-lettered. Authorized requeue creates a new execution and effect
linked to the dead letter; it never edits history. Amendments produce a sorted
per-recipient delta. Invalidation cancels uncrossed work and marks crossed work
for compensation; dispatch and reconciliation never blindly replay it.

The witness uses only a hermetic provider double. This package makes **no claim
that production Telegram or an employee account was contacted**. A later host
may attach the admitted package digest unchanged and inject a real provider.
