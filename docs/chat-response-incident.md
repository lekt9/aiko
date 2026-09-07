# Chat response incident, 2026-09-07

## Large-history recovery timeout

A separate Telegram conversation accumulated more than 17,000 durable events and stopped advancing while incoming messages continued to arrive. Cloudflare reported Durable Object storage timeouts and isolate resets. Local replay reproduced roughly 14 seconds of synchronous work before inference, dominated by transcript materialization in Tardigrade's compaction guard.

The pinned `tardie@0.22.0` patch in `patches/tardie@0.22.0.patch` checks the existing incremental transcript weight before materializing events. It retains the same compaction thresholds, event history, cancellation semantics, and transition inputs. The same local history replay fell to about 2–3 seconds. Regression coverage includes a 20,000-observation history and comparison with complete-history compaction at every tool-round prefix.

After deployment, the previously stranded cancellation settled, Telegram acknowledged its recovery notice, and the next queued turn began inference and tool execution. Readiness alone did not detect this incident; recovery must be verified against conversation progress and delivery receipts.

Validation: 659 agent tests passed, eight environment-gated tests skipped, and the agent and Cloudflare typechecks passed. A fresh isolated production request completed through `respond`, `AikoReplyPrepared`, and `TurnCompleted` with the expected answer. Telegram acknowledged queued replies on the affected account; older requests were still catching up at verification time.

## Provider conversation formatting

A queued Telegram message arrived between a browser `ToolCalled` and its eventual `ToolReturned`. Tardigrade retained the correct chronological journal, but the OpenAI-compatible request also placed the user message between the assistant tool call and tool response. Cerebras rejected this conversation with HTTP 400 on every subsequent request, including greetings.

## Evidence

The production export covered 11,245 events across 15 threads. Eight accounts were discovered; one busy account returned HTTP 409 and was excluded. The affected conversation contained 11 blocked response notices, each accepted by Telegram. These were inference failures, not failed delivery of those notices.

A fresh Cerebras request returned HTTP 200. Replaying the affected history before the repair returned HTTP 400 with `wrong_api_format`, identifying a browser tool call whose result did not immediately follow it. The same history after the repair returned HTTP 200 and completed. These probes only ran inference; no browser action or Telegram message was replayed.

Four historical delivery rejection events also appeared in the inspected export, including control-lane projections and a synthetic probe. Their retained reason was `invalid_request`; the original Telegram descriptions were discarded, so this audit cannot establish their exact cause. They were not resent. Browser `blocked` and `unknown` receipts remain visible as unresolved outcomes.

## Repair

- The provider adapter places each recorded tool result immediately after its matching assistant call on the wire. It preserves user messages, result contents and the durable journal. Missing or duplicate results fail validation instead of being invented.
- Provider HTTP responses retain a sanitized status and Retry-After hint so native Tardigrade retry classification can work. The default retry delays are 500 and 1,500 ms and can be overridden. Provider response bodies are discarded.
- Inference failures now reach native `TurnFailed` with their diagnostics. The existing outbox sends a safe service notice. Previously the response wrapper converted failures into `respond` followed by `TurnCompleted`, hiding the failure.
- Account discovery now reads the control API's `account` field. Successful queued, completed, listed, processed and ready receipts no longer count as errors. Blocked responses and Telegram rejection reasons are reported. The same snapshot produces 39 signals instead of 83; these include expected cancellations and policy blocks, not just defects.

## Model routing

| Role | Primary | Fallback |
| --- | --- | --- |
| Conversation | Codegraff `deepseek-v4-flash` | Codegraff `muse-spark-1.3-contributor` |
| Retrieval | Cerebras `qwen-3.8-27b` | Codegraff `muse-spark-1.3-contributor` |
| Browser inference | Cerebras `qwen-3.8-27b` | Codegraff `muse-spark-1.3-contributor` |

`AIKO_CONVERSATION_FALLBACKS`, `AIKO_RAG_FALLBACKS` and `AIKO_BROWSER_FALLBACKS` accept JSON arrays of `{provider, model}` entries. Fallbacks run after transient inference failure, with the existing native adapter, selected provider credentials, cancellation signal and shared accounting. A successful tool call does not trigger fallback or repeat its effects. Permanent malformed requests and refusals do not trigger model fallback. Actual serving endpoints remain recorded, and known usage is aggregated without inventing missing costs. The separate image-inspection transport is unchanged.

## Tardigrade integration and validation

The installed `tardie@0.22.0` source and [upstream Tardigrade](https://github.com/clavia-labs/tardigrade/tree/d9f16c1) were inspected, including the HTTP server, native model retry policy, message projection, method calls and host driver. Upstream was at release 0.22.3. This repair retains the pinned runtime and its reconciler, tool execution, cancellation, compaction and durable outbox. It changes the application's provider adapter rather than introducing a second agent loop or changing actor identity.

The full agent suite passed 645 tests, with 8 environment-dependent tests skipped and no failures. The miner's two regression tests, both host TypeScript checks, native CLI build and call, and Worker dry run passed. The native CLI witness completed through `respond` and the outbox at `http://127.0.0.1:4287/?thread=audit`; this URL lasts only while that local process runs. Build digest: `sha256:17f9bcd8a295c9b55d011be108200fb71b7a077826479964f8514bd7e8e7b68a`.

Both requested Codegraff models produced valid `respond` calls in live probes. DeepSeek used 455 reported tokens in 1,876 ms; Muse used 906 in 6,282 ms. These different models are not a matched latency comparison. No dependency was added. Matched before/after model cost and total billed cost are unavailable. Telegram delivery and ambiguous-send restart were tested through the real native host with a fake transport; this work did not send unsolicited test messages into user chats.

Worker version `b1f30a5d-ac2b-4a3e-b3f7-bf4a04479207` contains this repair and the configured fallbacks. The deployed readiness endpoint confirms all three role configurations. An isolated production API canary recorded DeepSeek inference, `ToolCalled(respond)`, `AikoResponseRequested`, `AikoReplyPrepared`, and native `TurnCompleted`, with the expected answer in 2,716 ms of observation. It made no external message deliveries. Private raw exports and detailed verification files are retained under `/tmp/aiko-chat-audit/`; shareable verification summaries are under `artifacts/chat-response-audit/`.
