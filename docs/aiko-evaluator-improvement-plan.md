# Aiko evaluator: useful, natural and fast

Prepared 2026-09-08. This is an implementation plan plus a prepared research-backed question database. Continuous optimisation and deployment are not enabled by this document.

The goal is for a person to ask in everyday language, receive the requested result, understand it immediately and know what is happening during longer work. Aiko should sound natural and competent without pretending to be human. Intermediate messages remain an actor decision through a tool call; there is no mandatory acknowledgement template or timer-driven chatter.

## 1. Establish the evidence and question bank

The database is available as [SQLite](../scripts/telegram-eval/dataset/questions.sqlite), [CSV](../scripts/telegram-eval/dataset/questions.csv) and [JSONL](../scripts/telegram-eval/dataset/questions.jsonl). It contains **200 candidate questions across 20 task categories**: 50 normalised Reddit intent prompts, 50 clearly labelled follow-up variants and the original 100 synthetic regression candidates. Every record includes an expected outcome, provenance, capability needs and a partition. No new question is enabled for live execution yet.

### What the Reddit research suggests

The initial purposive sample contains **25 threads across eight communities**, with dated evidence from 2020–2026: r/smallbusiness (9), r/ADHD (8), r/workingmoms (2), r/fatFIRE (2), and one each from r/productivity, r/adhdwomen, r/ADHDthriving and r/TechForAgingParents. It covers requests for help and reported delegation experience. Service adverts and an identified repost were excluded.

| Need found in the sample | Example evidence | Evaluation implication |
|---|---|---|
| Keep business administration moving | Meeting scheduling, lead records and open-task tracking in [this business request](https://www.reddit.com/r/smallbusiness/comments/1ly4p57/) | Test accurate records, deadlines and follow-through |
| Reduce the effort of getting organised | Quick task capture and a daily view of deadlines in [this assistant request](https://www.reddit.com/r/ADHD/comments/16tr3p9/) | Accept messy input; return an actionable short plan |
| Handle family paperwork and gifts | School forms, gift tracking and appointments in [this parent’s request](https://www.reddit.com/r/workingmoms/comments/rfe4hy/) | Preserve dates, state and corrections across turns |
| Coordinate practical care | Shared shopping lists and short non-medical updates in [this caregiver request](https://www.reddit.com/r/TechForAgingParents/comments/1sp255b/) | Summarise practical needs clearly without inventing health conclusions |
| Do the research and comparison work | Repair quotes, itineraries and party options in [this personal-assistant request](https://www.reddit.com/r/fatFIRE/comments/1b2dsle/) | Return useful sourced options and explain unknown costs |
| Make delayed communication manageable | A backlog of unanswered messages in [this help request](https://www.reddit.com/r/adhdwomen/comments/1vd1fo9/) | Draft a useful reply without guilt, jargon or invented excuses |

The product hypothesis is that people value less administration and fewer things to remember. Test whether Aiko actually reduces that effort. This is an inference from the sample, not a population demand ranking. Fifty normalised intents do not represent fifty independent requesters. Human-assistant requests also do not prove that Aiko has the necessary integrations or can perform physical errands.

The user approved standard web search after Unbrowse read failures. The evidence comes from accessible **search excerpts**, not full-thread retrieval: direct opens of six sampled threads failed. Each source records its canonical link, title, community, known date, retrieval date, role, evidence scope and a curated paraphrase in the durable [corpus](../scripts/telegram-eval/dataset/reddit-corpus.json). The source review label means agent-checked against the returned excerpt; it does not claim human review or independent verification of the author’s story. See the [source register](../scripts/telegram-eval/dataset/sources.csv) and [research history](../scripts/telegram-eval/dataset/research-status.json).

### Grow coverage without inflating evidence

1. Broaden the next collection round beyond business and organisation-related communities. Seek specific requests involving local discovery, job administration, accessibility, attachments and assistant failures. Keep the original 40–60-thread goal as a future coverage target, not a description of this 25-thread sample.
2. Add a source only when accessible text supports a concrete need; record role and retrieval limits. Exclude ads and deduplicate reposts. Count distinct source threads for an extracted task, never generated variants as extra demand.
3. Keep authored constraints, corrections and failure scenarios labelled as variations. Extend naturally from evidence rather than filling a numerical quota. This cannot enumerate every possible question.
4. Prepare fictional fixtures and objective checks before promoting a question into the executable runner. Preserve synthetic regression cases for the user's known failures even where the Reddit sample does not cover them.

The task categories remain inbox handling, scheduling, reminders, priorities, local food, travel, shopping, meals, household administration, expenses, documents, writing, customer support, content, research, spreadsheets, jobs, family coordination, technical help and conversation repair.

## 2. Turn questions into complete test scenarios

A question alone is insufficient to evaluate an assistant. Each executable scenario needs:

| Field | Purpose |
|---|---|
| Source and family | Trace the original need and keep related variants together |
| Initial state | Fixed date, timezone, prior conversation and available integrations |
| User turns | The initial request plus any clarification, correction or interruption |
| Fixtures | Fictional emails, calendars, receipts, files, photos and service responses |
| Expected outcome | What must actually be accomplished, including constraints |
| Evidence checks | Records, delivered files, calculations or retrieved sources proving the result |
| Allowed effects | Read-only, a controlled test write, or a draft that must remain unsent |
| UX expectations | Tone, level of detail and situations where an update would help |
| Timing class | Quick reply, ordinary tool use, research or long-running job |

Keep the natural prompts people use, including typos, fragments and “actually…” corrections. Add scenarios where Aiko must remember a budget, explain a failure simply, respond after a reaction-only turn or answer “are you still working on it?”

Use controlled services for reminders, calendar edits and outbound messages. Deliver these effects only to test records and test recipients. Do not let random scenario generation operate on the user's real calendar, buy products or message other people. Public read-only browser cases and bounded Codegraff jobs can exercise the real runtime. Separate integration-unavailable cases from configured-capability tests so a graceful explanation does not count as completed work.

The prepared split is **120 development / 40 validation / 40 reserved holdout questions**. Synthetic families stay together; every Reddit thread and its authored follow-ups stay together. Generic task topics still overlap across partitions, so audit semantic near-duplicates before running comparisons. The present holdout is visible to the builder; create fresh protected cases before claiming performance on unseen requests. Each follow-up record links to its parent and supplies ordered user turns; execute it as a conversation with fixture state, not as an isolated prompt.

## 3. Measure the user's experience and the actual outcome

Use Telethon to send one scenario at a time to the verified Aiko bot. Match the reply observed by the Telegram client with its host trace, keeping MTProto and Bot API IDs in their separate namespaces. Unmatched or ambiguous replies remain unconfirmed. Stop on an uncertain send or overlapping real-user activity; do not resend blindly.

Record four kinds of results separately:

| Area | Measurement |
|---|---|
| Completion | Correct requested result, constraints met, real artifact or verified action |
| Language | Natural tone, no canned filler, no false promises, appropriate length |
| Understandability | A layperson can identify the result, its limits and any next action |
| Speed | First visible message, first useful message, final result, longest silence and total tool/model cost |

Reactions, typing indicators and an empty “working on it” do not count as substantive answers. A delivered fallback counts as a reply, but not as task completion. Useful partial work earns a separate partial score.

Break total time into queue delay, model work, tool work and delivery delay where the logs support it. Separate cold and warm browser/sandbox runs. Report timeouts and missing replies alongside observed latency; never count them as zero or omit them from reliability statistics. The existing first-message metric needs an added content-labelled first-useful-message metric.

Initial latency targets below are proposed engineering goals, not current promises:

| Task class | Initial target |
|---|---|
| Simple answer or short rewrite | Final reply within 5 seconds at p50 and 10 seconds at p95 |
| Ordinary browser read or calculation | Final reply within 15 seconds at p50 and 30 seconds at p95 |
| Multi-source research | Useful first communication within 10 seconds when work is expected to take longer; final result within 90 seconds at p95 |
| Long external job | Useful early communication when appropriate; verified result delivered within 5 seconds of observed job completion |

Track the fraction meeting each target. Do not enforce a message every N seconds. Aiko chooses `send_message` when it helps: acknowledging substantial work, sharing a concrete finding, reporting a changed approach or explaining a blocker. Quick tasks should simply get their answer. Score redundant updates and premature success claims negatively.

## 4. Grade natural language and layman clarity explicitly

Use a fixed 1–5 rubric with evidence from the actual response. Scores 2 and 4 represent intermediate quality between these anchors:

| Dimension | 1 — poor | 3 — usable | 5 — strong |
|---|---|---|---|
| Natural language | Robotic, repetitive, patronising or exaggerated | Understandable but formulaic | Direct, warm when appropriate, matches the user's tone |
| Layman clarity | Jargon or unexplained status codes obscure the answer | Main point is clear with some extra effort | Result first; familiar words; clear limits and next action |
| Useful communication | Long unexplained silence, empty updates or misleading claims | Some helpful communication with gaps | Concise, truthful updates at useful moments; direct answers for quick work |
| Task completion | Requested outcome missing or wrong | Useful partial result | Complete, verified result meeting the constraints |
| Grounding | Invented fact, action or promise | Uncertainty disclosed but evidence incomplete | Material claims supported by tool results or sources |

Use deterministic checks first for numbers, JSON, word limits, files, reminders and tool completion. A source link is not proof that the answer is true: check whether the retrieved page supports each material claim. Define the word-count scope consistently; the user's received message is the default unless the task specifically requests a separate artifact.

For subjective grading, use an independent reviewer model with frozen rubric and randomised A/B ordering. Hide the candidate name and optimisation hypothesis. Require quoted response spans or trace references for deductions. Periodically reverse answer order to check position bias. If reviewer and deterministic evidence disagree, mark the case for inspection instead of averaging away the disagreement.

Calibrate the reviewer on a small fixed set of human-scored examples, including deliberately weak responses. A person should be able to answer “What did Aiko find or do?” and “What do I need to do next?” without reading the trace. Aiko's own claim that it was helpful is not a grade. Do not use word count, readability formulas or emoji frequency as substitutes for this assessment.

Keep task completion and grounding as eligibility gates. Among candidates that pass those gates, compare natural language, clarity, useful communication, speed and cost separately. An optional dashboard preference score may use 30% natural language, 30% clarity, 20% communication and 20% speed, but cannot override a failed task or unsupported action claim.

## 5. Run a bounded improvement loop

1. **Freeze a baseline.** Record actor version, instructions, model configuration, tool versions, dataset digest, grader version, seed and relevant environment state. Preserve full private traces and a redacted result summary.
2. **Find a recurring failure.** Group failures by evidence: silent work, unnecessary calls, misunderstood request, invented capability limit, confusing fallback, poor rewrite, lost context or unreliable tool result. Rank by severity and frequency; use frequency only within the measured sample.
3. **Propose one focused change.** Name the hypothesis and expected benefit. For example: make the existing progress-message tool easier for the actor to select during research, or translate a known browser failure into a plain explanation while retaining useful results.
4. **Evaluate on development cases.** Compare baseline and candidate on the same fixtures with alternating order. Repeat enough to identify stochastic failures. Measure completion, UX, latency and cost together.
5. **Validate without tuning to the answers.** Test on the reserved validation set. Evaluate a finalist once on fresh protected holdout scenarios; retire and replace exposed holdouts if their failures become optimisation input.
6. **Promote only with evidence.** Require no new critical regressions, improvement on the intended dimension and no material deterioration elsewhere. For small or noisy samples, report uncertainty and collect more data instead of claiming a win. Use paired outcomes and confidence intervals once sample size supports them.
7. **Observe and roll back.** For an authorised release, keep the previous actor version available, run a small canary set and revert on a new critical failure or sustained material regression. Preserve the candidate and failure trace for learning.

Start with at most three candidates per batch, 12 development scenarios per candidate and a 30-minute session limit, then evaluate a finalist on a larger reserved set. Log actual inference, compute and reviewer cost; configure a monetary cap before scheduling unattended runs. Stop on exhausted budget, repeated inconclusive candidates, unavailable services or user activity in the test conversation.

Keep the user’s known regressions in every promotion gate: a reaction cannot replace the requested answer; fallback text must explain the outcome plainly; configured sandbox and media tools must be recognised; the login flow must not expose browser controls for the user to click; intermediate Telegram messages must remain actor-chosen tool calls.

The evaluator itself also improves: add regression cases for grading and correlation mistakes, calibrate against human labels and version the rubric. When the grader changes, rescore archived baseline and candidate traces with the same new grader. Never alter the grading rules mid-comparison to make a candidate pass.

## 6. First improvement batch, grounded in the current live run

The corrected [live report](../artifacts/telegram-eval/live-8129-verified/report.md) contains six completed scenarios on deployment `63efbe26-b69b-41d1-baf8-45825c26e4bd`: six confirmed final replies and four automated objective passes. The run then stopped on a Telegram `SendMediaRequest` server error before the attachment cases. This is a partial six-case sample, not a completed 12-case benchmark.

| Finding | First action |
|---|---|
| Browser read: 43.7 seconds; documentation research: 110.5 seconds; neither had an intermediate message | Check progress-tool availability, selection and rejected calls; evaluate a focused instruction/tool-description change encouraging useful actor-chosen updates |
| Local research: 75.7 seconds, browser failure, raw `Fallback: browser_uncertain` text | Reproduce the browser failure and improve the fallback explanation, preserving verified partial findings and stating what remains unknown |
| Rewrite: 38 words in the received response, inaccurate claimed word count and an added promise to ship immediately | Add a constraint-preserving writing regression; return the requested rewrite directly, without unsupported promises |
| Quick JSON: 6.4 seconds; Python sum: 14.7 seconds | Keep these as latency and capability regression cases while changing longer-task behaviour |
| Attachment test send failed upstream | Keep transport failure separate from actor performance; inspect send state before another authorised attempt |

All six completed cases had zero intermediate messages. Observed first-reply p50/p95 were 14.7/110.5 seconds, but six cases are too few to infer production percentiles. Browser and documentation structural passes still need factual review. The earlier calibration run with the ID-namespace correlation bug is explicitly invalid and excluded. Historical measurements from a different account and old backlog are not a comparable speed baseline.

## 7. Delivery sequence

**Prepared now:** 200-question bank and exports, 25 source records across eight communities, durable excerpt summaries, labelled provenance and follow-up context, plus this plan. The builder checks database integrity, source references and partition separation.

**Next:** implement a reviewed scenario format, fictional fixtures and assertions for an initial balanced set of 12 cases. Include inbox triage, scheduling, task capture, reminders, expense totals, research, writing, a correction, a delayed tool, capability awareness, a plain-language fallback and an attachment. Broaden the evidence sample as coverage gaps surface. Validate fixtures before enabling scenarios in the Telethon runner.

**Then:** freeze the current actor as the baseline; add evidence-based language and clarity grading, first-useful-message timing and a report that shows user-visible conversation beside the trace. Calibrate the grader against human judgement.

**Then:** run the first bounded candidate batch above, inspect held-out results and promote a demonstrably better actor through the authorised release workflow. Once that loop is reliable, schedule bounded runs with an explicit cadence and spend limit. No background optimiser or schedule has been started by preparing this plan.
