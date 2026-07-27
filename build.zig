const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const typed_neuron = b.addModule("typed_neuron", .{
        .root_source_file = b.path("src/wire.zig"),
        .target = target,
        .optimize = optimize,
    });
    const version = b.option([]const u8, "version", "Version shown by neuron --version") orelse "0.1.0-dev";
    const options = b.addOptions();
    options.addOption([]const u8, "version", version);
    // Embed the current Git revision so the binary reports its immutable
    // source pin.  If the repo is not a Git checkout or the command fails,
    // the revision defaults to "unknown" — the witness catches this.
    const git_rev = b.run(&[_][]const u8{ "git", "rev-parse", "HEAD" });
    const rev = std.mem.trim(u8, git_rev, " \t\r\n");
    options.addOption([]const u8, "source_revision", if (rev.len == 40) rev else "unknown");

    const exe = b.addExecutable(.{
        .name = "neuron",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.root_module.addOptions("build_options", options);
    exe.root_module.addImport("typed_neuron", typed_neuron);
    exe.root_module.addAnonymousImport("meta_agent_defaults", .{
        .root_source_file = b.path("reference/defaults/meta-agent.json"),
    });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.step.dependOn(b.getInstallStep());
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the Typed Neuron CLI").dependOn(&run.step);

    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    tests.root_module.addImport("typed_neuron", typed_neuron);
    tests.root_module.addAnonymousImport("meta_agent_defaults", .{
        .root_source_file = b.path("reference/defaults/meta-agent.json"),
    });
    const run_tests = b.addRunArtifact(tests);
    const wire_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wire.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_wire_tests = b.addRunArtifact(wire_tests);
    const test_step = b.step("test", "Run all behavioral and contract tests");
    test_step.dependOn(&run_tests.step);
    test_step.dependOn(&run_wire_tests.step);
}
