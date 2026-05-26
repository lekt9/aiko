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
        "src/payload_crypto.zig",
        "src/words.zig",
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
