# Roadmap wave 3 — source pin, registry neuron, fanout sibling

> **Historical.** Dated roadmap wave. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Status: SETTLED 2026-07-27 (jesus-ralph gate `bash tests/roadmap-wave3-gate.sh`)

Wave 3 covered R5 (immutable source pin) and R2d (Registry Neuron over mesh).
The pipeline limb sibling was pulled as an amen-cycle lever.

## Items settled

- **R5 · Immutable source dependency pin.** Git commit hash embedded at build
  time via `build.zig`, exposed via `neuron --version`. `typed-neuron.lock.json`
  pins the sibling package content digest. Witness: `bash tests/
  source-pin-witness.sh` PASS. Contract: `a6b9a004`.

- **R2d · Registry Neuron over mesh.** `limbs/energy-router/neurons/
  registry_lookup.py` admitted and fired with seed index reads. EBM-ranked
  discovery: 3 compatible offers found, 1 filtered. Deterministic output.
  Witness: `python3 limbs/energy-router/tests/registry_witness.py` PASS.
  Contract: `39382bec`.

## Amen-cycle levers (post-wave)

- Introspection limb conformance (`29235fa`)
- Pipeline limb — stage neuron with in-flight budget (`3d551e0`)
- Jespa ledger claim 80→85 (`f3209c3`)
- Push to Gitea remote (`4c6a9440`)
- ROADMAP.md new-files table update (`7e2b7ea`)

## Standing gates

All green: `zig build test` 85/85, `zig build`, `bash tests/runtime-gate.sh`,
`bash tests/gate.sh`, `bash tests/meta-agent-gate.sh`.

## Remaining

- Cross-machine artifact sync (§22) — mesh partition infrastructure required
- Distributed cache dedupe (§25) — network-level cache protocol required
- R6 durability — intentionally out (Contract/Aiko is production)
