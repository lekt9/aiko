# Composio and AgentMail in Aiko

## What works—and what does not

This is an **opt-in, read-only API integration rollout**, not universal browser authentication.

- Composio's live session tools run through Aiko's existing native `execute` → `tools.call` path. No second agent, MCP server process, or catalog of hard-coded app primitives is introduced.
- Gmail, Outlook and other supported Composio toolkits can be discovered dynamically. Composio supplies their Connect Links; Aiko sends them privately to the current Telegram owner. Each user still approves the provider's requested access.
- AgentMail provisions one pod and one inbox per enabled owner. Its model-facing tools expose the address and whether mail is present, **not mail bodies, verification codes or links**. AgentMail's `count` is the returned page length, so the one-message presence check does not claim an inbox total. It does not send email.
- The existing browser sign-in and encrypted cookie custody remain separate. An OAuth API connection is **not** a Google/Microsoft browser session, and an AgentMail inbox is not a Google/Microsoft identity.

**Not completed by this change:** live Gmail/Outlook consent, an owner-bound real AgentMail inbox, Microsoft/other-provider browser SSO, AgentMail-backed OTP consumption, arbitrary-service login, or deployment. Existing private Google/email assistance has its own [verification gate](connector-engine.md#gmail-first-scope-and-verification). Do not use ordinary Composio mail reads to obtain OTPs for the model. The result sanitizer withholds recognized sign-in messages and credential fields/URLs, but is not a general-purpose proof that arbitrary mail encodings contain no secrets.

## Enable an owner

Install with the repository's pinned pnpm and scripts disabled. `@composio/core` is pinned in [the agent package](../apps/agent/package.json). The requested [Composio skill](../.agents/skills/composio/SKILL.md) is installed in this repository.

Supply `COMPOSIO_API_KEY` and/or `AGENTMAIL_API_KEY` through the existing private environment loader. Locally, Bun reads the ignored root `.env`; the standard owner-only `AIKO_SECRET_FILE` is also supported. Never put keys in tool arguments, scripts, committed configuration, or chat replies.

```dotenv
AIKO_CODE_MODE=true
# Actual authenticated Telegram user IDs, not chat/group IDs or placeholders:
AIKO_INTEGRATION_OWNERS=123456789
```

The owner must independently pass the normal account-admission policy. The integration allowlist does not create a Telegram account or override authentication. There is no shared `default` user and no automatic owner selection. Child workers do not inherit these grants.

For hosted use, set the same three integration variables in the Worker secret environment. [The existing deploy script](../scripts/deploy-aiko-cloudflare.ts) forwards them only when explicitly provided. Restart/rebuild after configuration changes. This work did not deploy or change live secrets.

Once enabled, try in your private Telegram conversation:

- “Connect Gmail so you can read my unread email.” (Or Outlook.)
- “Create my AgentMail inbox and tell me its address.”
- “Read the public Hacker News front page.”

A sent connection button is not proof of consent. Check the provider's current connection status and the actual execution receipt before claiming a result.

## Native tool contract

Discover `integration_list`, then `integration_tools` with `server: "composio"` or `"agentmail"`. Call `integration_call` with the returned `tool`, `schemaDigest` and fresh `arguments`. `integration_connect` initializes the tool session; its `ready` status is **not app authorization**. `integration_disconnect` disables this thread's provider dispatch until explicitly reconnected; it does not revoke upstream OAuth or delete mail/history.

Composio exposes the available safe session meta tools, currently search, schema lookup, connection management and multi-execution. App slugs and schemas come from the provider, not guessed names. The host removes optional workflow/session selectors from model-facing schemas and supplies correlation privately. A multi-call accepts up to eight app calls, validates each input against provider metadata, checks the read-only tag, and rejects destructive tools and nested meta calls. The provider session independently restricts discovery/execution to read-only tools. Remote workbench/bash, proxy execution and automatic file transfer are disabled. Broader OAuth scopes displayed during consent are not permission for this runtime to execute writes.

The same [dynamic tool runtime](../apps/agent/src/dynamic-tools.ts) serves existing MCP integrations through a compatibility export in `general-mcp.ts`; old names and receipts remain readable. Its execution, schema pins, account grants and retained-result checks are shared rather than copied. Results use the existing private CodeHarness custody. The host allowlist/key grant controls retained integration data; disconnecting a provider upstream does not by itself erase previously retained account history. Remove the host grant to cut this runtime's retained access. There is no upstream webhook-based revocation synchronizer in this rollout.

## Identity and custody

Composio user IDs and AgentMail `client_id`s derive from a SHA-256 digest of the **existing actor instance and authenticated owner**. Keep the instance stable across deployments. Do not migrate to a new provider identity without an explicit account migration.

Provider records use `connectors:<owner hash>:integration:<binding digest>` in the existing private connector store (owner Durable Object on Worker; private file/Postgres store locally). Records pin owner, provider identity and resource/session ID. Credential fingerprints separate replaced project keys, without storing the keys in those records. Restored foreign records fail closed. A deleted retained Composio session is an error, not permission to silently replace it.

AgentMail creates pods and inboxes only on an explicit native provisioning call with current, matching Telegram sender/chat/turn provenance. Deterministic `client_id` supports AgentMail's documented idempotent resource recovery. Before inbox-status reads, Aiko checks the pod's original client ID and the inbox's pod. No model-supplied pod/inbox ID or organization-wide mailbox endpoint is exposed. The organization key remains host-side; it is not passed to Composio, the model or a VM. Private OTP transport would need a separate, attempt-bound grant and private runner binding—not a generic email tool.

SDK retries, redirect following and SDK logging/tracking are disabled. The native runtime owns uncertain execution; do not resend an interrupted effect. Composio's published session interface does not currently expose cancellation options on `tools()`/`execute()` in its TypeScript types: requests have a 60-second transport timeout, and cancellation/revocation is checked before and after the call. An already-dispatched request may still finish remotely.

## Verification

[Sanitized live evidence](composio-first-call.json) records:

- A real native `COMPOSIO_SEARCH_TOOLS` discovery.
- `COMPOSIO_MULTI_EXECUTE_TOOL` → the discovered `COMPOSIO_SEARCH_FETCH_URL_CONTENT`, fetching `https://news.ycombinator.com/`.
- Successful upstream data, **cached** source, and Composio log ID `log_UsJ-xtKaH4Ql`.
- AgentMail `GET /v0/auth/me` returned HTTP 200. No inbox was created and no mail was read in this credential check.

This used the explicit existing **local/demo** identity, no paid Aiko inference, no Telegram delivery, and no private user integration. Search or successful key validation alone is not a connected-account tool-call witness.

Reproduce a read through the same native runtime:

```sh
# An operator-owned JSON file, containing no credentials:
# {"server":"composio","tool":"COMPOSIO_SEARCH_TOOLS",
#  "arguments":{"queries":[{"use_case":"Read the public Hacker News front page"}]}}
bun scripts/verify-integrations.ts --owner local --instance demo --request /path/to/request.json
```

Omit `tool` to inspect live meta schemas; discover the actual app slug/schema before executing it. `--state` selects a private provider-record directory (default `.aiko/integration-verification`). `--evidence` writes an exclusive owner-only result file: private API results must not be committed. This operator verifier refuses write-class tools, Connect Links and inbox provisioning.

Focused checks:

```sh
bun --no-env-file test apps/agent/test/integrations.test.ts \
  apps/agent/test/general-mcp.test.ts apps/agent/test/general-mcp-config.test.ts \
  apps/agent/test/tool-router-tools.test.ts
pnpm --filter @unlock/agent typecheck
pnpm aiko:cloud:build
# Optional reproducible Cell wrapper for the same offline tests:
UNLOCK_ROOT="$PWD" cell run scripts/integrations-verify.cell.yaml --out /tmp/integration-check
```

## Why this boundary

2026-09-08 — Add Composio as the preferred live API-session discovery path when enabled, while preserving native/local routing, existing Arcade compatibility and historical receipts. Generalize the existing MCP executor instead of creating provider-specific app primitives or another agent loop. Keep the first rollout read-only because dynamic multi-execution must not bypass effect approval. Reconsider writes after exact app schema/account pins, existing human action approvals, uncertain-operation recovery and end-to-end consent have a joined verification witness. Expand private identity providers only after an owner-approved SSO/OTP journey demonstrates exact origin/recipient/attempt binding, ambiguity rejection, custody and restart behavior.

### Official references consulted

- [Composio sessions](https://docs.composio.dev/docs/configuring-sessions.md)
- [Composio session SDK](https://docs.composio.dev/reference/sdk-reference/typescript/sessions.md)
- [Composio authentication](https://docs.composio.dev/docs/authentication/manually-authenticating.md)
- [AgentMail documentation index](https://docs.agentmail.to/llms.txt)
- [AgentMail multi-tenancy](https://docs.agentmail.to/multi-tenancy.md)
- [AgentMail idempotency](https://docs.agentmail.to/idempotency.md)
- [AgentMail API schema](https://docs.agentmail.to/openapi.json)
