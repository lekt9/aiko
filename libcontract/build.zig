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
    const shim = b.addExecutable(.{
        .name = "contract-lib-shim",
        .root_module = shim_mod,
    });
    b.installArtifact(shim);

    // ── tests ────────────────────────────────────────────────────────────
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/contract.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run libcontract tests");
    test_step.dependOn(&run_tests.step);
}
