const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // main.zig uses libc externs (popen, system, stat, getentropy, setenv,
    // _NSGetExecutablePath on Darwin) — link explicitly so cross-compile
    // targets (musl, glibc) get the symbols too.
    const libcontract = b.createModule(.{
        .root_source_file = b.path("../libcontract/src/contract.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    // bible.zig in libcontract @embedFile's the packed KJV blobs from
    // ../libcontract/data/. Add the search path so the embed resolves.
    libcontract.addEmbedPath(b.path("../libcontract/data"));
    const client = b.createModule(.{
        .root_source_file = b.path("../libcontract/src/client.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            // client.zig depends on contract.zig (lineage/wallet/persona
            // primitives). Declare the module dep explicitly so Zig 0.16
            // doesn't see contract.zig reachable from two modules with no
            // declared edge between them.
            .{ .name = "contract", .module = libcontract },
        },
    });

    // ─── Build the main binary — no LLM-judge gate ──────────────────
    //
    // Lewis 2026-05-26: "we can /contract against itself instead of
    // doing this weird thing". The substrate self-attests via:
    //   - pattern.zig comptime invariants (refuses non-conforming
    //     source at compile time, BEFORE the binary exists)
    //   - `zig build test` (runtime invariants on inline tests)
    //   - the build pipeline's own EVAL step (build-fractal.sh writes
    //     an L8 `signed:<binary-sha8>` row using the freshly-built
    //     binary itself)
    //   - the binary's startup self-verify (refuses to run if its
    //     own sha256 has no matching L8 row in the ledger)
    //
    // No external LLM. The signature IS substrate-derived. Bootstrap
    // is solved because the build pipeline produces the signature in
    // one shot from a fresh repo.
    addContractExecutable(b, target, optimize, libcontract, client, "contract-zig", null);

    // `zig build run` — local smoke-test entry point.
    const run_root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "contract", .module = libcontract },
            .{ .name = "contract_client", .module = client },
        },
    });

    const run_exe = b.addExecutable(.{
        .name = "contract-zig-run",
        .root_module = run_root,
    });
    const run_cmd = b.addRunArtifact(run_exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run contract-zig");
    run_step.dependOn(&run_cmd.step);

    const test_root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "contract", .module = libcontract },
            .{ .name = "contract_client", .module = client },
        },
    });
    const unit_tests = b.addTest(.{ .root_module = test_root });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run Contract unit tests");
    test_step.dependOn(&run_unit_tests.step);
}

/// Create the contract-zig executable.
///
/// `gate_step` is an optional dependency edge: the install step for
/// the produced executable depends on `gate_step` succeeding. Used to
/// route every install through the spirit-check verifier.
fn addContractExecutable(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    libcontract: *std.Build.Module,
    client: *std.Build.Module,
    exe_name: []const u8,
    gate_step: ?*std.Build.Step,
) void {
    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "contract", .module = libcontract },
            .{ .name = "contract_client", .module = client },
        },
    });

    const exe = b.addExecutable(.{
        .name = exe_name,
        .root_module = root,
    });
    const install_step = b.addInstallArtifact(exe, .{});
    if (gate_step) |gs| install_step.step.dependOn(gs);
    b.getInstallStep().dependOn(&install_step.step);
}
