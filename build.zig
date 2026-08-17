//! aiko — one build for the whole harness.
//!
//! aiko is a meta-fractal harness exposed as an MCP, mounted inside Hermes. It
//! is assembled from two Zig layers with a deliberate one-way dependency:
//!
//!     aiko (this build)
//!       ├─ neuron    the firing primitive, the membrane, the served `port`
//!       │            surface, and `redrive` (invalidation → re-derive →
//!       │            compensate). Standalone: no runtime dependency on
//!       │            contract or on the Rust host.
//!       └─ contract  the durable interpreter: append-only ledger, W6H (a row
//!                    that cannot answer who/what/when/where/why/how is
//!                    refused, naming the missing one), occurrence-keyed
//!                    invalidation, validity windows.
//!
//! The direction is load-bearing and must not be reversed. neuron building and
//! testing WITHOUT contract is the mechanical evidence that a delivered system
//! survives aiko being unavailable or handed off — the client's stated
//! condition, expressed as an architecture rather than a promise. Fusing the
//! two source trees would delete that evidence to solve a problem that does not
//! exist: they already share one repository.
//!
//! The Rust host under aiko/ is deliberately NOT built here. It compiles, but
//! its test build exhausts a 16GB machine, so a build that included it could
//! not be verified on the hardware this runs on. An unverifiable build step is
//! worse than an absent one.
//!
//!     zig build            → zig-out/bin/aiko
//!     zig build test       → both layers' suites
//!     zig build gate       → the runnable witnesses

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Each layer keeps its own build.zig as the source of truth for how it is
    // compiled. This build composes them; it does not restate them, because a
    // second description of how to build neuron is a second thing to drift.
    const neuron = b.dependency("neuron", .{ .target = target, .optimize = optimize });
    const contract = b.dependency("libcontract", .{ .target = target, .optimize = optimize });

    // The harness binary is neuron's CLI under its product name. Everything the
    // MCP surface needs is already dispatched there: `port`, `redrive`, `agent`,
    // `limb`, `interface`, `mcp`, `telemetry`.
    const harness = neuron.artifact("neuron");
    const install = b.addInstallArtifact(harness, .{ .dest_sub_path = "aiko" });
    b.getInstallStep().dependOn(&install.step);

    // `aiko-doctor` is the first binary in this repository that links BOTH
    // layers in one process. It is small on purpose: its job is to make the
    // seam falsifiable rather than assumed. It will not compile unless
    // contract's module export is real and `contract.FireRequest` is still
    // `typed_neuron.FireRequest`, which is the assumption the bridge will rest
    // on.
    const doctor_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    doctor_mod.addImport("typed_neuron", neuron.module("typed_neuron"));
    doctor_mod.addImport("contract", contract.module("contract"));
    // Aiko exposes Contract's pure analyzer; it does not grow a root scheduler.
    // Pointing at the owning source means the CLI and C ABI compile the same
    // implementation rather than two planners that can drift.
    const graph_analyzer_mod = b.createModule(.{
        .root_source_file = b.path("contract/libcontract/src/graph_plan.zig"),
        .target = target,
        .optimize = optimize,
    });
    doctor_mod.addImport("contract_graph_analyzer", graph_analyzer_mod);
    const doctor = b.addExecutable(.{ .name = "aiko-doctor", .root_module = doctor_mod });
    b.installArtifact(doctor);

    // contract is a library, not a second entry point: it is what makes a
    // firing durable and time-aware.
    //
    // Two things that do NOT work here, both found by deleting
    // contract/libcontract/zig-out and checking whether a top-level build put
    // it back:
    //
    //   contract.artifact("contract")            — ambiguous: libcontract
    //       publishes both a static lib and a dylib under that name, so this
    //       panics, and picking one would silently choose for every consumer.
    //   contract.builder.getInstallStep()        — a no-op in dependency
    //       context. It compiles, it depends cleanly, and it builds NOTHING.
    //       The unified build was neuron-only and looked green.
    //
    // So drive the sub-build the same way `test` does. It is less elegant than
    // a step dependency and it is the version that actually rebuilds.
    const contract_build = b.addSystemCommand(&.{ "zig", "build" });
    contract_build.setCwd(b.path("contract/libcontract"));
    b.getInstallStep().dependOn(&contract_build.step);

    const run = b.addRunArtifact(harness);
    run.step.dependOn(b.getInstallStep());
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the aiko harness CLI").dependOn(&run.step);

    // Each layer owns its own suite. Shelling out to the sub-builds keeps that
    // ownership honest: restating their test wiring here would be a second
    // description to drift, and reaching into another builder's internal step
    // list breaks whenever that layer reorganises its steps.
    const test_step = b.step("test", "Run both layers' test suites");
    const neuron_tests = b.addSystemCommand(&.{ "zig", "build", "test" });
    neuron_tests.setCwd(b.path("neuron"));
    const contract_tests = b.addSystemCommand(&.{ "zig", "build", "test" });
    contract_tests.setCwd(b.path("contract/libcontract"));
    test_step.dependOn(&neuron_tests.step);
    test_step.dependOn(&contract_tests.step);

    // The gate step is the acceptance criterion, not the unit tests: each gate
    // drives the public CLI from an empty directory and asserts against durable
    // state. Kept as a named step so `zig build gate` is the one command a host
    // runs before trusting a build.
    // Self-check must run on every native build (`zig build`), not only `zig build gate`.
    // It is anchored to the install aggregate so `zig build` always verifies wiring.
    // To avoid a cycle (`install <-> self-check`), the check depends on the
    // concrete install artifacts (harness + doctor + libcontract), while the
    // top-level install depends on the check. This keeps the graph acyclic.
    const self_check = b.addSystemCommand(&.{ "bash", "tests/aiko-self-check-gate.sh" });
    self_check.step.dependOn(&install.step);
    self_check.step.dependOn(&doctor.step);
    self_check.step.dependOn(&contract_build.step);
    b.getInstallStep().dependOn(&self_check.step);
    b.step("self-check", "Run the aiko self-wire/self-check gate").dependOn(&self_check.step);

    const gate_step = b.step("gate", "Run the runnable witnesses");
    const graph_main_gate = b.addSystemCommand(&.{ "bash", "tests/graph-harness-main-path-gate.sh" });
    graph_main_gate.step.dependOn(b.getInstallStep());
    gate_step.dependOn(&graph_main_gate.step);
    for ([_][]const u8{
        "neuron/tests/published-interface-gate.sh",
        "neuron/tests/redrive-gate.sh",
        "neuron/tests/authored-gap-gate.sh",
        "neuron/tests/skill-doc-gate.sh",
        "tests/zig-doctrine-gate.sh",
        "neuron/tests/escalation-ladder-gate.sh",
        "neuron/tests/staffing-engine-gate.sh",
        "neuron/tests/claim-deadline-gate.sh",
        "tests/bridge-gate.sh",
        "tests/dispatch-gate.sh",
        "neuron/tests/interface-morphogenesis-gate.sh",
        "neuron/tests/meta-agent-gate.sh",
        "neuron/tests/self-constructing-agent-gate.sh",
        "tests/tick-gate.sh",
        "tests/graph-engineering-gate.sh",
        "tests/cross-journal-retention-gate.sh",
        "tests/no-duplicate-fde-primitives-gate.sh",
        "neuron/tests/product-forge-gate.sh",
        "tests/contract-library-pin-gate.sh",
        "tests/contract-slim-ledger-gate.sh",
        "tests/layer-lock-gate.sh",
        // Doc gates are witnesses too: prose that contradicts the tree is a
        // defect the build must catch, not a review nicety. Both are cheap
        // (seconds, no compile) so they ride in the default gate step.
        "tests/docs-oss-ready-gate.sh",
        "tests/docs-quality-gate.sh",
        // self-check is already covered via install — skip here to avoid a
        // duplicate run inside gate (the dependency through install is enough).
    }) |witness| {
        const g = b.addSystemCommand(&.{ "bash", witness });
        g.step.dependOn(b.getInstallStep());
        if (std.mem.eql(u8, witness, "tests/graph-engineering-gate.sh")) {
            g.step.dependOn(&graph_main_gate.step);
            g.setEnvironmentVariable("AIKO_MAIN_PATH_ALREADY_GATED", "1");
        }
        gate_step.dependOn(&g.step);
    }
    gate_step.dependOn(&self_check.step);

    // Conformance re-runs the witness inventory against CONFORMANCE.md's
    // recorded verdicts — it deliberately re-executes gates, so it lives in
    // its own step rather than doubling every witness inside `zig build gate`.
    const conformance = b.addSystemCommand(&.{ "bash", "tests/conformance-gate.sh" });
    conformance.step.dependOn(b.getInstallStep());
    b.step("conformance", "Reproduce every CONFORMANCE.md verdict against the tree").dependOn(&conformance.step);
}
