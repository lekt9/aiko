const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // ── libcontract.a ────────────────────────────────────────────────────
    // Static library exposing the C ABI declared in src/c_abi.zig.
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/c_abi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lib_mod.addEmbedPath(b.path("data"));
    const lib = b.addLibrary(.{
        .name = "contract",
        .linkage = .static,
        .root_module = lib_mod,
    });
    b.installArtifact(lib);

    // ── contract-lib-shim ────────────────────────────────────────────────
    // Tiny CLI for the bash parity tests. Calls contract.zig directly (no
    // FFI roundtrip) but pulls c_abi.zig into the same module so static
    // symbols are exercised end-to-end.
    const shim_mod = b.createModule(.{
        .root_source_file = b.path("src/shim.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    shim_mod.addEmbedPath(b.path("data"));
    const shim = b.addExecutable(.{
        .name = "contract-lib-shim",
        .root_module = shim_mod,
    });
    b.installArtifact(shim);

    // ── tests ────────────────────────────────────────────────────────────
    // Σ27 (a4e162c8) — the-binary-IS-the-interface: every doctrine has its
    // tests INSIDE the source file, exercised by `zig build test`. No
    // verb-gates/<name>/verify.sh folder outriggers; if it isn't testable
    // from here, it isn't bound.
    const test_step = b.step("test", "Run libcontract tests");

    const test_files = [_][]const u8{
        "src/contract.zig",
        "src/pointer.zig",
        "src/guards.zig",
        "src/fractal.zig",
        "src/http.zig",
        "src/client.zig",
        "src/bible.zig",
        "src/cache.zig",
        "src/terminal.zig",
        "src/capability.zig",
        "src/embed.zig",
        "src/ebm.zig",
        "src/cas.zig",
        "src/reward.zig",
        "src/usage.zig",
        "src/usage_ledger.zig",
        "src/epoch.zig",
        // Solana devnet capability — a ZERO-DEPENDENCY closure: every file here
        // imports only `std` (base58 pure; solana_rpc uses std.http native TLS,
        // no curl/shell). No env reads (claim 1). The write/anchor engine
        // (solana_tx, agency, chain, iq_ledger, voltr, solana_vault) is deferred
        // until its on-chain purpose is built + its env-config refactored.
        "src/base58.zig",
        "src/solana_rpc.zig",
        "src/devnet_probe.zig",
        // FDRY bonding rail — native Voltr staking, std-only (base58 + std.crypto
        // PDA derivation). Operator-gated: builds the deposit card, never sends.
        // The PDA-matches-mainnet-constant test proves byte-correctness offline.
        "src/voltr.zig",
        "src/stake.zig",
        "src/payout.zig",
        "src/payload_crypto.zig",
        "src/words.zig",
        "src/pattern.zig",
        "src/shape.zig",
        "src/w6h.zig",
    };
    for (test_files) |tf| {
        const mod = b.createModule(.{
            .root_source_file = b.path(tf),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        // bible.zig embeds packed data from libcontract/data/. Make that dir
        // available to @embedFile in all test modules (cheap; cost is zero
        // if the file isn't referenced).
        mod.addEmbedPath(b.path("data"));
        const t = b.addTest(.{ .root_module = mod });
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}
