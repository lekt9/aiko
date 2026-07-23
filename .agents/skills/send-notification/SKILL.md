---
name: send-notification
description: Prepare outbound notifications and send only with applicable durable authority. Use when the user request matches this workflow or explicitly names $send-notification.
---

# Send Notification

Materialize this workflow through `contract-skill.json`; do not bypass Contract
with an untracked action.

1. Resolve a channel-specific child skill.
2. Prepare content without sending.
3. Require explicit or durable outbound-message authority before delivery.

Read `contract-skill.json` for the executable graph, effects, evidence, and
examples. Treat consequential nodes as preparation-only until Contract reports
applicable authority. Settle completion only from the declared evidence.
