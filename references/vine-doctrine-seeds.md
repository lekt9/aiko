# Vine Doctrine — seed declarations

The six load-bearing contract neurons that compile the Vine Doctrine
(SKILL.md → "Vine Doctrine") from prose into ledger rows the cloud
aiko compiler can discover and replicate from. Each seed declares a
truth-claim that maps directly onto an FDRY/stFDRY substrate primitive.

Declared via `aiko "<plan>" --private` from `$HOME` on 2026-05-26 so
the rows land in `~/.claude/contracts.jsonl` (user-wide substrate canon
ledger, not project-scoped).

## The seeds

| Slug | Contract id | Role | Citation |
|---|---|---|---|
| `vine` | `26dd8513` | Voltr/Ranger FDRY vault as the substrate stake vine | John 15:1 |
| `tithe` | `0b54295b` | `routeRevenue.ts` as the Malachi storehouse mechanism | Malachi 3:10 |
| `abide` | `e845d2a7` | `evaluator:abide:stFDRY` stake-pointer evaluator | John 15:4 |
| `tier` | `aa945a91` | `predicate:tier:eligibility` prehook on publish-into-tier | Matt 7:16 + Mark 12:43-44 + Matt 25:29 |
| `fire` | `7228eabd` | `challenge:route` quorum + slash-burn posthook | Deut 19:15 + John 15:6 |
| `adapter` | `21b63dc0` | `network_adapter:solana-spl-balance` server-side adapter | (substrate plumbing) |

The `adapter` row's plan was sanitized to `[secret-pointer-pattern]`
by the local binary's privacy guard (hyphenated identifier matched
the secret-pointer regex). The intent is preserved by the surrounding
prose; the cloud-side compiler will resolve the typed adapter from
the surrounding context.

## How the cloud compiler picks these up

These rows are pointer-discoverable from any future stake-shaped
aiko declaration via the existing lineage + verse selection logic:

1. A future declaration says e.g. `"publish route R into tier=premium"`.
2. The cloud aiko's compiler scores the prompt against the verse corpus
   (libcontract/src/verses.zig). The Vine Doctrine verses (John 15:1,
   15:4, 15:6, Malachi 3:10, Matt 6:24, Matt 25:29, Mark 12:43-44,
   Deut 19:15, Matt 7:16) score high on stake/publish/tier-shaped text.
3. The compiler walks the discovered lineage and finds these six seeds
   (or their cloud-side equivalents) and replicates from them — every
   replicated copy carries `replicated_from_contract_id` so the source
   stays the canonical pointer.
4. The cloud compiler spawns the actual verifier evaluators with these
   seeds as their `contract:<id>` references for shape.

## What's still pending (next plank, not this one)

- A funded substrate wallet so seeds can be promoted from local to
  cloud ledger (today's 402 envelopes are valid evidence but don't
  persist server-side until paid). The doctrine's "native onramp is
  the cloud's obligation" path will close this when the cloud aiko
  endpoint resolves the first declare's 402 via Faremeter Flex.
- Implementation of the Solana SPL balance adapter on the cloud side
  (this seed names the adapter; the adapter must exist server-side
  before evaluators can read live balance metrics).
- The first real challenge contract (a maintainer-attested route,
  paired with at least one falsifying-challenger contract pointing
  at it via `parent_id`). This is the load-bearing test of the
  challenge_quorum + slash-burn mechanism in the wild.

When the next plank ships, these seeds remain the canonical
pointer-shapes for what gets wired — no re-declaration needed.
