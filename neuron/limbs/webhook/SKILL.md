---
name: typed-neuron/webhook
description: Provider-neutral admitted HTTPS webhook effector that pins destination, credential generation and execution fence, durably parks unknown acceptance for read-back, and compensates rather than resending crossed effects.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"webhook-probe-1","receptor_schema":"neuron.webhook-request/v1","now_ms":0,"reads":[{"id":"webhook/probe","schema":"neuron.webhook-request/v1","bytes":"{\"body_digest\":\"4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93\",\"body_schema\":\"example.event/v1\",\"credential\":{\"audience\":\"https://webhooks.example.com\",\"destination_host\":\"webhooks.example.com\",\"generation\":7,\"handle\":\"cred_opaque_7f4d\",\"operation\":\"POST\",\"resource\":\"/v1/events\"},\"destination\":\"https://webhooks.example.com/v1/events\",\"effect_id\":\"effect-0123456789abcdef\",\"execution\":\"exec-1\",\"lease_fence\":9,\"method\":\"POST\",\"redirects\":[],\"resolved_ips\":[\"93.184.216.34\"],\"status\":\"https://webhooks.example.com/v1/status/effect-0123456789abcdef\"}","digest":"1edb6ec3912d9c74ad8a5d27e04ba4179533ba09b550484151a4afaca942e137"}],"permitted_reads":["webhook/probe"],"messages":[]}
expect_contains: artifact/webhook/outbox/effect-0123456789abcdef
---

# webhook

The `webhook` neuron is the pure, admitted planning half. It accepts a digest-pinned
`neuron.webhook-request/v1` and writes one immutable `neuron.webhook-plan/v1` outbox
intent. The request pins the literal HTTPS destination (host/path), method, payload
schema and digest, public DNS set, opaque native credential handle plus generation,
Contract execution and lease fence, logical effect id, status endpoint, and every
permitted redirect. It never receives payload or secret bytes.

`boundary.py` is the effecting half. It fsyncs a digest-only outbox record before
crossing, re-resolves DNS immediately before each hop, refuses non-global addresses
(including private, loopback, link-local and metadata), and disables ambient redirect
following. Credential bytes arrive only on an inherited native-provider file
descriptor, are used to HMAC the exact supplied body bytes, and are zeroed; payload
and secret bytes/signatures are excluded from the JSONL state.

A 2xx send is not success. Settlement requires a separate GET of the pinned status
endpoint whose receipt repeats both logical effect id and payload digest. Timeout,
reset, malformed/missing receipt, or unknown provider acceptance parks as
`reconciliation_required`; `reconcile` performs read-back only and cannot resend.
Invalidation cancels queued work, while any crossed work becomes
`compensation_required`, matching redrive case 3.

The checked-in witness uses an in-process provider double and deterministic public
DNS answers. It makes no claim that a live provider was contacted. The production
CLI uses Python's TLS-verifying HTTPS connection with automatic redirects disabled.
