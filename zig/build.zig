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

    // ─── Spirit-check gate (build-time LLM attestation verifier) ─────
    //
    // Every `zig build install` runs the spirit-check binary BEFORE
    // installing the main contract binaries. spirit-check refuses to
    // exit 0 unless every .zig source file under libcontract/src/ +
    // zig/src/ carries a current PASS row in `.contract-spirit-
    // attest.jsonl`, signed by the root /contract wallet.
    //
    // Verdicts are produced by an LLM judge (driven by `aiko attest`)
    // evaluating each file against the 10 commandments (order) +
    // 7 fruits of the spirit. Substrate-faithful: the LLM is the
    // judge, the wallet signs, the build verifies the signature.
    //
    // There is no flag, env var, or argument that bypasses this. The
    // only way to make the build green is to land an attested PASS
    // row for each source file.
    const spirit_check_root = b.createModule(.{
        .root_source_file = b.path("../libcontract/src/spirit_check_main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    spirit_check_root.addEmbedPath(b.path("../libcontract/data"));
    const spirit_check_exe = b.addExecutable(.{
        .name = "spirit-check",
        .root_module = spirit_check_root,
    });
    const run_spirit_check = b.addRunArtifact(spirit_check_exe);
    // Walk-up resolution in spirit.attestationLedgerPath needs a cwd
    // inside the repo tree; build_root is the canonical anchor.
    run_spirit_check.setCwd(b.path(".."));
    // The run-step's exit status propagates: non-zero → build fails.
    run_spirit_check.expectExitCode(0);

    // Build the main binaries (contract-zig + contract-zig-server)
    // and bind each install to the spirit-check verdict.
    addContractExecutable(b, target, optimize, libcontract, client, "contract-zig", "client", &run_spirit_check.step);
    addContractExecutable(b, target, optimize, libcontract, client, "contract-zig-server", "server", &run_spirit_check.step);

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
