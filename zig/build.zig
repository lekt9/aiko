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
    // Single executable: `contract-zig`. The aiko persona is selected at
    // RUNTIME from argv[0]'s basename inside main.zig (see BINARY_NAME +
    // AIKO_DECLARE_ONLY init in `pub fn main`). The installed `aiko`
    // entrypoint is a symlink → `contract` (see scripts/build.sh
    // step_install); one binary, two faces, no `build_options.binary_name`
    // discriminator.
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
        .name = "contract-zig",
        .root_module = root,
    });

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run contract-zig");
    run_step.dependOn(&run_cmd.step);
}
