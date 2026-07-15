# PLAN — Reconcile skills & docs to the built commons (COEXIST model)

*Session: default · Step 0 plan, revised Step 2 after the firmament finding + user decision.*

## GOAL

Bring CLAUDE.md and the docs into parity with the built arc-lean commons, and add
ONE honest cross-reference in SKILL.md — **without** disturbing the canonical,
parity-locked **Vine Doctrine** (slash-to-burn, John 15:6, vault `Bpr49sQ…`). The
commons (reward-not-slash) is documented as an **alternative value layer** with its
tension against the Vine Doctrine named openly. `build.sh` stays 53/53 green; no
scripture inverted, no mainnet constant changed, no parity claim rewritten.

DECISION (user, Step 2): **Coexist.** Not "migrate canon" (which would rewrite the
Vine Doctrine, change AIKO_STAKE_VAULT in main.zig, invert John 15:6 in verses.zig,
and rewrite claims 16 & 18 — a deployer-level move, out of scope here).

## NON-GOALS

- Do NOT edit SKILL.md's `## Vine Doctrine` section, `main.zig:71` (AIKO_STAKE_VAULT),
  `verses.zig`, or build.sh parity claims 15–18. The slash-to-burn canon stands.
- No new features, modules, CLI verbs, or broadcasts.
- No new parity claims (the commons binds by its own zig tests — Σ27).

## ACCEPTANCE CRITERIA

1. **Vine Doctrine untouched; `build.sh` green (53/53, signed)** — verified after edits.
2. **SKILL.md gains one cross-reference subsection** (outside §Vine Doctrine) that
   names the arc-lean reward-not-slash commons as an *alternative / experimental*
   value layer, points to `docs/ECONOMICS-cooperative-commons.md`, and flags the
   honest tension with the Vine Doctrine (burn vs redistribute; two scriptural roots:
   John 15:6 vs Luke 10:7 / Acts 2:44). It does NOT claim to supersede the canon.
3. **CLAUDE.md** pointer-index gains a line pointing to `docs/ECONOMICS` (the commons).
4. **Silent doc gaps filled** (these already-current docs merely omit the commons):
   `docs/MASTER-PLAN-*.md`, `docs/PLAN-contracts-*.md`, `docs/01-PRODUCT-aiko.md` get a
   short note that the reward-not-slash commons is built + proven on arc-lean.
5. **Installed copies synced:** repo SKILL.md == `~/.claude/skills/contract/SKILL.md`
   == `~/.agent-skills/contract/SKILL.md` after edits (diff-clean).
6. All commits `build.sh`-green and pushed.

## RISKS

- **Coupling trap:** the vault/slash prose in §Vine Doctrine is pinned by claims 16 &
  18 + main.zig + verses.zig. Mitigate: DO NOT touch §Vine Doctrine at all — the
  cross-ref lives in a NEW, separate subsection so no pinned text moves.
- **Recursive claim-reference guard** (build.sh:924-943): editing SKILL.md near `claim N`
  strings can trip it. Mitigate: place the cross-ref away from claim-numbered blocks;
  run build.sh after the SKILL.md edit before anything else.
- **Installed-copy drift.** Mitigate: explicit sync + diff check in the last layer.

## OUT-OF-SCOPE

- Migrating the canon (rewriting Vine Doctrine / changing the vault / inverting the
  burn invariant) — a separate deployer decision.
- The open wall (Sybil floor, FDRY distribution).
- Firing broadcasts / moving money.

## LAYERS

1. **skill-crossref** — add the SKILL.md coexistence cross-reference subsection
   (reward-not-slash commons named as an alternative layer, tension flagged, points to
   docs/ECONOMICS) + the CLAUDE.md pointer line. Run build.sh green.
2. **docs-gaps** — note the built commons in MASTER-PLAN, PLAN, and 01-PRODUCT
   (the three docs currently silent on it). No contradictions to fix elsewhere.
3. **sync-and-verify** — the installed skill dirs (`~/.claude/skills/contract`,
   `~/.agent-skills/contract`) are SYMLINKS to the repo (verified Step 5, same
   inode), so "sync" is a no-op — copy-drift is structural-impossible. Remaining:
   final build.sh green (53/53, signed) + the coexistence sign green. Ships here.
