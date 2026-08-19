# Aiko Drop-In — Receipt (2026-08-17)

**Skill:** `.agents/skills/aiko-drop-in/` (preferred, inside digest, `expect_contains: DELEGATED_CITATION_VERIFIED`)

**Walk:** `docs/graph-engineering/aiko-drop-in.walk.json` — 9 nodes, 7 layers, `amen 1/0`, `complete: false → verify frontier`.

**Gates green:**
- `tests/drop-in-covenant-gate.sh` — VerifiedIngress, delegation_capability, breakpoint, SMP
- `tests/hoysan-roster-engine-gate.sh` — hoysan-draft reuse + dashboard parity + confirm
- `tests/hoysan-deploy-gate.sh` — fanout + outbox-drainer + telethon ladder
- `tests/aiko-drop-in-gate.sh` (aggregate of above)
- `python3 tools/check_reuse.py --walk` — every node reads ≥1 frozen primitive (cell/primitives|patterns, neuron/limbs, contract)
- `cell/run.py build cell/patterns/hoysan-draft/hoysan-draft.cell.yaml`
- `cell/run.py build cell/patterns/fde/self-wire.cell.yaml`

**Deleted (no consumer):** 5 stale walks + 4 transcripts = -5912 lines. `cell/haulio*` already `.gitignore`d, left untracked as intended.

**Spawn model:** `inheritEnv=false` + fenced lease + opaque delegation_capability handle (subject/tenant/root+parent/fence+audience/purpose) + context projection narrow citations. No transcript/HOME/API_KEY copy. SMP-33 reply without allow_send proven via `neuron/limbs/conversation`.

**Remaining frontier:** `drop-in-verify` (eval node, runnable `tests/aiko-drop-in-gate.sh && tools/check_reuse.py`). Arm `/graph` to settle it.
