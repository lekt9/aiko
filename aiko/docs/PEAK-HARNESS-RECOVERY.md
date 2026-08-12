# Peak Harness Recovery

> **Historical.** Dated recovery report. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

## Outcome

Aiko's default engineering prompt is compact and evidence-first again. Generative UI is no longer embedded in every agent turn; it is an on-demand skill at `.agents/skills/generative-ui/SKILL.md`.

## What the earlier harnesses did well

The available Gitea history for Odysseus and ArkLib consistently shows:

- narrow changes tied to an explicit issue or PR objective;
- inspection of the existing ownership and integration points before editing;
- preservation of adjacent behavior instead of broad rewrites;
- focused regression tests and exact build/test evidence;
- concise descriptions that state both the change and the verification.

One representative Odysseus change is commit `8c2705b42a`, which restored the Codex integration with a small registration change while retaining existing MIME, lifespan, and webhook-auth fixes. ArkLib's issue `#464` sequence similarly used small, independently verifiable math, documentation, and CI commits.

The archived harness directory at `/Users/lewis/Library/Mobile Documents/com~apple~CloudDocs/Backups/agent-harness` contains the original session corpus. A normal disk-usage check is misleading because iCloud represents most payloads as `compressed,dataless` files until downloaded. The catalog includes large ArkLib JSONL sessions and their subagent traces, Odysseus project memory, Claude tasks, global and project memory, contracts, skills, and the other harness stores. For example, the ArkLib session `ff5140b7-887f-4af4-8267-f6dd5fd73f54.jsonl` has a logical size of 9.5 MB, while `odysseus-maintainer-pattern.md` is a 20.6 KB dataless object. The methodology extraction must include those payloads once iCloud materializes them; repository history is only the first evidence source, not a substitute for the archive.

## Prompt changes

The default prompt now prioritizes:

1. Inspect the real repository, representative data, and authoritative consumers.
2. Separate observed facts from assumptions.
3. Preserve semantic details such as counts, identifiers, units, ordering, and ownership.
4. Make the smallest complete change that preserves unrelated behavior.
5. Run the authoritative test or build, treat failures as evidence, and rerun after fixing the cause.
6. Review the final diff and report exact verification.

Contract support remains a compact substrate hint rather than a mandatory manual on every turn. Interactive-only capabilities such as Generative UI and channels are advertised as discoverable skills/capabilities rather than injected wholesale into headless coding sessions.

## Generative UI boundary

The skill owns the full JSON-render protocol, component types, composition rules, and persistence behavior:

`/.agents/skills/generative-ui/SKILL.md`

The default prompt only points to that skill when an interactive task asks for generated UI. This keeps ordinary coding, debugging, and PR work free of an unrelated schema while preserving the capability.

## Benchmark finding

The original Harbor comparison recorded Aiko at 6/7 and Grok at 7/7. A fresh isolated rerun of the failing `count-call-stack` task made both agents independently interpret the leading values as profiler sample weights. The hidden verifier instead counts each block once. Both agents parsed 646 blocks and 317 unique sites, but the hidden requirement was not stated in the task.

This is an ambiguous benchmark contract, not evidence that Aiko needs a task-specific prompt hack. The retest is recorded in:

- `docs/AIKO-PEAK-PROMPT-RETEST.md`
- `docs/AIKO-PEAK-PROMPT-RETEST.json`

Future PR benchmarks should state semantic invariants explicitly and use real repository tests as the oracle.

## Verification

- Prompt/template unit tests cover the compact headless boundary and ensure the Generative UI schema is absent from the default prompt.
- The Generative UI skill passes the skill validator.
- `scripts/verify-harbor-benchmark.mjs` validates the existing balanced Aiko/Grok benchmark report.
- The release binary is rebuilt and installed after prompt/template encryption is regenerated.

## Next benchmark shape

To measure one-shot PR performance rather than synthetic formatting behavior, construct a small frozen suite from historical Odysseus and ArkLib issues: checkout the parent commit, give only the original issue text, run Aiko once, and score with the repository's original tests plus a diff-scope check. This avoids relying on unavailable transcript payloads and directly measures the behavior that mattered.
