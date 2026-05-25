# contract-zig

Zig 0.16 binary implementing the Σ18 bootstrap floor of the `/contract`
substrate. **Stage 1** ships `declare` + `self` only; `iterate` and `_mark`
are gap `aa1176c4` (Stage 2 — remote delegation + LOCAL-required fallback)
and exit 1 with an explicit STAGE 2 PENDING block when invoked.

Rows written by `declare` are byte-compatible with the existing
`contract_core.py` reader (same JSON shape, same key order, same
`pointer_type` and `layer` inference, same ISO-8601 microsecond
timestamp). Ledger discovery follows `_resolve_ledger()`:
`$CONTRACTS_STORE` → `<cwd>/.claude/contracts.jsonl` →
`~/.contracts/contracts.jsonl`.

Build: `zig build` (output at `zig-out/bin/contract-zig`). Stage 1 satisfies
gap `2142cc6c` (LAMBDA-ZIG-STAGE1-SCAFFOLD).
