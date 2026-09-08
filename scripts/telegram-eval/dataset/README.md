# Aiko question database

Prepared 2026-09-08: **200 candidate questions across 20 task categories**. This is a research-backed question bank for the [evaluator plan](../../../docs/aiko-evaluator-improvement-plan.md), separate from the existing runnable Telegram cases.

| Provenance | Count | Meaning |
|---|---:|---|
| `reddit_paraphrase` | 50 | Normalised assistant requests based on tasks described in 25 Reddit threads |
| `reddit_derived_variant` | 50 | Authored follow-ups adding corrections, constraints or misunderstandings to those requests |
| `synthetic` | 100 | Earlier original regression candidates; no claimed Reddit source |

The 25 threads span eight communities. Fifty base prompts do not mean fifty independent requesters. These are paraphrased task intents, not quotations of questions posted to an AI assistant. Human-assistant tasks have been adapted to an agent setting; physical errands become planning or coordination tasks.

## Open and rebuild

- [questions.sqlite](questions.sqlite): queryable `questions`, `sources`, `metadata` and `verified_reddit_questions` view.
- [questions.csv](questions.csv): spreadsheet-friendly prompts, outcomes, provenance, source links and parent question IDs.
- [questions.jsonl](questions.jsonl): full structured records including user-turn sequences and capability needs.
- [sources.csv](sources.csv): source register with dates, role, scope, retrieval method and summaries.
- [reddit-corpus.json](reddit-corpus.json): durable curated source evidence and authored base/variant pairs.
- [seed.py](seed.py): reproducible standard-library builder; retains the original synthetic prompts.
- [research-status.json](research-status.json): authorisation, retrieval history, exclusions and coverage gaps.

Run `python3 scripts/telegram-eval/dataset/seed.py` from the repository root. It rebuilds the generated database and exports from `seed.py` and `reddit-corpus.json`. Add research to the corpus input; do not insert it directly into the generated SQLite snapshot. Store future live run results separately. The builder validates the replacement database before replacing the previous SQLite file.

## Evidence quality

The user authorised standard web search after Unbrowse read failures. Accessible **search excerpts** supplied the research text; direct opens of six sampled Reddit URLs failed. Every source is labelled `web_search_excerpt`. The corpus stores curated paraphrased evidence summaries, not raw full-thread archives. The earlier Unbrowse blockers remain in the history and no longer block this research.

`review_status=verified` means the agent checked the intent against a returned excerpt. It does **not** mean full-page retrieval, human review, verification of the author's identity or independent confirmation of their story. Original posts, employer comments and a former-assistant comment have separate scope/role labels. Where only a comment date is available, the original publication date remains null. Usernames and contact details are omitted.

Excluded material includes adverts, provider market-research solicitations and a duplicate repost. The sample favours small-business and organisation-related communities; it cannot establish population prevalence, current demand rankings or a complete list of possible assistant requests. Historical posts establish possible needs, not current prices or service capabilities.

## Evaluation partitions and readiness

There are **120 development, 40 validation and 40 reserved holdout questions**. All variants from a Reddit thread share one partition. Synthetic families also stay together, giving 45 partition groups overall. The `family` field is the partition group; `category` is the task topic. Generic topics recur across partitions, and semantic overlap between independent threads has not been eliminated. These visible partitions do not constitute a hidden generalisation benchmark. Build fresh protected scenarios and audit near-duplicates before making that claim.

Every new question has `runnable=false`. It still needs fictional input fixtures, a fixed clock, configured capabilities and executable outcome checks. A follow-up has a `parent_question_id`; `conversation_turns` gives the ordered user prompts, with the actor response between them. Do not send a context-dependent follow-up as a standalone case. Prepare fixture changes explicitly when a follow-up corrects a price, date or completed task.

Writes, reminders, purchases and outbound messages belong in controlled test services. An unavailable integration is a capability-awareness case, separate from successful task completion. No new Telegram messages or background optimisation were started by building this bank.

```sql
-- Inspect evidence-linked development prompts.
SELECT id, prompt, expected_outcome, provenance, source_url
FROM verified_reddit_questions
WHERE split = 'development';

-- Count source threads covering an extracted task category, not generated variants.
SELECT category, COUNT(DISTINCT source_id) AS sampled_threads
FROM questions
WHERE provenance = 'reddit_paraphrase'
GROUP BY category;
```
