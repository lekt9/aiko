const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const exe = b.addExecutable(.{
        .name = "cell",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "run cell").dependOn(&run.step);

    // zig build test — python test suite (cell/tests/test_cell.py)
    const pytest = b.addSystemCommand(&.{ "python3", "-m", "unittest", "tests.test_cell", "-v" });
    pytest.setCwd(b.path("."));
    const test_step = b.step("test", "Run cell test suite");
    test_step.dependOn(&pytest.step);

    // zig build gate — 10 witnesses, the acceptance criterion (empty dir, public CLI, durable state)
    const gate = b.addSystemCommand(&.{ "bash", "tests/gate.sh" });
    gate.setCwd(b.path("."));
    const gate_step = b.step("gate", "Run 10 gate witnesses (acceptance)");
    gate_step.dependOn(&gate.step);
}
