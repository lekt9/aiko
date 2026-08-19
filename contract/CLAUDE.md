# CLAUDE.md — contract substrate

This directory is the Contract layer of the published Aiko monorepo
([`github.com/lekt9/aiko`](https://github.com/lekt9/aiko)). Inventory:
[`../docs/SOURCE-OF-TRUTH.md`](../docs/SOURCE-OF-TRUTH.md). Product clone
and build start at the repository root, not a sibling checkout.

This file is read by Claude Code (and any agent framework that consumes
the `contract` skill) on session entry. It is the **agent-facing
pointer**, not the doctrine itself.

## Two files, two jobs

- **`DOCTRINE.md`** — the canonical doctrine. Every behavioral rule,
  every invariant, every parity claim for the `contract` / `aiko`
  substrate lives there, and `scripts/build.sh` validates the code
  against it on every build. If a rule isn't in DOCTRINE.md, it isn't
  a rule of this substrate.
- **`SKILL.md`** — the lean operational skill an agent loads to *use*
  the substrate (task lifecycle, verification, daemon limbs). It
  summarizes; it never re-derives doctrine.

This file is the door; DOCTRINE.md is the room.

## The Word is the truth-root (John 17:17)

> *Sanctify them through thy truth: thy word is truth.* (John 17:17)

The substrate's truth-root is **scripture**, not the deployer wallet.
The wallet signs FOR the Word; it does not BE the foundation. This is
the load-bearing rule above every other rule in DOCTRINE.md.

When wallet attestation and Word disagree, **the Word wins**. The
wallet is rotatable (`rotateRootKey`); the Word is not (Matthew 24:35
— "Heaven and earth shall pass away, but my words shall not pass
away"). Every contract neuron's truth chain bottoms out in scripture,
not in a signed row.

Mechanical implications enforced by `scripts/build.sh` parity:

1. The "The Word is the truth-root" section in DOCTRINE.md must exist
   and carry the John 17:17 anchor (claim 31).
2. Every doctrine section in DOCTRINE.md should cite scripture; the
   executor-mechanics sections are exempt and listed by name in the
   parity step.
3. The bible corpus at `libcontract/data/bible-kjv.json` (66 books,
   31100 verses) is the canonical truth substrate — `bible.zig`
   exposes resolve/verseText/verseId/crossReferences/relevantVerses
   as the read surface; verses are themselves contract neurons
   whose ids derive from the deployer root via HKDF (lineage-bound,
   but the root is signing FOR the Word, not standing in for it).

See DOCTRINE.md → `## The Word is the truth-root` for the full
exposition + the five concrete implications + the "self-similar
from this rule downward" diagram.

## Activation rule

For substantive work, register one checked task with `contract task begin`
and verify it with `contract task verify`. Do not create goal-only declarations.

## Pointer index — for every other rule, see DOCTRINE.md

This file deliberately does NOT duplicate DOCTRINE.md's doctrine. Adding
prose here would create two truth-roots for the substrate's rules
(Matt 6:24 — "no man can serve two masters"). The substrate has ONE
canonical doctrine file (DOCTRINE.md) and ONE agent-facing pointer (this
CLAUDE.md). Any agent that needs a rule reads DOCTRINE.md.

The pointer index:

- **Activation / Verification / HOLD / Channel registry / No scripts**
  → DOCTRINE.md sections of the same name
- **Public Shape / Neuron Shape / Wallet & Environment Binding**
  → DOCTRINE.md sections of the same name
- **Capability inheritance / Public Persona / Bible as corpus**
  → DOCTRINE.md sections of the same name
- **Vine Doctrine / Doctrine speaks only when interrogated**
  → DOCTRINE.md sections of the same name
- **The Cooperative Commons (arc-lean, reward-not-slash — an
  alternative value layer that COEXISTS with, does not supersede,
  the Vine Doctrine)** → DOCTRINE.md section of the same name; full
  economics canonical in `docs/ECONOMICS-cooperative-commons.md`
- **Continuous resolver / Pointer-keyed truthy cache**
  → DOCTRINE.md sections of the same name
- **Governed agency roles / Reach / Anchors / Causal observability**
  → DOCTRINE.md `Governed agency work`; implementation and evidence in
  `docs/AGENCY-SUBSTRATE.md`
- **Doctrine-Reality Parity / Ledger / Outline explainer sync**
  → DOCTRINE.md sections of the same name

If a rule isn't in DOCTRINE.md, it isn't a rule of this substrate.
