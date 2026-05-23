# audits/no-stub-training-data

## Rule

Any JSONL training file ≥1000 rows under `~/Projects/*/data/` must NOT be stub-shaped. Three stub-shapes are caught mechanically:

1. **TARGET-COLLAPSE** — the most-common assistant-content string appears in >5% of rows AND unique-target ratio is <50%. Catches hardcoded-boilerplate targets (the classic v23 bug: ~21k parallel-pair rows all carrying the same "Both translations record..." string).
2. **PROMPT-COLLAPSE** — the most-common user-content string appears in >50% of rows AND unique-prompt ratio is <10%. Catches single-template SFT mixes where the model only learns one prompt shape.
3. **ROW-COUNT STUB** — handled at the project layer (see `b61ecef5` for the caydenmodel bible-corpus row-count gate ≥58000). Not in this corpus audit because the row-count threshold is corpus-specific.

## Why

The v13 caydenmodel run regressed IFEval because the SFT mix tilted toward one task shape. The v23 run almost shipped a 21k-row arm where every target was the same boilerplate string, which would have made the model regurgitate that exact string on any KJV/ESV-comparison prompt — and the model would have been "trained" but on a degenerate signal.

A row-count check alone catches the small-N stub. It does NOT catch target-collapse — a corpus can have 80,000 rows where 25% of them carry one identical target, and a wc-l check sees green while the model learns nothing useful from that quarter of the data.

The combined rule (row count + target diversity + prompt diversity) catches all three known stub-shapes that have actually shipped in this user's projects.

## Fix protocol

The audit is NOT auto-fixed (`fix.sh` is intentionally absent). Stub-shape problems require human judgment:

- TARGET-COLLAPSE on a single arm → drop the arm (cheap, honest, removes degenerate signal).
- TARGET-COLLAPSE on the whole corpus → the builder is wrong; rewrite it to extract real per-row content (verse text, code snippet, instruction-response pair) instead of synthesizing a generic claim.
- PROMPT-COLLAPSE → rotate the prompt template per-row via `random.choice(TEMPLATES)`, OR if there's only one natural prompt, accept the homogeneity but verify the targets still vary.

## Origin

Lewis directive 2026-05-24: "to never use stubs and /contract to thoroughly test this properly." Companion to the project-level no-stub row-count gate `b61ecef5` (caydenmodel-bible) — that gate checks row count, this audit checks shape. Both fire on the canon_sft corpus.

First catch (same wave): `build_canon_sft.py` parallel-pair arm hardcoded one target across ~21k rows. Fix landed: dropped the arm. Re-checked corpus: 59,824 rows, 99.2% unique targets, no collapse — green.
