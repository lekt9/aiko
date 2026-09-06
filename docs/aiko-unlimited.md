# Aiko: unlimited task execution

Aiko no longer has a default tool-call ceiling. Leave `AIKO_TOOL_CALL_LIMIT` unset, or override an existing numeric setting explicitly:

```sh
AIKO_TOOL_CALL_LIMIT=unlimited pnpm aiko:dev
```

Restart the local service to load the policy. This change does not automatically enable the browser, paid inference, or any provider. If another process already occupies the port, restart that process deliberately rather than starting a second host against its state directory.

## What changed

- **No default 4/64/10,000-call ceiling.** Null/omitted tool budget means the native Tardie budget component is not mounted; it is not represented by an enormous number or non-JSON `Infinity`. Positive safe integers remain an explicit operator opt-in to a finite native budget.
- **No repeated-result stop.** Identical observations can continue; Aiko does not emit or enforce `AikoBrowserNoProgress` anymore. Previously completed turns are not reopened or rewritten.
- **No browser lifetime command quota.** Aiko enables the actual client's rolling trace mode. Settled, acknowledged correlation records retire between commands; published native evidence and monotonically increasing event IDs remain. Per-command flood/byte guards and bounds on unresolved correlation are retained. The client's original full-capture mode and HAR validation stay unchanged for other consumers.
- **No “browser context full” task completion.** Oversized transient expansion is omitted for that model request instead of completing the turn. Native compaction starts earlier to reserve room for browser excerpts and tool schemas. The model's context window is still finite.
- `/api/status` reports `toolCallLimit: null` and `noProgressStop: false`; the console displays **unlimited tool calls**. An explicitly configured numeric budget is shown instead.

The native harness continues until the planner finishes, the owner cancels, or execution encounters a terminal error/shutdown. There is no additional task-wide wall-clock timer or total-token budget introduced by Aiko. Repeated failures, broken telemetry and uncertain browser actions are not blindly retried forever.

## What “unlimited” does not mean

The requested change removes artificial task-length stops, **not all safety and resource bounds**. These remain:

- Authentication, account/tenant isolation, source permissions and human approvals.
- No blind replay of interrupted mutations; changed approval URLs/snapshots still block the action.
- Request admission/concurrency safeguards, finite RAM/disk, bounded payloads and retained evidence.
- Provider context/output limits, native failure/repair limits and individual network/model/browser command timeouts.
- Temporary browser profile idle cleanup and observation/approval expiry.
- The public-web egress policy and credential protection; no arbitrary host shell, JavaScript, file or cookie-export tools are added.

Live inference can now incur continuing costs without a tool-count cutoff, including during an unproductive loop. Use **Cancel task** to stop it. Tests use synthetic providers; no live paid inference, real account interaction, deployment or private-configuration change was performed for this work.

## Verification

- An actual native host executes **200 browser tool calls**, including repeated identical observations and native compaction, without a budget/no-progress stop.
- Another ongoing native turn is cancelled after passing **80 calls**, without further tool execution.
- The real browser client executes **2,300 mocked process exchanges / 4,600 trace events**, exceeding the old lifetime limits while retaining bounded correlation. Late results cannot duplicate or change settled receipts, and rolling mode does not reset a failed transport into a healthy one.
- Existing owner isolation, approvals, native crash recovery, memory, provider-adapter and cancellation regressions remain required. Explicit finite opt-in is also tested.
- Real Chromium public-site browsing and the approval/console interfaces are checked separately through browser-harness; they do not establish infinite-duration reliability or unlimited provider capacity.

Current evidence: [`artifacts/aiko-unlimited/verification.json`](../artifacts/aiko-unlimited/verification.json). The earlier browser implementation receipt remains historical; this document supersedes its default-budget and no-progress claims.
