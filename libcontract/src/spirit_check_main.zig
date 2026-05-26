//! spirit_check_main.zig — build-time gate binary.
//!
//! Walks every .zig source file declared in spirit.SOURCE_FILES and
//! refuses to exit cleanly unless each carries a current PASS
//! attestation in `.contract-spirit-attest.jsonl`, signed by the root
//! /contract wallet.
//!
//! Invoked from `zig/build.zig` as a RunStep that the main install
//! step depends on. Non-zero exit → build fails. There is no flag,
//! env var, or argument that bypasses this — the only way to make the
//! build green is to land a PASS row for each file (via `aiko attest`
//! which calls the LLM judge and signs the verdict).

const std = @import("std");
const spirit = @import("spirit.zig");

pub fn main(init: std.process.Init.Minimal) !u8 {
    var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const env = init.environ;

    const result = spirit.verifyAllAttested(allocator, env) catch |e| {
        std.debug.print(
            "spirit-check: verifier crashed: {s}\n" ++
                "  the build refuses to ship a binary without doctrinal " ++
                "attestation for every source file.\n",
            .{@errorName(e)},
        );
        return 2;
    };

    if (result.err) |err| {
        const path = if (result.failing_path) |p| p else "<unknown>";
        switch (err) {
            spirit.SpiritError.UnattestedSource => std.debug.print(
                "spirit-check: FAIL — source `{s}` has no attestation row.\n" ++
                    "  Run `aiko attest` to invoke the LLM judge against the 10 commandments\n" ++
                    "  (order) and the 7 fruits of the spirit, then sign the PASS verdict\n" ++
                    "  with the root /contract wallet.\n",
                .{path},
            ),
            spirit.SpiritError.AttestationVerdictNotPass => std.debug.print(
                "spirit-check: FAIL — source `{s}` carries a non-PASS verdict.\n" ++
                    "  The LLM judged this file as violating doctrine. Read the row's\n" ++
                    "  `reasoning` field, fix the offending code, then re-attest.\n",
                .{path},
            ),
            spirit.SpiritError.AttestationSignatureInvalid => std.debug.print(
                "spirit-check: FAIL — source `{s}` attestation has an invalid signature.\n" ++
                    "  Only the root /contract wallet's signature is accepted; a forged or\n" ++
                    "  truncated signature means the row cannot be trusted.\n",
                .{path},
            ),
            spirit.SpiritError.SourceUnreadable => std.debug.print(
                "spirit-check: FAIL — source `{s}` could not be read.\n" ++
                    "  The file is declared in SOURCE_FILES but missing on disk.\n",
                .{path},
            ),
            spirit.SpiritError.NoAttestationLedger => std.debug.print(
                "spirit-check: FAIL — `.contract-spirit-attest.jsonl` ledger is unreachable.\n" ++
                    "  Walk-up from the current working directory could not find a repo\n" ++
                    "  root with both `libcontract/` and `zig/` as siblings.\n",
                .{},
            ),
            else => std.debug.print(
                "spirit-check: FAIL — verifier reported `{s}` for `{s}`.\n",
                .{ @errorName(err), path },
            ),
        }
        return 1;
    }

    std.debug.print(
        "spirit-check: PASS — every source file is attested " ++
            "(order ✓ · spirit ✓ · signed ✓).\n",
        .{},
    );
    return 0;
}
