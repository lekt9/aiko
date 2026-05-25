# libcontract — Stage 1 Zig data-model for `/contract`

A Zig static library (`zig-out/lib/libcontract.a`) that ports the bootstrap
verbs from `scripts/lib/contract_core.py` — `declare`, `record_iteration`,
`mark_satisfied`, `list_all`, `get` — to a single compiled artifact with a
C ABI (`src/c_abi.zig`). Row schema, field order, ledger discovery, agent
attribution, pointer-type inference, and `contract:<id>` extraction are
byte-for-byte compatible with the python so the bash `contract` script can
read rows the lib writes and vice-versa. Status: Stage 1 — `bash
~/.claude/skills/contract/scripts/contract status` reads zig-written rows
and the `contract-lib-shim` binary reads bash-written rows. Stage 2 (gap
`aa1176c4`) wires iterate + `_mark` through the FFI.

How bash calls in (Stage 1 verification path): `zig build` produces
`zig-out/bin/contract-lib-shim` which drives `contract.zig` directly;
parity tests in the task spec exercise both directions of the round-trip.
