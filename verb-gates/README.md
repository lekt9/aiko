# verb-gates/ — one regression harness per CLI verb

A `verb-gate` is to the **verbs** what a `<shape>-gate` is to the **shapes**:
a tiny, sandboxed, deterministic check that exercises one CLI verb against
its documented behaviour. The shape gates prove the substrate's 9 firing
rules; the verb gates prove the 43 surface words.

**Why this isn't "verbs as first-class contracts":** because the substrate's
truth model is "verbs WRITE ledger rows; contracts ARE ledger rows". Verbs
are the **language** the substrate speaks, contracts are the **sentences**.
Forcing each word to be a sentence creates recursion that pays nothing —
every CLI call would need a contract lookup before dispatch, the bootstrap
becomes chicken-and-egg (you need `declare` to declare `declare`), and the
shape gates already prove the substrate's load-bearing claims. The actual
gap was behavioural: shape gates cover 9 shapes, nothing covers the 43
verbs. Verb gates close exactly that gap. (Per `310f425f`: shape IS the
type system, no new shape needed — each verb-gate is a plain `cell`.)

## Layout

```
~/.claude/skills/contract/verb-gates/<verb>/
  verify.sh   # runs the verb in a tempdir CONTRACTS_STORE, asserts happy path + at least one failure mode
  README.md   # optional — what truth the gate binds
```

## Runner

`scripts/run-verb-gates.sh` walks every `verb-gates/*/verify.sh` and runs
it. Wired into `scripts/skill-self-test.sh` as `self/verb-gates-pass`, so
every ledger event re-runs every verb's gate. A regression in `promote`
trips the next commit, not "someday when Lewis catches it."

## verify.sh discipline

- **Sandbox the ledger.** Set `HOME` to a tempdir if the verb touches
  `~/.contracts/`; otherwise set `CONTRACTS_STORE`. Never write to the
  real ledger from a gate.
- **Idempotency.** Running a gate twice gives the same result. No leftover
  state between runs.
- **Happy path + ≥1 failure mode.** Prove the verb works AND prove it
  fails cleanly on at least one invalid input.
- **Pure-read of the rest of the substrate.** A verb gate must not depend
  on a particular contract being in the real ledger, on a particular
  daemon being up, or on network access. If the verb itself does network
  I/O (e.g. `learn` pushing to Outline), the gate sets the documented
  opt-out env var (`CONTRACT_CRYSTALLIZE_NO_OUTLINE=1` for `learn`).

## Starter set (2026-05-23)

These five gates were the first wave — the verbs with the least existing
coverage and the highest blast radius if they broke:

| Verb | Why this gate exists |
|---|---|
| `promote` | Newly added; the cross-ledger row copy is fragile; no shape covers it |
| `_mark` | The KEY 2 path itself — if this drifts, nothing the substrate claims is provable |
| `supersede` (alias `merge`) | Fossilization affects `list`/`search` visibility — a bug here corrupts the natural-selection lifecycle |
| `corroborate` | The synapse primitive — silent failure would leave the wavefront blind to half its edges |
| `learn` | Crystallizes to memory + Outline; a quiet error here loses durable knowledge |

The other ~38 verbs land the same way as new gates are needed — same
pattern, same dir, no skill change required.

Origin: contract `2db87011`, 2026-05-23.
