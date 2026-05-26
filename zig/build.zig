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

    // ─── Wave-1 client/server split: build profile selector ──────────
    //
    // The `-Dcontract_binary_profile=<client|server>` flag selects which
    // build_options.contract_binary_profile constant gets compiled into
    // the binary. Currently the two binaries are byte-different but
    // functionally identical — only `cmdSelf --json` reads the constant
    // (it surfaces `"profile": "client"` vs `"profile": "server"`). The
    // heavy code-path gating (cmdSearch/cmdDiscover/bio*/runAction graph
    // branches → RPC wrappers in client profile) sequences after the
    // Worker side ships the matching /v1/contract endpoints.
    //
    // Default is "client" so a bare `zig build` (and `zig build run`)
    // still produce the canonical aiko client binary.
    //
    // build.sh invokes this twice: once with =client (installed as
    // `scripts/contract`, what `aiko -> contract` symlinks to) and once
    // with =server (installed as `scripts/contract-server`).
    const profile_arg = b.option(
        []const u8,
        "contract_binary_profile",
        "Build profile: 'client' (default, the aiko-symlinked binary) or 'server' (canonical compile/resolve/biology, not yet runtime-divergent in Wave 1)",
    ) orelse "client";

    // Build BOTH artifacts in one invocation so `zig build` (no -D) emits
    // contract-zig (client) + contract-zig-server (server). build.sh
    // calls `zig build` once and installs both. Each executable has its
    // own root_module so the OptionsModule constant differs per binary.
    addContractExecutable(b, target, optimize, libcontract, client, "contract-zig", "client");
    addContractExecutable(b, target, optimize, libcontract, client, "contract-zig-server", "server");

    // The `zig build run` step uses the profile_arg the operator passed
    // (default "client"). Useful for local smoke-testing the server
    // profile without leaving the build tree.
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
    const run_opts = b.addOptions();
    run_opts.addOption([]const u8, "contract_binary_profile", profile_arg);
    run_root.addImport("build_options", run_opts.createModule());

    const run_exe = b.addExecutable(.{
        .name = "contract-zig-run",
        .root_module = run_root,
    });
    const run_cmd = b.addRunArtifact(run_exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run contract-zig (profile selected by -Dcontract_binary_profile)");
    run_step.dependOn(&run_cmd.step);
}

/// Create one contract-zig executable with the given profile constant
/// baked in via build_options. Shared between the client and server
/// install targets — only the executable name + profile string differ.
fn addContractExecutable(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    libcontract: *std.Build.Module,
    client: *std.Build.Module,
    exe_name: []const u8,
    profile: []const u8,
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
    const opts = b.addOptions();
    opts.addOption([]const u8, "contract_binary_profile", profile);
    root.addImport("build_options", opts.createModule());

    const exe = b.addExecutable(.{
        .name = exe_name,
        .root_module = root,
    });
    b.installArtifact(exe);
}
