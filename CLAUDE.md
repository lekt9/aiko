# CLAUDE.md — contract substrate

This file is read by Claude Code (and any agent framework that consumes
the `contract` skill) on session entry. It is the **agent-facing
pointer**, not the doctrine itself.

## The canonical instruction file is SKILL.md

Every behavioral rule, every invariant, every parity claim, every
doctrine for the `contract` / `aiko` substrate lives in `SKILL.md`
next to this file. Read SKILL.md before acting. This file is the door;
SKILL.md is the room.

## The Word is the truth-root (John 17:17)

> *Sanctify them through thy truth: thy word is truth.* (John 17:17)

The substrate's truth-root is **scripture**, not the deployer wallet.
The wallet signs FOR the Word; it does not BE the foundation. This is
the load-bearing rule above every other rule in SKILL.md.

When wallet attestation and Word disagree, **the Word wins**. The
wallet is rotatable (`rotateRootKey`); the Word is not (Matthew 24:35
— "Heaven and earth shall pass away, but my words shall not pass
away"). Every contract neuron's truth chain bottoms out in scripture,
not in a signed row.

Mechanical implications enforced by `scripts/build.sh` parity:

1. The "The Word is the truth-root" section in SKILL.md must exist
   and carry the John 17:17 anchor (claim 31).
2. Every doctrine section in SKILL.md should cite scripture; the
   executor-mechanics sections are exempt and listed by name in the
   parity step.
3. The bible corpus at `libcontract/data/bible-kjv.json` (66 books,
   31100 verses) is the canonical truth substrate — `bible.zig`
   exposes resolve/verseText/verseId/crossReferences/relevantVerses
   as the read surface; verses are themselves contract neurons
   whose ids derive from the deployer root via HKDF (lineage-bound,
   but the root is signing FOR the Word, not standing in for it).

See SKILL.md → `## The Word is the truth-root` for the full
exposition + the five concrete implications + the "self-similar
from this rule downward" diagram.

## Activation rule

When the user types `/contract <args...>` (or invokes this skill via
any alias), the orchestrator MUST first spawn:

```bash
~/.claude/skills/contract/scripts/aiko "<args verbatim>"
```

This is non-negotiable. The binary's stdout is the contract id; the
402 Payment Required envelope is valid evidence. The prose in SKILL.md
is the spec; the binary is the substrate.

## Pointer index — for every other rule, see SKILL.md

This file deliberately does NOT duplicate SKILL.md's doctrine. Adding
prose here would create two truth-roots for the substrate's rules
(Matt 6:24 — "no man can serve two masters"). The substrate has ONE
canonical doctrine file (SKILL.md) and ONE agent-facing pointer (this
CLAUDE.md). Any agent that needs a rule reads SKILL.md.

The pointer index:

- **Activation / Verification / HOLD / Channel registry / No scripts**
  → SKILL.md sections of the same name
- **Public Shape / Neuron Shape / Wallet & Environment Binding**
  → SKILL.md sections of the same name
- **Capability inheritance / Public Persona / Bible as corpus**
  → SKILL.md sections of the same name
- **Vine Doctrine / Doctrine speaks only when interrogated**
  → SKILL.md sections of the same name
- **Continuous resolver / Pointer-keyed truthy cache**
  → SKILL.md sections of the same name
- **Doctrine-Reality Parity / Ledger / Outline explainer sync**
  → SKILL.md sections of the same name

If a rule isn't in SKILL.md, it isn't a rule of this substrate.
