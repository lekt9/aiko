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
    const client = b.createModule(.{
        .root_source_file = b.path("../libcontract/src/client.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const contract_options = b.addOptions();
    contract_options.addOption([]const u8, "binary_name", "contract");
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
    root.addOptions("build_options", contract_options);

    const exe = b.addExecutable(.{
        .name = "contract-zig",
        .root_module = root,
    });

    b.installArtifact(exe);

    const aiko_options = b.addOptions();
    aiko_options.addOption([]const u8, "binary_name", "aiko");
    const aiko_root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "contract", .module = libcontract },
            .{ .name = "contract_client", .module = client },
        },
    });
    aiko_root.addOptions("build_options", aiko_options);

    const aiko = b.addExecutable(.{
        .name = "aiko",
        .root_module = aiko_root,
    });

    b.installArtifact(aiko);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run contract-zig");
    run_step.dependOn(&run_cmd.step);
}
