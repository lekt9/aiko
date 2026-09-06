# Tardigrade native audit — 2026-09-06

Aiko now uses native method futures for router calls, native invocation cancellation and resume epochs, native output validation for reflection, and durable effect records for workflow recovery. The Telegram investigation also fixed the path between a completed model turn and a delivered reply. This audit covers the existing agent, Node host, Cloudflare host, router, background actors, workflow harness and channel boundary.

## Findings and changes

| Boundary | Finding | Result |
| --- | --- | --- |
| Router bridge | A custom dispatch-and-poll bridge duplicated method lifecycle behavior. | `actorCall` owns `CallPlanned`, `InvocationLinked`, dispatch, response and deadlines. Router placement uses native lineage and routing. Pending legacy dispatches are adopted without resending. |
| Router cancellation | Slow catalog I/O could outlive the foreground request. | Router method effects carry native invocation context; foreground cancellation propagates to the child and late results cannot become decisions. |
| Root admission | Custom key routing and host seeding interfered with native root cancellation/resume events. | Hosts validate actors and recognize native ingress, method, response, cancellation and timeout keys. Controls commit root events. |
| Resume | Some projections treated any old terminal as the current turn's terminal. Native `ToolReturned` does not carry an epoch. | Turn state uses native epoch/terminal projections. The response gate correlates a return with its current native call. Automation, typing and delivery projections respect resumed epochs. |
| Response | Plain inference completion could bypass the required channel response tool. | The inference adapter requires `respond` or a successful final channel tool before completion. Native tools record the response request; the outbox prepares and delivers it. |
| Reflection | Hand-written output parsing duplicated the native output protocol. | A declared reflection output contract and `outputValidateOnce` perform native validation; owner, evidence and semantic checks remain application policy. |
| Workflow recovery | Ephemeral workflow handles could disappear between native execution and a recorded result. | The native intent is committed before execution. Stable run IDs, stored receipts and recovery fencing prevent repeated effects. Unconfirmed attempts remain unknown. |
| Workflow authorization | Execution only matched a connection's primary connector ID, while authorization also accepted its authorized tool IDs. | Both resolve the same connected provider/tool relationship; execution rechecks revocation. |
| Telegram outbox | The next queued inference could precede delivery of the previous response. | Outbox effects are reconciled before the next inference. |
| Telegram persona | Invalid persona output was rejected with no message. The previous generation operation could answer the draft instead of rewriting it. | The adapter uses the persona rewrite operation. Protected anchors still must survive validation. Failure produces one fixed service notice through the same durable outbox. |
| Telegram transport | Strict-provider `null` optional fields rejected normal sends; long replies hit a local transport limit. | Optional nulls are normalized. The sender uses the shared bounded Telegram transport, including one rich message for long text. |
| Cloudflare execution | Heavy actor recovery was started from the short ingress RPC through `waitUntil`. | Ingress schedules an immediate durable alarm; the alarm awaits the native host driver. |

`actor.ts`, `channel-response.ts`, `tool-router*.ts`, `background.ts`, `workflow-host.ts`, `tool-workflows.ts`, `telegram-*.ts`, `server.ts` and `cloudflare.ts` contain these changes. Full source fingerprints are recorded in the audit artifacts.

## Deliberately retained boundaries

The Cloudflare adapter supplies physical Durable Object storage, alarms and transport to Tardigrade's reconciler and thread driver. It is not a second inference loop. Node uses the native Bun host. Passive history import remains a seed operation so importing historical delivery events cannot replay external effects.

Browser and workflow inference adapters keep credentials and raw transient request/response values outside durable model logs. The workflow DAG executor is a bounded domain capability under a native tool invocation, with owner authorization and operation receipts. It is not a parallel conversational agent loop or an arbitrary Python executor.

Memory continues through the `entity-learn` workspace library. The Tardie 0.5 package adapter is not exported; native tools, host-owned scope and the CLI witness in [aiko-entity-learn](aiko-entity-learn.md#native-cli-witness) are the integration. Browser transport continues through the linked `@unbrowse/browser-harness` low-level exports; their domain-specific indexes, auth membrane and request dependency graph are not replaced by actor orchestration.

## Verification

The regression suite passed **524 tests**, with **5 explicitly skipped live tests**, **0 failures**, and **5,013 assertions**. Both agent and Cloudflare TypeScript checks passed. The fixed and held-out checks include queued delivery ordering, direct final media, persona failure, ambiguous-send restart, cancellation during router I/O, resumed response completion, owner mismatch and workflow crash recovery. Deterministic providers are test fixtures, not evidence of live provider success.

The repository-pinned CLI built and served the native response witness. A method call completed through the production response gate and outbox. The global `tdg` executable on this machine resolves an older actor API despite its version label; the runnable command uses the repository dependency:

```sh
bun apps/agent/node_modules/tardie/src/cli/main.ts build apps/agent/scripts/audit-native-response.ts --out /tmp/aiko-native-cli/final-build --json
bun apps/agent/node_modules/tardie/src/cli/main.ts call message '{"text":"Verify the final response tool."}' --thread audit --id audit-response-final --url http://127.0.0.1:4279 --timeout 10000 --json
```

The local Voyager trace remains at **http://127.0.0.1:4279/?thread=audit**. Build digest: `sha256:0e77754496228242056e3c405fc8265f0c80d458b02aae64e533d351b0d4f5c1`. The witness uses deterministic inference and sends no external messages. CLI artifacts are under `artifacts/tardigrade-audit/cli-{build,call-final,events-final}.json`.

The live provider check uses a separate account and the deployed account API, then verifies native `ToolCalled(respond)`, `AikoResponseRequested` and `AikoReplyPrepared`. Its receipt is `artifacts/telegram-audit/deployed-canary.json`. This is separate from live Telegram message delivery; the audit did not send test messages to user chats.

## Comparable measurements and limits

Nonblank lines compare the files captured at the start of this audit with the final working files. These counts include application policy and new Telegram features; they are not a claim of code-size reduction.

| Files | Before | After |
| --- | ---: | ---: |
| Main actor | 611 | 616 |
| Background actor | 728 | 739 |
| Router actor + bridge | 352 | 389 |
| Channel response boundary | 240 | 238 |
| Workflow engine + host | 628 | 668 |
| Telegram tools + transport + ingress | 1,916 | 2,025 |
| Cloudflare + Node host | 2,369 | 2,372 |

No dependencies were added by this audit. The baseline suite had 499 passing tests and took 18.54 seconds; the expanded final suite had 524 passing tests and took 20.33 seconds. Different case counts make these unsuitable as a model latency comparison. Matched before/after model tokens, provider cost, and live latency are unavailable. Deterministic tests and the CLI witness make zero paid model calls. Live probes are separately recorded; their aggregate billed cost is unavailable.

The baseline is a source fingerprint and regression result, not an immutable baseline actor artifact or a scored model-quality experiment. Consequently this report makes no quantitative model-quality improvement claim. Five live browser tests remain skipped unless their real environment is configured. The earlier password-relay connector witness still requires the deployed vault and owner runtime mapping; this audit does not establish that login works.
