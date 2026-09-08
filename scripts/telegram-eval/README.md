# Aiko Telegram evaluator

Exercises the deployed Aiko bot as a real Telegram user through Telethon, then joins client-observed messages to the native event log. MTProto and Bot API message IDs use different namespaces: inbound matching uses the unique owner, text and server timestamp; outbound matching uses content, timestamp and reply context. Ambiguous matches remain unconfirmed. Scheduled messages and reactions do not count as answers. It never resets the user's conversation or changes the actor.

The [question database](dataset/README.md) contains 200 candidates: 50 Reddit-based intent prompts from 25 threads, 50 labelled follow-up variants and 100 synthetic regressions. Sources were reviewed against accessible web-search excerpts after the user approved that retrieval method. These candidates are separate from the runnable cases below and still need fixtures. The [improvement plan](../../docs/aiko-evaluator-improvement-plan.md) defines language grading, timing measurements and controlled candidate evaluation.

The 12 seeded cases cover quick answers, JSON, writing, Python execution, a delayed job, browsing, documentation research, local recommendations, CSV/image attachments, and conversational correction. A seed fixes both the generated inputs and case order. The two related conversation cases remain adjacent.

## Run

Create a private Python environment:

```bash
uv venv /tmp/aiko-telegram-eval-venv
uv pip install --python /tmp/aiko-telegram-eval-venv/bin/python -r scripts/telegram-eval/requirements.txt
```

For a new session, obtain your API ID and hash from [Telegram API development tools](https://my.telegram.org/apps), then run:

```bash
/tmp/aiko-telegram-eval-venv/bin/python scripts/telegram-eval/login.py
```

The helper asks for your API details, phone, login code, and two-step verification password if enabled. Hidden prompts keep credentials out of terminal history. It stores the session and API configuration under `~/.config/unbrowse/telegram-eval/` with private permissions. The evaluator automatically reads this configuration. For another location set `TELETHON_CONFIG_PATH` to its `config.json`.

Alternatively, use an existing authenticated **user** session, with these environment variables supplied from your private configuration:

- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (or `TG_API_ID` / `TG_API_HASH`).
- `TELETHON_SESSION_PATH`: absolute path including `.session`; alternatively `TELETHON_SESSION_STRING` in the environment.
- Aiko's existing operator configuration, loaded by `scripts/cloudflare-paths.ts`.

Do not put session strings, API hashes, phone numbers, or authenticated session files in this directory. The runner checks both the session's phone and Telegram user ID before sending anything. It resolves the target bot through Aiko's configured Bot API token and verifies the bot ID. It never logs in automatically or requests an OTP; authentication happens separately.

```bash
/tmp/aiko-telegram-eval-venv/bin/python scripts/telegram-eval/run.py \
  --live --owner YOUR_TELEGRAM_USER_ID --phone YOUR_PHONE \
  --seed 8129 --count 12 --timeout 180 --session-timeout 1800
```

A live invocation sends actual test messages/files **only to Aiko**. It refuses to start while the foreground conversation is active, pauses for user intervention, and stops at a hanging turn instead of queuing more tasks. Failed/ambiguous sends are never automatically resent. If the runner stops while Aiko is still working, inspect the conversation before starting another run. The cases do not authorize purchases, bookings, or messages to other people. Compute and inference use the deployment's existing billing.

Reports and traces are private files under the gitignored `artifacts/telegram-eval/` directory. Reports contain test replies and trace evidence; review before sharing. The runner disconnects its client without logging out or deleting your session.

## Read-only baseline or offline scoring

```bash
python3 scripts/telegram-eval/run.py --owner YOUR_TELEGRAM_USER_ID --window 5000
python3 scripts/telegram-eval/run.py --owner YOUR_TELEGRAM_USER_ID --logs /private/path/events.json
python3 -m unittest discover -s scripts/telegram-eval -p 'test_*.py'
```

Historical mode sends nothing and defaults to user turns (use `--include-automations` separately). It includes unfinished turns as censored observations, skips turns whose incoming event is outside the fetched window, and reports delivery-receipt timings rather than claiming client-visible end-to-end latency.

## Rubric

Deterministic checks cover exact/structured answers, file-derived values, visible final replies, browser receipts, and verifiable compute completion. Opaque private job pointers are marked **ungraded**, never promoted to proof of successful execution. A delivered failure/fallback can satisfy delivery while failing capability checks.

For subjective cases, review `cases.json`, the answer/checks in `report.json`, and the corresponding trace. Record each score with an evidence reference:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Capability | Wrong/missing result | Useful partial result | Requested outcome complete |
| Grounding | Unsupported success claim | Evidence gaps disclosed | Claims supported by actual results/sources |
| Clarity | Confusing or irrelevant | Usable with excess/missing detail | Direct, concise, appropriate to request |
| Progress UX | Unexplained long silence or misleading updates | Some useful communication | Timely, specific updates when useful; quick tasks answer directly |

Timing is measured separately: first visible message, final-message arrival, longest silence, intermediate-message count, model/tool calls, and recorded token usage. Silence over 30 seconds and long tasks without an intermediate message are diagnostic flags, **not enforced actor policies**. Reactions and typing do not substitute for a message. Edited messages retain first-visibility timing; final content is inspected after a short settlement window.

Small sequential samples do not estimate population reliability. Cold starts, existing memory, prior tasks, provider load, and image/file preprocessing affect timings. Missing replies are counted separately, never treated as zero-latency successes. Source-link presence is only structural evidence; reviewers must verify factual support. Record the deployed Worker version alongside each comparison, keep cases/rubric fixed, and use new seeds as held-out runs before claiming improvement.

Telethon integration follows its [sign-in documentation](https://docs.telethon.dev/en/stable/basic/signing-in.html) and [update-event documentation](https://docs.telethon.dev/en/stable/modules/events.html).
